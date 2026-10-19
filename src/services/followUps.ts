import type { Db } from '../db.js';
import { maybeOne, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { audit } from './audit.js';
import { link, notifyCustomer, notifyStaff } from './notifications.js';
import { getSettings, type Settings } from './settings.js';
import { createBooking } from './jobs.js';
import type { Priority } from './pricing.js';

/**
 * Follow-up suggestions: the outstanding work recorded on a make-safe job. Each one stays open on the admin side until
 * staff book a follow-up job or dismiss it with a reason, so a made-safe fault is never quietly left.
 */

const SELECT_FOLLOW_UPS = `SELECT f.*, j.ref AS job_ref, j.title AS job_title, j.made_safe_at, c.name AS customer_name, s.name AS site_name, t.name AS trade_name,
            u.name AS decided_by_name, fj.ref AS follow_up_job_ref,
            FLOOR(EXTRACT(EPOCH FROM (COALESCE(f.decided_at, now()) - f.created_at)) / 86400)::int AS age_days
       FROM follow_up_suggestions f JOIN jobs j ON j.id = f.job_id JOIN customers c ON c.id = f.customer_id
       JOIN sites s ON s.id = f.site_id JOIN trades t ON t.id = f.trade_id
       LEFT JOIN users u ON u.id = f.decided_by LEFT JOIN jobs fj ON fj.id = f.follow_up_job_id`;

export type AgeBand = 'current' | 'aged' | 'escalated';

function band(ageDays: number, settings: Settings): AgeBand {
  return ageDays >= settings.follow_up_escalate_days ? 'escalated' : ageDays >= settings.follow_up_flag_days ? 'aged' : 'current';
}

/** Open follow-ups, oldest first, each with its age in days and age band (current / aged / escalated). */
export async function openFollowUps(db: Db) {
  const settings = await getSettings(db);
  const rows = await query(db, `${SELECT_FOLLOW_UPS} WHERE f.status = 'open' ORDER BY f.created_at`);
  return rows.map((r) => ({ ...r, band: band(r.age_days, settings) }));
}

/** Dashboard counts: aged and escalated follow-ups are counted separately from the open total. */
export async function followUpSummary(db: Db) {
  const open = await openFollowUps(db);
  const aged = open.filter((f) => f.band === 'aged');
  const escalated = open.filter((f) => f.band === 'escalated');
  return { open: open.length, current: open.length - aged.length - escalated.length, aged: aged.length, escalated: escalated.length,
    agedList: [...escalated, ...aged] };
}

/** Every follow-up ever raised, by status (dismissed and declined ones stay in the record and are reportable). */
export async function followUpReport(db: Db, filter: { status?: string; from?: string; to?: string } = {}) {
  const status = filter.status && filter.status !== 'all' ? filter.status : null;
  return query(db,
    `${SELECT_FOLLOW_UPS} WHERE ($1::text IS NULL OR f.status = $1)
        AND ($2::date IS NULL OR (f.created_at AT TIME ZONE 'Pacific/Auckland')::date >= $2::date)
        AND ($3::date IS NULL OR (f.created_at AT TIME ZONE 'Pacific/Auckland')::date <= $3::date)
      ORDER BY f.created_at DESC`, [status, filter.from || null, filter.to || null]);
}

export function followUpCsv(rows: any[]): string {
  const esc = (v: unknown) => { const t = v == null ? '' : String(v instanceof Date ? v.toISOString() : v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const header = ['raised', 'job', 'customer', 'site', 'trade', 'outstanding', 'status', 'age_days', 'decided_at', 'decided_by', 'on_behalf_of_customer', 'reason_or_note', 'follow_up_job', 'customer_told', 'flagged', 'escalated', 'customer_reminded'];
  const lines = rows.map((r) => [r.created_at, r.job_ref, r.customer_name, r.site_name, r.trade_name, r.description, r.status, r.age_days, r.decided_at,
    r.decided_by_name, r.decided_on_behalf_of_customer, r.decision_note, r.follow_up_job_ref, r.customer_notified_at, r.flagged_at, r.escalated_at, r.customer_reminded_at].map(esc).join(','));
  return [header.join(','), ...lines].join('\n') + '\n';
}

/**
 * Worker: flags follow-ups open past follow_up_flag_days, and at follow_up_escalate_days escalates them to operations
 * and administrators and reminds the customer. Each step happens once per follow-up.
 */
export async function processFollowUpAgeing(db: Db): Promise<{ flagged: number; escalated: number }> {
  const settings = await getSettings(db);
  const flagged = await query(db,
    `UPDATE follow_up_suggestions SET flagged_at = now() WHERE status = 'open' AND flagged_at IS NULL
        AND created_at <= now() - ($1 || ' days')::interval RETURNING id, job_id`, [String(settings.follow_up_flag_days)]);
  for (const f of flagged) {
    await notifyStaff(db, ['ops'], { template: 'follow_up_aged', subject: `Follow-up open ${settings.follow_up_flag_days}+ days`,
      body: `A make-safe follow-up has been open for ${settings.follow_up_flag_days} days without being booked or dismissed.\n${link('/admin/follow-ups')}`,
      idempotencyKey: `follow-up-aged:${f.id}` });
  }
  const due = await query(db,
    `SELECT f.*, j.ref AS job_ref FROM follow_up_suggestions f JOIN jobs j ON j.id = f.job_id
      WHERE f.status = 'open' AND f.escalated_at IS NULL AND f.created_at <= now() - ($1 || ' days')::interval`, [String(settings.follow_up_escalate_days)]);
  for (const f of due) {
    await tx(db, async (c) => {
      const claimed = await maybeOne(c, `UPDATE follow_up_suggestions SET escalated_at = now(), customer_reminded_at = now(), flagged_at = COALESCE(flagged_at, now())
        WHERE id = $1 AND escalated_at IS NULL RETURNING id`, [f.id]);
      if (!claimed) return;
      await notifyStaff(c, ['ops', 'admin'], { template: 'follow_up_escalated', subject: `ESCALATED: outstanding work after make-safe on ${f.job_ref} (${settings.follow_up_escalate_days}+ days)`,
        body: `Outstanding since ${f.created_at.toISOString().slice(0, 10)}: ${f.description}\nBook it, record the customer's decision, or dismiss it with a reason.\n${link('/admin/follow-ups')}`,
        idempotencyKey: `follow-up-escalated:${f.id}` });
      await notifyCustomer(c, f.customer_id, { template: 'follow_up_reminder', subject: `Reminder: work still outstanding after ${f.job_ref}`,
        body: `When we made your property safe (${f.job_ref}), this work was left outstanding: ${f.description}\n\nIt has not been arranged yet. ` +
          `Please contact us to book it, or tell us on the job page if you do not want to proceed: ${link(`/app/jobs/${f.job_id}`)}`,
        idempotencyKey: `follow-up-reminder:${f.id}` });
    });
  }
  return { flagged: flagged.length, escalated: due.length };
}

/**
 * The customer decides not to proceed: recorded with their reason. Owners and approvers can record it themselves;
 * operations staff can record it on the customer's behalf (e.g. by phone), which is marked as such.
 */
export async function declineFollowUp(db: Db, actor: Actor, suggestionId: string, reason: string) {
  if (!reason?.trim()) throw new AppError('Please give a reason for not proceeding');
  const f = await maybeOne(db, 'SELECT * FROM follow_up_suggestions WHERE id = $1', [suggestionId]);
  if (!f) throw new NotFoundError('Follow-up');
  let onBehalf = false;
  if (actor.role === 'customer') {
    if (actor.customerId !== f.customer_id) throw new NotFoundError('Follow-up');
    if (!['owner', 'approver'].includes(actor.customerRole ?? '')) throw new ForbiddenError('Only an account owner or approver can decline outstanding work');
  } else {
    assertOps(actor);
    onBehalf = true;
  }
  const updated = await maybeOne(db, `UPDATE follow_up_suggestions SET status = 'declined_by_customer', decided_by = $2, decided_at = now(), decision_note = $3,
      decided_on_behalf_of_customer = $4 WHERE id = $1 AND status = 'open' RETURNING *`, [suggestionId, actor.id, reason.trim(), onBehalf]);
  if (!updated) throw new AppError('This follow-up has already been handled', 409);
  await audit(db, actor, { action: 'follow_up.declined_by_customer', entityType: 'follow_up', entityId: f.id, customerId: f.customer_id,
    details: { jobId: f.job_id, reason: reason.trim(), recordedOnBehalf: onBehalf } });
  await notifyStaff(db, ['ops'], { template: 'follow_up_declined', subject: 'Customer declined outstanding work after make-safe',
    body: `Reason: ${reason.trim()}${onBehalf ? ' (recorded by staff on the customer\'s behalf)' : ''}\n${link('/admin/follow-ups?status=declined_by_customer')}`,
    idempotencyKey: `follow-up-declined:${f.id}` });
  return updated;
}

export async function followUpsForJob(db: Db, jobId: string) {
  return query(db, `SELECT * FROM follow_up_suggestions WHERE job_id = $1 ORDER BY created_at`, [jobId]);
}

function assertOps(actor: Actor) {
  if (!isStaff(actor) || actor.role === 'finance') throw new ForbiddenError('Only operations staff or administrators handle follow-ups');
}

/** Books the follow-up as a new job for the customer (normal funding, authority and SLA rules apply). */
export async function bookFollowUp(db: Db, actor: Actor, suggestionId: string, input: { priority: Priority; preferredStart?: string | null; note?: string }) {
  assertOps(actor);
  const f = await maybeOne(db, `SELECT f.*, j.ref AS job_ref, j.title AS job_title FROM follow_up_suggestions f JOIN jobs j ON j.id = f.job_id WHERE f.id = $1`, [suggestionId]);
  if (!f) throw new NotFoundError('Follow-up');
  if (f.status !== 'open') throw new AppError(`This follow-up is already ${f.status}`, 409);
  const { job } = await createBooking(db, actor, {
    customerId: f.customer_id, siteId: f.site_id, tradeId: f.trade_id, priority: input.priority,
    title: `Follow-up to ${f.job_ref}: ${f.job_title}`.slice(0, 200),
    description: `Outstanding after make-safe on ${f.job_ref}: ${f.description}${input.note?.trim() ? `\n\n${input.note.trim()}` : ''}`,
    preferredStart: input.preferredStart ?? null, idempotencyKey: `follow-up:${f.id}`,
  });
  await tx(db, async (c) => {
    const updated = await maybeOne(c, `UPDATE follow_up_suggestions SET status = 'booked', follow_up_job_id = $2, decided_by = $3, decided_at = now(), decision_note = $4
      WHERE id = $1 AND status = 'open' RETURNING id`, [f.id, job.id, actor.id, input.note?.trim() || null]);
    if (!updated) throw new AppError('This follow-up was handled by someone else', 409);
    await audit(c, actor, { action: 'follow_up.booked', entityType: 'follow_up', entityId: f.id, customerId: f.customer_id, details: { jobId: f.job_id, followUpJobId: job.id } });
  });
  return job;
}

export async function dismissFollowUp(db: Db, actor: Actor, suggestionId: string, reason: string) {
  assertOps(actor);
  if (!reason?.trim()) throw new AppError('A reason is required to dismiss a follow-up');
  const f = await maybeOne(db, `UPDATE follow_up_suggestions SET status = 'dismissed', decided_by = $2, decided_at = now(), decision_note = $3
    WHERE id = $1 AND status = 'open' RETURNING *`, [suggestionId, actor.id, reason.trim()]);
  if (!f) throw new AppError('Follow-up not found or already handled', 409);
  await audit(db, actor, { action: 'follow_up.dismissed', entityType: 'follow_up', entityId: f.id, customerId: f.customer_id, details: { jobId: f.job_id, reason: reason.trim() } });
  return f;
}
