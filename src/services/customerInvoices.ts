import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { formatNzd, gstOn } from '../lib/money.js';
import { audit } from './audit.js';
import { isMakeSafeOnly } from './p1Scope.js';
import { currentRateCard } from './contractors.js';
import { lockJob, transitionJob } from './jobState.js';
import { type AccountCode, postJournal, prepaidMovement } from './ledger.js';
import { link, notifyCustomer } from './notifications.js';
import { type CostLine, loadApprovedRules, priceCostLines } from './pricing.js';
import { getSettings } from './settings.js';
import { enqueueSync } from './xero.js';

/** Amount the customer still owes on an invoice. */
export function outstandingCents(inv: { total_cents: number; prepaid_applied_cents: number; amount_paid_cents: number; credited_cents: number; credit_to_prepaid_cents: number }): number {
  return inv.total_cents - inv.credited_cents - inv.prepaid_applied_cents - inv.amount_paid_cents + inv.credit_to_prepaid_cents;
}

/**
 * Builds the customer invoice draft from the APPROVED contractor invoice lines using Ridgeline's customer
 * pricing rules (35% markup by default, or the configured callout/after-hours rules). The contractor's invoice
 * total is never copied to the customer.
 */
export async function createCustomerInvoiceDraft(db: Db, actor: Actor, contractorInvoiceId: string) {
  const ci = await one(db, 'SELECT * FROM contractor_invoices WHERE id = $1', [contractorInvoiceId]);
  if (ci.status !== 'approved') throw new AppError('Contractor invoice must be approved first');
  const job = await one(db, `SELECT j.*, t.is_specialist FROM jobs j JOIN trades t ON t.id = j.trade_id WHERE j.id = $1`, [ci.job_id]);
  const lines = await query(db, 'SELECT * FROM contractor_invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [contractorInvoiceId]);
  const costLines: CostLine[] = lines.map((l) => ({
    category: l.category, description: l.description, quantityMilli: l.quantity_milli, unitRateCents: l.unit_rate_cents,
    amountCents: l.amount_cents, timeWindow: l.time_window, contractorLineId: l.id,
  }));
  const card = await currentRateCard(db, ci.contractor_id, job.trade_id);
  const rules = await loadApprovedRules(db, job.customer_id);
  const pricing = priceCostLines(costLines,
    { customerId: job.customer_id, tradeId: job.trade_id, tradeIsSpecialist: job.is_specialist, priority: job.priority, standardContractorLabourRateCents: card?.labour_rate_cents },
    rules, await getSettings(db));

  return tx(db, async (c) => {
    const existing = await maybeOne(c, `SELECT * FROM customer_invoices WHERE job_id = $1 AND status <> 'void'`, [job.id]);
    if (existing) throw new AppError('A customer invoice already exists for this job (double billing prevented)', 409, 'duplicate_customer_invoice');
    const inv = await one(c,
      `INSERT INTO customer_invoices (customer_id, job_id, contractor_invoice_id, po_number, subtotal_ex_gst_cents, gst_cents, total_cents,
          contractor_cost_ex_gst_cents, markup_cents, pricing, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [job.customer_id, job.id, contractorInvoiceId, job.po_number, pricing.subtotalExGstCents, pricing.gstCents, pricing.totalCents,
       pricing.contractorCostExGstCents, pricing.markupCents, JSON.stringify(pricing), actor.id]);
    for (const [i, l] of pricing.lines.entries()) {
      await c.query(
        `INSERT INTO customer_invoice_lines (invoice_id, line_no, category, description, quantity_milli, unit_price_cents, amount_ex_gst_cents,
            contractor_line_id, contractor_cost_cents, pricing_rule_id, pricing_explanation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [inv.id, i + 1, l.category, l.description, l.quantityMilli, l.unitPriceCents, l.amountExGstCents, l.contractorLineId, l.contractorCostCents, l.ruleId, l.explanation]);
    }
    await audit(c, actor, { action: 'customer_invoice.drafted', entityType: 'customer_invoice', entityId: inv.id, customerId: job.customer_id,
      details: { subtotal: pricing.subtotalExGstCents, markup: pricing.markupCents, gst: pricing.gstCents } });
    return inv;
  });
}

/**
 * Issues the invoice: assigns the invoice number, applies prepaid credit (per the service agreement), records the
 * remainder as a receivable, recognises revenue and GST, settles the job commitment and notifies the customer.
 */
export async function issueCustomerInvoice(db: Db, actor: Actor, invoiceId: string) {
  if (!['admin', 'finance', 'system'].includes(actor.role)) throw new ForbiddenError('Only finance can issue customer invoices');
  return tx(db, async (c) => {
    const inv = await maybeOne(c, 'SELECT * FROM customer_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    if (!inv) throw new NotFoundError('Customer invoice');
    if (inv.status !== 'draft') {
      if (inv.status === 'void') throw new AppError('Invoice is void', 409);
      return inv; // Already issued: idempotent.
    }
    const settings = await getSettings(c);
    if (inv.gst_cents > 0 && !settings.company.gst_number?.trim()) {
      // A tax invoice must show the supplier's GST number; never issue one without it.
      throw new AppError(`Enter ${settings.company.legal_name}'s GST number in Admin → Settings before issuing GST invoices`, 409, 'gst_number_missing');
    }
    const job = await lockJob(c, inv.job_id);
    if (isMakeSafeOnly(job) && inv.subtotal_ex_gst_cents > job.p1_scope_cap_ex_gst_cents) {
      throw new AppError(`This emergency was authorised for make-safe work up to ${formatNzd(job.p1_scope_cap_ex_gst_cents)} ex GST; the invoice is ` +
        `${formatNzd(inv.subtotal_ex_gst_cents)} ex GST. Record the customer's approval or a staff override on the job before issuing.`, 409, 'make_safe_cap');
    }
    const disputes = await one<{ n: number }>(c, `SELECT COUNT(*)::int AS n FROM disputes WHERE job_id = $1 AND status IN ('open','investigating')`, [job.id]);
    if (disputes.n) throw new AppError('Resolve the open dispute on this job before invoicing', 409);
    if (job.status !== 'invoice_approved') throw new AppError('Job is not ready to invoice', 409);
    const customer = await one(c, 'SELECT * FROM customers WHERE id = $1 FOR UPDATE', [inv.customer_id]);
    const number = (await one<{ n: string }>(c, `SELECT 'RF-INV-' || nextval('customer_invoice_seq') AS n`)).n;

    const applied = customer.auto_apply_prepaid ? Math.min(customer.prepaid_balance_cents, inv.total_cents) : 0;
    const receivable = inv.total_cents - applied;
    const description = `Invoice ${number} for job ${job.ref}`;
    const counterLines = [
      { account: 'ACCOUNTS_RECEIVABLE' as AccountCode, debit: receivable, customerId: customer.id, jobId: job.id },
      { account: 'MAINTENANCE_REVENUE' as AccountCode, credit: inv.subtotal_ex_gst_cents, customerId: customer.id, jobId: job.id },
      { account: 'GST_OUTPUT' as AccountCode, credit: inv.gst_cents, customerId: customer.id, jobId: job.id },
    ];
    if (applied > 0) {
      await prepaidMovement(c, actor, {
        customerId: customer.id, type: 'job_charge', amountCents: -applied, description: `${description} (prepaid credit applied)`, reference: number,
        jobId: job.id, customerInvoiceId: inv.id, idempotencyKey: `invoice-issue:${inv.id}`, counterLines, sourceType: 'customer_invoice', sourceId: inv.id,
      });
    } else {
      await postJournal(c, actor, { description, sourceType: 'customer_invoice', sourceId: inv.id, idempotencyKey: `invoice-issue:${inv.id}`,
        lines: [{ account: 'ACCOUNTS_RECEIVABLE', debit: inv.total_cents, customerId: customer.id, jobId: job.id }, ...counterLines.slice(1)] });
    }
    const updated = await one(c,
      `UPDATE customer_invoices SET invoice_number = $2, status = $3, issue_date = CURRENT_DATE, due_date = CURRENT_DATE + $4::int,
          prepaid_applied_cents = $5, issued_by = $6, issued_at = now() WHERE id = $1 RETURNING *`,
      [inv.id, number, receivable === 0 ? 'paid' : 'issued', customer.payment_terms_days, applied, actor.id]);
    await c.query(`UPDATE job_commitments SET status = 'settled', closed_at = now() WHERE job_id = $1 AND status = 'active'`, [job.id]);
    await transitionJob(c, actor, job, 'customer_invoiced', { note: `${number}: ${formatNzd(inv.total_cents)} (prepaid ${formatNzd(applied)}, due ${formatNzd(receivable)})` });
    await enqueueSync(c, 'customer_invoice', inv.id);
    await notifyCustomer(c, customer.id, {
      template: 'customer_invoice_issued', subject: `Invoice ${number} – ${job.ref}`,
      body: `Your invoice ${number} for ${job.title} (${job.ref}) is attached with the completion report and your account statement.\n\n` +
        `Invoice total (incl GST): ${formatNzd(inv.total_cents)}\nGST included: ${formatNzd(inv.gst_cents)}\n` +
        `Prepaid credit applied: ${formatNzd(applied)}\nAmount now payable: ${formatNzd(receivable)}${receivable ? ` (due within ${customer.payment_terms_days} days)` : ''}\n\n` +
        `View online: ${link(`/app/invoices/${inv.id}`)}`,
      attachments: [
        { kind: 'customer_invoice_pdf', id: inv.id, filename: `${number}.pdf` },
        { kind: 'completion_report_pdf', id: job.id, filename: `${job.ref}-completion-report.pdf` },
        { kind: 'statement_pdf', id: customer.id, filename: `statement-${customer.account_ref}.pdf` },
      ],
      idempotencyKey: `invoice-issued:${inv.id}`, relatedType: 'customer_invoice', relatedId: inv.id,
    }, { includeBillingEmail: true });
    await audit(c, actor, { action: 'customer_invoice.issued', entityType: 'customer_invoice', entityId: inv.id, customerId: customer.id,
      details: { number, total: inv.total_cents, prepaidApplied: applied, receivable } });
    return updated;
  });
}

/** Recalculates a draft (e.g. after a pricing rule correction). Issued invoices are corrected by credit note instead. */
export async function recalculateDraft(db: Db, actor: Actor, invoiceId: string) {
  if (actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError();
  const inv = await maybeOne(db, 'SELECT * FROM customer_invoices WHERE id = $1', [invoiceId]);
  if (!inv) throw new NotFoundError('Customer invoice');
  if (inv.status !== 'draft') throw new AppError('Only drafts can be recalculated', 409);
  await tx(db, async (c) => {
    await c.query(`UPDATE customer_invoices SET status = 'void' WHERE id = $1`, [invoiceId]);
    await audit(c, actor, { action: 'customer_invoice.draft_recalculated', entityType: 'customer_invoice', entityId: invoiceId, customerId: inv.customer_id });
  });
  return createCustomerInvoiceDraft(db, actor, inv.contractor_invoice_id);
}

export interface PaymentApplication { paymentId: string; counterAccount: AccountCode }

/** Applies a confirmed customer payment to an issued invoice's receivable. */
export async function applyInvoicePayment(db: Db, actor: Actor, invoiceId: string, amountCents: number, p: PaymentApplication) {
  const inv = await maybeOne(db, 'SELECT * FROM customer_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
  if (!inv) throw new NotFoundError('Customer invoice');
  if (!['issued', 'partially_paid'].includes(inv.status)) throw new AppError('Invoice is not awaiting payment', 409);
  const due = outstandingCents(inv);
  if (amountCents > due) throw new AppError(`Payment exceeds the ${formatNzd(due)} outstanding`, 409);
  await postJournal(db, actor, {
    description: `Payment received for invoice ${inv.invoice_number}`, sourceType: 'customer_payment', sourceId: p.paymentId,
    idempotencyKey: `invoice-payment:${p.paymentId}`,
    lines: [{ account: p.counterAccount, debit: amountCents, customerId: inv.customer_id }, { account: 'ACCOUNTS_RECEIVABLE', credit: amountCents, customerId: inv.customer_id, jobId: inv.job_id }],
  });
  await db.query(
    `UPDATE customer_invoices SET amount_paid_cents = amount_paid_cents + $2,
        status = CASE WHEN total_cents - credited_cents - prepaid_applied_cents - (amount_paid_cents + $2) + credit_to_prepaid_cents = 0 THEN 'paid' ELSE 'partially_paid' END
      WHERE id = $1`, [invoiceId, amountCents]);
}

export async function reverseInvoicePayment(db: Db, actor: Actor, invoiceId: string, amountCents: number, p: PaymentApplication) {
  const inv = await one(db, 'SELECT * FROM customer_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
  await postJournal(db, actor, {
    description: `Reversal of payment for invoice ${inv.invoice_number}`, sourceType: 'customer_payment_reversal', sourceId: p.paymentId,
    idempotencyKey: `invoice-payment-reversal:${p.paymentId}`,
    lines: [{ account: 'ACCOUNTS_RECEIVABLE', debit: amountCents, customerId: inv.customer_id, jobId: inv.job_id }, { account: p.counterAccount, credit: amountCents, customerId: inv.customer_id }],
  });
  await db.query(`UPDATE customer_invoices SET amount_paid_cents = amount_paid_cents - $2, status = CASE WHEN amount_paid_cents - $2 > 0 THEN 'partially_paid' ELSE 'issued' END WHERE id = $1`,
    [invoiceId, amountCents]);
}

/** Uses available prepaid credit (e.g. after a top-up) to settle an invoice's outstanding receivable. */
export async function applyPrepaidToInvoice(db: Db, actor: Actor, invoiceId: string) {
  if (actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError();
  return tx(db, async (c) => {
    const inv = await maybeOne(c, 'SELECT * FROM customer_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    if (!inv) throw new NotFoundError('Customer invoice');
    if (!['issued', 'partially_paid'].includes(inv.status)) throw new AppError('Invoice has nothing outstanding', 409);
    const customer = await one(c, 'SELECT * FROM customers WHERE id = $1 FOR UPDATE', [inv.customer_id]);
    const committed = (await one<{ v: number }>(c, `SELECT COALESCE(SUM(amount_cents),0)::bigint AS v FROM job_commitments WHERE customer_id = $1 AND status = 'active'`, [customer.id])).v;
    const amount = Math.min(outstandingCents(inv), Math.max(0, customer.prepaid_balance_cents - committed));
    if (amount <= 0) throw new AppError('No uncommitted prepaid credit is available', 409);
    const seq = (await one<{ n: number }>(c, `SELECT COUNT(*)::int AS n FROM prepaid_transactions WHERE customer_invoice_id = $1`, [inv.id])).n;
    await prepaidMovement(c, actor, {
      customerId: customer.id, type: 'receivable_settlement', amountCents: -amount, description: `Prepaid credit applied to invoice ${inv.invoice_number}`,
      reference: inv.invoice_number, customerInvoiceId: inv.id, jobId: inv.job_id, idempotencyKey: `invoice-prepaid:${inv.id}:${seq}`,
      counterLines: [{ account: 'ACCOUNTS_RECEIVABLE', credit: amount, customerId: customer.id, jobId: inv.job_id }], sourceType: 'customer_invoice', sourceId: inv.id,
    });
    const updated = await one(c,
      `UPDATE customer_invoices SET prepaid_applied_cents = prepaid_applied_cents + $2,
          status = CASE WHEN total_cents - credited_cents - (prepaid_applied_cents + $2) - amount_paid_cents + credit_to_prepaid_cents = 0 THEN 'paid' ELSE status END
        WHERE id = $1 RETURNING *`, [inv.id, amount]);
    await audit(c, actor, { action: 'customer_invoice.prepaid_applied', entityType: 'customer_invoice', entityId: inv.id, customerId: customer.id, details: { amount } });
    return updated;
  });
}

/**
 * Credit note against an issued invoice (dispute resolution, pricing error). Reduces revenue and GST; the credit
 * first clears any outstanding receivable and the rest is returned to the customer's prepaid balance.
 */
export async function createCreditNote(db: Db, actor: Actor, invoiceId: string, input: { amountExGstCents: number; reason: string; disputeId?: string | null }) {
  if (actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError('Only finance or administrators can issue credit notes');
  if (!input.reason?.trim()) throw new AppError('A reason is required');
  if (!Number.isInteger(input.amountExGstCents) || input.amountExGstCents <= 0) throw new AppError('Credit amount must be positive');
  return tx(db, async (c) => {
    const inv = await maybeOne(c, 'SELECT * FROM customer_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    if (!inv) throw new NotFoundError('Customer invoice');
    if (!['issued', 'partially_paid', 'paid'].includes(inv.status)) throw new AppError('Only issued invoices can be credited', 409);
    const gstRate = (inv.pricing?.gstRateBps as number | undefined) ?? (await getSettings(c)).gst_rate_bps;
    const gst = inv.gst_cents > 0 ? gstOn(input.amountExGstCents, gstRate) : 0;
    const total = input.amountExGstCents + gst;
    const creditable = inv.total_cents - inv.credited_cents;
    if (total > creditable) throw new AppError(`Credit of ${formatNzd(total)} exceeds the ${formatNzd(creditable)} remaining on this invoice`, 409);
    const toReceivable = Math.min(outstandingCents(inv), total);
    const toPrepaid = total - toReceivable;
    const cn = await one(c,
      `INSERT INTO credit_notes (customer_invoice_id, customer_id, dispute_id, amount_ex_gst_cents, gst_cents, total_cents, to_prepaid_cents, to_receivable_cents, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [inv.id, inv.customer_id, input.disputeId ?? null, input.amountExGstCents, gst, total, toPrepaid, toReceivable, input.reason, actor.id]);
    const debitLines = [
      { account: 'MAINTENANCE_REVENUE' as AccountCode, debit: input.amountExGstCents, customerId: inv.customer_id, jobId: inv.job_id },
      { account: 'GST_OUTPUT' as AccountCode, debit: gst, customerId: inv.customer_id, jobId: inv.job_id },
      { account: 'ACCOUNTS_RECEIVABLE' as AccountCode, credit: toReceivable, customerId: inv.customer_id, jobId: inv.job_id },
    ];
    if (toPrepaid > 0) {
      await prepaidMovement(c, actor, {
        customerId: inv.customer_id, type: 'credit_note', amountCents: toPrepaid, description: `Credit note ${cn.credit_note_number} for ${inv.invoice_number}: ${input.reason}`,
        reference: cn.credit_note_number, customerInvoiceId: inv.id, jobId: inv.job_id, idempotencyKey: `credit-note:${cn.id}`,
        counterLines: debitLines, sourceType: 'credit_note', sourceId: cn.id,
      });
    } else {
      await postJournal(c, actor, { description: `Credit note ${cn.credit_note_number} for ${inv.invoice_number}`, sourceType: 'credit_note', sourceId: cn.id,
        idempotencyKey: `credit-note:${cn.id}`, lines: debitLines });
    }
    const updated = await one(c,
      `UPDATE customer_invoices SET credited_cents = credited_cents + $2, credit_to_prepaid_cents = credit_to_prepaid_cents + $3 WHERE id = $1 RETURNING *`,
      [inv.id, total, toPrepaid]);
    if (outstandingCents(updated) === 0 && updated.status !== 'paid') await c.query(`UPDATE customer_invoices SET status = 'paid' WHERE id = $1`, [inv.id]);
    await notifyCustomer(c, inv.customer_id, { template: 'credit_note', subject: `Credit note ${cn.credit_note_number}`,
      body: `A credit of ${formatNzd(total)} (incl GST ${formatNzd(gst)}) has been issued against invoice ${inv.invoice_number}: ${input.reason}.\n` +
        `${toPrepaid ? `${formatNzd(toPrepaid)} has been returned to your prepaid balance. ` : ''}${toReceivable ? `${formatNzd(toReceivable)} reduces the amount owing.` : ''}`,
      attachments: [{ kind: 'credit_note_pdf', id: cn.id, filename: `${cn.credit_note_number}.pdf` }],
      idempotencyKey: `credit-note:${cn.id}` }, { includeBillingEmail: true });
    await audit(c, actor, { action: 'credit_note.issued', entityType: 'credit_note', entityId: cn.id, customerId: inv.customer_id, details: { ...input, total, toPrepaid, toReceivable } });
    return cn;
  });
}

export async function getCustomerInvoiceForActor(db: Db, actor: Actor, invoiceId: string) {
  const inv = await maybeOne(db,
    `SELECT ci.*, j.ref AS job_ref, j.title AS job_title, c.name AS customer_name, c.account_ref, c.billing_address, c.billing_email, c.gst_number AS customer_gst_number
       FROM customer_invoices ci JOIN jobs j ON j.id = ci.job_id JOIN customers c ON c.id = ci.customer_id WHERE ci.id = $1`, [invoiceId]);
  if (!inv) throw new NotFoundError('Invoice');
  if (!isStaff(actor) && !(actor.role === 'customer' && actor.customerId === inv.customer_id)) throw new NotFoundError('Invoice');
  if (actor.role === 'customer' && inv.status === 'draft') throw new NotFoundError('Invoice');
  const lines = await query(db, 'SELECT * FROM customer_invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [invoiceId]);
  const creditNotes = await query(db, 'SELECT * FROM credit_notes WHERE customer_invoice_id = $1 ORDER BY created_at', [invoiceId]);
  if (actor.role === 'customer') {
    // Internal cost and margin data are never exposed to customers.
    delete inv.contractor_cost_ex_gst_cents; delete inv.markup_cents; delete inv.pricing; delete inv.contractor_invoice_id;
    for (const l of lines) { delete l.contractor_cost_cents; delete l.contractor_line_id; l.pricing_explanation = customerSafeExplanation(l); }
  }
  return { invoice: inv, lines, creditNotes, outstanding: outstandingCents(inv as any) };
}

function customerSafeExplanation(l: { category: string }): string {
  return l.category === 'minimum_charge' ? 'Minimum job charge under your agreement' : 'Priced under your agreed Ridgeline rates';
}
