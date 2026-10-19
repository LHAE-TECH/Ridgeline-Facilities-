import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { one, query } from '../src/db.js';
import { normaliseNzPhone } from '../src/lib/phone.js';
import { acceptOffer, escalateUnassigned } from '../src/services/dispatch.js';
import { deliverPending, queueSms } from '../src/services/notifications.js';
import { updateSetting } from '../src/services/settings.js';
import { resolveSmsTransport, setSmsFetch, setSmsTransport, verifyTwilioSignature } from '../src/services/sms.js';
import { activeCustomer, approvedContractor, book, count, db, resetDb, staff } from './helpers.js';

beforeEach(resetDb);

const saved = { ...config.sms };
afterEach(() => {
  Object.assign(config.sms, saved);
  setSmsFetch((...args) => fetch(...args));
  setSmsTransport(undefined);
});

function configureTwilio() {
  Object.assign(config.sms, { accountSid: 'AC_test', authToken: 'auth_token_test', from: '+6498880000', messagingServiceSid: '' });
  setSmsTransport(undefined);
}

describe('NZ phone numbers', () => {
  it('normalises to E.164 and rejects junk', () => {
    expect(normaliseNzPhone('021 555 0199')).toBe('+64215550199');
    expect(normaliseNzPhone('+64 21 555 0199')).toBe('+64215550199');
    expect(normaliseNzPhone('64215550199')).toBe('+64215550199');
    expect(normaliseNzPhone('call me')).toBeNull();
  });
});

describe('SMS delivery follows the never-report-sent-unless-it-succeeded rule', () => {
  it('marks SMS not_sent_unconfigured when no provider is configured', async () => {
    setSmsTransport(null);
    await queueSms(db, { phone: '021 555 0199', template: 't', body: 'hello', idempotencyKey: 'a' });
    await deliverPending(db);
    expect((await one(db, `SELECT status FROM notifications WHERE idempotency_key = 'a'`)).status).toBe('not_sent_unconfigured');
  });

  it('records invalid numbers as failed rather than dropping them', async () => {
    await queueSms(db, { phone: 'not a number', template: 't', body: 'hello', idempotencyKey: 'bad' });
    const n = await one(db, `SELECT status, last_error FROM notifications WHERE idempotency_key = 'bad'`);
    expect(n.status).toBe('failed');
    expect(n.last_error).toMatch(/Invalid or missing NZ phone/);
  });

  it('sends through Twilio and stores the message SID; an outage is retried, a rejected number fails at once, neither is marked sent', async () => {
    configureTwilio();
    const calls: { url: string; body: URLSearchParams }[] = [];
    let mode: 'outage' | 'reject' | 'ok' = 'outage';
    setSmsFetch((async (url: string, init: any) => {
      calls.push({ url, body: init.body });
      if (mode === 'outage') return new Response(JSON.stringify({ code: 20500, message: 'Internal Server Error' }), { status: 500 });
      if (mode === 'reject') return new Response(JSON.stringify({ code: 21211, message: "The 'To' number is not valid" }), { status: 400 });
      return new Response(JSON.stringify({ sid: 'SM123', status: 'queued' }), { status: 201 });
    }) as any);
    expect(resolveSmsTransport()).not.toBeNull();
    await queueSms(db, { phone: '021 555 0199', template: 't', body: 'Job offer', idempotencyKey: 'tw' });
    await deliverPending(db);
    let n = await one(db, `SELECT * FROM notifications WHERE idempotency_key = 'tw'`);
    expect(n.status).toBe('queued');
    expect(n.sent_at).toBeNull();
    expect(n.last_error).toMatch(/20500/);

    mode = 'reject';
    await queueSms(db, { phone: '09 000 0000', template: 't', body: 'Job offer', idempotencyKey: 'tw-bad' });
    await db.query(`UPDATE notifications SET next_attempt_at = now() + interval '1 hour' WHERE idempotency_key = 'tw'`);
    await deliverPending(db);
    const bad = await one(db, `SELECT * FROM notifications WHERE idempotency_key = 'tw-bad'`);
    expect(bad).toMatchObject({ status: 'failed', attempts: 1, sent_at: null });
    expect(bad.last_error).toMatch(/21211/);
    mode = 'ok';
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json');
    expect(calls[0].body.get('To')).toBe('+64215550199');
    expect(calls[0].body.get('StatusCallback')).toMatch(/\/webhooks\/sms\/twilio$/);

    await db.query(`UPDATE notifications SET next_attempt_at = now() WHERE id = $1`, [n.id]);
    await deliverPending(db);
    n = await one(db, `SELECT * FROM notifications WHERE idempotency_key = 'tw'`);
    expect(n).toMatchObject({ status: 'sent', provider_message_id: 'SM123', delivery_status: 'queued' });
  });

  it('accepts only correctly signed Twilio status callbacks and records carrier failures', async () => {
    configureTwilio();
    setSmsFetch((async () => new Response(JSON.stringify({ sid: 'SM999', status: 'queued' }), { status: 201 })) as any);
    await queueSms(db, { phone: '021 555 0199', template: 't', body: 'Escalation', idempotencyKey: 'cb' });
    await deliverPending(db);
    const app = createApp();
    const params = { MessageSid: 'SM999', MessageStatus: 'undelivered', ErrorCode: '30003' };
    const url = `${config.baseUrl}/webhooks/sms/twilio`;
    const sig = createHmac('sha1', 'auth_token_test').update(Object.keys(params).sort().reduce((a, k) => a + k + (params as any)[k], url)).digest('base64');
    expect(verifyTwilioSignature(url, params, sig)).toBe(true);
    expect((await request(app).post('/webhooks/sms/twilio').type('form').set('X-Twilio-Signature', 'forged').send(params)).status).toBe(403);
    expect((await request(app).post('/webhooks/sms/twilio').type('form').set('X-Twilio-Signature', sig).send(params)).status).toBe(204);
    const n = await one(db, `SELECT status, delivery_status, last_error FROM notifications WHERE idempotency_key = 'cb'`);
    expect(n).toMatchObject({ status: 'failed', delivery_status: 'undelivered' });
    expect(n.last_error).toMatch(/30003/);
  });
});

describe('SMS dispatch', () => {
  it('broadcasts P1 offers by SMS, confirms acceptance, and tells the others the job is taken', async () => {
    const a = await approvedContractor({ mobile: '021 111 1111' });
    const b = await approvedContractor({ mobile: '022 222 2222' });
    const fx = await activeCustomer();
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    const offers = await query(db, `SELECT body, recipient_phone FROM notifications WHERE template = 'job_offer_sms' ORDER BY recipient_phone`);
    expect(offers.map((o) => o.recipient_phone)).toEqual(['+64211111111', '+64222222222']);
    expect(offers[0].body).toMatch(new RegExp(`P1 EMERGENCY ${job.ref}`));
    expect(offers[0].body).toMatch(/On site by/);

    const offer = await one(db, `SELECT id FROM job_offers WHERE job_id = $1 AND contractor_id = $2`, [job.id, a.contractorId]);
    await acceptOffer(db, a.actor, offer.id);
    expect((await one(db, `SELECT recipient_phone, body FROM notifications WHERE template = 'job_confirmed_sms'`)).recipient_phone).toBe('+64211111111');
    expect((await one(db, `SELECT recipient_phone FROM notifications WHERE template = 'job_taken_sms'`)).recipient_phone).toBe('+64222222222');
    expect(b).toBeTruthy();
  });

  it('emails but does not SMS P3 offers when after-hours SMS is switched off', async () => {
    await approvedContractor();
    const admin = await staff('admin');
    await updateSetting(db, admin, 'sms_offers_outside_business_hours', false);
    const fx = await activeCustomer();
    await book(fx, { priority: 'standard' });
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'job_offer' AND channel = 'email'`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'job_offer_sms'`)).toBe(0);
  });

  it('escalates to the staff phone when nobody accepts a P1 within the configured window (default 10 min)', async () => {
    await approvedContractor();
    await staff('ops');
    const admin = await staff('admin');
    await updateSetting(db, admin, 'escalation_staff_phones', ['027 000 1111']);
    const fx = await activeCustomer();
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    expect(await escalateUnassigned(db)).toBe(0); // still inside the window
    await db.query(`UPDATE jobs SET sla_started_at = now() - interval '11 minutes' WHERE id = $1`, [job.id]);
    expect(await escalateUnassigned(db)).toBe(1);
    expect(await escalateUnassigned(db)).toBe(0); // once per level
    const sms = await one(db, `SELECT * FROM notifications WHERE template = 'escalation_sms'`);
    expect(sms.recipient_phone).toBe('+64270001111');
    expect(sms.body).toMatch(/ESCALATION .* unassigned: no contractor accepted within 10 minutes/);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'job_escalated' AND channel = 'email'`)).toBeGreaterThan(0);
    expect((await one(db, 'SELECT escalation_level FROM jobs WHERE id = $1', [job.id])).escalation_level).toBe(1);
  });

  it('escalates a P1 immediately when no contractor is eligible at all', async () => {
    const admin = await staff('admin');
    await updateSetting(db, admin, 'escalation_staff_phones', ['027 000 1111']);
    const fx = await activeCustomer();
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    expect(job.status).toBe('dispatch');
    expect((await one(db, `SELECT body FROM notifications WHERE template = 'escalation_sms'`)).body).toMatch(/no eligible contractor/);
  });
});
