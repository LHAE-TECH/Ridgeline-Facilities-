import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { SYSTEM_ACTOR, isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { audit } from './audit.js';
import { createCreditNote } from './customerInvoices.js';
import { recordJobEvent } from './jobState.js';
import { link, notifyStaff } from './notifications.js';
import { holdPayable, releaseHold } from './payables.js';

/**
 * Raises a dispute on a job. The job's customer invoice cannot be issued and the contractor payable is put on
 * hold (not reduced) until the dispute is resolved. History is retained in job events and the audit log.
 */
export async function raiseDispute(db: Db, actor: Actor, jobId: string, reason: string) {
  if (!reason?.trim()) throw new AppError('Describe the issue');
  return tx(db, async (c) => {
    const job = await maybeOne(c, 'SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
    if (!job) throw new NotFoundError('Job');
    let party: 'customer' | 'contractor' | 'ridgeline';
    if (isStaff(actor)) party = 'ridgeline';
    else if (actor.role === 'customer' && actor.customerId === job.customer_id && actor.customerRole !== 'viewer') party = 'customer';
    else if (actor.role === 'contractor' && actor.contractorId === job.assigned_contractor_id) party = 'contractor';
    else throw new NotFoundError('Job');
    const invoice = await maybeOne(c, `SELECT id FROM customer_invoices WHERE job_id = $1 AND status <> 'void'`, [jobId]);
    const d = await one(c, `INSERT INTO disputes (job_id, customer_invoice_id, raised_by, raised_by_party, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [jobId, invoice?.id ?? null, actor.id, party, reason.trim()]);
    await c.query(`UPDATE jobs SET hold_reason = 'Dispute open' WHERE id = $1`, [jobId]);
    const payable = await maybeOne(c, `SELECT id FROM contractor_payables WHERE job_id = $1 AND status IN ('awaiting_payment_approval','approved_for_payment')`, [jobId]);
    if (payable) await holdPayable(c, SYSTEM_ACTOR, payable.id, `Dispute ${d.id} open`);
    await recordJobEvent(c, actor, jobId, 'dispute.raised', { note: reason });
    await notifyStaff(c, ['ops', 'finance', 'admin'], { template: 'dispute_raised', subject: `Dispute raised on ${job.ref}`,
      body: `A ${party} raised a dispute on ${job.ref}: ${reason}\n${link(`/admin/disputes`)}`, idempotencyKey: `dispute:${d.id}` });
    await audit(c, actor, { action: 'dispute.raised', entityType: 'dispute', entityId: d.id, customerId: job.customer_id, contractorId: job.assigned_contractor_id, details: { reason, party } });
    return d;
  });
}

export async function setDisputeInvestigating(db: Db, actor: Actor, disputeId: string) {
  if (!isStaff(actor)) throw new ForbiddenError();
  await db.query(`UPDATE disputes SET status = 'investigating' WHERE id = $1 AND status = 'open'`, [disputeId]);
  await audit(db, actor, { action: 'dispute.investigating', entityType: 'dispute', entityId: disputeId });
}

/** Resolves a dispute, optionally issuing a customer credit note. Releases holds when no disputes remain open. */
export async function resolveDispute(db: Db, actor: Actor, disputeId: string, input: { outcome: 'resolved' | 'rejected'; resolution: string; creditExGstCents?: number }) {
  if (actor.role !== 'admin' && actor.role !== 'finance' && actor.role !== 'ops') throw new ForbiddenError();
  if (!input.resolution?.trim()) throw new AppError('Record the resolution');
  return tx(db, async (c) => {
    const d = await maybeOne(c, 'SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [disputeId]);
    if (!d) throw new NotFoundError('Dispute');
    if (!['open', 'investigating'].includes(d.status)) throw new AppError('Dispute already closed', 409);
    if (input.creditExGstCents) {
      const inv = await maybeOne(c, `SELECT id FROM customer_invoices WHERE job_id = $1 AND status IN ('issued','partially_paid','paid')`, [d.job_id]);
      if (!inv) throw new AppError('There is no issued invoice to credit for this job', 409);
      await createCreditNote(c, actor, inv.id, { amountExGstCents: input.creditExGstCents, reason: `Dispute resolution: ${input.resolution}`, disputeId });
    }
    await c.query(`UPDATE disputes SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now() WHERE id = $1`, [disputeId, input.outcome, input.resolution, actor.id]);
    const open = await one<{ n: number }>(c, `SELECT COUNT(*)::int AS n FROM disputes WHERE job_id = $1 AND status IN ('open','investigating')`, [d.job_id]);
    if (open.n === 0) {
      await c.query(`UPDATE jobs SET hold_reason = NULL WHERE id = $1`, [d.job_id]);
      const held = await query(c, `SELECT id FROM contractor_payables WHERE job_id = $1 AND status = 'on_hold' AND hold_reason LIKE 'Dispute %'`, [d.job_id]);
      for (const h of held) await releaseHold(c, SYSTEM_ACTOR, h.id);
    }
    await recordJobEvent(c, actor, d.job_id, `dispute.${input.outcome}`, { note: input.resolution });
    await audit(c, actor, { action: `dispute.${input.outcome}`, entityType: 'dispute', entityId: disputeId, details: input });
  });
}
