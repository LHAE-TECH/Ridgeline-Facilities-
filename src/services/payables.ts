import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { formatNzd, gstComponentOfInclusive, parseDollars } from '../lib/money.js';
import { audit } from './audit.js';
import { outstandingCents } from './customerInvoices.js';
import { postJournal } from './ledger.js';
import { notifyContractor, notifyStaff } from './notifications.js';
import { getSettings } from './settings.js';
import { enqueueSync } from './xero.js';

function assertFinance(actor: Actor): void {
  if (actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError('Only finance or administrators can manage contractor payments');
}

/** Supplier documentation requirements that must be met before a payable can be approved for payment. */
async function documentationIssues(db: Db, inv: any): Promise<string[]> {
  const settings = await getSettings(db);
  const issues: string[] = [];
  if (inv.gst_registered && !inv.contractor_gst_number) issues.push('GST-registered supplier has no GST number on file');
  if (inv.gst_registered && inv.total_cents > 100000 && !inv.is_tax_invoice) issues.push('Taxable supply information (tax invoice) required for supplies over $1,000');
  if (settings.require_contractor_invoice_document && !inv.file_id) issues.push('Supplier invoice document has not been uploaded');
  const contractor = await one(db, 'SELECT bank_account_number FROM contractors WHERE id = $1', [inv.contractor_id]);
  if (!contractor.bank_account_number) issues.push('Contractor bank account details missing');
  return issues;
}

/** Called when a contractor invoice is approved. Payment terms come from the contractor's agreement, not the customer's. */
export async function createPayableForInvoice(db: Db, actor: Actor, contractorInvoiceId: string) {
  const inv = await one(db, 'SELECT * FROM contractor_invoices WHERE id = $1', [contractorInvoiceId]);
  const issues = await documentationIssues(db, inv);
  const payable = await one(db,
    `INSERT INTO contractor_payables (contractor_id, contractor_invoice_id, job_id, invoice_total_cents, due_date, documentation_ok)
     VALUES ($1,$2,$3,$4, $5::date + $6::int, $7)
     ON CONFLICT (contractor_invoice_id) DO UPDATE SET contractor_invoice_id = EXCLUDED.contractor_invoice_id RETURNING *`,
    [inv.contractor_id, inv.id, inv.job_id, inv.total_cents, inv.invoice_date, inv.payment_terms_days, issues.length === 0]);
  await audit(db, actor, { action: 'payable.created', entityType: 'contractor_payable', entityId: payable.id, contractorId: inv.contractor_id, details: { issues } });
  return payable;
}

export async function payableWithContext(db: Db, payableId: string) {
  const p = await maybeOne(db,
    `SELECT p.*, ci.invoice_number, ci.invoice_date, ci.reviewed_by AS invoice_approved_by, ci.gst_registered, ci.contractor_gst_number, ci.is_tax_invoice,
            ci.file_id, ci.total_cents, j.ref AS job_ref, k.legal_name, k.bank_account_name, k.bank_account_number
       FROM contractor_payables p JOIN contractor_invoices ci ON ci.id = p.contractor_invoice_id JOIN jobs j ON j.id = p.job_id
       JOIN contractors k ON k.id = p.contractor_id WHERE p.id = $1`, [payableId]);
  if (!p) throw new NotFoundError('Payable');
  return p;
}

export function payableAmount(p: { invoice_total_cents: number; adjustments_cents: number }): number {
  return p.invoice_total_cents + p.adjustments_cents;
}

/** Warns when a contractor payment falls due before the matching customer funds have been received. */
export async function workingCapitalWarning(db: Db, payable: { job_id: string; due_date: string }): Promise<string | null> {
  const inv = await maybeOne(db, `SELECT * FROM customer_invoices WHERE job_id = $1 AND status <> 'void'`, [payable.job_id]);
  if (!inv) return 'Customer invoice not yet issued: customer funds not yet secured for this job';
  if (inv.status === 'draft') return 'Customer invoice is still a draft';
  const outstanding = outstandingCents(inv);
  if (outstanding > 0 && (!inv.due_date || inv.due_date > payable.due_date)) {
    return `Contractor due ${payable.due_date} before customer invoice ${inv.invoice_number} (${formatNzd(outstanding)} outstanding, due ${inv.due_date})`;
  }
  if (outstanding > 0) return `Customer invoice ${inv.invoice_number} still has ${formatNzd(outstanding)} outstanding`;
  return null;
}

export async function markDocumentationVerified(db: Db, actor: Actor, payableId: string, note: string) {
  assertFinance(actor);
  if (!note?.trim()) throw new AppError('Record what documentation was verified');
  await db.query('UPDATE contractor_payables SET documentation_ok = true WHERE id = $1', [payableId]);
  await audit(db, actor, { action: 'payable.documentation_verified', entityType: 'contractor_payable', entityId: payableId, details: { note } });
}

/** Routes the payable into the payment queue after a separate approval. */
export async function approveForPayment(db: Db, actor: Actor, payableId: string) {
  assertFinance(actor);
  return tx(db, async (c) => {
    const p = await maybeOne(c, 'SELECT * FROM contractor_payables WHERE id = $1 FOR UPDATE', [payableId]);
    if (!p) throw new NotFoundError('Payable');
    if (p.status !== 'awaiting_payment_approval') throw new AppError(`Payable is ${p.status}`, 409);
    const ctx = await payableWithContext(c, payableId);
    const issues = await documentationIssues(c, ctx);
    if (!p.documentation_ok && issues.length) throw new AppError(`Supplier documentation incomplete: ${issues.join('; ')}`, 409);
    const pendingAdj = await one<{ n: number }>(c, `SELECT COUNT(*)::int AS n FROM payable_adjustments WHERE payable_id = $1 AND status = 'proposed'`, [payableId]);
    if (pendingAdj.n) throw new AppError('Decide the proposed adjustments before approving payment', 409);
    const settings = await getSettings(c);
    if (settings.require_separate_payment_approver && ctx.invoice_approved_by === actor.id) {
      throw new AppError('Payment must be approved by someone other than the invoice approver', 409);
    }
    const updated = await one(c, `UPDATE contractor_payables SET status = 'approved_for_payment', payment_approved_by = $2, payment_approved_at = now() WHERE id = $1 RETURNING *`,
      [payableId, actor.id]);
    await audit(c, actor, { action: 'payable.approved_for_payment', entityType: 'contractor_payable', entityId: payableId, contractorId: p.contractor_id });
    return updated;
  });
}

export async function holdPayable(db: Db, actor: Actor, payableId: string, reason: string) {
  if (actor.role !== 'system') assertFinance(actor);
  if (!reason?.trim()) throw new AppError('A reason is required');
  const p = await maybeOne(db,
    `UPDATE contractor_payables SET status = 'on_hold', hold_reason = $2 WHERE id = $1 AND status IN ('awaiting_payment_approval','approved_for_payment') RETURNING *`,
    [payableId, reason]);
  if (!p) throw new AppError('Only unpaid payables not in a payment batch can be held', 409);
  await audit(db, actor, { action: 'payable.held', entityType: 'contractor_payable', entityId: payableId, contractorId: p.contractor_id, details: { reason } });
  return p;
}

export async function releaseHold(db: Db, actor: Actor, payableId: string) {
  if (actor.role !== 'system') assertFinance(actor);
  const p = await maybeOne(db,
    `UPDATE contractor_payables SET status = 'awaiting_payment_approval', hold_reason = NULL, payment_approved_by = NULL, payment_approved_at = NULL
      WHERE id = $1 AND status = 'on_hold' RETURNING *`, [payableId]);
  if (!p) throw new AppError('Payable is not on hold', 409);
  await audit(db, actor, { action: 'payable.hold_released', entityType: 'contractor_payable', entityId: payableId, contractorId: p.contractor_id });
  return p;
}

/** Proposes an adjustment. Nothing changes until it is approved; deductions also need the contractor's agreement. */
export async function proposeAdjustment(db: Db, actor: Actor, payableId: string, amountCents: number, reason: string, contractorAgreed: boolean) {
  assertFinance(actor);
  if (!reason?.trim()) throw new AppError('A reason is required');
  if (!Number.isInteger(amountCents) || amountCents === 0) throw new AppError('Adjustment must be a non-zero amount');
  const p = await maybeOne(db, 'SELECT * FROM contractor_payables WHERE id = $1', [payableId]);
  if (!p) throw new NotFoundError('Payable');
  if (!['awaiting_payment_approval', 'on_hold'].includes(p.status)) throw new AppError('Adjustments can only be made before payment approval', 409);
  const adj = await one(db,
    `INSERT INTO payable_adjustments (payable_id, amount_cents, reason, created_by, contractor_agreed) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [payableId, amountCents, reason, actor.id, contractorAgreed]);
  await audit(db, actor, { action: 'payable_adjustment.proposed', entityType: 'payable_adjustment', entityId: adj.id, contractorId: p.contractor_id, details: { amountCents, reason, contractorAgreed } });
  return adj;
}

export async function decideAdjustment(db: Db, actor: Actor, adjustmentId: string, decision: 'approved' | 'rejected') {
  if (actor.role !== 'admin') throw new ForbiddenError('Only an administrator can approve payable adjustments');
  return tx(db, async (c) => {
    const adj = await maybeOne(c, 'SELECT * FROM payable_adjustments WHERE id = $1 FOR UPDATE', [adjustmentId]);
    if (!adj) throw new NotFoundError('Adjustment');
    if (adj.status !== 'proposed') throw new AppError('Adjustment already decided', 409);
    if (decision === 'approved' && adj.created_by === actor.id) throw new AppError('Adjustments must be approved by a different person than the proposer', 409);
    const p = await one(c, 'SELECT * FROM contractor_payables WHERE id = $1 FOR UPDATE', [adj.payable_id]);
    if (decision === 'approved') {
      if (adj.amount_cents < 0 && !adj.contractor_agreed) throw new AppError('Deductions require the contractor\'s recorded agreement', 409);
      if (p.invoice_total_cents + p.adjustments_cents + adj.amount_cents < 0) throw new AppError('Adjustment would make the payable negative', 409);
      const inv = await one(c, 'SELECT gst_registered FROM contractor_invoices WHERE id = $1', [p.contractor_invoice_id]);
      const abs = Math.abs(adj.amount_cents);
      const gst = inv.gst_registered ? gstComponentOfInclusive(abs, (await getSettings(c)).gst_rate_bps) : 0;
      const lines = adj.amount_cents > 0
        ? [{ account: 'CONTRACTOR_COSTS' as const, debit: abs - gst }, { account: 'GST_INPUT' as const, debit: gst }, { account: 'CONTRACTOR_PAYABLE' as const, credit: abs }]
        : [{ account: 'CONTRACTOR_PAYABLE' as const, debit: abs }, { account: 'CONTRACTOR_COSTS' as const, credit: abs - gst }, { account: 'GST_INPUT' as const, credit: gst }];
      await postJournal(c, actor, { description: `Payable adjustment: ${adj.reason}`, sourceType: 'payable_adjustment', sourceId: adj.id,
        idempotencyKey: `payable-adjustment:${adj.id}`, lines: lines.map((l) => ({ ...l, contractorId: p.contractor_id, jobId: p.job_id })) });
      await c.query('UPDATE contractor_payables SET adjustments_cents = adjustments_cents + $2 WHERE id = $1', [p.id, adj.amount_cents]);
    }
    await c.query('UPDATE payable_adjustments SET status = $2, approved_by = $3, decided_at = now() WHERE id = $1', [adjustmentId, decision, actor.id]);
    await audit(c, actor, { action: `payable_adjustment.${decision}`, entityType: 'payable_adjustment', entityId: adjustmentId, contractorId: p.contractor_id });
  });
}

/** Creates a payment batch from approved payables due on or before the given date. Scheduling is NOT payment. */
export async function createPaymentBatch(db: Db, actor: Actor, opts: { dueOnOrBefore: string; payableIds?: string[] }) {
  assertFinance(actor);
  return tx(db, async (c) => {
    const payables = await query(c,
      `SELECT * FROM contractor_payables WHERE status = 'approved_for_payment' AND due_date <= $1::date
         AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY due_date FOR UPDATE`, [opts.dueOnOrBefore, opts.payableIds?.length ? opts.payableIds : null]);
    if (!payables.length) throw new AppError('No approved payables are due for that date', 409);
    const batch = await one(c, `INSERT INTO payment_batches (created_by) VALUES ($1) RETURNING *`, [actor.id]);
    for (const p of payables) {
      await c.query(`INSERT INTO contractor_payments (payable_id, batch_id, contractor_id, amount_cents, scheduled_date) VALUES ($1,$2,$3,$4,$5)`,
        [p.id, batch.id, p.contractor_id, payableAmount(p), opts.dueOnOrBefore]);
      await c.query(`UPDATE contractor_payables SET status = 'in_batch' WHERE id = $1`, [p.id]);
    }
    await audit(c, actor, { action: 'payment_batch.created', entityType: 'payment_batch', entityId: batch.id, details: { count: payables.length } });
    return batch;
  });
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Generic NZ direct-credit CSV for upload to internet banking. Exporting does not mark anything as paid. */
export async function exportBatchCsv(db: Db, actor: Actor, batchId: string): Promise<{ filename: string; csv: string }> {
  assertFinance(actor);
  const batch = await maybeOne(db, 'SELECT * FROM payment_batches WHERE id = $1', [batchId]);
  if (!batch) throw new NotFoundError('Batch');
  const rows = await query(db,
    `SELECT cp.*, k.legal_name, k.bank_account_name, k.bank_account_number, j.ref AS job_ref, ci.invoice_number
       FROM contractor_payments cp JOIN contractors k ON k.id = cp.contractor_id JOIN contractor_payables p ON p.id = cp.payable_id
       JOIN jobs j ON j.id = p.job_id JOIN contractor_invoices ci ON ci.id = p.contractor_invoice_id
      WHERE cp.batch_id = $1 AND cp.status = 'scheduled' ORDER BY k.legal_name`, [batchId]);
  const header = ['Payee name', 'Bank account', 'Amount', 'Particulars', 'Code', 'Reference', 'Payment ID'];
  const lines = rows.map((r) => [r.bank_account_name || r.legal_name, r.bank_account_number ?? '', (r.amount_cents / 100).toFixed(2),
    'RIDGELINE', r.invoice_number.slice(0, 12), r.job_ref.slice(0, 12), r.id].map(csvCell).join(','));
  await db.query(`UPDATE payment_batches SET status = 'exported', exported_at = COALESCE(exported_at, now()) WHERE id = $1 AND status = 'draft'`, [batchId]);
  await audit(db, actor, { action: 'payment_batch.exported', entityType: 'payment_batch', entityId: batchId, details: { rows: rows.length } });
  return { filename: `${batch.ref}.csv`, csv: [header.join(','), ...lines].join('\n') + '\n' };
}

/** Marks a contractor payment as paid ONLY with a bank reference and actual payment date. Idempotent. */
export async function confirmContractorPayment(db: Db, actor: Actor, paymentId: string, input: { paidDate: string; reference: string; source?: 'manual' | 'bank_statement' | 'provider' }) {
  if (actor.role !== 'system') assertFinance(actor);
  if (!input.reference?.trim()) throw new AppError('Payment reference is required to confirm payment');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidDate ?? '')) throw new AppError('Actual payment date is required');
  if (input.paidDate > new Date().toISOString().slice(0, 10)) throw new AppError('Payment date cannot be in the future');
  return tx(db, async (c) => {
    const pay = await maybeOne(c, 'SELECT * FROM contractor_payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!pay) throw new NotFoundError('Payment');
    if (pay.status === 'confirmed') return pay;
    if (pay.status !== 'scheduled') throw new AppError(`Payment is ${pay.status}`, 409);
    const p = await one(c, 'SELECT * FROM contractor_payables WHERE id = $1 FOR UPDATE', [pay.payable_id]);
    await postJournal(c, actor, { description: `Contractor payment ${input.reference}`, sourceType: 'contractor_payment', sourceId: paymentId,
      idempotencyKey: `contractor-payment:${paymentId}`, entryDate: input.paidDate,
      lines: [{ account: 'CONTRACTOR_PAYABLE', debit: pay.amount_cents, contractorId: pay.contractor_id, jobId: p.job_id },
              { account: 'BANK', credit: pay.amount_cents, contractorId: pay.contractor_id }] });
    const updated = await one(c,
      `UPDATE contractor_payments SET status = 'confirmed', paid_date = $2, payment_reference = $3, confirmation_source = $4, confirmed_by = $5, confirmed_at = now()
        WHERE id = $1 RETURNING *`, [paymentId, input.paidDate, input.reference.trim(), input.source ?? 'manual', actor.id]);
    await c.query(`UPDATE contractor_payables SET status = 'paid', paid_at = now() WHERE id = $1`, [p.id]);
    if (pay.batch_id) {
      await c.query(`UPDATE payment_batches SET status = 'completed' WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM contractor_payments WHERE batch_id = $1 AND status = 'scheduled')`, [pay.batch_id]);
    }
    await enqueueSync(c, 'contractor_payment', paymentId);
    const inv = await one(c, 'SELECT invoice_number FROM contractor_invoices WHERE id = $1', [p.contractor_invoice_id]);
    await notifyContractor(c, pay.contractor_id, { template: 'contractor_paid', subject: `Payment made: invoice ${inv.invoice_number}`,
      body: `Ridgeline paid ${formatNzd(pay.amount_cents)} for invoice ${inv.invoice_number} on ${input.paidDate} (reference ${input.reference}).`,
      attachments: [{ kind: 'remittance_pdf', id: paymentId, filename: `remittance-${inv.invoice_number}.pdf` }], idempotencyKey: `contractor-paid:${paymentId}` });
    await audit(c, actor, { action: 'contractor_payment.confirmed', entityType: 'contractor_payment', entityId: paymentId, contractorId: pay.contractor_id, details: input });
    return updated;
  });
}

export async function failContractorPayment(db: Db, actor: Actor, paymentId: string, reason: string) {
  assertFinance(actor);
  return tx(db, async (c) => {
    const pay = await maybeOne(c, 'SELECT * FROM contractor_payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!pay) throw new NotFoundError('Payment');
    if (pay.status !== 'scheduled') throw new AppError('Only scheduled payments can be marked failed', 409);
    await c.query(`UPDATE contractor_payments SET status = 'failed', failure_reason = $2 WHERE id = $1`, [paymentId, reason]);
    await c.query(`UPDATE contractor_payables SET status = 'approved_for_payment' WHERE id = $1`, [pay.payable_id]);
    await notifyStaff(c, ['finance', 'admin'], { template: 'contractor_payment_failed', subject: 'Contractor payment failed',
      body: `Payment of ${formatNzd(pay.amount_cents)} failed: ${reason}. The payable has returned to the payment queue.`, idempotencyKey: `cp-failed:${paymentId}` });
    await audit(c, actor, { action: 'contractor_payment.failed', entityType: 'contractor_payment', entityId: paymentId, contractorId: pay.contractor_id, details: { reason } });
  });
}

/**
 * Reconciles a bank statement CSV (columns: date, amount, reference/particulars...). A debit matches a scheduled
 * payment when the amount is equal and the row text contains the payment ID, invoice number or job reference.
 */
export async function reconcileBankStatement(db: Db, actor: Actor, csv: string): Promise<{ matched: { paymentId: string; reference: string }[]; unmatched: string[] }> {
  assertFinance(actor);
  const scheduled = await query(db,
    `SELECT cp.*, ci.invoice_number, j.ref AS job_ref FROM contractor_payments cp JOIN contractor_payables p ON p.id = cp.payable_id
       JOIN contractor_invoices ci ON ci.id = p.contractor_invoice_id JOIN jobs j ON j.id = p.job_id WHERE cp.status = 'scheduled'`);
  const matched: { paymentId: string; reference: string }[] = [];
  const unmatched: string[] = [];
  const used = new Set<string>();
  for (const raw of csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const cells = raw.split(',').map((s) => s.replace(/^"|"$/g, '').trim());
    const date = cells.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(x));
    const amountCell = cells.find((x) => /^-?\$?\d[\d,]*\.\d{2}$/.test(x));
    if (!date || !amountCell) { if (!/date/i.test(raw)) unmatched.push(raw); continue; }
    const amount = Math.abs(parseDollars(amountCell));
    const iso = date.includes('/') ? (() => { const [d, m, y] = date.split('/'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; })() : date;
    const text = raw.toUpperCase();
    const hit = scheduled.find((s) => !used.has(s.id) && s.amount_cents === amount &&
      (text.includes(s.id.toUpperCase()) || text.includes(String(s.invoice_number).toUpperCase().slice(0, 12)) || text.includes(String(s.job_ref).toUpperCase())));
    if (!hit) { unmatched.push(raw); continue; }
    used.add(hit.id);
    const reference = `STMT ${iso} ${hit.job_ref}`;
    await confirmContractorPayment(db, actor, hit.id, { paidDate: iso, reference, source: 'bank_statement' });
    matched.push({ paymentId: hit.id, reference });
  }
  await audit(db, actor, { action: 'bank_statement.reconciled', entityType: 'contractor_payment', details: { matched: matched.length, unmatched: unmatched.length } });
  return { matched, unmatched };
}
