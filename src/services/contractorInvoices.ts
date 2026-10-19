import type { Db } from '../db.js';
import { isUniqueViolation, maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { applyBps, formatNzd, formatQuantity, gstOn, qtyAmount } from '../lib/money.js';
import { audit } from './audit.js';
import { isMakeSafeOnly } from './p1Scope.js';
import { currentRateCard } from './contractors.js';
import { createCustomerInvoiceDraft, issueCustomerInvoice, supersededTermsHold } from './customerInvoices.js';
import { lockJob, transitionJob } from './jobState.js';
import { postJournal } from './ledger.js';
import { link, notifyContractor, notifyStaff } from './notifications.js';
import { createPayableForInvoice } from './payables.js';
import { type CostCategory, COST_CATEGORIES } from './pricing.js';
import { getSettings } from './settings.js';
import { TIME_WINDOWS, TIME_WINDOW_LABELS, type TimeWindow, loadHolidays, windowsDuring } from './timeWindows.js';
import { enqueueSync } from './xero.js';

export interface InvoiceLineInput {
  category: CostCategory;
  description: string;
  quantityMilli: number;
  unitRateCents: number;
  timeWindow?: TimeWindow;
  variationId?: string | null;
}

export interface ContractorInvoiceInput {
  jobId: string;
  invoiceNumber: string;
  invoiceDate: string;
  lines: InvoiceLineInput[];
  gstCents: number;
  totalCents: number;
  isTaxInvoice?: boolean;
  notes?: string;
  fileId?: string | null;
  idempotencyKey?: string;
}

export interface ValidationFlag { code: string; severity: 'warning' | 'blocking'; message: string }

const WINDOW_MULTIPLIER: Record<TimeWindow, string | null> = {
  standard: null, after_hours: 'after_hours_multiplier_bps', weekend: 'weekend_multiplier_bps',
  public_holiday: 'public_holiday_multiplier_bps', overnight: 'overnight_multiplier_bps',
};

/**
 * Checks a contractor invoice against the job, the agreed rate card, the authorised scope (estimate/quote plus
 * approved variations) and the completion evidence. Returns flags; 'blocking' flags prevent approval.
 */
export async function validateContractorInvoice(db: Db, invoiceId: string): Promise<ValidationFlag[]> {
  const inv = await one(db, 'SELECT * FROM contractor_invoices WHERE id = $1', [invoiceId]);
  const lines = await query(db, 'SELECT * FROM contractor_invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [invoiceId]);
  const job = await one(db, 'SELECT * FROM jobs WHERE id = $1', [inv.job_id]);
  const settings = await getSettings(db);
  const flags: ValidationFlag[] = [];
  const add = (code: string, message: string, severity: ValidationFlag['severity'] = 'warning') => flags.push({ code, severity, message });

  if (job.assigned_contractor_id !== inv.contractor_id) add('wrong_job', 'Job is not assigned to this contractor', 'blocking');
  const report = await maybeOne(db, 'SELECT * FROM completion_reports WHERE job_id = $1 ORDER BY version DESC LIMIT 1', [job.id]);
  if (!job.cancelled_at) {
    if (!report) add('no_evidence', 'No completion evidence has been submitted', 'blocking');
    else if (report.review_status !== 'approved') add('evidence_not_approved', 'Completion evidence has not been approved yet', 'blocking');
  }

  const card = await currentRateCard(db, inv.contractor_id, job.trade_id);
  if (!card) add('no_rate_card', 'No agreed rate card for this contractor and trade', 'blocking');

  const holidays = await loadHolidays(db);
  const windows = job.arrived_at && job.completed_at ? windowsDuring(new Date(job.arrived_at), new Date(job.completed_at), settings, holidays) : null;
  const receipts = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM job_evidence WHERE job_id = $1 AND kind = 'receipt' AND withdrawn_at IS NULL`, [job.id]);

  let labourHoursMilli = 0;
  let materialsTotal = 0;
  const variationTotals = new Map<string, number>();
  for (const l of lines) {
    const label = `Line ${l.line_no} (${l.description})`;
    if (l.category === 'labour') labourHoursMilli += l.quantity_milli;
    if (l.category === 'materials') materialsTotal += l.amount_cents;
    if (windows && ['labour', 'minimum_charge'].includes(l.category) && !windows.has(l.time_window)) {
      add('time_window_mismatch', `${label} is billed as ${TIME_WINDOW_LABELS[l.time_window as TimeWindow]} but attendance was during ${[...windows].map((w) => TIME_WINDOW_LABELS[w]).join(', ')}`);
    }
    if (card) {
      if (l.category === 'labour') {
        const col = WINDOW_MULTIPLIER[l.time_window as TimeWindow];
        const max = col ? applyBps(card.labour_rate_cents, card[col]) : card.labour_rate_cents;
        if (l.unit_rate_cents > max) add('rate_discrepancy', `${label}: rate ${formatNzd(l.unit_rate_cents)}/h exceeds agreed ${formatNzd(max)}/h for ${TIME_WINDOW_LABELS[l.time_window as TimeWindow]}`);
      }
      if (l.category === 'callout') {
        const max = job.priority === 'emergency' ? card.emergency_callout_cents : card.callout_cents;
        if (l.unit_rate_cents > max) add('rate_discrepancy', `${label}: callout ${formatNzd(l.unit_rate_cents)} exceeds agreed ${formatNzd(max)}${job.priority === 'emergency' ? ' (emergency)' : ''}`);
        if (l.quantity_milli > 1000) add('multiple_callouts', `${label}: more than one callout charged`);
      }
      if (l.category === 'travel' && l.unit_rate_cents > card.travel_per_km_cents) add('rate_discrepancy', `${label}: travel rate exceeds agreed ${formatNzd(card.travel_per_km_cents)}/km`);
      if (l.category === 'minimum_charge' && l.amount_cents > card.min_charge_cents) add('rate_discrepancy', `${label}: minimum charge exceeds agreed ${formatNzd(card.min_charge_cents)}`);
      if (l.category === 'cancellation' && l.amount_cents > card.cancellation_fee_cents) add('rate_discrepancy', `${label}: cancellation fee exceeds agreed ${formatNzd(card.cancellation_fee_cents)}`);
    }
    if (l.category === 'cancellation' && !job.cancellation_billable) add('unauthorised_cancellation_charge', `${label}: job was not a billable cancellation`, 'blocking');
    if (job.cancelled_at && !['cancellation', 'callout', 'travel'].includes(l.category)) add('charge_after_cancellation', `${label}: only cancellation, callout and travel charges apply to a cancelled job`);
    if (l.category === 'materials' && l.amount_cents > settings.materials_receipt_threshold_cents && receipts.n === 0) {
      add('missing_receipt', `${label}: materials over ${formatNzd(settings.materials_receipt_threshold_cents)} need a receipt uploaded to the job`);
    }
    if (l.category === 'variation') {
      if (!l.variation_id) add('unauthorised_variation', `${label}: variation charged without an approved variation`, 'blocking');
      else variationTotals.set(l.variation_id, (variationTotals.get(l.variation_id) ?? 0) + l.amount_cents);
    }
  }
  for (const [vid, total] of variationTotals) {
    const v = await maybeOne(db, `SELECT * FROM quotes WHERE id = $1 AND job_id = $2 AND kind = 'variation'`, [vid, job.id]);
    if (!v || v.status !== 'approved') add('unauthorised_variation', 'Variation charged has not been approved by the customer', 'blocking');
    else if (total > v.contractor_cost_cents) add('variation_exceeded', `Variation charges ${formatNzd(total)} exceed the approved ${formatNzd(v.contractor_cost_cents)}`);
  }
  if (report) {
    const reportedMilli = Math.round((report.labour_minutes * 1000) / 60);
    if (labourHoursMilli > reportedMilli * (1 + settings.labour_tolerance_bps / 10000)) {
      add('labour_exceeds_report', `Labour billed ${formatQuantity(labourHoursMilli)} h exceeds the ${formatQuantity(reportedMilli)} h recorded in the completion report`);
    }
    const reportMaterials = (report.materials as { quantityMilli: number; unitCostCents: number }[]).reduce((s, m) => s + qtyAmount(m.quantityMilli, m.unitCostCents), 0);
    const allowed = card ? applyBps(reportMaterials, 10000 + card.materials_margin_bps) : reportMaterials;
    if (materialsTotal > allowed) add('materials_exceed_report', `Materials billed ${formatNzd(materialsTotal)} exceed materials recorded in the completion report (${formatNzd(allowed)} incl. agreed margin)`);
    for (const f of report.review_flags ?? []) add(`evidence_${f.code}`, `Evidence flag: ${f.message}`);
  }
  if (isMakeSafeOnly(job) && job.authorised_contractor_cost_cents != null && inv.subtotal_ex_gst_cents > job.authorised_contractor_cost_cents) {
    add('beyond_make_safe_scope', `Invoice ${formatNzd(inv.subtotal_ex_gst_cents)} ex GST exceeds the make-safe authorisation of ${formatNzd(job.authorised_contractor_cost_cents)}. ` +
      'Work beyond make-safe needs customer approval or a staff override on the job first', 'blocking');
  }
  if (job.authorised_contractor_cost_cents != null && !job.cancelled_at) {
    const limit = applyBps(job.authorised_contractor_cost_cents, 10000 + settings.authorised_overrun_bps);
    if (inv.subtotal_ex_gst_cents > limit) {
      add('exceeds_authorised_amount', `Invoice ${formatNzd(inv.subtotal_ex_gst_cents)} ex GST exceeds the authorised ${formatNzd(job.authorised_contractor_cost_cents)} (+${settings.authorised_overrun_bps / 100}% tolerance = ${formatNzd(limit)})`);
    }
  }
  const similar = await maybeOne(db,
    `SELECT invoice_number FROM contractor_invoices WHERE contractor_id = $1 AND id <> $2 AND total_cents = $3 AND status <> 'rejected'
       AND invoice_date BETWEEN $4::date - 30 AND $4::date + 30 AND job_id <> $5 LIMIT 1`,
    [inv.contractor_id, inv.id, inv.total_cents, inv.invoice_date, inv.job_id]);
  if (similar) add('possible_duplicate', `Same total as invoice ${similar.invoice_number} within 30 days; check it is not a duplicate`);
  if (inv.gst_registered && !inv.is_tax_invoice && inv.total_cents > 100000) {
    add('tax_invoice_required', 'Supplies over $1,000 from a GST-registered supplier need full taxable supply information (tax invoice)');
  }
  return flags;
}

/** Contractor submits an invoice to Ridgeline (never to the customer). Arithmetic and GST errors are rejected outright. */
export async function submitContractorInvoice(db: Db, actor: Actor, input: ContractorInvoiceInput) {
  if (actor.role !== 'contractor' || !actor.contractorId) throw new ForbiddenError('Only contractors submit invoices');
  if (!input.invoiceNumber?.trim()) throw new AppError('Invoice number is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate ?? '')) throw new AppError('Invoice date is required');
  if (!input.lines?.length) throw new AppError('Add at least one invoice line');
  return tx(db, async (c) => {
    if (input.idempotencyKey) {
      const existing = await maybeOne(c, 'SELECT * FROM contractor_invoices WHERE idempotency_key = $1 AND contractor_id = $2', [input.idempotencyKey, actor.contractorId]);
      if (existing) return existing;
    }
    const job = await lockJob(c, input.jobId).catch(() => { throw new AppError('Unknown job reference'); });
    if (job.assigned_contractor_id !== actor.contractorId) throw new AppError('Incorrect job reference: this job is not assigned to you', 403, 'wrong_job');
    const dup = await maybeOne(c, 'SELECT id FROM contractor_invoices WHERE contractor_id = $1 AND lower(invoice_number) = lower($2)', [actor.contractorId, input.invoiceNumber.trim()]);
    if (dup) throw new AppError(`Invoice number ${input.invoiceNumber} has already been submitted`, 409, 'duplicate_invoice');
    const live = await maybeOne(c, `SELECT invoice_number FROM contractor_invoices WHERE job_id = $1 AND status IN ('submitted','flagged','approved')`, [job.id]);
    if (live) throw new AppError(`Invoice ${live.invoice_number} has already been submitted for this job`, 409, 'duplicate_invoice');
    const billableCancel = job.status === 'cancelled' && job.cancellation_billable;
    if (!['evidence_submitted', 'evidence_approved'].includes(job.status) && !billableCancel) {
      throw new AppError('Submit your completion evidence before invoicing this job', 409);
    }
    const contractor = await one(c, 'SELECT * FROM contractors WHERE id = $1', [actor.contractorId]);

    let subtotal = 0;
    const lines = input.lines.map((l, i) => {
      if (!COST_CATEGORIES.includes(l.category)) throw new AppError(`Line ${i + 1}: invalid category`);
      if (!l.description?.trim()) throw new AppError(`Line ${i + 1}: description is required`);
      if (!(l.quantityMilli > 0) || !(l.unitRateCents >= 0)) throw new AppError(`Line ${i + 1}: quantity and rate are required`);
      const tw = l.timeWindow ?? 'standard';
      if (!TIME_WINDOWS.includes(tw)) throw new AppError(`Line ${i + 1}: invalid time window`);
      const amount = qtyAmount(l.quantityMilli, l.unitRateCents);
      subtotal += amount;
      return { ...l, timeWindow: tw, amount };
    });
    if (!contractor.gst_registered && input.gstCents !== 0) throw new AppError('You are not GST-registered with Ridgeline, so GST cannot be charged. Update your GST details first.');
    if (contractor.gst_registered) {
      const expected = gstOn(subtotal, (await getSettings(c)).gst_rate_bps);
      if (Math.abs(input.gstCents - expected) > 1) throw new AppError(`GST should be ${formatNzd(expected)} on ${formatNzd(subtotal)} (15%)`);
    }
    if (input.totalCents !== subtotal + input.gstCents) throw new AppError(`Invoice total should be ${formatNzd(subtotal + input.gstCents)} (lines ${formatNzd(subtotal)} + GST ${formatNzd(input.gstCents)})`);


    let inv;
    try {
      inv = await one(c,
        `INSERT INTO contractor_invoices (contractor_id, job_id, invoice_number, invoice_date, subtotal_ex_gst_cents, gst_cents, total_cents, gst_registered,
            contractor_gst_number, contractor_legal_name, contractor_nzbn, payment_terms_days, is_tax_invoice, file_id, notes, submitted_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [actor.contractorId, job.id, input.invoiceNumber.trim(), input.invoiceDate, subtotal, input.gstCents, input.totalCents, contractor.gst_registered,
         contractor.gst_number, contractor.legal_name, contractor.nzbn, contractor.payment_terms_days, input.isTaxInvoice ?? contractor.gst_registered,
         input.fileId ?? null, input.notes || null, actor.id, input.idempotencyKey ?? null]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('This invoice is a duplicate', 409, 'duplicate_invoice');
      throw err;
    }
    for (const [i, l] of lines.entries()) {
      await c.query(
        `INSERT INTO contractor_invoice_lines (invoice_id, line_no, category, description, quantity_milli, unit_rate_cents, amount_cents, time_window, variation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [inv.id, i + 1, l.category, l.description.trim(), l.quantityMilli, l.unitRateCents, l.amount, l.timeWindow, l.variationId || null]);
    }
    const flags = await validateContractorInvoice(c, inv.id);
    const status = flags.length ? 'flagged' : 'submitted';
    inv = await one(c, 'UPDATE contractor_invoices SET status = $2, validation = $3 WHERE id = $1 RETURNING *', [inv.id, status, JSON.stringify({ flags, checkedAt: new Date() })]);
    if (job.status === 'evidence_approved' || billableCancel) {
      await transitionJob(c, actor, job, 'invoice_submitted', { note: `Contractor invoice ${inv.invoice_number} submitted` });
    }
    await notifyStaff(c, ['finance', 'admin'], { template: 'contractor_invoice_submitted', subject: `Contractor invoice ${inv.invoice_number} for ${job.ref}`,
      body: `${contractor.legal_name} submitted invoice ${inv.invoice_number} (${formatNzd(inv.total_cents)}) for ${job.ref}.` +
        `${flags.length ? `\n${flags.length} validation flag(s): ${flags.map((f) => f.message).join('; ')}` : ''}\n${link(`/admin/contractor-invoices/${inv.id}`)}`,
      idempotencyKey: `ci-submitted:${inv.id}` });
    await audit(c, actor, { action: 'contractor_invoice.submitted', entityType: 'contractor_invoice', entityId: inv.id, contractorId: actor.contractorId,
      customerId: job.customer_id, details: { total: inv.total_cents, flags: flags.map((f) => f.code) } });
    return inv;
  });
}

/**
 * Approves a contractor invoice: creates the payable (contractor ledger), posts cost + GST input, and generates the
 * customer invoice draft from Ridgeline's own pricing rules. Warning flags require a recorded override reason.
 */
export async function approveContractorInvoice(db: Db, actor: Actor, invoiceId: string, overrideReason?: string) {
  if (actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError('Only finance or administrators can approve contractor invoices');
  const result = await tx(db, async (c) => {
    const inv = await maybeOne(c, 'SELECT * FROM contractor_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    if (!inv) throw new NotFoundError('Contractor invoice');
    if (!['submitted', 'flagged'].includes(inv.status)) throw new AppError(`Invoice is already ${inv.status}`, 409);
    const job = await lockJob(c, inv.job_id);
    const flags = await validateContractorInvoice(c, invoiceId);
    const blocking = flags.filter((f) => f.severity === 'blocking');
    if (blocking.length) throw new AppError(`Cannot approve: ${blocking.map((f) => f.message).join('; ')}`, 409, 'blocking_flags');
    if (flags.length && !overrideReason?.trim()) {
      throw new AppError(`This invoice has ${flags.length} validation flag(s). Record the reason for approving despite them.`, 409, 'override_required');
    }
    if (job.status !== 'invoice_submitted') throw new AppError('Job is not awaiting invoice approval (check evidence has been approved)', 409);

    await c.query(`UPDATE contractor_invoices SET status = 'approved', reviewed_by = $2, approved_at = now(), override_reason = $3, validation = $4 WHERE id = $1`,
      [invoiceId, actor.id, overrideReason || null, JSON.stringify({ flags, checkedAt: new Date() })]);
    await postJournal(c, actor, {
      description: `Contractor invoice ${inv.invoice_number} (${inv.contractor_legal_name}) for job ${job.ref}`,
      sourceType: 'contractor_invoice', sourceId: invoiceId, idempotencyKey: `contractor-invoice:${invoiceId}`,
      lines: [
        { account: 'CONTRACTOR_COSTS', debit: inv.subtotal_ex_gst_cents, contractorId: inv.contractor_id, jobId: job.id },
        { account: 'GST_INPUT', debit: inv.gst_cents, contractorId: inv.contractor_id, jobId: job.id },
        { account: 'CONTRACTOR_PAYABLE', credit: inv.total_cents, contractorId: inv.contractor_id, jobId: job.id },
      ],
    });
    await createPayableForInvoice(c, actor, invoiceId);
    const draft = await createCustomerInvoiceDraft(c, actor, invoiceId);
    await transitionJob(c, actor, job, 'invoice_approved', { note: `Contractor invoice ${inv.invoice_number} approved` });
    await enqueueSync(c, 'contractor_invoice', invoiceId);
    await notifyContractor(c, inv.contractor_id, { template: 'contractor_invoice_approved', subject: `Invoice ${inv.invoice_number} approved`,
      body: `Your invoice ${inv.invoice_number} for ${job.ref} (${formatNzd(inv.total_cents)}) has been approved and queued for payment under your agreed terms.`,
      idempotencyKey: `ci-approved:${invoiceId}` });
    await audit(c, actor, { action: 'contractor_invoice.approved', entityType: 'contractor_invoice', entityId: invoiceId, contractorId: inv.contractor_id,
      customerId: job.customer_id, details: { overrideReason, flags: flags.map((f) => f.code) } });
    return { draftId: draft.id as string };
  });
  const settings = await getSettings(db);
  if (settings.auto_issue_customer_invoices) {
    const job = await one(db, 'SELECT j.* FROM jobs j JOIN contractor_invoices ci ON ci.job_id = j.id WHERE ci.id = $1', [invoiceId]);
    const held = await supersededTermsHold(db, job);
    if (held) {
      // Never auto-issue: leave the draft held for finance to review.
      await notifyStaff(db, ['finance', 'admin'], { template: 'invoice_held_superseded_terms', subject: `Invoice held for review: ${job.ref}`,
        body: `The customer invoice for ${job.ref} was not issued automatically because ${held}\n${link(`/admin/customer-invoices/${result.draftId}`)}`,
        idempotencyKey: `invoice-held:${result.draftId}` });
    } else {
      await issueCustomerInvoice(db, actor, result.draftId);
    }
  }
  return result;
}

export async function rejectContractorInvoice(db: Db, actor: Actor, invoiceId: string, reason: string) {
  if (actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError();
  if (!reason?.trim()) throw new AppError('A reason is required');
  return tx(db, async (c) => {
    const inv = await maybeOne(c, 'SELECT * FROM contractor_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    if (!inv) throw new NotFoundError('Contractor invoice');
    if (!['submitted', 'flagged'].includes(inv.status)) throw new AppError(`Invoice is already ${inv.status}`, 409);
    const job = await lockJob(c, inv.job_id);
    await c.query(`UPDATE contractor_invoices SET status = 'rejected', rejection_reason = $2, reviewed_by = $3 WHERE id = $1`, [invoiceId, reason, actor.id]);
    if (job.status === 'invoice_submitted') {
      await transitionJob(c, actor, job, job.cancelled_at ? 'cancelled' : 'evidence_approved', { note: `Contractor invoice ${inv.invoice_number} rejected: ${reason}` });
    }
    await notifyContractor(c, inv.contractor_id, { template: 'contractor_invoice_rejected', subject: `Invoice ${inv.invoice_number} rejected`,
      body: `Your invoice ${inv.invoice_number} for ${job.ref} was rejected: ${reason}\nPlease submit a corrected invoice with a new invoice number.\n${link(`/c/jobs/${job.id}`)}`,
      idempotencyKey: `ci-rejected:${invoiceId}` });
    await audit(c, actor, { action: 'contractor_invoice.rejected', entityType: 'contractor_invoice', entityId: invoiceId, contractorId: inv.contractor_id, details: { reason } });
  });
}

export async function getContractorInvoiceForActor(db: Db, actor: Actor, invoiceId: string) {
  const inv = await maybeOne(db,
    `SELECT ci.*, j.ref AS job_ref, j.title AS job_title, j.customer_id, c.name AS customer_name
       FROM contractor_invoices ci JOIN jobs j ON j.id = ci.job_id JOIN customers c ON c.id = j.customer_id WHERE ci.id = $1`, [invoiceId]);
  if (!inv) throw new NotFoundError('Contractor invoice');
  if (!isStaff(actor) && !(actor.role === 'contractor' && actor.contractorId === inv.contractor_id)) throw new NotFoundError('Contractor invoice');
  const lines = await query(db, 'SELECT * FROM contractor_invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [invoiceId]);
  return { invoice: inv, lines };
}
