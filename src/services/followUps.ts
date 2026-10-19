import type { Db } from '../db.js';
import { maybeOne, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { audit } from './audit.js';
import { createBooking } from './jobs.js';
import type { Priority } from './pricing.js';

/**
 * Follow-up suggestions: the outstanding work recorded on a make-safe job. Each one stays open on the admin side until
 * staff book a follow-up job or dismiss it with a reason, so a made-safe fault is never quietly left.
 */

export async function openFollowUps(db: Db) {
  return query(db,
    `SELECT f.*, j.ref AS job_ref, j.title AS job_title, j.made_safe_at, c.name AS customer_name, s.name AS site_name, t.name AS trade_name,
            ROUND(EXTRACT(EPOCH FROM (now() - f.created_at)) / 3600)::int AS age_hours
       FROM follow_up_suggestions f JOIN jobs j ON j.id = f.job_id JOIN customers c ON c.id = f.customer_id
       JOIN sites s ON s.id = f.site_id JOIN trades t ON t.id = f.trade_id
      WHERE f.status = 'open' ORDER BY f.created_at`);
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
