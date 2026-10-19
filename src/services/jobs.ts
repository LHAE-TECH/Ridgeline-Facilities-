import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { SYSTEM_ACTOR, isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { formatNzd } from '../lib/money.js';
import { audit } from './audit.js';
import { assertCustomerAccess } from './customers.js';
import { dispatchJob } from './dispatch.js';
import { type JobStatus, lockJob, recordJobEvent, transitionJob } from './jobState.js';
import { accountPosition, type AccountPosition } from './ledger.js';
import { link, notifyContractor, notifyCustomer, notifyStaff } from './notifications.js';
import { type Priority, buildEstimateCostLines, loadApprovedRules, priceCostLines, type PricingResult } from './pricing.js';
import { getSettings, type Settings } from './settings.js';
import { TIME_WINDOW_LABELS, type TimeWindow, classifyTime, loadHolidays } from './timeWindows.js';

export const PRIORITIES: Priority[] = ['routine', 'urgent', 'emergency'];

export interface BookingInput {
  customerId: string;
  siteId: string;
  facilityId?: string | null;
  unitId?: string | null;
  tradeId: number;
  priority: Priority;
  title: string;
  description: string;
  accessInstructions?: string;
  siteContactName?: string;
  siteContactPhone?: string;
  preferredStart?: string | null;
  preferredEnd?: string | null;
  poNumber?: string;
  idempotencyKey?: string;
}

export interface Estimate {
  window: TimeWindow;
  windowLabel: string;
  hours: number;
  pricing: PricingResult;
  disclaimer: string;
}

export async function estimateJob(db: Db, input: Pick<BookingInput, 'customerId' | 'tradeId' | 'priority' | 'preferredStart'>): Promise<Estimate> {
  const trade = await maybeOne(db, 'SELECT * FROM trades WHERE id = $1 AND is_active', [input.tradeId]);
  if (!trade) throw new AppError('Select a valid job category');
  const settings = await getSettings(db);
  const holidays = await loadHolidays(db);
  const when = input.preferredStart ? new Date(input.preferredStart) : new Date();
  const window = input.priority === 'emergency' && !input.preferredStart ? classifyTime(new Date(), settings, holidays) : classifyTime(when, settings, holidays);
  const rules = await loadApprovedRules(db, input.customerId);
  const ctx = { customerId: input.customerId, tradeId: trade.id, tradeIsSpecialist: trade.is_specialist, priority: input.priority };
  const hours = Number(trade.default_estimate_hours);
  const lines = buildEstimateCostLines(rules, ctx, window, hours);
  const pricing = priceCostLines(lines, ctx, rules, settings);
  return {
    window, windowLabel: TIME_WINDOW_LABELS[window], hours, pricing,
    disclaimer: `ESTIMATE ONLY: based on a typical ${hours} hour ${trade.name.toLowerCase()} job during ${TIME_WINDOW_LABELS[window].toLowerCase()}. ` +
      'Final charges are based on the approved contractor cost for the work actually performed, priced under your agreed rates.',
  };
}

export interface FundingCheck {
  ok: boolean;
  emergencyOverride: boolean;
  reasons: string[];
  position: AccountPosition;
  requiredTopUpCents: number;
}

/** Applies the account's eligibility rules (minimum balance, available funds) to a proposed charge. */
export function evaluateFunding(position: AccountPosition, chargeCents: number, priority: Priority, settings: Settings): FundingCheck {
  const reasons: string[] = [];
  let requiredTopUp = 0;
  if (settings.booking_requires_minimum_balance && position.belowMinimum) {
    reasons.push(`Prepaid balance ${formatNzd(position.balanceCents)} is below the agreed minimum of ${formatNzd(position.minimumCents)}`);
    requiredTopUp = Math.max(requiredTopUp, position.shortfallToMinimumCents);
  }
  if (position.availableCents < chargeCents) {
    reasons.push(`Available balance ${formatNzd(position.availableCents)} does not cover the estimated charge of ${formatNzd(chargeCents)}`);
    requiredTopUp = Math.max(requiredTopUp, chargeCents - position.availableCents);
  }
  if (reasons.length === 0) return { ok: true, emergencyOverride: false, reasons, position, requiredTopUpCents: 0 };
  if (priority === 'emergency' && settings.allow_emergency_below_minimum) {
    return { ok: true, emergencyOverride: true, reasons, position, requiredTopUpCents: requiredTopUp };
  }
  return { ok: false, emergencyOverride: false, reasons, position, requiredTopUpCents: requiredTopUp };
}

function canBook(actor: Actor): boolean {
  return isStaff(actor) || (actor.role === 'customer' && actor.customerRole !== 'viewer');
}

/** True if the actor may approve a charge of this size on behalf of the customer. */
function canApproveCharge(actor: Actor, amountCents: number, customer: any): boolean {
  if (actor.role !== 'customer' || actor.customerId !== customer.id) return false;
  if (actor.customerRole === 'owner') return true;
  if (actor.customerRole === 'approver') return actor.approvalLimitCents == null || actor.approvalLimitCents >= amountCents;
  return false;
}

/**
 * Creates a job. The job is only released to dispatch when funding and authority rules pass; otherwise it is
 * held (pending_funds / awaiting_customer_approval) and the customer is told what is needed.
 * Idempotent per customer + idempotency key, so a double-submitted form creates one job.
 */
export async function createBooking(db: Db, actor: Actor, input: BookingInput) {
  assertCustomerAccess(actor, input.customerId);
  if (!canBook(actor)) throw new ForbiddenError('Your role cannot book jobs');
  if (!PRIORITIES.includes(input.priority)) throw new AppError('Invalid priority');
  if (!input.title?.trim() || !input.description?.trim()) throw new AppError('Describe the problem');
  if (input.preferredStart && input.preferredEnd && new Date(input.preferredEnd) <= new Date(input.preferredStart)) {
    throw new AppError('Preferred window end must be after its start');
  }

  const result = await tx(db, async (c) => {
    if (input.idempotencyKey) {
      const existing = await maybeOne(c, 'SELECT * FROM jobs WHERE customer_id = $1 AND idempotency_key = $2', [input.customerId, input.idempotencyKey]);
      if (existing) return { job: existing, created: false, funding: null as FundingCheck | null, estimate: null as Estimate | null };
    }
    const customer = await one(c, 'SELECT * FROM customers WHERE id = $1 FOR UPDATE', [input.customerId]);
    if (['suspended', 'closed'].includes(customer.status)) throw new AppError(`This account is ${customer.status}; bookings are not available`, 403);
    if (customer.status === 'pending_assessment' || customer.agreed_minimum_balance_cents === null) {
      throw new AppError('Your prepaid account must be assessed and agreed before booking jobs', 403, 'not_assessed');
    }
    if (customer.po_required && !input.poNumber?.trim()) throw new AppError('A purchase order number is required for this account');
    const site = await maybeOne(c, 'SELECT * FROM sites WHERE id = $1 AND customer_id = $2 AND is_active', [input.siteId, input.customerId]);
    if (!site) throw new AppError('Select one of your sites');
    if (input.facilityId) {
      const f = await maybeOne(c, 'SELECT id FROM facilities WHERE id = $1 AND customer_id = $2 AND site_id = $3', [input.facilityId, input.customerId, input.siteId]);
      if (!f) throw new AppError('Facility does not belong to the selected site');
    }
    if (input.unitId) {
      const u = await maybeOne(c, `SELECT u.id FROM units u JOIN facilities f ON f.id = u.facility_id WHERE u.id = $1 AND u.customer_id = $2 AND f.site_id = $3`,
        [input.unitId, input.customerId, input.siteId]);
      if (!u) throw new AppError('Unit does not belong to the selected site');
    }

    const settings = await getSettings(c);
    const estimate = await estimateJob(c, input);
    const estimateTotal = estimate.pricing.totalCents;
    const sla = settings.sla_hours[input.priority];

    const job = await one(c,
      `INSERT INTO jobs (customer_id, site_id, facility_id, unit_id, trade_id, priority, title, description, access_instructions,
          site_contact_name, site_contact_phone, preferred_start, preferred_end, po_number, status, estimate, estimate_total_cents,
          authorised_contractor_cost_cents, respond_by, attend_by, booked_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending_funds',$15,$16,$17,
               now() + ($18 || ' hours')::interval, now() + ($19 || ' hours')::interval, $20, $21) RETURNING *`,
      [input.customerId, input.siteId, input.facilityId || null, input.unitId || null, input.tradeId, input.priority, input.title.trim(),
       input.description.trim(), input.accessInstructions || site.access_notes || null, input.siteContactName || null, input.siteContactPhone || null,
       input.preferredStart || null, input.preferredEnd || null, input.poNumber || null, JSON.stringify(estimate), estimateTotal,
       estimate.pricing.contractorCostExGstCents, String(sla.respond), String(sla.attend), actor.id, input.idempotencyKey ?? null]);
    await recordJobEvent(c, actor, job.id, 'created', { to: 'pending_funds', note: `Estimated ${formatNzd(estimateTotal)} incl. GST` });

    let funding: FundingCheck | null = null;
    const needsApproval = estimateTotal > customer.authority_limit_cents && !canApproveCharge(actor, estimateTotal, customer);
    if (estimateTotal > customer.authority_limit_cents && !needsApproval) {
      await c.query('UPDATE jobs SET customer_approved_by = $2, customer_approved_at = now() WHERE id = $1', [job.id, actor.id]);
    }
    if (needsApproval) {
      await transitionJob(c, actor, job, 'awaiting_customer_approval', {
        note: `Estimate ${formatNzd(estimateTotal)} exceeds the authority limit of ${formatNzd(customer.authority_limit_cents)}`,
      });
      await notifyCustomer(c, input.customerId, {
        template: 'job_needs_approval', subject: `Approval needed: ${job.ref}`,
        body: `Job ${job.ref} (${job.title}) has an estimated charge of ${formatNzd(estimateTotal)}, above your authority limit. ` +
          `An authorised approver must approve it before dispatch.\n${link(`/app/jobs/${job.id}`)}`,
        idempotencyKey: `needs-approval:${job.id}`,
      });
    } else {
      funding = await releaseForDispatchIfFunded(c, actor, job, settings);
    }
    await notifyStaff(c, ['ops', 'admin'], {
      template: 'job_booked', subject: `New ${input.priority} job ${job.ref}`,
      body: `${customer.name} booked ${job.ref}: ${job.title} (status: ${job.status}).\n${link(`/admin/jobs/${job.id}`)}`,
      idempotencyKey: `booked:${job.id}`,
    });
    await audit(c, actor, { action: 'job.booked', entityType: 'job', entityId: job.id, customerId: input.customerId, details: { estimateTotal, status: job.status } });
    return { job, created: true, funding, estimate };
  });

  if (result.created && result.job.status === 'dispatch') await autoDispatch(db, result.job.id);
  const job = await one(db, 'SELECT * FROM jobs WHERE id = $1', [result.job.id]);
  return { ...result, job };
}

async function autoDispatch(db: Db, jobId: string) {
  const settings = await getSettings(db);
  if (settings.auto_dispatch) await dispatchJob(db, SYSTEM_ACTOR, jobId);
}

/**
 * Checks funding and, if it passes (or an exception applies), commits the estimated charge against the
 * customer's available balance and releases the job to dispatch. Caller holds the job lock.
 */
async function releaseForDispatchIfFunded(c: Db, actor: Actor, job: any, settings: Settings, exception?: { id: string }): Promise<FundingCheck> {
  await one(c, 'SELECT id FROM customers WHERE id = $1 FOR UPDATE', [job.customer_id]);
  const position = await accountPosition(c, job.customer_id);
  const funding = evaluateFunding(position, job.estimate_total_cents, job.priority, settings);
  if (!funding.ok && !exception) {
    if (job.status !== 'pending_funds') await transitionJob(c, actor, job, 'pending_funds', { note: funding.reasons.join('; ') });
    else await recordJobEvent(c, actor, job.id, 'funding.insufficient', { note: funding.reasons.join('; ') });
    await notifyCustomer(c, job.customer_id, {
      template: 'job_pending_funds', subject: `Top-up required to dispatch ${job.ref}`,
      body: `Job ${job.ref} is on hold: ${funding.reasons.join('; ')}.\nPlease top up at least ${formatNzd(funding.requiredTopUpCents)} to release it for dispatch.\n${link('/app/account')}`,
      idempotencyKey: `pending-funds:${job.id}`,
    });
    return funding;
  }
  await c.query(`INSERT INTO job_commitments (customer_id, job_id, amount_cents) VALUES ($1,$2,$3)`, [job.customer_id, job.id, job.estimate_total_cents]);
  const note = exception ? `Released under funding exception ${exception.id}`
    : funding.emergencyOverride ? `EMERGENCY released despite: ${funding.reasons.join('; ')}` : 'Funding check passed';
  await transitionJob(c, actor, job, 'dispatch', { note, set: exception ? { funding_exception_id: { value: exception.id } } : {} });
  if (funding.emergencyOverride) {
    await notifyStaff(c, ['finance', 'admin'], {
      template: 'emergency_underfunded', subject: `Emergency job ${job.ref} dispatched with insufficient funds`,
      body: `${job.ref} was released as an emergency although: ${funding.reasons.join('; ')}. Follow up the customer top-up.\n${link(`/admin/jobs/${job.id}`)}`,
      idempotencyKey: `emergency-underfunded:${job.id}`,
    });
  }
  return funding;
}

/** Customer approver approves a job whose estimate exceeds the agreed authority limit. */
export async function approveJobAsCustomer(db: Db, actor: Actor, jobId: string) {
  const out = await tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    assertCustomerAccess(actor, job.customer_id);
    if (job.status !== 'awaiting_customer_approval') throw new AppError('This job is not awaiting approval', 409);
    const customer = await one(c, 'SELECT * FROM customers WHERE id = $1', [job.customer_id]);
    if (!canApproveCharge(actor, job.estimate_total_cents, customer)) throw new ForbiddenError('Your approval limit does not cover this job');
    await c.query('UPDATE jobs SET customer_approved_by = $2, customer_approved_at = now() WHERE id = $1', [jobId, actor.id]);
    await recordJobEvent(c, actor, jobId, 'customer.approved', { note: `Approved estimate ${formatNzd(job.estimate_total_cents)}` });
    await releaseForDispatchIfFunded(c, actor, job, await getSettings(c));
    await audit(c, actor, { action: 'job.customer_approved', entityType: 'job', entityId: jobId, customerId: job.customer_id });
    return job.status as JobStatus;
  });
  if (out === 'dispatch') await autoDispatch(db, jobId);
}

/** An authorised Ridgeline user releases a held job despite insufficient funds. */
export async function grantFundingException(db: Db, actor: Actor, jobId: string, reason: string) {
  if (actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError('Only administrators or finance can authorise funding exceptions');
  if (!reason?.trim()) throw new AppError('A reason is required for a funding exception');
  await tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    if (job.status !== 'pending_funds') throw new AppError('Only jobs awaiting funds can be released by exception', 409);
    const ex = await one(c, `INSERT INTO funding_exceptions (customer_id, job_id, reason, max_cents, approved_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [job.customer_id, jobId, reason.trim(), job.estimate_total_cents, actor.id]);
    await releaseForDispatchIfFunded(c, actor, job, await getSettings(c), ex);
    await audit(c, actor, { action: 'job.funding_exception', entityType: 'job', entityId: jobId, customerId: job.customer_id, details: { reason } });
  });
  await autoDispatch(db, jobId);
}

/** After a top-up, re-checks held jobs (oldest first) and releases those now funded. */
export async function recheckPendingFunding(db: Db, customerId: string): Promise<string[]> {
  const pending = await query<{ id: string }>(db, `SELECT id FROM jobs WHERE customer_id = $1 AND status = 'pending_funds' ORDER BY created_at`, [customerId]);
  const released: string[] = [];
  for (const p of pending) {
    const status = await tx(db, async (c) => {
      const job = await lockJob(c, p.id);
      if (job.status !== 'pending_funds') return job.status;
      const settings = await getSettings(c);
      const position = await accountPosition(c, customerId);
      if (!evaluateFunding(position, job.estimate_total_cents, job.priority, settings).ok) return job.status;
      await releaseForDispatchIfFunded(c, SYSTEM_ACTOR, job, settings);
      return job.status;
    });
    if (status === 'dispatch') {
      released.push(p.id);
      await autoDispatch(db, p.id);
    }
  }
  return released;
}

const CANCELLABLE: JobStatus[] = ['pending_funds', 'awaiting_customer_approval', 'dispatch', 'offered', 'assigned', 'on_site'];

/**
 * Cancels a job. Cancellation after a contractor is assigned and either on site or within the late-cancellation
 * window is billable where the customer's agreement permits it; the contractor may then invoice a cancellation fee.
 */
export async function cancelJob(db: Db, actor: Actor, jobId: string, reason: string) {
  if (!reason?.trim()) throw new AppError('A cancellation reason is required');
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    assertCustomerAccess(actor, job.customer_id);
    if (actor.role === 'customer' && actor.customerRole === 'viewer') throw new ForbiddenError();
    if (!CANCELLABLE.includes(job.status)) throw new AppError('This job can no longer be cancelled; raise a dispute instead', 409);
    const customer = await one(c, 'SELECT * FROM customers WHERE id = $1', [job.customer_id]);
    const settings = await getSettings(c);
    let billable = false;
    if (job.assigned_contractor_id && customer.cancellation_fees_apply) {
      const lateMs = settings.late_cancellation_hours * 3600 * 1000;
      const target = job.preferred_start ? new Date(job.preferred_start) : job.attend_by ? new Date(job.attend_by) : null;
      billable = job.status === 'on_site' || (target !== null && target.getTime() - Date.now() <= lateMs);
    }
    await c.query(`UPDATE job_offers SET status = 'withdrawn', responded_at = now() WHERE job_id = $1 AND status = 'offered'`, [jobId]);
    await c.query(`UPDATE job_assignments SET status = 'ended', ended_at = now(), ended_reason = 'cancelled' WHERE job_id = $1 AND status = 'active'`, [jobId]);
    await c.query(`UPDATE job_commitments SET status = 'released', closed_at = now() WHERE job_id = $1 AND status = 'active'`, [jobId]);
    await transitionJob(c, actor, job, 'cancelled', {
      note: `${reason}${billable ? ' (late cancellation: cancellation charges may apply)' : ''}`,
      set: { cancelled_at: { sql: 'now()' }, cancellation_reason: { value: reason }, cancellation_billable: { value: billable } },
    });
    if (job.assigned_contractor_id) {
      await notifyContractor(c, job.assigned_contractor_id, {
        template: 'job_cancelled', subject: `Job ${job.ref} cancelled`,
        body: `Job ${job.ref} has been cancelled. ${billable ? 'This was a late cancellation; you may invoice your agreed cancellation fee.' : 'Please do not attend.'}`,
        idempotencyKey: `cancelled:${jobId}`,
      });
    }
    await notifyStaff(c, ['ops', 'admin'], { template: 'job_cancelled_staff', subject: `Job ${job.ref} cancelled`,
      body: `${job.ref} cancelled by ${actor.name}: ${reason}${billable ? ' (billable)' : ''}`, idempotencyKey: `cancelled-staff:${jobId}` });
    await audit(c, actor, { action: 'job.cancelled', entityType: 'job', entityId: jobId, customerId: job.customer_id, details: { reason, billable } });
    return { billable };
  });
}

export interface CloseCheck { canClose: boolean; outstanding: string[] }

/** The operational and financial checks that must all pass before a job is closed. */
export async function closeChecks(db: Db, jobId: string): Promise<CloseCheck> {
  const job = await maybeOne(db, 'SELECT * FROM jobs WHERE id = $1', [jobId]);
  if (!job) throw new NotFoundError('Job');
  const settings = await getSettings(db);
  const outstanding: string[] = [];
  if (job.status !== 'customer_invoiced') outstanding.push('Customer invoice has not been issued');
  const report = await maybeOne(db, `SELECT review_status FROM completion_reports WHERE job_id = $1 ORDER BY version DESC LIMIT 1`, [jobId]);
  if (!job.cancelled_at && report?.review_status !== 'approved') outstanding.push('Completion evidence not approved');
  const ci = await maybeOne(db, `SELECT * FROM contractor_invoices WHERE job_id = $1 AND status = 'approved'`, [jobId]);
  if (!ci) outstanding.push('Contractor invoice not approved');
  const inv = await maybeOne(db, `SELECT * FROM customer_invoices WHERE job_id = $1 AND status <> 'void'`, [jobId]);
  if (settings.close_requires_customer_settled && inv && !['paid'].includes(inv.status)) outstanding.push('Customer invoice not fully settled');
  const payable = ci ? await maybeOne(db, `SELECT status FROM contractor_payables WHERE contractor_invoice_id = $1`, [ci.id]) : null;
  if (settings.close_requires_contractor_paid && payable?.status !== 'paid') outstanding.push('Contractor payment not confirmed');
  const disputes = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM disputes WHERE job_id = $1 AND status IN ('open','investigating')`, [jobId]);
  if (disputes.n > 0) outstanding.push('Open dispute');
  return { canClose: outstanding.length === 0, outstanding };
}

export async function closeJob(db: Db, actor: Actor, jobId: string) {
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    const check = await closeChecks(c, jobId);
    if (!check.canClose) throw new AppError(`Job cannot be closed: ${check.outstanding.join('; ')}`, 409);
    await transitionJob(c, actor, job, 'closed', { set: { closed_at: { sql: 'now()' } } });
    await audit(c, actor, { action: 'job.closed', entityType: 'job', entityId: jobId, customerId: job.customer_id });
  });
}

/** Worker: closes every invoiced job whose checks now pass. */
export async function autoCloseJobs(db: Db): Promise<number> {
  const candidates = await query<{ id: string }>(db, `SELECT id FROM jobs WHERE status = 'customer_invoiced'`);
  let closed = 0;
  for (const j of candidates) {
    if ((await closeChecks(db, j.id)).canClose) {
      await closeJob(db, SYSTEM_ACTOR, j.id);
      closed++;
    }
  }
  return closed;
}

/** Jobs visible to the actor (data isolation is enforced here, not in the views). */
export async function getJobForActor(db: Db, actor: Actor, jobId: string) {
  const job = await maybeOne(db,
    `SELECT j.*, s.name AS site_name, s.address AS site_address, s.region AS site_region, s.hazards AS site_hazards, s.lat AS site_lat, s.lng AS site_lng,
            t.name AS trade_name, t.code AS trade_code, t.before_photo_required, c.name AS customer_name, c.acknowledgement_required,
            f.name AS facility_name, u.label AS unit_label, k.legal_name AS contractor_legal_name, k.trading_name AS contractor_trading_name
       FROM jobs j JOIN sites s ON s.id = j.site_id JOIN trades t ON t.id = j.trade_id JOIN customers c ON c.id = j.customer_id
       LEFT JOIN facilities f ON f.id = j.facility_id LEFT JOIN units u ON u.id = j.unit_id LEFT JOIN contractors k ON k.id = j.assigned_contractor_id
      WHERE j.id = $1`, [jobId]);
  if (!job) throw new NotFoundError('Job');
  if (isStaff(actor)) return job;
  if (actor.role === 'customer' && job.customer_id === actor.customerId) return job;
  if (actor.role === 'contractor') {
    if (job.assigned_contractor_id === actor.contractorId) return job;
    const offer = await maybeOne(db, `SELECT 1 FROM job_offers WHERE job_id = $1 AND contractor_id = $2 AND status = 'offered'`, [jobId, actor.contractorId]);
    if (offer) return job;
  }
  throw new NotFoundError('Job');
}

