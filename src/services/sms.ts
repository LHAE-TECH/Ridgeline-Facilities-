import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * SMS via Twilio's REST API (reaches all NZ mobile networks). A message counts as "sent" only when Twilio
 * returns a message SID; final delivery (delivered / undelivered / failed) arrives later on the status callback.
 */

export interface SmsMessage { to: string; body: string }
export interface SmsResult { messageId: string; status: string }
export type SmsTransport = (msg: SmsMessage) => Promise<SmsResult>;

let override: SmsTransport | null | undefined;
export function setSmsTransport(t: SmsTransport | null | undefined): void { override = t; }

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
export function setSmsFetch(f: Fetch): void { fetchImpl = f; }

export function smsConfigured(): boolean {
  return Boolean(config.sms.accountSid && config.sms.authToken && (config.sms.from || config.sms.messagingServiceSid));
}

export function statusCallbackUrl(): string {
  return `${config.baseUrl}/webhooks/sms/twilio`;
}

export function resolveSmsTransport(): SmsTransport | null {
  if (override !== undefined) return override;
  if (!smsConfigured()) return null;
  return async ({ to, body }) => {
    const params = new URLSearchParams({ To: to, Body: body, StatusCallback: statusCallbackUrl() });
    if (config.sms.messagingServiceSid) params.set('MessagingServiceSid', config.sms.messagingServiceSid);
    else params.set('From', config.sms.from);
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${config.sms.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${config.sms.accountSid}:${config.sms.authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; message?: string; code?: number };
    if (!res.ok || !json.sid) throw new Error(`Twilio rejected SMS (${res.status}${json.code ? ` code ${json.code}` : ''}): ${json.message ?? 'no message SID returned'}`);
    return { messageId: json.sid, status: json.status ?? 'queued' };
  };
}

/** Validates Twilio's X-Twilio-Signature (HMAC-SHA1 of the full URL plus sorted POST parameters). */
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined, authToken = config.sms.authToken): boolean {
  if (!signature || !authToken) return false;
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac('sha1', authToken).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** SMS bodies are kept short (one or two segments). */
export function smsText(s: string, max = 300): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
