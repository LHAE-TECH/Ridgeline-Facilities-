import type { Db } from '../db.js';
import { one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError } from '../lib/errors.js';
import { applyBps, formatNzd } from '../lib/money.js';
import { audit } from './audit.js';
import { lockJob, recordJobEvent } from './jobState.js';
import { accountPosition } from './ledger.js';
import { normaliseNzPhone } from '../lib/phone.js';
import { link, notifyContractor, notifyCustomer, notifyStaff, queueSms } from './notifications.js';
import { getSettings, type Settings } from './settings.js';

/**
 * Unfunded and over-authority P1 jobs.
 *
 * Nothing delays the response to a P1: the on-site and made-safe clocks run from booking. What is limited is the
 * SCOPE. A P1 dispatched without prepaid cover or above the customer's authority limit is authorised for make-safe
 * work only, up to a cap (customer price ex GST; global setting, or per customer). Anything beyond needs the
 * customer's approval or a staff override with a reason, both recorded on the job.
 */

export type ScopeReason = 'unfunded' | 'over_authority' | 'unfunded_over_authority';

/** True while a job is limited to make-safe work. */
export function isMakeSafeOnly(job: { p1_scope?: string | null; scope_extended_at?: unknown }): boolean {
  return job.p1_scope === 'make_safe' && !job.scope_extended_at;
}

export function makeSafeCapExGst(customer: { p1_unfunded_cap_ex_gst_cents?: number | null }, settings: Settings): number {
  return Number(customer.p1_unfunded_cap_ex_gst_cents ?? settings.p1_unfunded_cap_ex_gst_cents);
}

export function suspendThreshold(customer: { p1_unfunded_suspend_threshold_cents?: number | null }, settings: Settings): number {
  return Number(customer.p1_unfunded_suspend_threshold_cents ?? settings.p1_unfunded_suspend_threshold_cents);
}

export interface MakeSafeScope {
  reason: ScopeReason;
  capExGstCents: number;
  /** Customer charge (incl GST) reserved against the account: the cap, not the full estimate. */
  commitCents: number;
  /** Contractor cost (ex GST) authorised for make-safe work, from the estimate's own price/cost ratio. */
  authorisedContractorCostCents: number;
}

export function makeSafeScope(job: any, customer: any, settings: Settings, reason: ScopeReason): MakeSafeScope {
  const cap = makeSafeCapExGst(customer, settings);
  const pricing = job.estimate?.pricing ?? {};
  const subtotal = Number(pricing.subtotalExGstCents ?? 0);
  const cost = Number(pricing.contractorCostExGstCents ?? 0);
  // Translate the customer-price cap into contractor cost using this job's estimated pricing (rules vary by window).
  const authorised = subtotal > 0 ? Math.floor((cost * cap) / subtotal) : Math.floor((cap * 10000) / (10000 + settings.assessment_markup_bps));
  const commitCents = settings.ridgeline_gst_registered ? applyBps(cap, 10000 + settings.gst_rate_bps) : cap;
  return { reason, capExGstCents: cap, commitCents, authorisedContractorCostCents: authorised };
}

export interface UnfundedPosition {
  receivableCents: number;
  openP1UnfundedCents: number;
  totalCents: number;
  thresholdCents: number;
  suspended: boolean;
}

/**
 * The customer's money at risk without prepaid cover: unpaid invoice balances plus the unfunded part of P1 jobs not
 * yet invoiced (once invoiced, that part is in the receivable, so nothing is counted twice).
 *
 * The open part is the recorded unfunded amounts, capped at the account's actual current shortfall (active
 * commitments minus prepaid balance). So several P1s sharing one balance are counted once, and a top-up reduces the
 * exposure straight away.
 */
export async function unfundedPosition(db: Db, customerId: string, settings?: Settings): Promise<UnfundedPosition> {
  const s = settings ?? await getSettings(db);
  const r = await one(db,
    `SELECT c.p1_unfunded_suspend_threshold_cents,
            COALESCE((SELECT SUM(total_cents - credited_cents - prepaid_applied_cents - amount_paid_cents + credit_to_prepaid_cents)
                        FROM customer_invoices WHERE customer_id = c.id AND status IN ('issued','partially_paid')),0)::bigint AS receivable,
            COALESCE((SELECT SUM(unfunded_cents) FROM jobs WHERE customer_id = c.id AND unfunded_cents > 0
                        AND status NOT IN ('customer_invoiced','closed','cancelled')),0)::bigint AS open_p1
       FROM customers c WHERE c.id = $1`, [customerId]);
  const receivableCents = Number(r.receivable);
  const shortfall = Math.max(0, -(await accountPosition(db, customerId)).availableCents);
  const openP1UnfundedCents = Math.min(Number(r.open_p1), shortfall);
  const totalCents = receivableCents + openP1UnfundedCents;
  const thresholdCents = suspendThreshold(r, s);
  return { receivableCents, openP1UnfundedCents, totalCents, thresholdCents, suspended: totalCents >= thresholdCents };
}

/** Ops dashboard: unfunded P1 exposure across all customers. */
export async function p1Exposure(db: Db) {
  const settings = await getSettings(db);
  const rows = await query(db,
    `WITH open_p1 AS (
       SELECT customer_id, SUM(unfunded_cents)::bigint AS open_unfunded, COUNT(*)::int AS open_jobs
         FROM jobs WHERE unfunded_cents > 0 AND status NOT IN ('customer_invoiced','closed','cancelled') GROUP BY customer_id),
     p1_ar AS (
       SELECT i.customer_id, SUM(i.total_cents - i.credited_cents - i.prepaid_applied_cents - i.amount_paid_cents + i.credit_to_prepaid_cents)::bigint AS invoiced_unpaid
         FROM customer_invoices i JOIN jobs j ON j.id = i.job_id
        WHERE j.unfunded_cents > 0 AND i.status IN ('issued','partially_paid') GROUP BY i.customer_id)
     SELECT c.id, c.name, c.account_ref, c.p1_unfunded_suspend_threshold_cents,
            COALESCE(o.open_unfunded,0)::bigint AS open_unfunded, COALESCE(o.open_jobs,0)::int AS open_jobs, COALESCE(a.invoiced_unpaid,0)::bigint AS invoiced_unpaid
       FROM customers c LEFT JOIN open_p1 o ON o.customer_id = c.id LEFT JOIN p1_ar a ON a.customer_id = c.id
      WHERE o.customer_id IS NOT NULL OR a.customer_id IS NOT NULL`);
  const customers = [];
  for (const r of rows) {
    const pos = await unfundedPosition(db, r.id, settings);
    customers.push({ id: r.id, name: r.name, accountRef: r.account_ref, openUnfundedCents: pos.openP1UnfundedCents, openJobs: r.open_jobs,
      invoicedUnpaidCents: Number(r.invoiced_unpaid), unfundedBalanceCents: pos.totalCents, thresholdCents: pos.thresholdCents, suspended: pos.suspended });
  }
  customers.sort((a, b) => (b.openUnfundedCents + b.invoicedUnpaidCents) - (a.openUnfundedCents + a.invoicedUnpaidCents));
  const openUnfundedCents = customers.reduce((s, c) => s + c.openUnfundedCents, 0);
  const invoicedUnpaidCents = customers.reduce((s, c) => s + c.invoicedUnpaidCents, 0);
  return { totalCents: openUnfundedCents + invoicedUnpaidCents, openUnfundedCents, invoicedUnpaidCents,
    openJobs: customers.reduce((s, c) => s + c.openJobs, 0), suspendedCustomers: customers.filter((c) => c.suspended).length, customers };
}

/**
 * Records that work beyond make-safe is authorised. Caller holds the job lock. Used for explicit approvals and when a
 * customer approves a quote or variation on a make-safe job.
 */
export async function recordScopeExtension(c: Db, actor: Actor, job: any, kind: 'customer_approval' | 'staff_override', reason: string) {
  if (!isMakeSafeOnly(job)) return;
  const fullCost = Number(job.estimate?.pricing?.contractorCostExGstCents ?? 0);
  const before = await one(c, `SELECT COALESCE(SUM(amount_cents),0)::bigint AS v FROM job_commitments WHERE job_id = $1 AND status = 'active'`, [job.id]);
  const available = (await accountPosition(c, job.customer_id)).availableCents;
  await c.query(`UPDATE job_commitments SET amount_cents = GREATEST(amount_cents, $2) WHERE job_id = $1 AND status = 'active'`, [job.id, job.estimate_total_cents]);
  const delta = Math.max(0, job.estimate_total_cents - Number(before.v));
  // Only jobs dispatched without cover accrue unfunded exposure; the extra commitment is unfunded beyond what is available.
  const extraUnfunded = job.p1_scope_reason?.startsWith('unfunded') ? Math.max(0, delta - Math.max(0, available)) : 0;
  await c.query(
    `UPDATE jobs SET scope_extended_at = now(), scope_extended_by = $2, scope_extension_kind = $3, scope_extension_reason = $4,
        authorised_contractor_cost_cents = GREATEST(COALESCE(authorised_contractor_cost_cents,0), $5), unfunded_cents = unfunded_cents + $6,
        customer_approved_by = CASE WHEN $3 = 'customer_approval' THEN $2 ELSE customer_approved_by END,
        customer_approved_at = CASE WHEN $3 = 'customer_approval' THEN now() ELSE customer_approved_at END
      WHERE id = $1`, [job.id, actor.id, kind, reason, fullCost, extraUnfunded]);
  job.scope_extended_at = new Date();
  const who = kind === 'customer_approval' ? 'customer approval' : 'staff override';
  await recordJobEvent(c, actor, job.id, 'p1.scope_extended', { note: `Work beyond make-safe authorised by ${who}: ${reason}` });
  await audit(c, actor, { action: 'job.p1_scope_extended', entityType: 'job', entityId: job.id, customerId: job.customer_id,
    details: { kind, reason, capExGst: job.p1_scope_cap_ex_gst_cents, extraUnfunded } });
  if (job.assigned_contractor_id) {
    await notifyContractor(c, job.assigned_contractor_id, { template: 'scope_extended', subject: `${job.ref}: work beyond make-safe approved`,
      body: `Further work on ${job.ref} is now authorised (${who}). Quote any work beyond the original estimate as a variation.\n${link(`/c/jobs/${job.id}`)}`,
      idempotencyKey: `scope-extended:${job.id}` });
  }
  await notifyStaff(c, ['ops', 'admin'], { template: 'scope_extended', subject: `${job.ref}: make-safe scope extended (${who})`,
    body: `${reason}\n${link(`/admin/jobs/${job.id}`)}`, idempotencyKey: `scope-extended-staff:${job.id}` });
}

/** Customer approval (owner, or approver within their limit) or staff override (ops/admin, reason required). */
export async function extendP1Scope(db: Db, actor: Actor, jobId: string, reason: string | undefined) {
  await tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    if (!isMakeSafeOnly(job)) throw new AppError('This job is not limited to make-safe work', 409);
    if (['customer_invoiced', 'closed', 'cancelled'].includes(job.status)) throw new AppError('This job can no longer be extended', 409);
    if (actor.role === 'customer') {
      if (actor.customerId !== job.customer_id) throw new ForbiddenError();
      const ok = actor.customerRole === 'owner'
        || (actor.customerRole === 'approver' && (actor.approvalLimitCents == null || actor.approvalLimitCents >= job.estimate_total_cents));
      if (!ok) throw new ForbiddenError('Only an owner, or an approver whose limit covers the estimate, can approve further work');
      await recordScopeExtension(c, actor, job, 'customer_approval',
        reason?.trim() || `Approved by ${actor.name} for the estimated ${formatNzd(job.estimate_total_cents)} incl GST`);
      return;
    }
    if (!isStaff(actor) || !['ops', 'admin'].includes(actor.role)) throw new ForbiddenError('Only operations or administrators can override the make-safe scope');
    if (!reason?.trim()) throw new AppError('A reason is required to override the make-safe scope');
    await recordScopeExtension(c, actor, job, 'staff_override', reason.trim());
  });
}

/** Customer-facing explanation sent when a P1 is dispatched for make-safe only. */
export async function notifyMakeSafeDispatch(c: Db, job: any, scope: MakeSafeScope, detail: string) {
  const why = scope.reason === 'over_authority' ? 'its estimate is above your authority limit'
    : scope.reason === 'unfunded' ? 'your prepaid balance does not cover it' : 'your prepaid balance does not cover it and its estimate is above your authority limit';
  await notifyCustomer(c, job.customer_id, {
    template: 'p1_make_safe_dispatch', subject: `Emergency ${job.ref} dispatched: make-safe work only`,
    body: `We have dispatched emergency job ${job.ref} (${job.title}) immediately. Because ${why}, the contractor is authorised to make the site safe only, ` +
      `up to ${formatNzd(scope.capExGstCents)} ex GST. ${detail}\nAny further work needs your approval: ${link(`/app/jobs/${job.id}`)}`,
    idempotencyKey: `p1-make-safe:${job.id}`,
  });
}

/**
 * Who gets the SMS when a P1 is held at the threshold: every active staff user with the on-call release right (so the
 * person alerted can act), plus any escalation phone. Escalation phones that belong to nobody with the right are
 * returned separately so the settings and users pages can warn about them.
 */
export async function p1HoldAlertRecipients(db: Db) {
  const settings = await getSettings(db);
  const onCall = await query<{ id: string; name: string; phone: string | null }>(db,
    `SELECT id, name, phone FROM users WHERE on_call_p1_release AND is_active AND role IN ('admin','ops','finance')`);
  const releasers = new Set(onCall.map((u) => normaliseNzPhone(u.phone)).filter((p): p is string => !!p));
  const escalation = settings.escalation_staff_phones.map((p) => normaliseNzPhone(p)).filter((p): p is string => !!p);
  return {
    phones: [...new Set([...releasers, ...escalation])],
    onCallWithoutMobile: onCall.filter((u) => !normaliseNzPhone(u.phone)).map((u) => u.name),
    alertedWithoutAuthority: escalation.filter((p) => !releasers.has(p)),
    onCallCount: onCall.length,
  };
}

export async function smsP1HoldAlert(db: Db, body: string, key: string): Promise<number> {
  const { phones } = await p1HoldAlertRecipients(db);
  for (const phone of phones) await queueSms(db, { phone, template: 'p1_hold_sms', body, idempotencyKey: `${key}:${phone}` });
  return phones.length;
}

/** P1 jobs held at the unfunded threshold, with hold durations (reported separately from SLA performance). */
export async function p1HoldReport(db: Db, period: { from: string; to: string }, customerId?: string | null) {
  const jobs = await query(db,
    `SELECT j.id, j.ref, j.title, j.status, j.created_at, j.p1_held_at, j.p1_hold_released_at, j.p1_hold_release_kind, j.sla_onsite_met, j.sla_resolve_met,
            c.name AS customer_name, s.name AS site_name,
            ROUND(EXTRACT(EPOCH FROM (COALESCE(j.p1_hold_released_at, now()) - j.p1_held_at)) / 60)::int AS hold_minutes
       FROM jobs j JOIN customers c ON c.id = j.customer_id JOIN sites s ON s.id = j.site_id
      WHERE j.p1_held_at IS NOT NULL AND (j.created_at AT TIME ZONE 'Pacific/Auckland')::date BETWEEN $1::date AND $2::date
        AND ($3::uuid IS NULL OR j.customer_id = $3) ORDER BY j.created_at`, [period.from, period.to, customerId ?? null]);
  const released = jobs.filter((j) => j.p1_hold_released_at);
  return {
    jobs,
    count: jobs.length,
    stillHeld: jobs.filter((j) => !j.p1_hold_released_at).length,
    avgHoldMinutes: released.length ? Math.round(released.reduce((s, j) => s + j.hold_minutes, 0) / released.length) : null,
    maxHoldMinutes: jobs.length ? Math.max(...jobs.map((j) => j.hold_minutes)) : null,
  };
}
