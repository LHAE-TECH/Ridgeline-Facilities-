import type { Db } from '../db.js';
import { maybeOne } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { AppError, NotFoundError } from '../lib/errors.js';

export type JobStatus =
  | 'pending_funds' | 'awaiting_customer_approval' | 'dispatch' | 'offered' | 'assigned' | 'on_site' | 'in_progress'
  | 'evidence_submitted' | 'evidence_rejected' | 'evidence_approved' | 'invoice_submitted' | 'invoice_approved'
  | 'customer_invoiced' | 'closed' | 'cancelled';

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  pending_funds: 'Awaiting top-up or exception',
  awaiting_customer_approval: 'Awaiting customer approval',
  dispatch: 'Awaiting dispatch',
  offered: 'Offered to contractors',
  assigned: 'Contractor assigned',
  on_site: 'Contractor on site',
  in_progress: 'Work in progress',
  evidence_submitted: 'Completed – evidence under review',
  evidence_rejected: 'More evidence requested',
  evidence_approved: 'Work verified',
  invoice_submitted: 'Contractor invoice under review',
  invoice_approved: 'Contractor invoice approved',
  customer_invoiced: 'Customer invoiced',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

/** Allowed status transitions. Anything else is rejected. */
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  pending_funds: ['dispatch', 'awaiting_customer_approval', 'cancelled'],
  awaiting_customer_approval: ['dispatch', 'pending_funds', 'cancelled'],
  dispatch: ['offered', 'assigned', 'cancelled'],
  offered: ['dispatch', 'assigned', 'cancelled'],
  assigned: ['on_site', 'dispatch', 'assigned', 'cancelled'],
  on_site: ['in_progress', 'dispatch', 'assigned', 'cancelled'],
  in_progress: ['evidence_submitted', 'dispatch', 'assigned'],
  evidence_submitted: ['evidence_approved', 'evidence_rejected'],
  evidence_rejected: ['evidence_submitted'],
  evidence_approved: ['invoice_submitted'],
  invoice_submitted: ['invoice_approved', 'evidence_approved', 'cancelled'],
  invoice_approved: ['customer_invoiced'],
  customer_invoiced: ['closed'],
  closed: [],
  cancelled: ['invoice_submitted'],
};

export const ACTIVE_WORK_STATUSES: JobStatus[] = ['assigned', 'on_site', 'in_progress'];

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export async function lockJob(db: Db, jobId: string): Promise<any> {
  const job = await maybeOne(db, 'SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
  if (!job) throw new NotFoundError('Job');
  return job;
}

export interface TransitionOptions {
  eventType?: string;
  note?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  /** Extra column assignments, e.g. { arrived_at: 'now()' } — values are SQL expressions or {value}. */
  set?: Record<string, { sql: string } | { value: unknown }>;
}

/** Changes a job's status (caller must hold the row lock) and records a server-timestamped event. */
export async function transitionJob(db: Db, actor: Actor, job: { id: string; status: JobStatus }, to: JobStatus, opts: TransitionOptions = {}): Promise<void> {
  if (job.status !== to && !canTransition(job.status, to)) {
    throw new AppError(`A job that is "${JOB_STATUS_LABELS[job.status]}" cannot move to "${JOB_STATUS_LABELS[to]}"`, 409, 'invalid_transition');
  }
  const sets = ['status = $2', 'updated_at = now()'];
  const params: unknown[] = [job.id, to];
  for (const [col, v] of Object.entries(opts.set ?? {})) {
    if (!/^[a-z_]+$/.test(col)) throw new Error('Invalid column');
    if ('sql' in v) sets.push(`${col} = ${v.sql}`);
    else { params.push(v.value); sets.push(`${col} = $${params.length}`); }
  }
  await db.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $1`, params);
  await recordJobEvent(db, actor, job.id, opts.eventType ?? `status.${to}`, { from: job.status, to, note: opts.note, lat: opts.lat, lng: opts.lng, accuracy: opts.accuracy });
  job.status = to;
}

export async function recordJobEvent(db: Db, actor: Actor, jobId: string, eventType: string,
  o: { from?: string | null; to?: string | null; note?: string | null; lat?: number | null; lng?: number | null; accuracy?: number | null } = {}): Promise<void> {
  await db.query(
    `INSERT INTO job_events (job_id, event_type, from_status, to_status, actor_id, note, lat, lng, accuracy_m) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [jobId, eventType, o.from ?? null, o.to ?? null, actor.id, o.note ?? null, o.lat ?? null, o.lng ?? null, o.accuracy ?? null],
  );
}
