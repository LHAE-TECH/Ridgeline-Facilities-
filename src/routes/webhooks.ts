import express, { Router } from 'express';
import { pool } from '../db.js';
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
