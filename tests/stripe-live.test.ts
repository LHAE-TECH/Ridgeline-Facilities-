/**
 * LIVE Stripe test-mode integration test for saved-card automatic top-ups.
 *
 * Runs only when STRIPE_TEST_SECRET_KEY (an sk_test_… key) is set and api.stripe.com is reachable. It creates real
 * test-mode Customers, SetupIntents and off-session PaymentIntents using Stripe's test payment methods, and checks
 * Ridgeline's ledger against what Stripe reports. No real money moves in test mode.
 *
 *   STRIPE_TEST_SECRET_KEY=sk_test_... npx vitest run tests/stripe-live.test.ts
 */
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { one } from '../src/db.js';
import { SYSTEM_ACTOR } from '../src/lib/actor.js';
import { ensureStripeCustomer, processAutoTopUps, recordSetupIntent } from '../src/services/autoTopUp.js';
import { accountPosition, reconcileCustomerBalance } from '../src/services/ledger.js';
import { grantAutoTopUpConsent } from '../src/services/payments.js';
import { constructEvent, handleStripeEvent, resetStripeClient, stripeClient } from '../src/services/stripe.js';
import { activeCustomer, db, resetDb } from './helpers.js';

const KEY = process.env.STRIPE_TEST_SECRET_KEY ?? '';
const WEBHOOK_SECRET = 'whsec_local_live_test';
const saved = { ...config.stripe };

describe.skipIf(!KEY)('Stripe test mode: saved-card automatic top-ups (live API)', () => {
  beforeAll(async () => {
    if (!KEY.startsWith('sk_test_')) throw new Error('STRIPE_TEST_SECRET_KEY must be a test-mode key (sk_test_…)');
    Object.assign(config.stripe, { secretKey: KEY, webhookSecret: WEBHOOK_SECRET });
    resetStripeClient();
    await resetDb();
  });
  afterAll(() => { Object.assign(config.stripe, saved); resetStripeClient(); });

  /** Saves a Stripe test card the way Checkout (setup mode) does: a confirmed off-session SetupIntent. */
  async function saveTestCard(customerId: string, testPaymentMethod: string) {
    const stripeCustomer = await ensureStripeCustomer(db, customerId);
    const si = await stripeClient().setupIntents.create({
      customer: stripeCustomer, payment_method: testPaymentMethod, payment_method_types: ['card'], usage: 'off_session', confirm: true,
      metadata: { customer_id: customerId, purpose: 'auto_topup_card' },
    });
    expect(si.status).toBe('succeeded');
    return recordSetupIntent(db, SYSTEM_ACTOR, si.id);
  }

  it('charges a saved Visa off-session and credits the prepaid balance exactly once', async () => {
    const fx = await activeCustomer();
    const card = await saveTestCard(fx.customerId, 'pm_card_visa');
    expect(card).toMatchObject({ brand: 'visa', last4: '4242', status: 'active' });
    const before = (await accountPosition(db, fx.customerId)).balanceCents;
    await grantAutoTopUpConsent(db, fx.owner, fx.customerId, 25000, before + 1, true);

    const r = await processAutoTopUps(db);
    expect(r).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    const payment = await one(db, `SELECT * FROM customer_payments WHERE customer_id = $1 AND is_auto_topup`, [fx.customerId]);
    expect(payment.status).toBe('succeeded');
    const pi = await stripeClient().paymentIntents.retrieve(payment.provider_payment_id);
    expect(pi).toMatchObject({ status: 'succeeded', amount_received: 25000, currency: 'nzd' });
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(before + 25000);

    // Stripe's webhook for the same PaymentIntent (signed and verified) must not credit again, nor a redelivery.
    const payload = JSON.stringify({ id: `evt_live_${pi.id}`, object: 'event', type: 'payment_intent.succeeded', data: { object: pi } });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const event = constructEvent(Buffer.from(payload), header, WEBHOOK_SECRET);
    expect(await handleStripeEvent(db, event)).toBe('already_credited');
    expect(await handleStripeEvent(db, event)).toBe('duplicate');

    // Same day: no second charge.
    expect(await processAutoTopUps(db)).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(before + 25000);
    expect((await reconcileCustomerBalance(db, fx.customerId)).ok).toBe(true);
  }, 60000);

  it('handles a card that saves but is declined when charged: nothing credited, customer told', async () => {
    const fx = await activeCustomer();
    // Stripe test card 4000000000000341: attaching succeeds, charges fail.
    await saveTestCard(fx.customerId, 'pm_card_chargeCustomerFail');
    const before = (await accountPosition(db, fx.customerId)).balanceCents;
    await grantAutoTopUpConsent(db, fx.owner, fx.customerId, 25000, before + 1, true);

    const r = await processAutoTopUps(db);
    expect(r).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    const payment = await one(db, `SELECT * FROM customer_payments WHERE customer_id = $1 AND is_auto_topup`, [fx.customerId]);
    expect(payment.status).toBe('failed');
    expect(payment.failure_code).toBeTruthy();
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(before);
    if (payment.provider_payment_id) {
      const pi = await stripeClient().paymentIntents.retrieve(payment.provider_payment_id);
      expect(pi.status).not.toBe('succeeded');
    }
    expect((await one(db, `SELECT COUNT(*)::int AS n FROM notifications WHERE template = 'payment_failed'`)).n).toBeGreaterThan(0);
  }, 60000);
});
