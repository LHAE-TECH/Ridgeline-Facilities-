/**
 * Logic tests for saved-card automatic top-ups using a minimal in-memory stand-in for the Stripe client.
 * These check Ridgeline's own state handling (idempotency, crediting, failure handling). They do NOT prove the
 * Stripe integration works: that is covered by tests/stripe-live.test.ts against a real Stripe test-mode account.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { one } from '../src/db.js';
import { SYSTEM_ACTOR } from '../src/lib/actor.js';
import { chargeAutoTopUp, processAutoTopUps, recordSetupIntent } from '../src/services/autoTopUp.js';
import { accountPosition, reconcileCustomerBalance } from '../src/services/ledger.js';
import { grantAutoTopUpConsent, processLowBalances } from '../src/services/payments.js';
import { handleStripeEvent, resetStripeClient, setStripeClientForTests } from '../src/services/stripe.js';
import { activeCustomer, count, db, resetDb } from './helpers.js';

const saved = { ...config.stripe };
let piCalls: { params: any; key: string }[] = [];
let nextOutcome: 'succeeded' | 'decline' | 'network' = 'succeeded';

function fakeStripe(customerId: string) {
  return {
    customers: { create: async () => ({ id: 'cus_fake' }) },
    setupIntents: {
      retrieve: async (id: string) => ({ id, status: 'succeeded', customer: 'cus_fake', metadata: { customer_id: customerId, user_id: '' },
        payment_method: { id: 'pm_fake_visa', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } } }),
    },
    paymentIntents: {
      create: async (params: any, opts: any) => {
        piCalls.push({ params, key: opts.idempotencyKey });
        if (nextOutcome === 'network') throw Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' });
        if (nextOutcome === 'decline') throw Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined', raw: { payment_intent: { id: 'pi_declined' } } });
        return { id: `pi_${piCalls.length}`, status: 'succeeded', amount_received: params.amount, currency: 'nzd', metadata: params.metadata };
      },
    },
    paymentMethods: { detach: async () => ({}) },
  };
}

async function setupCustomerWithCard() {
  const fx = await activeCustomer();
  await db.query(`UPDATE customers SET stripe_customer_id = 'cus_fake' WHERE id = $1`, [fx.customerId]);
  setStripeClientForTests(fakeStripe(fx.customerId));
  await recordSetupIntent(db, SYSTEM_ACTOR, 'seti_fake');
  const balance = (await accountPosition(db, fx.customerId)).balanceCents;
  const consent = await grantAutoTopUpConsent(db, fx.owner, fx.customerId, 50000, balance + 1, true);
  return { fx, consent, balance };
}

beforeEach(async () => {
  await resetDb();
  piCalls = [];
  nextOutcome = 'succeeded';
  Object.assign(config.stripe, { secretKey: 'sk_test_fake', webhookSecret: 'whsec_fake' });
});
afterEach(() => { Object.assign(config.stripe, saved); resetStripeClient(); });

describe('saved-card automatic top-ups (logic)', () => {
  it('links the saved card to the consent text and charges off-session once, crediting exactly once', async () => {
    const { fx, consent, balance } = await setupCustomerWithCard();
    expect(consent.consent_text).toMatch(/charge \$500\.00 to the card saved on this account \(currently VISA ending 4242\)/);
    expect(consent.consent_text).toMatch(/LHA Holdings Limited trading as Ridgeline Facilities/);
    const r = await processAutoTopUps(db);
    expect(r).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(piCalls[0].params).toMatchObject({ amount: 50000, currency: 'nzd', off_session: true, confirm: true, customer: 'cus_fake', payment_method: 'pm_fake_visa' });
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(balance + 50000);

    // The webhook for the same PaymentIntent does not credit again.
    const pi = { id: 'pi_1', object: 'payment_intent', status: 'succeeded', amount_received: 50000, currency: 'nzd', metadata: piCalls[0].params.metadata };
    expect(await handleStripeEvent(db, { id: 'evt_pi_1', type: 'payment_intent.succeeded', data: { object: pi } } as any)).toBe('already_credited');
    // A second run the same day neither charges nor credits again.
    expect(await processAutoTopUps(db)).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(piCalls).toHaveLength(1);
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(balance + 50000);
    expect((await reconcileCustomerBalance(db, fx.customerId)).ok).toBe(true);
    // The request-only path does not also raise a bank-transfer request for card consents.
    expect((await processLowBalances(db)).autoTopUps).toBe(0);
  });

  it('records a decline without crediting, notifies the customer and pauses after the configured failures', async () => {
    const { fx, consent, balance } = await setupCustomerWithCard();
    await db.query(`INSERT INTO settings (key, value) VALUES ('auto_topup_max_failures', '1') ON CONFLICT (key) DO UPDATE SET value = '1'`);
    nextOutcome = 'decline';
    const r = await chargeAutoTopUp(db, consent.id);
    expect(r.outcome).toBe('failed');
    const p = await one(db, 'SELECT * FROM customer_payments WHERE id = $1', [r.paymentId]);
    expect(p).toMatchObject({ status: 'failed', failure_code: 'card_declined', provider_payment_id: 'pi_declined' });
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(balance);
    expect((await one(db, 'SELECT failure_count FROM auto_topup_consents WHERE id = $1', [consent.id])).failure_count).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'payment_failed'`)).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'auto_topup_paused'`)).toBeGreaterThan(0);
    expect((await chargeAutoTopUp(db, consent.id)).outcome).toBe('skipped');
  });

  it('retries a network failure with the same idempotency key so Stripe cannot charge twice', async () => {
    const { fx, consent, balance } = await setupCustomerWithCard();
    nextOutcome = 'network';
    await expect(chargeAutoTopUp(db, consent.id)).rejects.toThrow(/socket hang up/);
    const pending = await one(db, `SELECT * FROM customer_payments WHERE customer_id = $1 AND is_auto_topup`, [fx.customerId]);
    expect(pending.status).toBe('pending');
    nextOutcome = 'succeeded';
    expect((await chargeAutoTopUp(db, consent.id)).outcome).toBe('succeeded');
    expect(piCalls.map((c) => c.key)).toEqual([`auto-topup-pi:${pending.id}`, `auto-topup-pi:${pending.id}`]);
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(balance + 50000);
  });

  it('refuses a SetupIntent that belongs to a different Stripe customer', async () => {
    const fx = await activeCustomer();
    await db.query(`UPDATE customers SET stripe_customer_id = 'cus_other' WHERE id = $1`, [fx.customerId]);
    setStripeClientForTests(fakeStripe(fx.customerId));
    await expect(recordSetupIntent(db, SYSTEM_ACTOR, 'seti_x')).rejects.toThrow(/does not match/);
  });
});
