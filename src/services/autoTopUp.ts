import Stripe from 'stripe';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { SYSTEM_ACTOR } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { audit } from './audit.js';
import { assertCustomerAccess } from './customers.js';
import { accountPosition } from './ledger.js';
import { link, notifyCustomer, notifyStaff } from './notifications.js';
import { confirmPayment, failPayment, requestPayment } from './payments.js';
import { getSettings } from './settings.js';
import { stripeClient, stripeEnabled } from './stripe.js';

/**
 * Saved-card automatic top-ups.
 *
 * 1. The account owner saves a card through Stripe Checkout in setup mode (card details never touch our servers;
 *    Stripe performs any 3-D Secure authentication at that point and records the card for off-session use).
 * 2. The owner gives explicit consent (amount + trigger threshold); the consent records the card it applies to.
 * 3. When the prepaid balance falls below the threshold, the worker creates an off-session PaymentIntent. The
 *    balance is credited only when Stripe reports the PaymentIntent succeeded (synchronously or by webhook) —
 *    both paths are idempotent. Declines are recorded, the customer is told, and after repeated failures
 *    automatic charging pauses until the card is updated.
 */

function nzDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(d);
}

export async function ensureStripeCustomer(db: Db, customerId: string): Promise<string> {
  const customer = await one(db, 'SELECT id, name, billing_email, account_ref, stripe_customer_id FROM customers WHERE id = $1', [customerId]);
  if (customer.stripe_customer_id) return customer.stripe_customer_id;
  const created = await stripeClient().customers.create(
    { name: customer.name, email: customer.billing_email, metadata: { customer_id: customer.id, account_ref: customer.account_ref } },
    { idempotencyKey: `stripe-customer:${customer.id}` });
  await db.query('UPDATE customers SET stripe_customer_id = COALESCE(stripe_customer_id, $2) WHERE id = $1', [customerId, created.id]);
  return (await one(db, 'SELECT stripe_customer_id FROM customers WHERE id = $1', [customerId])).stripe_customer_id;
}

function assertOwner(actor: Actor, customerId: string): void {
  assertCustomerAccess(actor, customerId);
  if (actor.role !== 'customer' || actor.customerRole !== 'owner') throw new ForbiddenError('Only the account owner can manage saved cards');
}

/** Starts Stripe Checkout (setup mode) so the owner can save a card for automatic top-ups. Returns the redirect URL. */
export async function createCardSetupCheckout(db: Db, actor: Actor, customerId: string): Promise<string> {
  assertOwner(actor, customerId);
  if (!stripeEnabled()) throw new AppError('Card payments are not configured', 409);
  const stripeCustomer = await ensureStripeCustomer(db, customerId);
  const company = (await getSettings(db)).company;
  const session = await stripeClient().checkout.sessions.create({
    mode: 'setup',
    customer: stripeCustomer,
    payment_method_types: ['card'],
    metadata: { customer_id: customerId, user_id: actor.id ?? '', purpose: 'auto_topup_card' },
    setup_intent_data: {
      metadata: { customer_id: customerId, user_id: actor.id ?? '', purpose: 'auto_topup_card' },
      description: `Card saved for automatic prepaid top-ups with ${company.legal_name} trading as ${company.trading_name}`,
    },
    success_url: `${config.baseUrl}/app/account?card=saved`,
    cancel_url: `${config.baseUrl}/app/account?card=cancelled`,
  });
  await audit(db, actor, { action: 'card.setup_started', entityType: 'customer', entityId: customerId, customerId });
  return session.url!;
}

/**
 * Records a succeeded SetupIntent as the customer's active card (replacing any previous card) and links it to an
 * active automatic top-up consent. Idempotent on the SetupIntent ID.
 */
export async function recordSetupIntent(db: Db, actor: Actor, setupIntentId: string) {
  const si = await stripeClient().setupIntents.retrieve(setupIntentId, { expand: ['payment_method'] });
  if (si.status !== 'succeeded') throw new AppError(`Card setup is ${si.status}`, 409);
  const customerId = si.metadata?.customer_id;
  if (!customerId) throw new AppError('SetupIntent is not linked to a Ridgeline customer', 400);
  return tx(db, async (c) => {
    const customer = await one(c, 'SELECT id, stripe_customer_id FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
    const siCustomer = typeof si.customer === 'string' ? si.customer : si.customer?.id;
    if (!customer.stripe_customer_id || siCustomer !== customer.stripe_customer_id) throw new AppError('SetupIntent customer does not match the account', 400);
    const existing = await maybeOne(c, 'SELECT * FROM customer_payment_methods WHERE provider_setup_id = $1', [si.id]);
    if (existing) return existing;
    const pm = si.payment_method as Stripe.PaymentMethod;
    await c.query(`UPDATE customer_payment_methods SET status = 'replaced', removed_at = now() WHERE customer_id = $1 AND status = 'active'`, [customerId]);
    const row = await one(c,
      `INSERT INTO customer_payment_methods (customer_id, provider_pm_id, provider_setup_id, brand, last4, exp_month, exp_year, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (provider_pm_id) DO UPDATE SET status = 'active', removed_at = NULL, provider_setup_id = EXCLUDED.provider_setup_id RETURNING *`,
      [customerId, pm.id, si.id, pm.card?.brand ?? null, pm.card?.last4 ?? null, pm.card?.exp_month ?? null, pm.card?.exp_year ?? null,
       si.metadata?.user_id || actor.id || null]);
    await c.query(`UPDATE auto_topup_consents SET payment_method_id = $2, failure_count = 0, last_failure_reason = NULL WHERE customer_id = $1 AND revoked_at IS NULL`,
      [customerId, row.id]);
    await audit(c, actor, { action: 'card.saved', entityType: 'customer_payment_method', entityId: row.id, customerId, details: { brand: row.brand, last4: row.last4 } });
    return row;
  });
}

export async function removeCard(db: Db, actor: Actor, customerId: string) {
  assertOwner(actor, customerId);
  const pm = await maybeOne(db, `SELECT * FROM customer_payment_methods WHERE customer_id = $1 AND status = 'active'`, [customerId]);
  if (!pm) throw new NotFoundError('Saved card');
  if (stripeEnabled()) await stripeClient().paymentMethods.detach(pm.provider_pm_id).catch((e) => { if (e?.code !== 'resource_missing') throw e; });
  await db.query(`UPDATE customer_payment_methods SET status = 'removed', removed_at = now() WHERE id = $1`, [pm.id]);
  await db.query(`UPDATE auto_topup_consents SET payment_method_id = NULL WHERE customer_id = $1 AND payment_method_id = $2`, [customerId, pm.id]);
  await audit(db, actor, { action: 'card.removed', entityType: 'customer_payment_method', entityId: pm.id, customerId });
}

export type ChargeOutcome = 'succeeded' | 'processing' | 'failed' | 'skipped';

/** Charges a consented saved card off-session for one automatic top-up. Safe to call repeatedly (idempotent per day). */
export async function chargeAutoTopUp(db: Db, consentId: string): Promise<{ outcome: ChargeOutcome; paymentId?: string; reason?: string }> {
  const settings = await getSettings(db);
  const consent = await maybeOne(db,
    `SELECT a.*, pm.provider_pm_id, pm.status AS pm_status, pm.last4, pm.brand, c.stripe_customer_id, c.status AS customer_status
       FROM auto_topup_consents a JOIN customers c ON c.id = a.customer_id LEFT JOIN customer_payment_methods pm ON pm.id = a.payment_method_id
      WHERE a.id = $1`, [consentId]);
  if (!consent || consent.revoked_at) return { outcome: 'skipped', reason: 'no active consent' };
  if (!consent.provider_pm_id || consent.pm_status !== 'active') return { outcome: 'skipped', reason: 'no active saved card' };
  if (consent.failure_count >= settings.auto_topup_max_failures) return { outcome: 'skipped', reason: 'paused after repeated failures' };
  if (!stripeEnabled()) return { outcome: 'skipped', reason: 'Stripe not configured' };

  const today = nzDate();
  // One payment record per consent per NZ day; retries (e.g. after a network error) reuse it and its Stripe idempotency key.
  const payment = await requestPayment(db, SYSTEM_ACTOR, {
    customerId: consent.customer_id, amountCents: consent.amount_cents, method: 'card', purpose: 'top_up', isAutoTopUp: true,
    idempotencyKey: `auto-topup:${consent.id}:${today}`,
  });
  if (payment.status === 'succeeded') return { outcome: 'skipped', paymentId: payment.id, reason: 'already topped up today' };
  if (payment.status !== 'pending') return { outcome: 'skipped', paymentId: payment.id, reason: `already ${payment.status} today` };
  await db.query('UPDATE auto_topup_consents SET last_attempt_at = now() WHERE id = $1', [consent.id]);
  const company = settings.company;

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripeClient().paymentIntents.create({
      amount: consent.amount_cents, currency: 'nzd', customer: consent.stripe_customer_id, payment_method: consent.provider_pm_id,
      // Card only: avoids redirect-based methods that would need a return_url for an off-session confirmation.
      payment_method_types: ['card'], off_session: true, confirm: true,
      description: `Automatic prepaid top-up ${payment.reference}`,
      metadata: { purpose: 'auto_topup', payment_id: payment.id, customer_id: consent.customer_id, consent_id: consent.id, merchant: company.legal_name },
    }, { idempotencyKey: `auto-topup-pi:${payment.id}` });
  } catch (err) {
    const e = err as Stripe.errors.StripeError;
    if (e?.type === 'StripeCardError') {
      const piId = (e.raw as any)?.payment_intent?.id ?? (e as any).payment_intent?.id ?? null;
      if (piId) await db.query('UPDATE customer_payments SET provider = $2, provider_payment_id = COALESCE(provider_payment_id, $3) WHERE id = $1', [payment.id, 'stripe', piId]);
      await recordAutoTopUpFailure(db, payment.id, consent, e.code ?? e.decline_code ?? 'card_error', e.message);
      return { outcome: 'failed', paymentId: payment.id, reason: e.message };
    }
    // Network/API errors: the payment stays pending and the next run retries with the same idempotency key,
    // so Stripe returns the original result instead of charging twice.
    await db.query('UPDATE auto_topup_consents SET last_failure_reason = $2 WHERE id = $1', [consent.id, `Temporary error: ${(err as Error).message}`.slice(0, 300)]);
    throw err;
  }
  await db.query(`UPDATE customer_payments SET provider = 'stripe', provider_payment_id = $2 WHERE id = $1`, [payment.id, pi.id]);
  const settled = await settleAutoTopUpIntent(db, pi);
  return { outcome: settled === 'credited' || settled === 'already_credited' ? 'succeeded' : settled === 'processing' ? 'processing' : 'failed', paymentId: payment.id };
}

/** Applies a PaymentIntent result (from the API response or the webhook) exactly once. */
export async function settleAutoTopUpIntent(db: Db, pi: Stripe.PaymentIntent): Promise<string> {
  const paymentId = pi.metadata?.payment_id;
  if (!paymentId) return 'ignored';
  const payment = await maybeOne(db, 'SELECT * FROM customer_payments WHERE id = $1', [paymentId]);
  if (!payment) return 'unknown_payment';
  if (pi.status === 'succeeded') {
    if (pi.amount_received !== payment.amount_cents || pi.currency !== 'nzd') {
      await notifyStaff(db, ['finance', 'admin'], { template: 'auto_topup_mismatch', subject: `Card top-up amount mismatch ${payment.reference}`,
        body: `Stripe reported ${pi.amount_received} ${pi.currency} for ${payment.reference} (expected ${payment.amount_cents} nzd). Not credited; investigate.`,
        idempotencyKey: `auto-topup-mismatch:${payment.id}` });
      return 'amount_mismatch';
    }
    const r = await confirmPayment(db, SYSTEM_ACTOR, paymentId, { providerPaymentId: pi.id });
    if (pi.metadata.consent_id) await db.query('UPDATE auto_topup_consents SET failure_count = 0, last_failure_reason = NULL WHERE id = $1', [pi.metadata.consent_id]);
    return r.credited ? 'credited' : 'already_credited';
  }
  if (pi.status === 'processing') return 'processing';
  if (payment.status !== 'pending') return 'already_final';
  const consent = pi.metadata.consent_id ? await maybeOne(db, 'SELECT * FROM auto_topup_consents WHERE id = $1', [pi.metadata.consent_id]) : null;
  const reason = pi.status === 'requires_action' ? 'The bank requires the cardholder to authenticate this payment'
    : pi.last_payment_error?.message ?? `Payment ${pi.status}`;
  await recordAutoTopUpFailure(db, paymentId, consent, pi.last_payment_error?.code ?? pi.status, reason);
  return 'failed';
}

async function recordAutoTopUpFailure(db: Db, paymentId: string, consent: any, code: string, message: string) {
  const settings = await getSettings(db);
  await failPayment(db, SYSTEM_ACTOR, paymentId, `Automatic card top-up declined: ${message}`);
  await db.query('UPDATE customer_payments SET failure_code = $2 WHERE id = $1', [paymentId, code]);
  if (!consent) return;
  const updated = await one(db, `UPDATE auto_topup_consents SET failure_count = failure_count + 1, last_failure_reason = $2 WHERE id = $1 RETURNING failure_count, customer_id`,
    [consent.id, `${code}: ${message}`.slice(0, 300)]);
  if (updated.failure_count >= settings.auto_topup_max_failures) {
    await notifyCustomer(db, updated.customer_id, { template: 'auto_topup_paused', subject: 'Automatic top-ups paused',
      body: `Automatic top-ups have failed ${updated.failure_count} times and are paused. Please update your saved card or top up by bank transfer.\n${link('/app/account')}`,
      idempotencyKey: `auto-topup-paused:${consent.id}:${updated.failure_count}` }, { includeBillingEmail: true });
    await notifyStaff(db, ['finance', 'admin'], { template: 'auto_topup_paused_staff', subject: 'Customer automatic top-ups paused',
      body: `Automatic top-ups for customer ${updated.customer_id} paused after ${updated.failure_count} failures (${code}).`, idempotencyKey: `auto-topup-paused-staff:${consent.id}:${updated.failure_count}` });
  }
}

/** Worker: charges consented saved cards for accounts whose balance has fallen below their trigger. */
export async function processAutoTopUps(db: Db): Promise<{ attempted: number; succeeded: number; failed: number }> {
  if (!stripeEnabled()) return { attempted: 0, succeeded: 0, failed: 0 };
  const consents = await query(db,
    `SELECT a.id, a.customer_id, a.trigger_below_cents FROM auto_topup_consents a
       JOIN customer_payment_methods pm ON pm.id = a.payment_method_id AND pm.status = 'active'
       JOIN customers c ON c.id = a.customer_id AND c.status IN ('active','pending_deposit')
      WHERE a.revoked_at IS NULL`);
  let attempted = 0, succeeded = 0, failed = 0;
  for (const c of consents) {
    const pos = await accountPosition(db, c.customer_id);
    if (pos.balanceCents >= c.trigger_below_cents) continue;
    try {
      const r = await chargeAutoTopUp(db, c.id);
      if (r.outcome === 'skipped') continue;
      attempted++;
      if (r.outcome === 'succeeded') succeeded++;
      if (r.outcome === 'failed') failed++;
    } catch (err) {
      attempted++;
      failed++;
      console.error('[auto-topup] temporary failure', err);
    }
  }
  return { attempted, succeeded, failed };
}

export async function savedCard(db: Db, customerId: string) {
  return maybeOne(db, `SELECT id, brand, last4, exp_month, exp_year, created_at FROM customer_payment_methods WHERE customer_id = $1 AND status = 'active'`, [customerId]);
}

export function describeCard(card: { brand?: string | null; last4?: string | null } | null): string {
  return card ? `${(card.brand ?? 'card').toUpperCase()} ending ${card.last4}` : 'no saved card';
}

