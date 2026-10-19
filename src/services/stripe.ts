import Stripe from 'stripe';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { maybeOne, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { SYSTEM_ACTOR } from '../lib/actor.js';
import { AppError } from '../lib/errors.js';
import { confirmPayment, failPayment, requestPayment } from './payments.js';

/**
 * Optional Stripe Checkout for card top-ups and invoice payments. Funds are credited only from a verified
 * webhook (checkout.session.completed with payment_status 'paid'), never from the browser redirect.
 */

let client: Stripe | null = null;
export function stripeEnabled(): boolean {
  return Boolean(config.stripe.secretKey && config.stripe.webhookSecret);
}
export function stripeClient(): Stripe {
  if (!client) client = new Stripe(config.stripe.secretKey || 'sk_test_unconfigured', { maxNetworkRetries: 2 });
  return client;
}
/** Used after changing keys at runtime (tests). */
export function resetStripeClient(): void { client = null; }
/** Unit tests substitute a minimal fake; the live test-mode suite uses the real client. */
export function setStripeClientForTests(fake: unknown): void { client = fake as Stripe; }
const stripe = stripeClient;

export async function createCheckout(db: Db, actor: Actor, input: { customerId: string; amountCents: number; customerInvoiceId?: string | null; idempotencyKey: string }) {
  if (!stripeEnabled()) throw new AppError('Card payments are not configured; please pay by bank transfer', 409);
  const payment = await requestPayment(db, actor, { customerId: input.customerId, amountCents: input.amountCents, method: 'card',
    purpose: input.customerInvoiceId ? 'invoice' : undefined, customerInvoiceId: input.customerInvoiceId, idempotencyKey: input.idempotencyKey });
  if (payment.provider_session_id) {
    const existing = await stripe().checkout.sessions.retrieve(payment.provider_session_id);
    return existing.url!;
  }
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    currency: 'nzd',
    line_items: [{ quantity: 1, price_data: { currency: 'nzd', unit_amount: input.amountCents,
      product_data: { name: input.customerInvoiceId ? 'Ridgeline Facilities invoice payment' : 'Ridgeline prepaid maintenance top-up' } } }],
    client_reference_id: payment.id,
    metadata: { payment_id: payment.id, reference: payment.reference },
    success_url: `${config.baseUrl}/app/account?payment=processing`,
    cancel_url: `${config.baseUrl}/app/account?payment=cancelled`,
  }, { idempotencyKey: `checkout:${payment.id}` });
  await db.query(`UPDATE customer_payments SET provider = 'stripe', provider_session_id = $2 WHERE id = $1`, [payment.id, session.id]);
  return session.url!;
}

export function constructEvent(rawBody: Buffer, signature: string | undefined, secret = config.stripe.webhookSecret): Stripe.Event {
  if (!signature) throw new AppError('Missing Stripe signature', 400);
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/** Processes a verified webhook exactly once (deduplicated on the Stripe event ID). */
export async function handleStripeEvent(db: Db, event: Stripe.Event): Promise<string> {
  // One transaction: if processing fails, the dedupe row rolls back too, so Stripe's retry is processed.
  return tx(db, async (c) => {
    const inserted = await maybeOne(c,
      `INSERT INTO webhook_events (provider, event_id, event_type, payload) VALUES ('stripe', $1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id`,
      [event.id, event.type, JSON.stringify(event)]);
    if (!inserted) return 'duplicate';
    let result = 'ignored';
    if (event.type.startsWith('checkout.session.')) {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === 'setup') {
        if (event.type === 'checkout.session.completed' && session.setup_intent) {
          const { recordSetupIntent } = await import('./autoTopUp.js');
          await recordSetupIntent(c, SYSTEM_ACTOR, String(typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent.id));
          result = 'card_saved';
        }
      } else {
        const paymentId = session?.metadata?.payment_id ?? session?.client_reference_id;
        if (paymentId && (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded')) {
          if (session.payment_status === 'paid') {
            const r = await confirmPayment(c, SYSTEM_ACTOR, paymentId, { providerPaymentId: String(session.payment_intent ?? session.id) });
            result = r.credited ? 'credited' : 'already_credited';
          } else {
            result = 'awaiting_async_payment';
          }
        } else if (paymentId && (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired')) {
          await failPayment(c, SYSTEM_ACTOR, paymentId, event.type === 'checkout.session.expired' ? 'Checkout expired' : 'Card payment failed');
          result = 'failed';
        }
      }
    } else if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
      // Off-session automatic top-up charges (Checkout payments are handled via the session events above).
      const pi = event.data.object as Stripe.PaymentIntent;
      if (pi.metadata?.purpose === 'auto_topup' && pi.metadata.payment_id) {
        const { settleAutoTopUpIntent } = await import('./autoTopUp.js');
        result = await settleAutoTopUpIntent(c, pi);
      }
    }
    await c.query(`UPDATE webhook_events SET processed_at = now(), result = $2 WHERE provider = 'stripe' AND event_id = $1`, [event.id, result]);
    return result;
  });
}
