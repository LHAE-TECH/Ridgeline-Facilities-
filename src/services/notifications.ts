import nodemailer from 'nodemailer';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { query } from '../db.js';

export interface Attachment { kind: 'customer_invoice_pdf' | 'statement_pdf' | 'completion_report_pdf' | 'remittance_pdf'; id: string; filename: string }

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
    else content = await pdf.remittancePdf(db, a.id);
    out.push({ filename: a.filename, content });
  }
  return out;
}

/**
 * Sends queued notifications. Without a configured transport, messages are marked 'not_sent_unconfigured'
 * so the system never claims an email was delivered when it was not. Failures retry with backoff.
 */
export async function deliverPending(db: Db, limit = 25): Promise<{ sent: number; failed: number; skipped: number }> {
  const transport = resolveTransport();
  const rows = await query(db,
    `SELECT * FROM notifications WHERE status = 'queued' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1`, [limit]);
  let sent = 0, failed = 0, skipped = 0;
  for (const n of rows) {
    if (!transport) {
      await db.query(`UPDATE notifications SET status = 'not_sent_unconfigured', last_error = 'Email transport not configured' WHERE id = $1`, [n.id]);
      skipped++;
      continue;
    }
    try {
      const attachments = await buildAttachments(db, n.attachments ?? []);
      const res = await transport({ to: n.recipient_email, subject: n.subject, text: n.body, attachments });
      await db.query(`UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1, provider_message_id = $2, last_error = NULL WHERE id = $1`, [n.id, res.messageId]);
      if (n.related_type === 'customer_invoice' && n.template === 'customer_invoice_issued') {
        await db.query('UPDATE customer_invoices SET sent_at = COALESCE(sent_at, now()) WHERE id = $1', [n.related_id]);
      }
      sent++;
    } catch (err) {
      const attempts = n.attempts + 1;
      const giveUp = attempts >= 6;
      await db.query(
        `UPDATE notifications SET attempts = $2, last_error = $3, status = $4, next_attempt_at = now() + ($5 || ' minutes')::interval WHERE id = $1`,
        [n.id, attempts, String((err as Error).message).slice(0, 500), giveUp ? 'failed' : 'queued', String(2 ** attempts)]);
      failed++;
    }
  }
  return { sent, failed, skipped };
}
