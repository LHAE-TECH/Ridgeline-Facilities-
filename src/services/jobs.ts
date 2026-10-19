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
import { makeSafeScope, type MakeSafeScope, notifyMakeSafeDispatch, unfundedPosition } from './p1Scope.js';
import { classifyPriority, isEscalatedAboveTriage, priorityLabel, reclassifyPriority, refreshSiteArea, smsEscalationPhones, startSlaClock, type TriageAnswers } from './sla.js';
import { TIME_WINDOW_LABELS, type TimeWindow, classifyTime, loadHolidays } from './timeWindows.js';

export const PRIORITIES: Priority[] = ['emergency', 'urgent', 'standard', 'scheduled'];

export interface BookingInput {
  customerId: string;
  siteId: string;
  facilityId?: string | null;
  unitId?: string | null;
  tradeId: number;
  /** Priority chosen by the booker. If omitted, the triage classification is used. */
  priority?: Priority | null;
  /** Intake triage answers; the classification can only raise, never lower, the chosen priority for safety. */
  triage?: TriageAnswers;
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

export async function estimateJob(db: Db, input: Pick<BookingInput, 'customerId' | 'tradeId' | 'preferredStart'> & { priority: Priority }): Promise<Estimate> {
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
  // Nothing holds a P1: emergencies are always released and finance follows up the shortfall.
  if (priority === 'emergency') {
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
/**
 * Resolves the job priority from the booker's choice and the intake triage. A triage result that is more urgent
 * than the choice wins (a reported safety risk is never booked below P1). A choice more urgent than the triage is
 * kept but flagged for operations to review.
 */
export function resolvePriority(chosen: Priority | null | undefined, triage: TriageAnswers | undefined): { priority: Priority; suggested: Priority | null; note: string | null } {
  if (chosen && !PRIORITIES.includes(chosen)) throw new AppError('Invalid priority');
  if (!triage) {
    if (!chosen) throw new AppError('Select a priority');
    return { priority: chosen, suggested: null, note: null };
  }
  const suggested = classifyPriority(triage);
  if (!chosen) return { priority: suggested, suggested, note: null };
  if (isEscalatedAboveTriage(suggested, chosen)) {
    return { priority: suggested, suggested, note: `Raised from ${priorityLabel(chosen)} to ${priorityLabel(suggested)} by intake triage` };
  }
  if (isEscalatedAboveTriage(chosen, suggested)) {
    return { priority: chosen, suggested, note: `Booker chose ${priorityLabel(chosen)}; triage suggested ${priorityLabel(suggested)}. Review classification.` };
  }
  return { priority: chosen, suggested, note: null };
}

export async function createBooking(db: Db, actor: Actor, rawInput: BookingInput) {
  assertCustomerAccess(actor, rawInput.customerId);
  if (!canBook(actor)) throw new ForbiddenError('Your role cannot book jobs');
  const resolved = resolvePriority(rawInput.priority, rawInput.triage);
  const input = { ...rawInput, priority: resolved.priority };
  if (input.priority === 'scheduled' && !input.preferredStart) throw new AppError('Scheduled (P4) jobs need an agreed attendance date');
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
    const settingsForArea = await getSettings(c);
    const area = await refreshSiteArea(c, site.id, settingsForArea);
    if (area.source === 'unconfirmed') {
      await notifyStaff(c, ['ops', 'admin'], {
        template: 'site_area_unconfirmed', subject: `Confirm SLA area: ${site.name} (${site.suburb || 'no suburb'})`,
        body: `${site.address}, ${site.suburb || ''} is not in any SLA area. Pin it to an area or add the suburb to Settings → sla_areas.\n${link(`/admin/customers/${input.customerId}`)}`,
        idempotencyKey: `site-area-unconfirmed:${site.id}`,
      });
      if (input.priority !== 'emergency' || !settingsForArea.unconfirmed_area_allows_p1) {
        throw new AppError(`Ridgeline needs to confirm the service area for ${site.name} before jobs can be booked there. We have been notified; ` +
          'for an emergency, call us now.', 409, 'area_unconfirmed');
      }
    }
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

    const job = await one(c,
      `INSERT INTO jobs (customer_id, site_id, facility_id, unit_id, trade_id, priority, title, description, access_instructions,
          site_contact_name, site_contact_phone, preferred_start, preferred_end, po_number, status, estimate, estimate_total_cents,
          authorised_contractor_cost_cents, booked_by, idempotency_key, triage, suggested_priority, priority_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending_funds',$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [input.customerId, input.siteId, input.facilityId || null, input.unitId || null, input.tradeId, input.priority, input.title.trim(),
       input.description.trim(), input.accessInstructions || site.access_notes || null, input.siteContactName || null, input.siteContactPhone || null,
       input.preferredStart || null, input.preferredEnd || null, input.poNumber || null, JSON.stringify(estimate), estimateTotal,
       estimate.pricing.contractorCostExGstCents, actor.id, input.idempotencyKey ?? null, input.triage ? JSON.stringify(input.triage) : null,
       resolved.suggested, resolved.note]);
    await recordJobEvent(c, actor, job.id, 'created', { to: 'pending_funds',
      note: `${priorityLabel(input.priority)} · estimated ${formatNzd(estimateTotal)} incl. GST${resolved.note ? ` · ${resolved.note}` : ''}` });
    // A P1 clock runs from the moment of booking, so any delay before release counts against the target.
    if (input.priority === 'emergency') await recordSlaStart(c, actor, job);

    let funding: FundingCheck | null = null;
    const overAuthority = estimateTotal > customer.authority_limit_cents;
    const needsApproval = overAuthority && !canApproveCharge(actor, estimateTotal, customer);
    if (overAuthority && !needsApproval) {
      await c.query('UPDATE jobs SET customer_approved_by = $2, customer_approved_at = now() WHERE id = $1', [job.id, actor.id]);
    }
    if (needsApproval && input.priority === 'emergency') {
      // Nothing delays a P1: it is dispatched now for make-safe scope only (see releaseForDispatchIfFunded).
      funding = await releaseForDispatchIfFunded(c, actor, job, settings);
    } else if (needsApproval) {
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
      template: 'job_booked', subject: `New ${priorityLabel(input.priority)} job ${job.ref}${resolved.note ? ' (check priority)' : ''}`,
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

async function recordSlaStart(c: Db, actor: Actor, job: any) {
  const sla = await startSlaClock(c, job);
  if (!sla) return;
  const from = job.priority === 'emergency' ? 'from booking' : 'from release';
  await recordJobEvent(c, actor, job.id, 'sla.started', {
    note: `${priorityLabel(job.priority)} clock ${from}: ${sla.onsiteLabel} (due ${sla.onsiteDue.toISOString()}); ${sla.resolveLabel} (due ${sla.resolveDue.toISOString()})`,
  });
}

/**
 * Staff reclassification. Raising a held job (awaiting funds or approval) to P1 releases it immediately, because
 * nothing holds an emergency.
 */
export async function reclassifyJob(db: Db, actor: Actor, jobId: string, priority: Priority, reason: string) {
  await reclassifyPriority(db, actor, jobId, priority, reason);
  if (priority !== 'emergency') return;
  const status = await tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    if (!['pending_funds', 'awaiting_customer_approval'].includes(job.status)) return job.status;
    await releaseForDispatchIfFunded(c, actor, job, await getSettings(c));
    return (await one(c, 'SELECT status FROM jobs WHERE id = $1', [jobId])).status;
  });
  if (status === 'dispatch') await autoDispatch(db, jobId);
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
  const customer = await one(c, 'SELECT * FROM customers WHERE id = $1 FOR UPDATE', [job.customer_id]);
  const fresh = await one(c, 'SELECT * FROM jobs WHERE id = $1', [job.id]);
  const position = await accountPosition(c, job.customer_id);
  const funding = evaluateFunding(position, job.estimate_total_cents, job.priority, settings);
  const shortfall = funding.reasons.length > 0;

  // P1: response is never limited, scope is. Unfunded or over-authority emergencies are authorised for make-safe only.
  let scope: MakeSafeScope | null = null;
  if (job.priority === 'emergency' && !fresh.scope_extended_at) {
    const overAuthority = job.estimate_total_cents > customer.authority_limit_cents && !fresh.customer_approved_by;
    if (shortfall || overAuthority) {
      scope = makeSafeScope(fresh, customer, settings, shortfall && overAuthority ? 'unfunded_over_authority' : shortfall ? 'unfunded' : 'over_authority');
    }
    if (shortfall && !exception) {
      const unfunded = await unfundedPosition(c, job.customer_id, settings);
      if (unfunded.suspended) return holdSuspendedP1(c, actor, job, funding, unfunded.totalCents, unfunded.thresholdCents);
    }
  }

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
  const commitCents = scope ? scope.commitCents : job.estimate_total_cents;
  // The part of this commitment not covered by available prepaid funds is unfunded exposure.
  const unfundedCents = scope && shortfall ? Math.max(0, commitCents - Math.max(0, position.availableCents)) : 0;
  await c.query(`INSERT INTO job_commitments (customer_id, job_id, amount_cents) VALUES ($1,$2,$3)`, [job.customer_id, job.id, commitCents]);
  const note = exception ? `Released under funding exception ${exception.id}`
    : scope ? `EMERGENCY released for make-safe only (up to ${formatNzd(scope.capExGstCents)} ex GST)${shortfall ? ` despite: ${funding.reasons.join('; ')}` : ''}`
    : 'Funding check passed';
  await transitionJob(c, actor, job, 'dispatch', { note, set: {
    released_at: { sql: 'COALESCE(released_at, now())' },
    ...(exception ? { funding_exception_id: { value: exception.id } } : {}),
    ...(scope ? {
      p1_scope: { value: 'make_safe' }, p1_scope_reason: { value: scope.reason }, p1_scope_cap_ex_gst_cents: { value: scope.capExGstCents },
      authorised_contractor_cost_cents: { value: scope.authorisedContractorCostCents }, unfunded_cents: { value: unfundedCents },
    } : {}),
  } });
  // P2–P4 clocks start at release; a P1 clock has been running since booking.
  const released = await one(c, 'SELECT * FROM jobs WHERE id = $1', [job.id]);
  if (job.priority !== 'emergency' || !released.sla_started_at) await recordSlaStart(c, actor, released);
  if (scope) {
    await recordJobEvent(c, actor, job.id, 'p1.make_safe_scope', {
      note: `Make-safe scope only (${scope.reason.replace(/_/g, ' ')}): up to ${formatNzd(scope.capExGstCents)} ex GST; contractor cost authorised ${formatNzd(scope.authorisedContractorCostCents)} ex GST; unfunded ${formatNzd(unfundedCents)}`,
    });
    await notifyMakeSafeDispatch(c, released, scope, shortfall ? `Please top up your account: ${funding.reasons.join('; ')}.` : '');
  }
  if (shortfall && job.priority === 'emergency') {
    await notifyStaff(c, ['finance', 'admin'], {
      template: 'emergency_underfunded', subject: `Emergency job ${job.ref} dispatched with insufficient funds (make-safe only)`,
      body: `${job.ref} was released as an emergency for make-safe work only (cap ${formatNzd(scope?.capExGstCents ?? 0)} ex GST, unfunded ${formatNzd(unfundedCents)}) although: ${funding.reasons.join('; ')}. Follow up the customer top-up.\n${link(`/admin/jobs/${job.id}`)}`,
      idempotencyKey: `emergency-underfunded:${job.id}`,
    });
  }
  return funding;
}

/**
 * The customer's unfunded balance has reached its threshold: this P1 is not dispatched automatically. The clock is
 * already running from booking, so staff are alerted at once (email and SMS) to decide on a funding exception.
 */
async function holdSuspendedP1(c: Db, actor: Actor, job: any, funding: FundingCheck, unfundedCents: number, thresholdCents: number): Promise<FundingCheck> {
  const why = `Automatic unfunded P1 dispatch suspended: unfunded balance ${formatNzd(unfundedCents)} has reached the ${formatNzd(thresholdCents)} threshold`;
  if (job.status !== 'pending_funds') await transitionJob(c, actor, job, 'pending_funds', { note: why });
  await recordJobEvent(c, actor, job.id, 'p1.unfunded_suspended', { note: `${why}. ${funding.reasons.join('; ')}` });
  await notifyStaff(c, ['ops', 'finance', 'admin'], {
    template: 'p1_unfunded_suspended', subject: `URGENT: P1 ${job.ref} held (unfunded threshold reached)`,
    body: `${why}. The P1 clock is running from booking. Release it with a funding exception (make-safe scope) or contact the customer now.\n${link(`/admin/jobs/${job.id}`)}`,
    idempotencyKey: `p1-suspended:${job.id}`,
  });
  await smsEscalationPhones(c, `URGENT P1 ${job.ref} HELD: customer unfunded balance over threshold. Decide funding exception now. ${link(`/admin/jobs/${job.id}`)}`, `p1-suspended-sms:${job.id}`);
  await notifyCustomer(c, job.customer_id, {
    template: 'p1_unfunded_suspended_customer', subject: `Emergency ${job.ref}: payment needed to dispatch`,
    body: `We cannot dispatch emergency job ${job.ref} automatically because your account has ${formatNzd(unfundedCents)} outstanding without prepaid cover. ` +
      `Our team has been alerted and will contact you. Topping up your account releases the job: ${link('/app/account')}`,
    idempotencyKey: `p1-suspended-customer:${job.id}`,
  });
  return { ...funding, ok: false, emergencyOverride: false };
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
    `SELECT j.*, s.name AS site_name, s.address AS site_address, s.region AS site_region, s.suburb AS site_suburb, s.city AS site_city, s.sla_area_override AS site_sla_area_override, s.hazards AS site_hazards, s.lat AS site_lat, s.lng AS site_lng,
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

