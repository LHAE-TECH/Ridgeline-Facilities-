import express, { Router } from 'express';
import { pool } from '../db.js';
import { config } from '../config.js';
import { recordSmsDelivery } from '../services/notifications.js';
import { verifyTwilioSignature } from '../services/sms.js';
import { constructEvent, handleStripeEvent, stripeEnabled } from '../services/stripe.js';

export const webhookRouter = Router();

webhookRouter.post('/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!stripeEnabled()) return res.status(503).json({ error: 'Stripe not configured' });
  let event;
  try {
    event = constructEvent(req.body as Buffer, req.get('stripe-signature') ?? undefined);
  } catch {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  try {
    const result = await handleStripeEvent(pool, event);
    res.json({ received: true, result });
  } catch (err) {
    console.error('Stripe webhook processing failed', err);
    // Non-2xx makes Stripe retry; the event row was rolled back so the retry is processed.
    res.status(500).json({ error: 'Processing failed' });
  }
});

/** Twilio message status callback: records handset delivery results (delivered / undelivered / failed). */
webhookRouter.post('/sms/twilio', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
  const params = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, String(v)]));
  const url = `${config.baseUrl}${req.originalUrl}`;
  if (!verifyTwilioSignature(url, params, req.get('x-twilio-signature') ?? undefined)) return res.status(403).send('Invalid signature');
  if (params.MessageSid && params.MessageStatus) {
    await recordSmsDelivery(pool, params.MessageSid, params.MessageStatus, params.ErrorCode ?? null);
  }
  res.status(204).end();
});
