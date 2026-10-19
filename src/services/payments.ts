import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { SYSTEM_ACTOR, isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { formatNzd } from '../lib/money.js';
import { audit } from './audit.js';
import { assertCustomerAccess } from './customers.js';
import { applyInvoicePayment, reverseInvoicePayment } from './customerInvoices.js';
import { recheckPendingFunding } from './jobs.js';
import { type AccountCode, accountPosition, postJournal, prepaidMovement } from './ledger.js';
import { link, notifyCustomer, notifyStaff } from './notifications.js';
import { getSettings } from './settings.js';

export type PaymentMethod = 'bank_transfer' | 'card' | 'other';

function clearingAccount(method: string): AccountCode {
  return method === 'card' ? 'STRIPE_CLEARING' : 'BANK';
}

export interface TopUpRequestInput {
  customerId: string;
  amountCents: number;
  method: PaymentMethod;
  purpose?: 'deposit' | 'top_up' | 'invoice';
  customerInvoiceId?: string | null;
  idempotencyKey?: string;
  isAutoTopUp?: boolean;
}

/** Creates a pending payment request. Nothing is credited until the payment is confirmed. */
export async function requestPayment(db: Db, actor: Actor, input: TopUpRequestInput) {
  assertCustomerAccess(actor, input.customerId);
  if (actor.role === 'customer' && actor.customerRole === 'viewer') throw new ForbiddenError();
  if (!Number.isInteger(input.amountCents) || input.amountCents < 100) throw new AppError('Minimum payment is $1.00');
  if (input.amountCents > 100_000_000) throw new AppError('Amount is too large');
  const customer = await maybeOne(db, 'SELECT * FROM customers WHERE id = $1', [input.customerId]);
  if (!customer) throw new NotFoundError('Customer');
  if (customer.status === 'closed') throw new AppError('Account is closed');
  let purpose = input.purpose ?? (customer.status === 'pending_deposit' ? 'deposit' : 'top_up');
  if (purpose === 'invoice') {
    const inv = await maybeOne(db, `SELECT * FROM customer_invoices WHERE id = $1 AND customer_id = $2`, [input.customerInvoiceId, input.customerId]);
    if (!inv || !['issued', 'partially_paid'].includes(inv.status)) throw new AppError('Invoice is not payable');
    const due = inv.total_cents - inv.prepaid_applied_cents - inv.amount_paid_cents - inv.credited_cents;
    if (input.amountCents > due) throw new AppError(`Amount exceeds the ${formatNzd(due)} outstanding`);
  } else if (input.customerInvoiceId) {
    purpose = 'invoice';
  }
  const existing = input.idempotencyKey ? await maybeOne(db, 'SELECT * FROM customer_payments WHERE idempotency_key = $1', [input.idempotencyKey]) : null;
  if (existing) return existing;
  const payment = await one(db,
    `INSERT INTO customer_payments (customer_id, purpose, customer_invoice_id, method, amount_cents, requested_by, idempotency_key, is_auto_topup)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [input.customerId, purpose, input.customerInvoiceId ?? null, input.method, input.amountCents, actor.id, input.idempotencyKey ?? null, input.isAutoTopUp ?? false]);
  const row = payment ?? await one(db, 'SELECT * FROM customer_payments WHERE idempotency_key = $1', [input.idempotencyKey]);
  await audit(db, actor, { action: 'payment.requested', entityType: 'customer_payment', entityId: row.id, customerId: input.customerId,
    details: { amount: input.amountCents, method: input.method, purpose } });
  return row;
}

export interface ConfirmPaymentInput {
  receivedDate?: string;
  bankReference?: string;
  providerPaymentId?: string;
}

/**
 * Confirms that money was actually received and credits it exactly once (row lock + payment status +
 * idempotent ledger key). Safe to call repeatedly, e.g. from retried webhooks.
 */
export async function confirmPayment(db: Db, actor: Actor, paymentId: string, input: ConfirmPaymentInput = {}): Promise<{ payment: any; credited: boolean }> {
  if (actor.role !== 'system' && actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError('Only finance can confirm payments');
  const out = await tx(db, async (c) => {
    const payment = await maybeOne(c, 'SELECT * FROM customer_payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!payment) throw new NotFoundError('Payment');
    if (payment.status === 'succeeded') return { payment, credited: false };
    if (payment.status !== 'pending') throw new AppError(`Payment is ${payment.status} and cannot be confirmed`, 409);
    const counter = clearingAccount(payment.method);
    if (payment.purpose === 'invoice') {
      await applyInvoicePayment(c, actor, payment.customer_invoice_id, payment.amount_cents, { paymentId, counterAccount: counter });
    } else {
      await prepaidMovement(c, actor, {
        customerId: payment.customer_id, type: payment.purpose, amountCents: payment.amount_cents,
        description: `${payment.purpose === 'deposit' ? 'Initial prepaid deposit' : 'Prepaid top-up'} ${payment.reference}`,
        reference: input.bankReference || payment.reference, paymentId, idempotencyKey: `payment:${paymentId}`,
        counterLines: [{ account: counter, debit: payment.amount_cents, customerId: payment.customer_id }],
        sourceType: 'customer_payment', sourceId: paymentId,
      });
    }
    const updated = await one(c,
      `UPDATE customer_payments SET status = 'succeeded', confirmed_by = $2, confirmed_at = now(), received_date = COALESCE($3::date, CURRENT_DATE),
          bank_reference = COALESCE($4, bank_reference), provider_payment_id = COALESCE($5, provider_payment_id)
        WHERE id = $1 RETURNING *`,
      [paymentId, actor.id, input.receivedDate ?? null, input.bankReference ?? null, input.providerPaymentId ?? null]);
    if (payment.purpose !== 'invoice') {
      // Activate the account once the agreed minimum has been funded.
      await c.query(
        `UPDATE customers SET status = 'active', updated_at = now()
          WHERE id = $1 AND status = 'pending_deposit' AND agreed_minimum_balance_cents IS NOT NULL AND prepaid_balance_cents >= agreed_minimum_balance_cents`,
        [payment.customer_id]);
      const pos = await accountPosition(c, payment.customer_id);
      if (!pos.belowMinimum) await c.query('UPDATE customers SET low_balance_alerted_at = NULL WHERE id = $1', [payment.customer_id]);
    }
    await notifyCustomer(c, payment.customer_id, {
      template: 'payment_received', subject: `Payment received: ${formatNzd(payment.amount_cents)}`,
      body: `We have received your payment ${payment.reference} of ${formatNzd(payment.amount_cents)}. ` +
        (payment.purpose === 'invoice' ? 'It has been applied to your invoice.' : 'It has been credited to your prepaid maintenance account.') +
        `\n${link('/app/account')}`,
      idempotencyKey: `payment-received:${paymentId}`,
    }, { includeBillingEmail: true });
    await audit(c, actor, { action: 'payment.confirmed', entityType: 'customer_payment', entityId: paymentId, customerId: payment.customer_id,
      details: { amount: payment.amount_cents, ...input } });
    return { payment: updated, credited: true };
  });
  if (out.credited && out.payment.purpose !== 'invoice') await recheckPendingFunding(db, out.payment.customer_id);
  return out;
}

/** Finance records a bank receipt that has been seen on the bank statement (creates and confirms in one step). */
export async function recordBankReceipt(db: Db, actor: Actor, input: { customerId: string; amountCents: number; purpose?: 'deposit' | 'top_up' | 'invoice';
  customerInvoiceId?: string | null; receivedDate: string; bankReference: string; idempotencyKey: string }) {
  if (actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError();
  if (!input.bankReference?.trim()) throw new AppError('Bank reference is required to record a receipt');
  const payment = await requestPayment(db, actor, { customerId: input.customerId, amountCents: input.amountCents, method: 'bank_transfer',
    purpose: input.purpose, customerInvoiceId: input.customerInvoiceId, idempotencyKey: input.idempotencyKey });
  return confirmPayment(db, actor, payment.id, { receivedDate: input.receivedDate, bankReference: input.bankReference });
}

export async function failPayment(db: Db, actor: Actor, paymentId: string, reason: string) {
  if (actor.role !== 'system' && actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError();
  return tx(db, async (c) => {
    const payment = await maybeOne(c, 'SELECT * FROM customer_payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!payment) throw new NotFoundError('Payment');
    if (payment.status !== 'pending') return payment;
    const updated = await one(c, `UPDATE customer_payments SET status = 'failed', failure_reason = $2 WHERE id = $1 RETURNING *`, [paymentId, reason]);
    await notifyCustomer(c, payment.customer_id, {
      template: 'payment_failed', subject: `Payment ${payment.reference} was not completed`,
      body: `Your payment of ${formatNzd(payment.amount_cents)} (${payment.reference}) failed: ${reason}. No funds were credited.\n${link('/app/account')}`,
      idempotencyKey: `payment-failed:${paymentId}`,
    });
    await notifyStaff(c, ['finance', 'admin'], { template: 'payment_failed_staff', subject: `Failed payment ${payment.reference}`,
      body: `Payment ${payment.reference} of ${formatNzd(payment.amount_cents)} failed: ${reason}`, idempotencyKey: `payment-failed-staff:${paymentId}` });
    await audit(c, actor, { action: 'payment.failed', entityType: 'customer_payment', entityId: paymentId, customerId: payment.customer_id, details: { reason } });
    return updated;
  });
}

/**
 * Reverses a confirmed payment (e.g. dishonoured transfer or card chargeback). Prepaid credit is clawed back;
 * any amount already spent becomes a receivable rather than driving the prepaid balance negative.
 */
export async function reversePayment(db: Db, actor: Actor, paymentId: string, reason: string) {
  if (actor.role !== 'system' && actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError();
  if (!reason?.trim()) throw new AppError('A reason is required');
  return tx(db, async (c) => {
    const payment = await maybeOne(c, 'SELECT * FROM customer_payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!payment) throw new NotFoundError('Payment');
    if (payment.status === 'reversed') return payment;
    if (payment.status !== 'succeeded') throw new AppError('Only confirmed payments can be reversed', 409);
    const counter = clearingAccount(payment.method);
    if (payment.purpose === 'invoice') {
      await reverseInvoicePayment(c, actor, payment.customer_invoice_id, payment.amount_cents, { paymentId, counterAccount: counter });
    } else {
      const cust = await one(c, 'SELECT prepaid_balance_cents FROM customers WHERE id = $1 FOR UPDATE', [payment.customer_id]);
      const fromPrepaid = Math.min(cust.prepaid_balance_cents, payment.amount_cents);
      const toReceivable = payment.amount_cents - fromPrepaid;
      if (fromPrepaid > 0) {
        await prepaidMovement(c, actor, {
          customerId: payment.customer_id, type: 'reversal', amountCents: -fromPrepaid,
          description: `Reversal of payment ${payment.reference}: ${reason}`, reference: payment.reference, paymentId,
          idempotencyKey: `payment-reversal:${paymentId}`,
          counterLines: [
            { account: counter, credit: payment.amount_cents, customerId: payment.customer_id },
            { account: 'ACCOUNTS_RECEIVABLE', debit: toReceivable, customerId: payment.customer_id },
          ],
          sourceType: 'customer_payment_reversal', sourceId: paymentId,
        });
      } else {
        await postJournal(c, actor, { description: `Reversal of payment ${payment.reference} (already spent): ${reason}`,
          sourceType: 'customer_payment_reversal', sourceId: paymentId, idempotencyKey: `payment-reversal:${paymentId}`,
          lines: [{ account: counter, credit: payment.amount_cents, customerId: payment.customer_id },
                  { account: 'ACCOUNTS_RECEIVABLE', debit: payment.amount_cents, customerId: payment.customer_id }] });
      }
    }
    const updated = await one(c, `UPDATE customer_payments SET status = 'reversed', failure_reason = $2 WHERE id = $1 RETURNING *`, [paymentId, reason]);
    await notifyCustomer(c, payment.customer_id, { template: 'payment_reversed', subject: `Payment ${payment.reference} reversed`,
      body: `Your payment ${payment.reference} of ${formatNzd(payment.amount_cents)} was reversed: ${reason}. Your account has been adjusted.\n${link('/app/account')}`,
      idempotencyKey: `payment-reversed:${paymentId}` }, { includeBillingEmail: true });
    await audit(c, actor, { action: 'payment.reversed', entityType: 'customer_payment', entityId: paymentId, customerId: payment.customer_id, details: { reason } });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Refunds of prepaid balance
// ---------------------------------------------------------------------------

export async function requestRefund(db: Db, actor: Actor, customerId: string, amountCents: number, reason: string) {
  assertCustomerAccess(actor, customerId);
  if (actor.role === 'customer' && actor.customerRole !== 'owner') throw new ForbiddenError('Only the account owner can request refunds');
  if (!reason?.trim()) throw new AppError('A reason is required');
  const pos = await accountPosition(db, customerId);
  if (amountCents <= 0 || amountCents > pos.availableCents) throw new AppError(`Refund must be between $0.01 and the available balance of ${formatNzd(pos.availableCents)}`);
  const r = await one(db, `INSERT INTO refunds (customer_id, amount_cents, reason, requested_by) VALUES ($1,$2,$3,$4) RETURNING *`, [customerId, amountCents, reason, actor.id]);
  await notifyStaff(db, ['finance', 'admin'], { template: 'refund_requested', subject: `Refund requested: ${formatNzd(amountCents)}`,
    body: `A refund of ${formatNzd(amountCents)} has been requested. Reason: ${reason}\n${link('/admin/refunds')}`, idempotencyKey: `refund-req:${r.id}` });
  await audit(db, actor, { action: 'refund.requested', entityType: 'refund', entityId: r.id, customerId, details: { amountCents, reason } });
  return r;
}

export async function decideRefund(db: Db, actor: Actor, refundId: string, decision: 'approved' | 'rejected', note?: string) {
  if (actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError();
  return tx(db, async (c) => {
    const r = await maybeOne(c, 'SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId]);
    if (!r) throw new NotFoundError('Refund');
    if (r.status !== 'requested') throw new AppError('Refund already decided', 409);
    if (decision === 'approved') {
      const pos = await accountPosition(c, r.customer_id);
      if (r.amount_cents > pos.availableCents) throw new AppError(`Available balance is only ${formatNzd(pos.availableCents)}`, 409);
    }
    const updated = await one(c, `UPDATE refunds SET status = $2, approved_by = $3, approved_at = now(), rejection_reason = $4 WHERE id = $1 RETURNING *`,
      [refundId, decision, actor.id, decision === 'rejected' ? note ?? null : null]);
    await audit(c, actor, { action: `refund.${decision}`, entityType: 'refund', entityId: refundId, customerId: r.customer_id, details: { note } });
    return updated;
  });
}

/** Records that an approved refund was actually paid out; only then is the prepaid balance reduced. */
export async function markRefundPaid(db: Db, actor: Actor, refundId: string, input: { paidReference: string; paidDate: string }) {
  if (actor.role !== 'admin' && actor.role !== 'finance') throw new ForbiddenError();
  if (!input.paidReference?.trim()) throw new AppError('Payment reference is required');
  return tx(db, async (c) => {
    const r = await maybeOne(c, 'SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId]);
    if (!r) throw new NotFoundError('Refund');
    if (r.status === 'paid') return r;
    if (r.status !== 'approved') throw new AppError('Refund must be approved before it is paid', 409);
    const pos = await accountPosition(c, r.customer_id);
    if (r.amount_cents > pos.availableCents) throw new AppError(`Available balance is only ${formatNzd(pos.availableCents)}`, 409);
    await prepaidMovement(c, actor, {
      customerId: r.customer_id, type: 'refund', amountCents: -r.amount_cents, description: `Refund of prepaid balance: ${r.reason}`,
      reference: input.paidReference, idempotencyKey: `refund:${refundId}`,
      counterLines: [{ account: 'BANK', credit: r.amount_cents, customerId: r.customer_id }], sourceType: 'refund', sourceId: refundId,
    });
    const updated = await one(c, `UPDATE refunds SET status = 'paid', paid_reference = $2, paid_date = $3, paid_by = $4 WHERE id = $1 RETURNING *`,
      [refundId, input.paidReference, input.paidDate, actor.id]);
    await notifyCustomer(c, r.customer_id, { template: 'refund_paid', subject: `Refund paid: ${formatNzd(r.amount_cents)}`,
      body: `We have paid your refund of ${formatNzd(r.amount_cents)} (reference ${input.paidReference}).`, idempotencyKey: `refund-paid:${refundId}` }, { includeBillingEmail: true });
    await audit(c, actor, { action: 'refund.paid', entityType: 'refund', entityId: refundId, customerId: r.customer_id, details: input });
    return updated;
  });
}

/** Staff balance adjustment (e.g. goodwill credit). Requires administrator and a reason. */
export async function adjustPrepaidBalance(db: Db, actor: Actor, customerId: string, amountCents: number, reason: string, idempotencyKey: string) {
  if (actor.role !== 'admin') throw new ForbiddenError('Only an administrator can adjust prepaid balances');
  if (!reason?.trim()) throw new AppError('A reason is required');
  // Goodwill credits are a cost to Ridgeline; debits recover amounts owed and reduce revenue.
  const res = await prepaidMovement(db, actor, {
    customerId, type: 'adjustment', amountCents, description: `Adjustment: ${reason}`, idempotencyKey: `adjustment:${idempotencyKey}`,
    counterLines: [amountCents > 0
      ? { account: 'MAINTENANCE_REVENUE', debit: amountCents, customerId }
      : { account: 'MAINTENANCE_REVENUE', credit: -amountCents, customerId }],
    sourceType: 'adjustment',
  });
  await audit(db, actor, { action: 'prepaid.adjusted', entityType: 'customer', entityId: customerId, customerId, details: { amountCents, reason } });
  return res;
}

// ---------------------------------------------------------------------------
// Automatic top-ups (explicit customer consent required)
// ---------------------------------------------------------------------------

export const AUTO_TOPUP_CONSENT_TEXT = (amount: string, trigger: string) =>
  `I authorise Ridgeline Facilities to request a top-up of ${amount} to our prepaid maintenance account whenever the balance falls below ${trigger}. ` +
  'I understand I can withdraw this authority at any time from the account page, and that no payment is taken without a payment method I have authorised.';

export async function grantAutoTopUpConsent(db: Db, actor: Actor, customerId: string, amountCents: number, triggerBelowCents: number, confirmed: boolean) {
  assertCustomerAccess(actor, customerId);
  if (actor.role !== 'customer' || actor.customerRole !== 'owner') throw new ForbiddenError('Only the account owner can authorise automatic top-ups');
  if (!confirmed) throw new AppError('You must tick the consent box to authorise automatic top-ups');
  if (amountCents < 10000) throw new AppError('Automatic top-ups must be at least $100');
  return tx(db, async (c) => {
    await c.query(`UPDATE auto_topup_consents SET revoked_at = now(), revoked_by = $2 WHERE customer_id = $1 AND revoked_at IS NULL`, [customerId, actor.id]);
    const consent = await one(c,
      `INSERT INTO auto_topup_consents (customer_id, consented_by, amount_cents, trigger_below_cents, consent_text) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [customerId, actor.id, amountCents, triggerBelowCents, AUTO_TOPUP_CONSENT_TEXT(formatNzd(amountCents), formatNzd(triggerBelowCents))]);
    await audit(c, actor, { action: 'auto_topup.consented', entityType: 'auto_topup_consent', entityId: consent.id, customerId, details: { amountCents, triggerBelowCents } });
    return consent;
  });
}

export async function revokeAutoTopUpConsent(db: Db, actor: Actor, customerId: string) {
  assertCustomerAccess(actor, customerId);
  if (actor.role === 'customer' && actor.customerRole !== 'owner') throw new ForbiddenError();
  await db.query(`UPDATE auto_topup_consents SET revoked_at = now(), revoked_by = $2 WHERE customer_id = $1 AND revoked_at IS NULL`, [customerId, actor.id]);
  await audit(db, actor, { action: 'auto_topup.revoked', entityType: 'customer', entityId: customerId, customerId });
}

/**
 * Worker: low-balance alerts and consented automatic top-up requests. Automatic top-ups create a pending
 * payment request and notify the customer; funds are credited only when the payment is confirmed.
 */
export async function processLowBalances(db: Db): Promise<{ alerts: number; autoTopUps: number }> {
  const settings = await getSettings(db);
  let alerts = 0, autoTopUps = 0;
  const customers = await query(db,
    `SELECT c.*, a.id AS consent_id, a.amount_cents AS auto_amount, a.trigger_below_cents
       FROM customers c LEFT JOIN auto_topup_consents a ON a.customer_id = c.id AND a.revoked_at IS NULL
      WHERE c.status = 'active' AND c.agreed_minimum_balance_cents IS NOT NULL`);
  for (const c of customers) {
    const threshold = Math.round((c.agreed_minimum_balance_cents * settings.low_balance_alert_bps) / 10000);
    const pos = await accountPosition(db, c.id);
    if (c.consent_id && pos.balanceCents < c.trigger_below_cents) {
      const pending = await maybeOne(db, `SELECT 1 FROM customer_payments WHERE customer_id = $1 AND is_auto_topup AND status = 'pending'`, [c.id]);
      if (!pending) {
        const p = await requestPayment(db, SYSTEM_ACTOR, { customerId: c.id, amountCents: c.auto_amount, method: 'bank_transfer', purpose: 'top_up',
          isAutoTopUp: true, idempotencyKey: `auto-topup:${c.id}:${new Date().toISOString().slice(0, 10)}` });
        await notifyCustomer(db, c.id, { template: 'auto_topup_requested', subject: `Automatic top-up requested: ${formatNzd(c.auto_amount)}`,
          body: `As authorised, we have requested a top-up of ${formatNzd(c.auto_amount)}. Please pay using reference ${p.reference}.\n${link('/app/account')}`,
          idempotencyKey: `auto-topup-notify:${p.id}` }, { includeBillingEmail: true });
        autoTopUps++;
      }
    }
    const recentlyAlerted = c.low_balance_alerted_at && Date.now() - new Date(c.low_balance_alerted_at).getTime() < settings.low_balance_reminder_days * 86400000;
    if (pos.balanceCents < threshold && !recentlyAlerted) {
      await notifyCustomer(db, c.id, { template: 'low_balance', subject: 'Prepaid maintenance balance is low',
        body: `Your prepaid balance is ${formatNzd(pos.balanceCents)}, below your agreed minimum of ${formatNzd(c.agreed_minimum_balance_cents)}. ` +
          `Please top up at least ${formatNzd(pos.shortfallToMinimumCents)} so routine jobs can continue to be dispatched.\n${link('/app/account')}`,
        idempotencyKey: `low-balance:${c.id}:${new Date().toISOString().slice(0, 10)}` }, { includeBillingEmail: true });
      await db.query('UPDATE customers SET low_balance_alerted_at = now() WHERE id = $1', [c.id]);
      alerts++;
    }
  }
  return { alerts, autoTopUps };
}

export function canSeePayments(actor: Actor, customerId: string): boolean {
  return isStaff(actor) || (actor.role === 'customer' && actor.customerId === customerId);
}
