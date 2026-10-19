import nodemailer from 'nodemailer';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { query } from '../db.js';
import { normaliseNzPhone } from '../lib/phone.js';
import { getSettings } from './settings.js';
import { resolveSmsTransport, smsText } from './sms.js';

export interface Attachment {
  kind: 'customer_invoice_pdf' | 'statement_pdf' | 'completion_report_pdf' | 'remittance_pdf' | 'credit_note_pdf' | 'monthly_report_pdf';
  id: string;
  filename: string;
}

export interface NotificationInput {
  to?: string | null;
  userId?: string | null;
  template: string;
  subject: string;
  body: string;
  attachments?: Attachment[];
  idempotencyKey?: string;
  relatedType?: string;
  relatedId?: string;
}

/** Queues an email in the outbox (same transaction as the business change). Duplicate keys are ignored. */
export async function queueNotification(db: Db, n: NotificationInput): Promise<void> {
  let to = n.to ?? null;
  if (!to && n.userId) {
    const rows = await query<{ email: string }>(db, 'SELECT email FROM users WHERE id = $1 AND is_active', [n.userId]);
    to = rows[0]?.email ?? null;
  }
  if (!to) return;
  await db.query(
    `INSERT INTO notifications (recipient_email, recipient_user_id, template, subject, body, attachments, idempotency_key, related_type, related_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (idempotency_key) DO NOTHING`,
    [to, n.userId ?? null, n.template, n.subject, n.body, JSON.stringify(n.attachments ?? []), n.idempotencyKey ?? null, n.relatedType ?? null, n.relatedId ?? null],
  );
}

export interface SmsInput {
  phone: string | null | undefined;
  userId?: string | null;
  template: string;
  body: string;
  idempotencyKey?: string;
  relatedType?: string;
  relatedId?: string;
}

/**
 * Queues an SMS. An invalid or missing number is recorded as a failed notification (never silently dropped),
 * so escalation gaps are visible in the outbox.
 */
export async function queueSms(db: Db, n: SmsInput): Promise<void> {
  const phone = normaliseNzPhone(n.phone ?? null);
  await db.query(
    `INSERT INTO notifications (channel, recipient_phone, recipient_user_id, template, subject, body, idempotency_key, related_type, related_id, status, last_error)
     VALUES ('sms',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (idempotency_key) DO NOTHING`,
    [phone ?? n.phone ?? null, n.userId ?? null, n.template, smsText(n.body, 60), smsText(n.body), n.idempotencyKey ?? null, n.relatedType ?? null,
     n.relatedId ?? null, phone ? 'queued' : 'failed', phone ? null : `Invalid or missing NZ phone number: ${n.phone ?? '(none)'}`],
  );
}

export async function notifyStaff(db: Db, roles: string[], n: Omit<NotificationInput, 'to' | 'userId'>): Promise<void> {
  const staff = await query<{ id: string; email: string }>(db, `SELECT id, email FROM users WHERE role = ANY($1) AND is_active`, [roles]);
  for (const s of staff) {
    await queueNotification(db, { ...n, to: s.email, userId: s.id, idempotencyKey: n.idempotencyKey ? `${n.idempotencyKey}:${s.id}` : undefined });
  }
}

export async function notifyCustomer(db: Db, customerId: string, n: Omit<NotificationInput, 'to' | 'userId'>, opts: { includeBillingEmail?: boolean } = {}): Promise<void> {
  const users = await query<{ id: string; email: string }>(db,
    `SELECT id, email FROM users WHERE customer_id = $1 AND is_active AND customer_role IN ('owner','approver')`, [customerId]);
  const sent = new Set<string>();
  for (const u of users) {
    sent.add(u.email.toLowerCase());
    await queueNotification(db, { ...n, to: u.email, userId: u.id, idempotencyKey: n.idempotencyKey ? `${n.idempotencyKey}:${u.id}` : undefined });
  }
  if (opts.includeBillingEmail) {
    const [c] = await query<{ billing_email: string }>(db, 'SELECT billing_email FROM customers WHERE id = $1', [customerId]);
    if (c && !sent.has(c.billing_email.toLowerCase())) {
      await queueNotification(db, { ...n, to: c.billing_email, idempotencyKey: n.idempotencyKey ? `${n.idempotencyKey}:billing` : undefined });
    }
  }
}

export async function notifyContractor(db: Db, contractorId: string, n: Omit<NotificationInput, 'to' | 'userId'>): Promise<void> {
  const users = await query<{ id: string; email: string }>(db, `SELECT id, email FROM users WHERE contractor_id = $1 AND is_active`, [contractorId]);
  for (const u of users) {
    await queueNotification(db, { ...n, to: u.email, userId: u.id, idempotencyKey: n.idempotencyKey ? `${n.idempotencyKey}:${u.id}` : undefined });
  }
}

/** SMS to a contractor's dispatch mobile. */
export async function smsContractor(db: Db, contractorId: string, n: Omit<SmsInput, 'phone' | 'userId'>): Promise<void> {
  const rows = await query<{ mobile_phone: string | null; phone: string | null }>(db, 'SELECT mobile_phone, phone FROM contractors WHERE id = $1', [contractorId]);
  await queueSms(db, { ...n, phone: rows[0]?.mobile_phone ?? rows[0]?.phone ?? null, idempotencyKey: n.idempotencyKey });
}

export function link(path: string): string {
  return `${config.baseUrl}${path}`;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface EmailMessage { to: string; subject: string; text: string; attachments: { filename: string; content: Buffer }[] }
export type EmailTransport = (msg: EmailMessage) => Promise<{ messageId: string }>;

let transportOverride: EmailTransport | null | undefined;

/** Tests inject a transport here; production uses SMTP when configured. */
export function setEmailTransport(t: EmailTransport | null | undefined): void {
  transportOverride = t;
}

function resolveTransport(): EmailTransport | null {
  if (transportOverride !== undefined) return transportOverride;
  if (!config.smtp.host) return null;
  const smtp = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return async (msg) => {
    const info = await smtp.sendMail({ from: config.smtp.from, to: msg.to, subject: msg.subject, text: msg.text, attachments: msg.attachments });
    return { messageId: info.messageId };
  };
}

async function buildAttachments(db: Db, attachments: Attachment[]): Promise<{ filename: string; content: Buffer }[]> {
  if (!attachments.length) return [];
  const pdf = await import('./pdf.js');
  const out: { filename: string; content: Buffer }[] = [];
  for (const a of attachments) {
    let content: Buffer;
    if (a.kind === 'customer_invoice_pdf') content = await pdf.customerInvoicePdf(db, a.id);
    else if (a.kind === 'statement_pdf') content = await pdf.statementPdf(db, a.id);
    else if (a.kind === 'completion_report_pdf') content = await pdf.completionReportPdf(db, a.id);
    else if (a.kind === 'credit_note_pdf') content = await pdf.creditNotePdf(db, a.id);
    else if (a.kind === 'monthly_report_pdf') { const [cid, month] = a.id.split('|'); content = await pdf.monthlyReportPdf(db, cid, month); }
    else content = await pdf.remittancePdf(db, a.id);
    out.push({ filename: a.filename, content });
  }
  return out;
}

/**
 * Sends queued notifications. Without a configured transport, messages are marked 'not_sent_unconfigured'
 * so the system never claims an email was delivered when it was not. Failures retry with backoff.
 */
/** Footer naming the contracting entity, appended to every email. */
async function emailFooter(db: Db): Promise<string> {
  const c = (await getSettings(db)).company;
  return `\n\n--\n${c.trading_name} is a trading name of ${c.legal_name} (NZBN ${c.nzbn}${c.gst_number ? `, GST ${c.gst_number}` : ''}).` +
    `${c.address ? `\n${c.address}` : ''}\n${c.email}${c.website ? ` · ${c.website}` : ''}`;
}

/**
 * Sends queued notifications. Without a configured transport, messages are marked 'not_sent_unconfigured'
 * so the system never claims an email or SMS was delivered when it was not. Failures retry with backoff.
 * For SMS, 'sent' means the provider accepted the message (it returned a message ID); the handset delivery
 * result is recorded separately in delivery_status from the provider's status callback.
 */
export async function deliverPending(db: Db, limit = 25): Promise<{ sent: number; failed: number; skipped: number }> {
  const email = resolveTransport();
  const sms = resolveSmsTransport();
  const rows = await query(db,
    `SELECT * FROM notifications WHERE status = 'queued' AND next_attempt_at <= now() ORDER BY channel = 'sms' DESC, created_at LIMIT $1`, [limit]);
  let sent = 0, failed = 0, skipped = 0;
  const footer = rows.some((r) => r.channel === 'email') ? await emailFooter(db) : '';
  for (const n of rows) {
    const transportMissing = n.channel === 'sms' ? !sms : !email;
    if (transportMissing) {
      await db.query(`UPDATE notifications SET status = 'not_sent_unconfigured', last_error = $2 WHERE id = $1`,
        [n.id, n.channel === 'sms' ? 'SMS provider not configured' : 'Email transport not configured']);
      skipped++;
      continue;
    }
    try {
      let messageId: string;
      if (n.channel === 'sms') {
        const res = await sms!({ to: n.recipient_phone, body: n.body });
        messageId = res.messageId;
        await db.query(`UPDATE notifications SET delivery_status = $2, delivery_updated_at = now() WHERE id = $1`, [n.id, res.status]);
      } else {
        const attachments = await buildAttachments(db, n.attachments ?? []);
        messageId = (await email!({ to: n.recipient_email, subject: n.subject, text: n.body + footer, attachments })).messageId;
      }
      await db.query(`UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1, provider_message_id = $2, last_error = NULL WHERE id = $1`, [n.id, messageId]);
      if (n.related_type === 'customer_invoice' && n.template === 'customer_invoice_issued') {
        await db.query('UPDATE customer_invoices SET sent_at = COALESCE(sent_at, now()) WHERE id = $1', [n.related_id]);
      }
      sent++;
    } catch (err) {
      const attempts = n.attempts + 1;
      // SMS is time-critical: retry quickly, give up sooner so escalation is not delayed by a dead number.
      const maxAttempts = n.channel === 'sms' ? 4 : 6;
      const giveUp = attempts >= maxAttempts;
      const delayMinutes = n.channel === 'sms' ? attempts : 2 ** attempts;
      await db.query(
        `UPDATE notifications SET attempts = $2, last_error = $3, status = $4, next_attempt_at = now() + ($5 || ' minutes')::interval WHERE id = $1`,
        [n.id, attempts, String((err as Error).message).slice(0, 500), giveUp ? 'failed' : 'queued', String(delayMinutes)]);
      failed++;
    }
  }
  return { sent, failed, skipped };
}

/** Applies a provider delivery receipt (Twilio status callback). Delivery failures are recorded as failed. */
export async function recordSmsDelivery(db: Db, providerMessageId: string, status: string, errorCode?: string | null): Promise<boolean> {
  const failedStatuses = ['failed', 'undelivered'];
  const res = await db.query(
    `UPDATE notifications SET delivery_status = $2, delivery_updated_at = now(),
        status = CASE WHEN $3 THEN 'failed' ELSE status END,
        last_error = CASE WHEN $3 THEN $4 ELSE last_error END
      WHERE channel = 'sms' AND provider_message_id = $1`,
    [providerMessageId, status, failedStatuses.includes(status), `Carrier reported ${status}${errorCode ? ` (error ${errorCode})` : ''}`]);
  return (res.rowCount ?? 0) > 0;
}
