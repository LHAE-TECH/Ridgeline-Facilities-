import type { Db } from '../db.js';
import { isUniqueViolation, maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { SYSTEM_ACTOR, isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { audit } from './audit.js';
import { DOCUMENT_TYPES } from './contractors.js';
import { lockJob, recordJobEvent, transitionJob } from './jobState.js';
import { link, notifyContractor, notifyCustomer, notifyStaff } from './notifications.js';
import { getSettings } from './settings.js';
import { classifyTime, loadHolidays } from './timeWindows.js';

export interface ContractorAssessment {
  contractorId: string;
  name: string;
  eligible: boolean;
  reasons: string[];
  activeJobs: number;
  distanceKm: number | null;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Evaluates every contractor against a job: trade & qualification, coverage area, availability, capacity,
 * response requirements, agreed rates and compliance (insurance/licences). Reasons explain any ineligibility.
 */
export async function assessContractorsForJob(db: Db, jobId: string): Promise<ContractorAssessment[]> {
  const job = await maybeOne(db,
    `SELECT j.*, s.region AS site_region, s.lat AS site_lat, s.lng AS site_lng, t.required_documents, t.name AS trade_name
       FROM jobs j JOIN sites s ON s.id = j.site_id JOIN trades t ON t.id = j.trade_id WHERE j.id = $1`, [jobId]);
  if (!job) throw new NotFoundError('Job');
  const settings = await getSettings(db);
  const holidays = await loadHolidays(db);
  const attendTime = job.preferred_start ? new Date(job.preferred_start) : new Date();
  const window = classifyTime(attendTime, settings, holidays);
  const requiredDocs: string[] = [...new Set([...settings.always_required_documents, ...(job.required_documents ?? [])])];

  const contractors = await query(db,
    `SELECT c.*,
            ct.verified AS trade_verified, (ct.contractor_id IS NOT NULL) AS has_trade,
            (SELECT COUNT(*) FROM jobs aj WHERE aj.assigned_contractor_id = c.id AND aj.status IN ('assigned','on_site','in_progress'))::int AS active_jobs,
            EXISTS (SELECT 1 FROM contractor_rate_cards r WHERE r.contractor_id = c.id AND r.trade_id = $1 AND r.status = 'approved'
                     AND r.effective_from <= CURRENT_DATE AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE)) AS has_rate_card,
            COALESCE((SELECT array_agg(DISTINCT d.doc_type) FROM compliance_documents d WHERE d.contractor_id = c.id AND d.status = 'verified'
                       AND (d.expires_at IS NULL OR d.expires_at >= CURRENT_DATE)), '{}') AS valid_docs
       FROM contractors c LEFT JOIN contractor_trades ct ON ct.contractor_id = c.id AND ct.trade_id = $1
      WHERE c.status IN ('approved','pending','suspended')
      ORDER BY c.legal_name`, [job.trade_id]);

  return contractors.map((c) => {
    const reasons: string[] = [];
    if (c.status !== 'approved') reasons.push(`Contractor status is ${c.status}`);
    if (!c.has_trade) reasons.push(`Not registered for ${job.trade_name}`);
    else if (!c.trade_verified) reasons.push(`${job.trade_name} qualification not verified`);
    if (!c.has_rate_card) reasons.push(`No agreed rate card for ${job.trade_name}`);
    let distanceKm: number | null = null;
    if (c.base_lat != null && c.base_lng != null && job.site_lat != null && job.site_lng != null) {
      distanceKm = Math.round(haversineKm(c.base_lat, c.base_lng, job.site_lat, job.site_lng) * 10) / 10;
    }
    const inRegion = (c.service_regions ?? []).includes(job.site_region);
    const inRadius = distanceKm !== null && c.service_radius_km != null && distanceKm <= c.service_radius_km;
    if (!inRegion && !inRadius) reasons.push(`Does not cover ${job.site_region}`);
    if (!c.available) reasons.push('Marked unavailable');
    if (c.active_jobs >= c.max_concurrent_jobs) reasons.push(`At capacity (${c.active_jobs}/${c.max_concurrent_jobs} active jobs)`);
    if (job.priority === 'emergency' && !c.emergency_available) reasons.push('Not available for emergency response');
    if (window !== 'standard' && !c.after_hours_available) reasons.push('Not available outside standard hours');
    for (const d of requiredDocs) {
      if (!(c.valid_docs ?? []).includes(d)) reasons.push(`Missing or expired: ${DOCUMENT_TYPES[d] ?? d}`);
    }
    return { contractorId: c.id, name: c.trading_name || c.legal_name, eligible: reasons.length === 0, reasons, activeJobs: c.active_jobs, distanceKm };
  });
}

/** Sends offers to every eligible contractor not already offered. Returns the number of new offers. */
export async function dispatchJob(db: Db, actor: Actor, jobId: string): Promise<{ offered: number; eligible: number }> {
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    if (!['dispatch', 'offered'].includes(job.status)) throw new AppError('Job is not awaiting dispatch', 409);
    const settings = await getSettings(c);
    const assessments = (await assessContractorsForJob(c, jobId)).filter((a) => a.eligible);
    const previous = await query<{ contractor_id: string }>(c,
      `SELECT contractor_id FROM job_offers WHERE job_id = $1 AND status IN ('offered','declined')`, [jobId]);
    const skip = new Set(previous.map((p) => p.contractor_id));
    const minutes = settings.offer_expiry_minutes[job.priority] ?? 60;
    let offered = 0;
    for (const a of assessments) {
      if (skip.has(a.contractorId)) continue;
      await c.query(`INSERT INTO job_offers (job_id, contractor_id, expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`,
        [jobId, a.contractorId, String(minutes)]);
      await notifyContractor(c, a.contractorId, {
        template: 'job_offer', subject: `New ${job.priority} job offer ${job.ref}`,
        body: `A new ${job.priority} job is available: ${job.title}.\nThis offer expires in ${minutes} minutes.\nView and accept: ${link('/c')}`,
        idempotencyKey: `offer:${jobId}:${a.contractorId}:${Date.now()}`, relatedType: 'job', relatedId: jobId,
      });
      offered++;
    }
    const live = await one<{ n: number }>(c, `SELECT COUNT(*)::int AS n FROM job_offers WHERE job_id = $1 AND status = 'offered'`, [jobId]);
    if (live.n > 0 && job.status === 'dispatch') {
      await transitionJob(c, actor, job, 'offered', { note: `Offered to ${live.n} contractor(s)` });
    }
    if (live.n === 0) {
      await notifyStaff(c, ['ops', 'admin'], {
        template: 'job_unassigned', subject: `No eligible contractor for ${job.ref}`,
        body: `Job ${job.ref} (${job.priority}) has no eligible contractor available. Manual assignment is required.\n${link(`/admin/jobs/${jobId}`)}`,
        idempotencyKey: `unassigned:${jobId}:${new Date().toISOString().slice(0, 13)}`, relatedType: 'job', relatedId: jobId,
      });
    }
    return { offered, eligible: assessments.length };
  });
}

async function finaliseAssignment(c: Db, actor: Actor, job: any, contractorId: string, method: 'accepted' | 'manual', note?: string) {
  try {
    await c.query(`INSERT INTO job_assignments (job_id, contractor_id, method, assigned_by) VALUES ($1,$2,$3,$4)`,
      [job.id, contractorId, method, method === 'manual' ? actor.id : null]);
  } catch (err) {
    if (isUniqueViolation(err, 'job_assignments_one_active_idx')) throw new AppError('This job has already been assigned', 409, 'already_assigned');
    throw err;
  }
  // Close every remaining live offer (an accepted offer is already marked 'accepted').
  await c.query(`UPDATE job_offers SET status = 'withdrawn', responded_at = now() WHERE job_id = $1 AND status = 'offered'`, [job.id]);
  await transitionJob(c, actor, job, 'assigned', {
    eventType: method === 'manual' ? 'assigned.manual' : 'assigned.accepted', note,
    set: { assigned_contractor_id: { value: contractorId }, accepted_at: { sql: 'now()' }, arrived_at: { value: null }, started_at: { value: null } },
  });
  const contractor = await one(c, 'SELECT legal_name, trading_name FROM contractors WHERE id = $1', [contractorId]);
  await notifyCustomer(c, job.customer_id, {
    template: 'job_assigned', subject: `Contractor assigned to ${job.ref}`,
    body: `${contractor.trading_name || contractor.legal_name} has been assigned to your job ${job.ref}: ${job.title}.\nTrack progress: ${link(`/app/jobs/${job.id}`)}`,
    idempotencyKey: `assigned:${job.id}:${contractorId}:${Date.now()}`, relatedType: 'job', relatedId: job.id,
  });
}

/**
 * Contractor accepts an offer. Row locks plus the unique active-assignment index guarantee that only one
 * contractor can win a job, even under concurrent acceptance.
 */
export async function acceptOffer(db: Db, actor: Actor, offerId: string) {
  if (actor.role !== 'contractor' || !actor.contractorId) throw new ForbiddenError('Only contractors can accept offers');
  return tx(db, async (c) => {
    const offer = await maybeOne(c, 'SELECT * FROM job_offers WHERE id = $1', [offerId]);
    if (!offer || offer.contractor_id !== actor.contractorId) throw new NotFoundError('Offer');
    const job = await lockJob(c, offer.job_id);
    const fresh = await one(c, 'SELECT * FROM job_offers WHERE id = $1 FOR UPDATE', [offerId]);
    if (fresh.status === 'accepted') throw new AppError('You have already accepted this job', 409, 'duplicate_acceptance');
    if (fresh.status !== 'offered') throw new AppError(`This offer is no longer available (${fresh.status})`, 409);
    if (new Date(fresh.expires_at) <= new Date()) {
      await c.query(`UPDATE job_offers SET status = 'expired' WHERE id = $1`, [offerId]);
      throw new AppError('This offer has expired', 409, 'offer_expired');
    }
    if (job.assigned_contractor_id || !['offered', 'dispatch'].includes(job.status)) {
      throw new AppError('This job has already been assigned', 409, 'already_assigned');
    }
    const me = (await assessContractorsForJob(c, job.id)).find((a) => a.contractorId === actor.contractorId);
    if (!me?.eligible) throw new AppError(`You are not currently eligible for this job: ${me?.reasons.join('; ') ?? 'unknown'}`, 403, 'not_eligible');
    await c.query(`UPDATE job_offers SET status = 'accepted', responded_at = now() WHERE id = $1`, [offerId]);
    await finaliseAssignment(c, actor, job, actor.contractorId!, 'accepted');
    await audit(c, actor, { action: 'job.accepted', entityType: 'job', entityId: job.id, customerId: job.customer_id, contractorId: actor.contractorId });
    return job;
  });
}

export async function declineOffer(db: Db, actor: Actor, offerId: string, reason?: string) {
  if (actor.role !== 'contractor') throw new ForbiddenError();
  return tx(db, async (c) => {
    const offer = await maybeOne(c, 'SELECT * FROM job_offers WHERE id = $1', [offerId]);
    if (!offer || offer.contractor_id !== actor.contractorId) throw new NotFoundError('Offer');
    const job = await lockJob(c, offer.job_id);
    const updated = await maybeOne(c, `UPDATE job_offers SET status = 'declined', responded_at = now(), decline_reason = $2 WHERE id = $1 AND status = 'offered' RETURNING id`,
      [offerId, reason || null]);
    if (!updated) throw new AppError('This offer is no longer open', 409);
    await recordJobEvent(c, actor, job.id, 'offer.declined', { note: reason });
    await returnToQueueIfNoLiveOffers(c, job);
  });
}

async function returnToQueueIfNoLiveOffers(c: Db, job: any) {
  const live = await one<{ n: number }>(c, `SELECT COUNT(*)::int AS n FROM job_offers WHERE job_id = $1 AND status = 'offered'`, [job.id]);
  if (live.n === 0 && job.status === 'offered') {
    await transitionJob(c, SYSTEM_ACTOR, job, 'dispatch', { note: 'All offers declined or expired; returned to dispatch queue' });
    await notifyStaff(c, ['ops', 'admin'], {
      template: 'job_unassigned', subject: `Job ${job.ref} needs dispatch`,
      body: `All offers for ${job.ref} were declined or expired. Manual assignment may be required.\n${link(`/admin/jobs/${job.id}`)}`,
      idempotencyKey: `requeue:${job.id}:${Date.now()}`, relatedType: 'job', relatedId: job.id,
    });
  }
}

/** Expires stale offers and returns jobs with no live offers to the dispatch queue. */
export async function expireOffers(db: Db): Promise<number> {
  const expired = await query<{ job_id: string }>(db,
    `UPDATE job_offers SET status = 'expired' WHERE status = 'offered' AND expires_at <= now() RETURNING job_id`);
  for (const jobId of [...new Set(expired.map((e) => e.job_id))]) {
    await tx(db, async (c) => {
      const job = await lockJob(c, jobId);
      await returnToQueueIfNoLiveOffers(c, job);
    });
  }
  return expired.length;
}

/** Staff assignment. Ineligible contractors can only be assigned by an administrator with a recorded reason. */
export async function manualAssign(db: Db, actor: Actor, jobId: string, contractorId: string, overrideReason?: string) {
  if (!isStaff(actor) || actor.role === 'finance') throw new ForbiddenError('Only operations staff can assign jobs');
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    if (!['dispatch', 'offered', 'assigned', 'on_site', 'in_progress'].includes(job.status)) throw new AppError('Job cannot be assigned in its current status', 409);
    const assessment = (await assessContractorsForJob(c, jobId)).find((a) => a.contractorId === contractorId);
    if (!assessment) throw new NotFoundError('Contractor');
    if (!assessment.eligible) {
      if (actor.role !== 'admin' || !overrideReason?.trim()) {
        throw new AppError(`Contractor is not eligible: ${assessment.reasons.join('; ')}. An administrator may override with a reason.`, 409, 'not_eligible');
      }
    }
    if (job.assigned_contractor_id === contractorId) throw new AppError('Contractor is already assigned to this job', 409);
    if (job.assigned_contractor_id) {
      await c.query(`UPDATE job_assignments SET status = 'ended', ended_at = now(), ended_reason = 'reassigned' WHERE job_id = $1 AND status = 'active'`, [jobId]);
      await notifyContractor(c, job.assigned_contractor_id, {
        template: 'job_reassigned', subject: `Job ${job.ref} reassigned`, body: `Job ${job.ref} has been reassigned by Ridgeline. Please do not attend.`,
        idempotencyKey: `reassigned:${jobId}:${job.assigned_contractor_id}:${Date.now()}`,
      });
    }
    await finaliseAssignment(c, actor, job, contractorId, 'manual', overrideReason ? `Eligibility override: ${overrideReason}` : undefined);
    await notifyContractor(c, contractorId, {
      template: 'job_assigned_manual', subject: `Job ${job.ref} assigned to you`, body: `Ridgeline has assigned job ${job.ref}: ${job.title}.\n${link(`/c/jobs/${jobId}`)}`,
      idempotencyKey: `manual-assign:${jobId}:${contractorId}:${Date.now()}`,
    });
    await audit(c, actor, { action: 'job.manually_assigned', entityType: 'job', entityId: jobId, customerId: job.customer_id, contractorId,
      details: { overrideReason: overrideReason ?? null, ineligibleReasons: assessment.reasons } });
  });
}

/** Removes the assigned contractor and returns the job to the dispatch queue. */
export async function unassign(db: Db, actor: Actor, jobId: string, reason: string) {
  if (!isStaff(actor) || actor.role === 'finance') throw new ForbiddenError();
  if (!reason?.trim()) throw new AppError('A reason is required');
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    if (!job.assigned_contractor_id || !['assigned', 'on_site', 'in_progress'].includes(job.status)) throw new AppError('Job has no active assignment', 409);
    await c.query(`UPDATE job_assignments SET status = 'ended', ended_at = now(), ended_reason = $2 WHERE job_id = $1 AND status = 'active'`, [jobId, reason]);
    const previous = job.assigned_contractor_id;
    await transitionJob(c, actor, job, 'dispatch', { eventType: 'unassigned', note: reason,
      set: { assigned_contractor_id: { value: null }, accepted_at: { value: null }, arrived_at: { value: null }, started_at: { value: null } } });
    await notifyContractor(c, previous, { template: 'job_unassigned_contractor', subject: `Job ${job.ref} withdrawn`,
      body: `Ridgeline has withdrawn job ${job.ref} from you. Reason: ${reason}`, idempotencyKey: `withdrawn:${jobId}:${previous}:${Date.now()}` });
    await audit(c, actor, { action: 'job.unassigned', entityType: 'job', entityId: jobId, customerId: job.customer_id, contractorId: previous, details: { reason } });
  });
}

/** Alerts operations about jobs at risk of breaching respond/attend deadlines. */
export async function checkSlaRisks(db: Db): Promise<number> {
  const risky = await query(db,
    `SELECT id, ref, priority, status, respond_by, attend_by FROM jobs
      WHERE sla_alerted_at IS NULL AND (
        (status IN ('dispatch','offered') AND respond_by IS NOT NULL AND respond_by - (respond_by - created_at) * 0.25 <= now())
        OR (status = 'assigned' AND attend_by IS NOT NULL AND attend_by - (attend_by - created_at) * 0.2 <= now()))`);
  for (const j of risky) {
    await notifyStaff(db, ['ops', 'admin'], {
      template: 'sla_risk', subject: `SLA risk: ${j.ref} (${j.priority})`,
      body: `Job ${j.ref} is "${j.status}" and is at risk of breaching its ${j.status === 'assigned' ? 'attendance' : 'response'} deadline ` +
        `(${new Date(j.status === 'assigned' ? j.attend_by : j.respond_by).toISOString()}).\n${link(`/admin/jobs/${j.id}`)}`,
      idempotencyKey: `sla:${j.id}`, relatedType: 'job', relatedId: j.id,
    });
    await db.query('UPDATE jobs SET sla_alerted_at = now() WHERE id = $1', [j.id]);
  }
  return risky.length;
}
