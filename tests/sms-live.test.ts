/**
 * LIVE Twilio SMS integration test. Real messages, real network, no stubs.
 *
 * Runs only when real Twilio credentials and a test handset are configured (and api.twilio.com is reachable):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID   (live credentials,
 *     not Twilio "test credentials", which never deliver)
 *   SMS_TEST_MOBILE           NZ mobile that should receive the test message, e.g. 021 123 4567
 *   SMS_TEST_FAILING_NUMBER   optional; a number that cannot receive SMS (default +6490000000, an invalid Auckland number)
 *   SMS_LIVE_PUBLIC_URL       optional; public HTTPS URL forwarding to http://localhost:SMS_LIVE_PORT (default 3999).
 *                             When set, Twilio's own status callback is received by the app. Without it, the final
 *                             status Twilio reports is replayed, correctly signed, through the same webhook endpoint.
 *
 *   npm run test:live          (sets NODE_USE_ENV_PROXY=1 so Node uses an outbound proxy where one is configured)
 *
 * The ordinary suite blanks TWILIO_* so it can never text real people; vitest.config.ts passes the real values to this
 * file as LIVE_TWILIO_*.
 */
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { one } from '../src/db.js';
import { isNzMobile, normaliseNzPhone } from '../src/lib/phone.js';
import { deliverPending, queueSms } from '../src/services/notifications.js';
import { setSmsFetch, setSmsTransport } from '../src/services/sms.js';
import { db, resetDb } from './helpers.js';

const live = {
  accountSid: process.env.LIVE_TWILIO_ACCOUNT_SID ?? '',
  authToken: process.env.LIVE_TWILIO_AUTH_TOKEN ?? '',
  from: process.env.LIVE_TWILIO_FROM_NUMBER ?? '',
  messagingServiceSid: process.env.LIVE_TWILIO_MESSAGING_SERVICE_SID ?? '',
};
const MOBILE = process.env.SMS_TEST_MOBILE ?? '';
const FAILING = process.env.SMS_TEST_FAILING_NUMBER || '+6490000000';
const PUBLIC_URL = (process.env.SMS_LIVE_PUBLIC_URL ?? '').replace(/\/$/, '');
const PORT = Number(process.env.SMS_LIVE_PORT ?? 3999);
const enabled = Boolean(live.accountSid && live.authToken && (live.from || live.messagingServiceSid) && MOBILE);
const FINAL = ['delivered', 'undelivered', 'failed'];
const saved = { sms: { ...config.sms }, baseUrl: config.baseUrl };

describe.skipIf(!enabled)('Twilio SMS (live API, real handset)', () => {
  const app = createApp();
  let server: Server | null = null;

  beforeAll(async () => {
    if (!live.accountSid.startsWith('AC')) throw new Error('TWILIO_ACCOUNT_SID must be a Twilio account SID (AC…)');
    if (!isNzMobile(normaliseNzPhone(MOBILE))) throw new Error(`SMS_TEST_MOBILE "${MOBILE}" is not an NZ mobile number`);
    Object.assign(config.sms, live);
    setSmsTransport(undefined); // the real Twilio REST transport
    setSmsFetch((...args) => fetch(...args));
    if (PUBLIC_URL) {
      config.baseUrl = PUBLIC_URL; // StatusCallback and signature URL use the public address
      server = await new Promise<Server>((resolve) => { const s = app.listen(PORT, () => resolve(s)); });
    }
    await resetDb();
  });
  afterAll(async () => {
    Object.assign(config.sms, saved.sms);
    config.baseUrl = saved.baseUrl;
    if (server) await new Promise((r) => server!.close(r));
  });

  async function twilioMessage(sid: string): Promise<{ status: string; error_code: number | null; to: string }> {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${live.accountSid}/Messages/${sid}.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${live.accountSid}:${live.authToken}`).toString('base64')}` },
    });
    if (!res.ok) throw new Error(`Twilio message lookup failed: ${res.status}`);
    return res.json() as any;
  }

  async function waitFor<T>(what: string, fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v !== null) return v;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  /** Twilio's final status for the message, from Twilio's API (not from our own records). */
  const finalStatus = (sid: string) => waitFor(`Twilio final status for ${sid}`, async () => {
    const m = await twilioMessage(sid);
    return FINAL.includes(m.status) ? m : null;
  }, 180_000);

  /**
   * The delivery receipt reaches the app: either Twilio's own callback (public URL mode) or the final status replayed
   * through the real webhook with a valid X-Twilio-Signature computed from the live auth token.
   */
  async function deliveryReceipt(notificationId: string, sid: string, m: { status: string; error_code: number | null }) {
    if (PUBLIC_URL) {
      console.info(`[sms-live] waiting for Twilio's own status callback at ${PUBLIC_URL}/webhooks/sms/twilio`);
      return waitFor('Twilio status callback', async () => {
        const n = await one(db, 'SELECT * FROM notifications WHERE id = $1', [notificationId]);
        return n.delivery_status === m.status ? n : null;
      }, 120_000);
    }
    console.info('[sms-live] SMS_LIVE_PUBLIC_URL not set: replaying Twilio\'s reported final status through the signed webhook');
    const params: Record<string, string> = { AccountSid: live.accountSid, MessageSid: sid, MessageStatus: m.status, ...(m.error_code ? { ErrorCode: String(m.error_code) } : {}) };
    const url = `${config.baseUrl}/webhooks/sms/twilio`;
    const sig = createHmac('sha1', live.authToken).update(Object.keys(params).sort().reduce((a, k) => a + k + params[k], url)).digest('base64');
    expect((await request(app).post('/webhooks/sms/twilio').type('form').set('X-Twilio-Signature', sig).send(params)).status).toBe(204);
    return one(db, 'SELECT * FROM notifications WHERE id = $1', [notificationId]);
  }

  it('delivers a real SMS to the test mobile, marks it sent only on a Twilio SID, and records the delivery receipt', async () => {
    const key = `live-sms-${Date.now()}`;
    await queueSms(db, { phone: MOBILE, template: 'live_test', idempotencyKey: key,
      body: `Ridgeline Facilities live SMS test ${new Date().toISOString().slice(0, 16)}Z. No action needed.` });
    const r = await deliverPending(db);
    let n = await one(db, 'SELECT * FROM notifications WHERE idempotency_key = $1', [key]);
    expect(r.sent, n.last_error ?? '').toBe(1);
    expect(n.status).toBe('sent');
    expect(n.provider_message_id).toMatch(/^SM[0-9a-f]{32}$/);
    expect(n.recipient_phone).toBe(normaliseNzPhone(MOBILE));

    const m = await finalStatus(n.provider_message_id);
    expect(m.status, `Twilio reports ${m.status}${m.error_code ? ` (error ${m.error_code})` : ''}`).toBe('delivered');
    n = await deliveryReceipt(n.id, n.provider_message_id, m);
    expect(n).toMatchObject({ status: 'sent', delivery_status: 'delivered' });
    expect(n.delivery_updated_at).not.toBeNull();
  }, 330_000);

  it('records a number that cannot receive SMS as failed, never as sent', async () => {
    const key = `live-sms-fail-${Date.now()}`;
    await queueSms(db, { phone: FAILING, template: 'live_test', body: 'Ridgeline Facilities live SMS failure test.', idempotencyKey: key });
    await deliverPending(db);
    let n = await one(db, 'SELECT * FROM notifications WHERE idempotency_key = $1', [key]);
    if (n.status === 'failed') {
      // Rejected by Twilio's API (e.g. 21211 invalid number, 21614 not a mobile): failed on the first attempt, no SID.
      expect(n.last_error).toMatch(/Twilio rejected SMS \(400/);
      expect(n.provider_message_id).toBeNull();
      expect(n.sent_at).toBeNull();
      console.info(`[sms-live] failing number rejected by Twilio: ${n.last_error}`);
      return;
    }
    // Accepted by Twilio but not deliverable: the carrier result must turn the record into a failure.
    expect(n.status, n.last_error ?? '').toBe('sent');
    const m = await finalStatus(n.provider_message_id);
    expect(['undelivered', 'failed']).toContain(m.status);
    n = await deliveryReceipt(n.id, n.provider_message_id, m);
    expect(n.status).toBe('failed');
    expect(n.delivery_status).toBe(m.status);
    expect(n.last_error).toMatch(/Carrier reported/);
  }, 330_000);
});
