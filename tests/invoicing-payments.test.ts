import Stripe from 'stripe';
import { beforeEach, describe, expect, it } from 'vitest';
import { one, query } from '../src/db.js';
import { approveContractorInvoice, rejectContractorInvoice, submitContractorInvoice, validateContractorInvoice } from '../src/services/contractorInvoices.js';
import { applyPrepaidToInvoice, createCreditNote, issueCustomerInvoice } from '../src/services/customerInvoices.js';
import { raiseDispute, resolveDispute } from '../src/services/disputes.js';
import { customerDecideQuote, reviewQuote, submitQuote } from '../src/services/evidence.js';
import { cancelJob, closeChecks, closeJob } from '../src/services/jobs.js';
import { accountBalances, accountPosition, reconcileCustomerBalance } from '../src/services/ledger.js';
import { approveForPayment, confirmContractorPayment, createPaymentBatch, decideAdjustment, exportBatchCsv, proposeAdjustment, reconcileBankStatement } from '../src/services/payables.js';
import { recordBankReceipt, requestPayment } from '../src/services/payments.js';
import { constructEvent, handleStripeEvent } from '../src/services/stripe.js';
import { acceptOffer, manualAssign } from '../src/services/dispatch.js';
import { recordArrival } from '../src/services/evidence.js';
import { activeCustomer, approvedContractor, book, completeAndApprove, count, db, resetDb, staff, today } from './helpers.js';

beforeEach(resetDb);

/** Contractor bills $200 labour (2.5h @ $80) — standard window — plus optional extra lines. */
async function invoiceFor(jobId: string, c: Awaited<ReturnType<typeof approvedContractor>>, extra: any[] = [], opts: { number?: string; gstRegistered?: boolean } = {}) {
  const lines = [{ category: 'labour', description: 'Labour', quantityMilli: 2500, unitRateCents: 8000, timeWindow: 'standard' }, ...extra];
  const subtotal = lines.reduce((s, l) => s + Math.round((l.quantityMilli * l.unitRateCents) / 1000), 0);
  const gst = opts.gstRegistered === false ? 0 : Math.round(subtotal * 0.15);
  return submitContractorInvoice(db, c.actor, { jobId, invoiceNumber: opts.number ?? `INV-${Math.random().toString(36).slice(2, 8)}`, invoiceDate: today(),
    lines, gstCents: gst, totalCents: subtotal + gst });
}

async function jobReadyForInvoice(opts: { deposit?: number; contractor?: Parameters<typeof approvedContractor>[0] } = {}) {
  const c = await approvedContractor(opts.contractor);
  const fx = await activeCustomer({ deposit: opts.deposit });
  const { job } = await book(fx);
  await completeAndApprove(job.id, c);
  // Simulate an approved quote so callout + labour fall within the authorised scope.
  await db.query('UPDATE jobs SET authorised_contractor_cost_cents = 50000 WHERE id = $1', [job.id]);
  return { c, fx, job };
}

describe('criteria 7 & 8: contractor invoices go to Ridgeline and are checked against the job and rate card', () => {
  it('never sends contractor invoices to the customer and accepts a clean invoice', async () => {
    const { c, fx, job } = await jobReadyForInvoice();
    const inv = await invoiceFor(job.id, c);
    expect(inv.status).toBe('submitted');
    const customerEmails = (await query(db, `SELECT email FROM users WHERE customer_id = $1`, [fx.customerId])).map((u) => u.email);
    const toCustomer = await query(db, `SELECT * FROM notifications WHERE recipient_email = ANY($1) AND template LIKE 'contractor_invoice%'`, [customerEmails]);
    expect(toCustomer).toHaveLength(0);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'contractor_invoice_submitted'`)).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM customer_invoices WHERE job_id = $1`, [job.id])).toBe(0);
  });

  it('rejects wrong job references, duplicate numbers, bad arithmetic and invalid GST outright', async () => {
    const { c, job } = await jobReadyForInvoice();
    const other = await approvedContractor();
    await expect(invoiceFor(job.id, other)).rejects.toThrow(/Incorrect job reference/);
    await expect(submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'A1', invoiceDate: today(),
      lines: [{ category: 'labour', description: 'L', quantityMilli: 1000, unitRateCents: 8000 }], gstCents: 1000, totalCents: 9000 })).rejects.toThrow(/GST should be \$12\.00/);
    await expect(submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'A1', invoiceDate: today(),
      lines: [{ category: 'labour', description: 'L', quantityMilli: 1000, unitRateCents: 8000 }], gstCents: 1200, totalCents: 9999 })).rejects.toThrow(/total should be/);
    await invoiceFor(job.id, c, [], { number: 'DUP-1' });
    await expect(invoiceFor(job.id, c, [], { number: 'dup-1' })).rejects.toThrow(/already been submitted/);
  });

  it('flags rate discrepancies, unauthorised variations, missing receipts, excess labour and overruns', async () => {
    const { c, job } = await jobReadyForInvoice();
    const inv = await submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'FLAG-1', invoiceDate: today(), lines: [
      { category: 'labour', description: 'Labour', quantityMilli: 5000, unitRateCents: 9500 }, // rate > $80 and 5h > 2h reported
      { category: 'callout', description: 'Callout', quantityMilli: 1000, unitRateCents: 10000 },
      { category: 'materials', description: 'Parts', quantityMilli: 1000, unitRateCents: 9000 }, // > $50 without receipt; > reported $20
      { category: 'variation', description: 'Extra', quantityMilli: 1000, unitRateCents: 5000 },
    ], gstCents: Math.round(71500 * 0.15), totalCents: 71500 + Math.round(71500 * 0.15) });
    expect(inv.status).toBe('flagged');
    const codes = (inv.validation.flags as any[]).map((f) => f.code);
    for (const code of ['rate_discrepancy', 'labour_exceeds_report', 'missing_receipt', 'materials_exceed_report', 'unauthorised_variation', 'exceeds_authorised_amount']) {
      expect(codes).toContain(code);
    }
    const finance = await staff('finance');
    await expect(approveContractorInvoice(db, finance, inv.id, 'ok')).rejects.toThrow(/Cannot approve.*variation/);
    await rejectContractorInvoice(db, finance, inv.id, 'Variation not approved; rate above agreement');
    expect((await one(db, 'SELECT status FROM jobs WHERE id = $1', [job.id])).status).toBe('evidence_approved');
  });

  it('requires a recorded reason to approve an invoice with warning flags', async () => {
    const { c, job } = await jobReadyForInvoice();
    const inv = await submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'W1', invoiceDate: today(),
      lines: [{ category: 'labour', description: 'Labour', quantityMilli: 2000, unitRateCents: 9000 }], gstCents: 2700, totalCents: 20700 });
    expect(inv.status).toBe('flagged');
    const finance = await staff('finance');
    await expect(approveContractorInvoice(db, finance, inv.id)).rejects.toThrow(/Record the reason/);
    await expect(approveContractorInvoice(db, await staff('ops'), inv.id, 'x')).rejects.toThrow(/finance or administrators/);
    await approveContractorInvoice(db, finance, inv.id, 'Rate increase agreed by phone 12 Oct; card to be updated');
  });
});

describe('criteria 10, 12 & 13: customer invoice from Ridgeline pricing, prepaid settlement, independent payables', () => {
  it('prices from approved contractor cost with 35% markup and settles against prepaid credit', async () => {
    const { c, fx, job } = await jobReadyForInvoice();
    const ci = await invoiceFor(job.id, c, [{ category: 'callout', description: 'Callout', quantityMilli: 1000, unitRateCents: 10000 }]);
    const finance = await staff('finance');
    const { draftId } = await approveContractorInvoice(db, finance, ci.id);
    const draft = await one(db, 'SELECT * FROM customer_invoices WHERE id = $1', [draftId]);
    // Contractor: $200 labour + $100 callout = $300 ex GST → customer $270 + $135 = $405 ex GST, GST $60.75
    expect(draft.contractor_cost_ex_gst_cents).toBe(30000);
    expect(draft.subtotal_ex_gst_cents).toBe(40500);
    expect(draft.markup_cents).toBe(10500);
    expect(draft.gst_cents).toBe(6075);
    expect(draft.total_cents).toBe(46575);

    // Payable equals the contractor's invoice (incl. their GST), independent of the customer price.
    const payable = await one(db, 'SELECT * FROM contractor_payables WHERE contractor_invoice_id = $1', [ci.id]);
    expect(payable.invoice_total_cents).toBe(34500);
    expect(payable.status).toBe('awaiting_payment_approval');

    const before = await accountPosition(db, fx.customerId);
    const issued = await issueCustomerInvoice(db, finance, draftId);
    expect(issued.invoice_number).toMatch(/^RF-INV-\d+$/);
    expect(issued.prepaid_applied_cents).toBe(46575);
    expect(issued.status).toBe('paid');
    const after = await accountPosition(db, fx.customerId);
    expect(after.balanceCents).toBe(before.balanceCents - 46575);
    expect(after.committedCents).toBe(0); // commitment settled
    expect((await reconcileCustomerBalance(db, fx.customerId)).ok).toBe(true);

    // Double billing prevented: issuing again is a no-op and no second invoice can be created.
    await issueCustomerInvoice(db, finance, draftId);
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(after.balanceCents);
    await expect(db.query(`INSERT INTO customer_invoices (customer_id, job_id, contractor_invoice_id, subtotal_ex_gst_cents, gst_cents, total_cents,
      contractor_cost_ex_gst_cents, markup_cents, pricing) VALUES ($1,$2,$3,1,0,1,1,0,'{}')`, [fx.customerId, job.id, ci.id])).rejects.toThrow(/customer_invoice_one_per_job_idx|duplicate/);

    // Ledger separation: revenue is the GST-exclusive price; prepaid balance is a liability; payable separate.
    const gl = Object.fromEntries((await accountBalances(db)).map((a) => [a.code, a.balance_cents]));
    expect(gl.MAINTENANCE_REVENUE).toBe(40500);
    expect(gl.CONTRACTOR_COSTS).toBe(30000);
    expect(gl.GST_OUTPUT).toBe(6075);
    expect(gl.GST_INPUT).toBe(4500);
    expect(gl.CONTRACTOR_PAYABLE).toBe(34500);
    expect((await one(db, `SELECT status FROM jobs WHERE id = $1`, [job.id])).status).toBe('customer_invoiced');
  });

  it('records a receivable when prepaid credit does not cover the invoice', async () => {
    const c = await approvedContractor();
    const fx = await activeCustomer();
    const { job } = await book(fx);
    await completeAndApprove(job.id, c);
    const ci = await invoiceFor(job.id, c);
    const finance = await staff('finance');
    const { draftId } = await approveContractorInvoice(db, finance, ci.id);
    await db.query('UPDATE customers SET prepaid_balance_cents = 10000 WHERE id = $1', [fx.customerId]); // simulate low balance
    const issued = await issueCustomerInvoice(db, finance, draftId);
    expect(issued.prepaid_applied_cents).toBe(10000);
    expect(issued.status).toBe('issued');
    const ar = await one(db, `SELECT SUM(debit_cents - credit_cents)::bigint AS v FROM journal_lines WHERE account_code = 'ACCOUNTS_RECEIVABLE' AND customer_id = $1`, [fx.customerId]);
    expect(ar.v).toBe(issued.total_cents - 10000);
    // Customer pays the remainder by bank transfer.
    await recordBankReceipt(db, finance, { customerId: fx.customerId, amountCents: issued.total_cents - 10000, purpose: 'invoice', customerInvoiceId: issued.id,
      receivedDate: today(), bankReference: 'INV PAY', idempotencyKey: 'inv-pay-1' });
    expect((await one(db, 'SELECT status FROM customer_invoices WHERE id = $1', [issued.id])).status).toBe('paid');
  });

  it('flows higher after-hours contractor cost through to the customer (no double premium)', async () => {
    const { c, job } = await jobReadyForInvoice();
    // Attendance was during standard hours, so billing after-hours is flagged but can be approved with a reason.
    const ci = await submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'AH-1', invoiceDate: today(),
      lines: [{ category: 'labour', description: 'After-hours labour', quantityMilli: 2000, unitRateCents: 12000, timeWindow: 'after_hours' }],
      gstCents: 3600, totalCents: 27600 });
    const finance = await staff('finance');
    const { draftId } = await approveContractorInvoice(db, finance, ci.id, 'Customer requested evening attendance');
    const lines = await query(db, 'SELECT * FROM customer_invoice_lines WHERE invoice_id = $1', [draftId]);
    expect(lines).toHaveLength(1);
    expect(lines[0].amount_ex_gst_cents).toBe(32400); // $240 × 1.35
  });
});

describe('criterion 14: contractor payments are marked paid only after confirmation', () => {
  it('scheduling and exporting do not mark paid; confirmation with reference does', async () => {
    const { c, job } = await jobReadyForInvoice();
    const ci = await invoiceFor(job.id, c);
    const finance = await staff('finance');
    const admin = await staff('admin');
    const { draftId } = await approveContractorInvoice(db, finance, ci.id);
    await issueCustomerInvoice(db, finance, draftId);
    const payable = await one(db, 'SELECT * FROM contractor_payables WHERE contractor_invoice_id = $1', [ci.id]);

    // Unapproved deductions never reduce the payment.
    const adj = await proposeAdjustment(db, finance, payable.id, -2000, 'Rubbish left on site', false);
    await expect(approveForPayment(db, finance, payable.id)).rejects.toThrow(/proposed adjustments/);
    await expect(decideAdjustment(db, admin, adj.id, 'approved')).rejects.toThrow(/contractor's recorded agreement/);
    await decideAdjustment(db, admin, adj.id, 'rejected');

    await approveForPayment(db, finance, payable.id);
    const due = (await one(db, 'SELECT due_date FROM contractor_payables WHERE id = $1', [payable.id])).due_date;
    const batch = await createPaymentBatch(db, finance, { dueOnOrBefore: due });
    const { csv } = await exportBatchCsv(db, finance, batch.id);
    expect(csv).toContain('230.00'); // $200 + GST
    expect((await one(db, 'SELECT status FROM contractor_payables WHERE id = $1', [payable.id])).status).toBe('in_batch');
    expect(await count(`SELECT COUNT(*) AS n FROM contractor_payments WHERE status = 'confirmed'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'contractor_paid'`)).toBe(0);

    const pay = await one(db, 'SELECT * FROM contractor_payments WHERE payable_id = $1', [payable.id]);
    await expect(confirmContractorPayment(db, finance, pay.id, { paidDate: today(), reference: '' })).rejects.toThrow(/reference is required/);
    await confirmContractorPayment(db, finance, pay.id, { paidDate: today(), reference: 'ANZ-TRF-8812' });
    await confirmContractorPayment(db, finance, pay.id, { paidDate: today(), reference: 'ANZ-TRF-8812' });
    expect((await one(db, 'SELECT status FROM contractor_payables WHERE id = $1', [payable.id])).status).toBe('paid');
    expect(await count(`SELECT COUNT(*) AS n FROM journal_entries WHERE source_type = 'contractor_payment'`)).toBe(1);
    const gl = Object.fromEntries((await accountBalances(db)).map((a) => [a.code, a.balance_cents]));
    expect(gl.CONTRACTOR_PAYABLE).toBe(0);

    // With customer settled and contractor paid, the job can close.
    expect((await closeChecks(db, job.id)).canClose).toBe(true);
    await closeJob(db, admin, job.id);
  });

  it('reconciles a bank statement line to the scheduled payment', async () => {
    const { c, job } = await jobReadyForInvoice();
    const ci = await invoiceFor(job.id, c);
    const finance = await staff('finance');
    await approveContractorInvoice(db, finance, ci.id);
    const payable = await one(db, 'SELECT * FROM contractor_payables WHERE contractor_invoice_id = $1', [ci.id]);
    await approveForPayment(db, finance, payable.id);
    await createPaymentBatch(db, finance, { dueOnOrBefore: payable.due_date });
    const res = await reconcileBankStatement(db, finance, `Date,Amount,Particulars,Reference\n${today()},-230.00,RIDGELINE,${(await one(db, 'SELECT ref FROM jobs WHERE id=$1', [job.id])).ref}\n${today()},-55.00,OTHER,XYZ`);
    expect(res.matched).toHaveLength(1);
    expect(res.unmatched).toHaveLength(1);
    expect((await one(db, 'SELECT status FROM contractor_payables WHERE id = $1', [payable.id])).status).toBe('paid');
  });
});

describe('criterion 15: repeated requests and webhooks do not duplicate financial transactions', () => {
  it('processes a Stripe checkout webhook once even when delivered repeatedly', async () => {
    const fx = await activeCustomer();
    const before = (await accountPosition(db, fx.customerId)).balanceCents;
    const p = await requestPayment(db, fx.owner, { customerId: fx.customerId, amountCents: 75000, method: 'card' });
    const event = { id: 'evt_test_1', object: 'event', type: 'checkout.session.completed', data: { object: {
      id: 'cs_test_1', object: 'checkout.session', payment_status: 'paid', payment_intent: 'pi_test_1', client_reference_id: p.id, metadata: { payment_id: p.id } } } };
    const payload = JSON.stringify(event);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' });
    const verified = constructEvent(Buffer.from(payload), header, 'whsec_test_secret');
    expect(() => constructEvent(Buffer.from(payload), header.replace(/v1=./, 'v1=0'), 'whsec_test_secret')).toThrow();

    const results = await Promise.all([handleStripeEvent(db, verified), handleStripeEvent(db, verified), handleStripeEvent(db, verified)]);
    expect(results.filter((r) => r === 'credited')).toHaveLength(1);
    // A different event for the same session (Stripe can send async_payment_succeeded too) is also safe.
    const second = await handleStripeEvent(db, { ...verified, id: 'evt_test_2', type: 'checkout.session.async_payment_succeeded' } as any);
    expect(second).toBe('already_credited');
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(before + 75000);
    expect(await count(`SELECT COUNT(*) AS n FROM prepaid_transactions WHERE payment_id = $1`, [p.id])).toBe(1);
  });

  it('journal entries are idempotent and immutable', async () => {
    const fx = await activeCustomer();
    await expect(db.query(`UPDATE journal_lines SET debit_cents = 1 WHERE customer_id = $1`, [fx.customerId])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM prepaid_transactions WHERE customer_id = $1`, [fx.customerId])).rejects.toThrow(/append-only/);
  });
});

describe('criterion 16: refunds, variations, cancellations and disputes retain audit history', () => {
  it('variation: priced by Ridgeline, approved by customer, extends authorised scope', async () => {
    const c = await approvedContractor();
    const fx = await activeCustomer();
    const { job } = await book(fx);
    const offer = await one(db, `SELECT id FROM job_offers WHERE job_id = $1`, [job.id]);
    await acceptOffer(db, c.actor, offer.id);
    await recordArrival(db, c.actor, job.id);
    const q = await submitQuote(db, c.actor, job.id, 'variation', 'Replace corroded pipe section', [{ category: 'labour', description: '1h extra', quantityMilli: 1000, unitRateCents: 8000 }]);
    expect(q.customer_price_ex_gst_cents).toBe(10800);
    await reviewQuote(db, await staff('ops'), q.id, 'send');
    const authBefore = (await one(db, 'SELECT authorised_contractor_cost_cents AS a FROM jobs WHERE id = $1', [job.id])).a;
    await customerDecideQuote(db, fx.owner, q.id, 'approved');
    expect((await one(db, 'SELECT authorised_contractor_cost_cents AS a FROM jobs WHERE id = $1', [job.id])).a).toBe(authBefore + 8000);
    const events = await query(db, `SELECT event_type FROM job_events WHERE job_id = $1 ORDER BY id`, [job.id]);
    expect(events.map((e) => e.event_type)).toEqual(expect.arrayContaining(['variation.submitted', 'variation.sent_to_customer', 'variation.approved']));
  });

  it('late cancellation is billable and the contractor can invoice the agreed cancellation fee', async () => {
    const c = await approvedContractor();
    const fx = await activeCustomer();
    const { job } = await book(fx, { preferredStart: new Date(Date.now() + 30 * 60000).toISOString() });
    await manualAssign(db, await staff('ops'), job.id, c.contractorId);
    const r = await cancelJob(db, fx.owner, job.id, 'Tenant not home');
    expect(r.billable).toBe(true);
    const ci = await submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'CXL-1', invoiceDate: today(),
      lines: [{ category: 'cancellation', description: 'Late cancellation', quantityMilli: 1000, unitRateCents: 8000 }], gstCents: 1200, totalCents: 9200 });
    expect(ci.status).toBe('submitted');
    const { draftId } = await approveContractorInvoice(db, await staff('finance'), ci.id);
    const draft = await one(db, 'SELECT subtotal_ex_gst_cents FROM customer_invoices WHERE id = $1', [draftId]);
    expect(draft.subtotal_ex_gst_cents).toBe(10800); // no minimum job charge on cancellations
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job.cancelled' AND entity_id = $1`, [job.id])).toBe(1);
  });

  it('dispute: holds invoicing and contractor payment, resolves with a credit note, keeps history', async () => {
    const { c, fx, job } = await jobReadyForInvoice();
    const ci = await invoiceFor(job.id, c);
    const finance = await staff('finance');
    const { draftId } = await approveContractorInvoice(db, finance, ci.id);
    await issueCustomerInvoice(db, finance, draftId);
    const balanceAfterInvoice = (await accountPosition(db, fx.customerId)).balanceCents;

    const d = await raiseDispute(db, fx.owner, job.id, 'Tap still drips');
    const payable = await one(db, 'SELECT status, hold_reason FROM contractor_payables WHERE contractor_invoice_id = $1', [ci.id]);
    expect(payable.status).toBe('on_hold');
    expect((await closeChecks(db, job.id)).outstanding).toContain('Open dispute');

    await resolveDispute(db, finance, d.id, { outcome: 'resolved', resolution: 'Partial credit for return visit', creditExGstCents: 5000 });
    const cn = await one(db, 'SELECT * FROM credit_notes WHERE dispute_id = $1', [d.id]);
    expect(cn.total_cents).toBe(5750);
    expect(cn.to_prepaid_cents).toBe(5750); // invoice was fully prepaid, so credit returns to the balance
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(balanceAfterInvoice + 5750);
    expect((await one(db, 'SELECT status FROM contractor_payables WHERE contractor_invoice_id = $1', [ci.id])).status).toBe('awaiting_payment_approval');
    expect((await reconcileCustomerBalance(db, fx.customerId)).ok).toBe(true);
    const audit = await query(db, `SELECT action FROM audit_log WHERE action LIKE 'dispute.%' OR action = 'credit_note.issued'`);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['dispute.raised', 'credit_note.issued', 'dispute.resolved']));
    await expect(db.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });

  it('credit note against an unpaid invoice reduces the receivable first', async () => {
    const { c, fx, job } = await jobReadyForInvoice();
    const ci = await invoiceFor(job.id, c);
    const finance = await staff('finance');
    const { draftId } = await approveContractorInvoice(db, finance, ci.id);
    await db.query('UPDATE customers SET auto_apply_prepaid = false WHERE id = $1', [fx.customerId]);
    const inv = await issueCustomerInvoice(db, finance, draftId);
    expect(inv.prepaid_applied_cents).toBe(0);
    const cn = await createCreditNote(db, finance, inv.id, { amountExGstCents: 1000, reason: 'Goodwill' });
    expect(cn.to_receivable_cents).toBe(1150);
    await applyPrepaidToInvoice(db, finance, inv.id);
    expect((await one(db, 'SELECT status FROM customer_invoices WHERE id = $1', [inv.id])).status).toBe('paid');
    expect((await reconcileCustomerBalance(db, fx.customerId)).ok).toBe(true);
  });
});
