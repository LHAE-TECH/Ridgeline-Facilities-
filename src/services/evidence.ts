import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { formatNzd, parseQuantity } from '../lib/money.js';
import { audit } from './audit.js';
import { isMakeSafeOnly, recordScopeExtension } from './p1Scope.js';
import { lockJob, recordJobEvent, transitionJob } from './jobState.js';
import { link, notifyContractor, notifyCustomer, notifyStaff } from './notifications.js';
import { type CostLine, loadApprovedRules, priceCostLines } from './pricing.js';
import { getSettings } from './settings.js';
import { evaluateSla } from './sla.js';
import { type FilePurpose, saveFile } from './storage.js';

export interface GeoInput { lat?: number | null; lng?: number | null; accuracy?: number | null }

function assertAssigned(actor: Actor, job: any): void {
  if (actor.role !== 'contractor' || job.assigned_contractor_id !== actor.contractorId) throw new ForbiddenError('This job is not assigned to you');
}

function cleanGeo(g: GeoInput): GeoInput {
  const ok = (v: unknown, lim: number) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
  return { lat: ok(g.lat, 90) ? g.lat : null, lng: ok(g.lng, 180) ? g.lng : null, accuracy: typeof g.accuracy === 'number' && Number.isFinite(g.accuracy) ? g.accuracy : null };
}

/** Records arrival with a server timestamp (and GPS position if the contractor's device permitted it). */
export async function recordArrival(db: Db, actor: Actor, jobId: string, geo: GeoInput = {}) {
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    assertAssigned(actor, job);
    if (job.status !== 'assigned') throw new AppError('Arrival can only be recorded for an assigned job', 409);
    const g = cleanGeo(geo);
    await transitionJob(c, actor, job, 'on_site', { eventType: 'arrived', ...g, set: { arrived_at: { sql: 'now()' } } });
    await evaluateSla(c, jobId);
    await notifyCustomer(c, job.customer_id, { template: 'contractor_arrived', subject: `Contractor on site: ${job.ref}`,
      body: `The contractor has arrived for job ${job.ref}.\n${link(`/app/jobs/${jobId}`)}`, idempotencyKey: `arrived:${jobId}:${Date.now()}` });
  });
}

/** P1: the contractor confirms the hazard is made safe (the P1 resolution target). Server timestamp. */
export async function markMadeSafe(db: Db, actor: Actor, jobId: string, note: string, geo: GeoInput = {}) {
  if (!note?.trim()) throw new AppError('Describe how the site was made safe');
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    assertAssigned(actor, job);
    if (job.priority !== 'emergency') throw new AppError('Made safe applies to P1 emergency jobs', 409);
    if (!['on_site', 'in_progress'].includes(job.status)) throw new AppError('Record arrival before marking the site safe', 409);
    if (job.made_safe_at) throw new AppError('Already recorded as made safe', 409);
    await c.query('UPDATE jobs SET made_safe_at = now() WHERE id = $1', [jobId]);
    await recordJobEvent(c, actor, jobId, 'made_safe', { note, ...cleanGeo(geo) });
    await evaluateSla(c, jobId);
    await notifyCustomer(c, job.customer_id, { template: 'made_safe', subject: `Made safe: ${job.ref}`,
      body: `The contractor has made the site safe for ${job.ref}: ${note}\n${link(`/app/jobs/${jobId}`)}`, idempotencyKey: `made-safe:${jobId}` });
  });
}

export async function startWork(db: Db, actor: Actor, jobId: string, geo: GeoInput = {}) {
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    assertAssigned(actor, job);
    if (job.status !== 'on_site') throw new AppError('Record arrival before starting work', 409);
    if (job.requires_quote) {
      const q = await maybeOne(c, `SELECT 1 FROM quotes WHERE job_id = $1 AND kind = 'quote' AND status = 'approved'`, [jobId]);
      if (!q) throw new AppError('This job requires an approved quote before work starts', 409);
    }
    await transitionJob(c, actor, job, 'in_progress', { eventType: 'work_started', ...cleanGeo(geo), set: { started_at: { sql: 'now()' } } });
  });
}

const EVIDENCE_KINDS = ['before_photo', 'after_photo', 'receipt', 'document', 'signature'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface UploadedFile { buffer: Buffer; originalName: string; mimeType: string }

/** Adds evidence files. Originals are stored with their SHA-256 hash and are never overwritten or deleted. */
export async function addEvidence(db: Db, actor: Actor, jobId: string, kind: EvidenceKind, files: UploadedFile[],
  meta: { caption?: string; deviceCapturedAt?: string | null } & GeoInput = {}) {
  if (!EVIDENCE_KINDS.includes(kind)) throw new AppError('Invalid evidence type');
  if (!files.length) throw new AppError('Choose at least one file');
  const job = await maybeOne(db, 'SELECT * FROM jobs WHERE id = $1', [jobId]);
  if (!job) throw new NotFoundError('Job');
  assertAssigned(actor, job);
  const allowed = ['on_site', 'in_progress', 'evidence_rejected'];
  if (kind === 'receipt' || kind === 'document') allowed.push('evidence_submitted', 'evidence_approved', 'invoice_submitted');
  if (!allowed.includes(job.status)) throw new AppError('Evidence can only be added while on site, during work, or when more evidence is requested', 409);
  if (kind === 'after_photo' && job.status === 'on_site') throw new AppError('Start work before adding after photographs', 409);
  const g = cleanGeo(meta);
  let deviceAt: string | null = null;
  if (meta.deviceCapturedAt) {
    const d = new Date(meta.deviceCapturedAt);
    if (!Number.isNaN(d.getTime())) deviceAt = d.toISOString();
  }
  const created = [];
  for (const f of files) {
    const file = await saveFile(db, actor, { ...f, purpose: kind as FilePurpose, customerId: job.customer_id, contractorId: actor.contractorId, jobId });
    created.push(await one(db,
      `INSERT INTO job_evidence (job_id, kind, file_id, caption, device_captured_at, lat, lng, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [jobId, kind, file.id, meta.caption || null, deviceAt, g.lat, g.lng, actor.id]));
  }
  await recordJobEvent(db, actor, jobId, `evidence.${kind}`, { note: `${files.length} file(s) uploaded`, lat: g.lat, lng: g.lng });
  return created;
}

/** Customer photos attached at booking time. */
export async function addBookingPhotos(db: Db, actor: Actor, jobId: string, files: UploadedFile[]) {
  const job = await maybeOne(db, 'SELECT * FROM jobs WHERE id = $1', [jobId]);
  if (!job) throw new NotFoundError('Job');
  if (!(isStaff(actor) || (actor.role === 'customer' && actor.customerId === job.customer_id))) throw new ForbiddenError();
  for (const f of files) {
    const file = await saveFile(db, actor, { ...f, purpose: 'booking_photo', customerId: job.customer_id, jobId });
    await db.query(`INSERT INTO job_evidence (job_id, kind, file_id, uploaded_by) VALUES ($1,'booking_photo',$2,$3)`, [jobId, file.id, actor.id]);
  }
}

export interface MaterialInput { description: string; quantity: string | number; unitCostCents: number }

export interface CompletionInput {
  workPerformed: string;
  labourMinutes: number;
  workers?: number;
  materials?: MaterialInput[];
  siteNotes?: string;
  issuesFound?: string;
  acknowledgedByName?: string;
  /** Make-safe jobs only (both required): what was made safe, and what remains outstanding. */
  madeSafeSummary?: string;
  outstandingWork?: string;
}

/** A job dispatched for make-safe scope that has not been extended: its report must say what was made safe and what is left. */
export function makeSafeReportRequired(job: { p1_scope?: string | null; scope_extended_at?: unknown }): boolean {
  return isMakeSafeOnly(job);
}

export interface EvidenceStatus { complete: boolean; missing: string[]; counts: Record<string, number> }

/** Mandatory evidence rules. A job cannot be submitted for approval until all are met. */
export async function evidenceStatus(db: Db, jobId: string, pendingReport?: CompletionInput): Promise<EvidenceStatus> {
  const job = await one(db,
    `SELECT j.*, t.before_photo_required, c.acknowledgement_required FROM jobs j JOIN trades t ON t.id = j.trade_id JOIN customers c ON c.id = j.customer_id WHERE j.id = $1`, [jobId]);
  const settings = await getSettings(db);
  const counts: Record<string, number> = {};
  for (const r of await query<{ kind: string; n: number }>(db,
    `SELECT kind, COUNT(*)::int AS n FROM job_evidence WHERE job_id = $1 AND withdrawn_at IS NULL GROUP BY kind`, [jobId])) counts[r.kind] = r.n;
  const missing: string[] = [];
  if (!job.arrived_at) missing.push('Arrival time has not been recorded');
  if (!job.started_at) missing.push('Work start time has not been recorded');
  if (job.before_photo_required && !counts.before_photo) missing.push('At least one before photograph');
  if ((counts.after_photo ?? 0) < settings.min_after_photos) missing.push(`At least ${settings.min_after_photos} after photograph(s)`);
  if (pendingReport) {
    if (!pendingReport.workPerformed?.trim()) missing.push('Description of work performed');
    if (!Number.isInteger(pendingReport.labourMinutes) || pendingReport.labourMinutes <= 0) missing.push('Labour time');
    if (job.acknowledgement_required && !pendingReport.acknowledgedByName?.trim()) missing.push('Customer / site representative acknowledgement');
    for (const m of pendingReport.materials ?? []) {
      if (!m.description?.trim() || !(m.unitCostCents >= 0)) missing.push('Each material needs a description and cost');
    }
  }
  return { complete: missing.length === 0, missing, counts };
}

/** Contractor completes the job and submits the completion report (a new version on each resubmission). */
export async function completeJob(db: Db, actor: Actor, jobId: string, input: CompletionInput, geo: GeoInput = {}) {
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    assertAssigned(actor, job);
    if (!['in_progress', 'evidence_rejected'].includes(job.status)) throw new AppError('Job is not in progress', 409);
    const status = await evidenceStatus(c, jobId, input);
    if (!status.complete) throw new AppError(`Mandatory evidence missing: ${status.missing.join('; ')}`, 422, 'evidence_incomplete');
    const makeSafe = makeSafeReportRequired(job);
    if (makeSafe && (!input.madeSafeSummary?.trim() || !input.outstandingWork?.trim())) {
      throw new AppError('This was a make-safe job: describe what was made safe and what remains outstanding (both required)', 422, 'make_safe_report_incomplete');
    }

    const materials = (input.materials ?? []).map((m) => ({ description: m.description.trim(), quantityMilli: parseQuantity(m.quantity), unitCostCents: m.unitCostCents }));
    const flags = await automaticFlags(c, job, input, cleanGeo(geo));
    const v = await one<{ v: number }>(c, 'SELECT COALESCE(MAX(version),0)::int + 1 AS v FROM completion_reports WHERE job_id = $1', [jobId]);
    const report = await one(c,
      `INSERT INTO completion_reports (job_id, version, work_performed, labour_minutes, workers, materials, site_notes, issues_found,
          acknowledged_by_name, acknowledged_at, submitted_by, review_flags, made_safe_summary, outstanding_work)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9::text IS NOT NULL THEN now() END, $10, $11, $12, $13) RETURNING *`,
      [jobId, v.v, input.workPerformed.trim(), input.labourMinutes, input.workers ?? 1, JSON.stringify(materials), input.siteNotes || null,
       input.issuesFound || null, input.acknowledgedByName?.trim() || null, actor.id, JSON.stringify(flags),
       input.madeSafeSummary?.trim() || null, input.outstandingWork?.trim() || null]);
    if (makeSafe) {
      // The outstanding work becomes a follow-up suggestion that staff must book or dismiss with a reason.
      const f = await one(c,
        `INSERT INTO follow_up_suggestions (job_id, customer_id, site_id, trade_id, completion_report_id, description)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (job_id) WHERE status = 'open' DO UPDATE SET description = EXCLUDED.description, completion_report_id = EXCLUDED.completion_report_id
         RETURNING id, customer_notified_at`,
        [jobId, job.customer_id, job.site_id, job.trade_id, report.id, input.outstandingWork!.trim()]);
      if (!f.customer_notified_at) {
        // The customer is told at once what was made safe and what is still outstanding.
        await notifyCustomer(c, job.customer_id, { template: 'follow_up_customer', subject: `${job.ref}: made safe, further work outstanding`,
          body: `The emergency at your property (${job.ref}) has been made safe: ${input.madeSafeSummary!.trim()}\n\nStill outstanding: ${input.outstandingWork!.trim()}\n\n` +
            `We will contact you to arrange this work. If you do not want to proceed, you can tell us (with a reason) on the job page: ${link(`/app/jobs/${jobId}`)}`,
          idempotencyKey: `follow-up-customer:${f.id}` });
        await c.query('UPDATE follow_up_suggestions SET customer_notified_at = now() WHERE id = $1', [f.id]);
      }
      await notifyStaff(c, ['ops', 'admin'], { template: 'follow_up_suggested', subject: `Follow-up needed after make-safe: ${job.ref}`,
        body: `Made safe: ${input.madeSafeSummary!.trim()}\nOutstanding: ${input.outstandingWork!.trim()}\nBook or dismiss the follow-up: ${link('/admin/follow-ups')}`,
        idempotencyKey: `follow-up:${report.id}` });
    }
    const g = cleanGeo(geo);
    await transitionJob(c, actor, job, 'evidence_submitted', {
      eventType: v.v === 1 ? 'completed' : 'evidence_resubmitted', ...g,
      note: flags.length ? `Auto-flags: ${flags.map((f) => f.code).join(', ')}` : null,
      set: v.v === 1 ? { completed_at: { sql: 'now()' } } : {},
    });
    await evaluateSla(c, jobId);
    await notifyStaff(c, ['ops', 'admin'], { template: 'evidence_submitted', subject: `Completion evidence for ${job.ref}`,
      body: `Contractor submitted completion evidence (version ${v.v}) for ${job.ref}.${flags.length ? ` Flags: ${flags.map((f) => f.message).join('; ')}` : ''}\n${link(`/admin/jobs/${jobId}`)}`,
      idempotencyKey: `evidence-submitted:${report.id}` });
    return report;
  });
}

interface Flag { code: string; message: string }

async function automaticFlags(c: Db, job: any, input: CompletionInput, geo: GeoInput): Promise<Flag[]> {
  const settings = await getSettings(c);
  const flags: Flag[] = [];
  if (job.arrived_at) {
    const onSiteMinutes = Math.max(1, Math.round((Date.now() - new Date(job.arrived_at).getTime()) / 60000));
    const allowed = onSiteMinutes * (input.workers ?? 1) * (1 + settings.labour_tolerance_bps / 10000);
    if (input.labourMinutes > allowed) {
      flags.push({ code: 'excessive_labour', message: `Labour of ${input.labourMinutes} min exceeds recorded on-site time of ${onSiteMinutes} min × ${input.workers ?? 1} worker(s)` });
    }
  }
  const site = await one(c, 'SELECT lat, lng FROM sites WHERE id = $1', [job.site_id]);
  if (geo.lat != null && geo.lng != null && site.lat != null && site.lng != null) {
    const dKm = Math.hypot((geo.lat - site.lat) * 111, (geo.lng - site.lng) * 111 * Math.cos((site.lat * Math.PI) / 180));
    if (dKm > settings.site_distance_flag_km) flags.push({ code: 'location_mismatch', message: `Completion recorded ~${dKm.toFixed(1)} km from the site` });
  }
  const early = await maybeOne(c,
    `SELECT COUNT(*)::int AS n FROM job_evidence WHERE job_id = $1 AND kind = 'after_photo' AND withdrawn_at IS NULL AND device_captured_at IS NOT NULL AND device_captured_at < $2`,
    [job.id, job.arrived_at]);
  if (early?.n) flags.push({ code: 'photo_time_before_arrival', message: `${early.n} after photo(s) report a device time before arrival (device clocks are not authoritative)` });
  return flags;
}

/** Ridgeline approves the evidence, or rejects it and requests more information. */
export async function reviewEvidence(db: Db, actor: Actor, jobId: string, decision: 'approve' | 'reject', notes?: string) {
  if (!isStaff(actor) || actor.role === 'finance') throw new ForbiddenError('Only operations staff can review completion evidence');
  if (decision === 'reject' && !notes?.trim()) throw new AppError('Explain what additional evidence or correction is required');
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    if (job.status !== 'evidence_submitted') throw new AppError('No evidence is awaiting review', 409);
    const report = await one(c, 'SELECT * FROM completion_reports WHERE job_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE', [jobId]);
    await c.query(`UPDATE completion_reports SET review_status = $2, review_notes = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`,
      [report.id, decision === 'approve' ? 'approved' : 'rejected', notes || null, actor.id]);
    if (decision === 'approve') {
      await transitionJob(c, actor, job, 'evidence_approved', { note: notes });
      const inv = await maybeOne(c, `SELECT id FROM contractor_invoices WHERE job_id = $1 AND status IN ('submitted','flagged')`, [jobId]);
      if (inv) await transitionJob(c, actor, job, 'invoice_submitted', { note: 'Contractor invoice already submitted' });
      await notifyCustomer(c, job.customer_id, { template: 'job_completed', subject: `Work completed: ${job.ref}`,
        body: `The work for ${job.ref} (${job.title}) has been completed and verified by Ridgeline.\nCompletion report: ${link(`/app/jobs/${jobId}`)}`,
        idempotencyKey: `job-completed:${jobId}`, attachments: [{ kind: 'completion_report_pdf', id: jobId, filename: `${job.ref}-completion-report.pdf` }] });
    } else {
      await transitionJob(c, actor, job, 'evidence_rejected', { note: notes });
      await notifyContractor(c, job.assigned_contractor_id, { template: 'evidence_rejected', subject: `More evidence needed for ${job.ref}`,
        body: `Ridgeline needs more information for ${job.ref}: ${notes}\n${link(`/c/jobs/${jobId}`)}`, idempotencyKey: `evidence-rejected:${report.id}` });
    }
    await audit(c, actor, { action: `evidence.${decision}d`, entityType: 'job', entityId: jobId, customerId: job.customer_id, contractorId: job.assigned_contractor_id,
      details: { reportVersion: report.version, notes } });
  });
}

/** Evidence is never deleted; staff can withdraw an item (e.g. wrong job) with a reason, keeping the original. */
export async function withdrawEvidence(db: Db, actor: Actor, evidenceId: string, reason: string) {
  if (!isStaff(actor)) throw new ForbiddenError();
  if (!reason?.trim()) throw new AppError('A reason is required');
  const ev = await maybeOne(db, `UPDATE job_evidence SET withdrawn_at = now(), withdrawn_by = $2, withdrawn_reason = $3 WHERE id = $1 AND withdrawn_at IS NULL RETURNING *`,
    [evidenceId, actor.id, reason]);
  if (!ev) throw new NotFoundError('Evidence');
  await recordJobEvent(db, actor, ev.job_id, 'evidence.withdrawn', { note: `${ev.kind} withdrawn: ${reason}` });
  await audit(db, actor, { action: 'evidence.withdrawn', entityType: 'job_evidence', entityId: evidenceId, details: { reason, jobId: ev.job_id } });
}

// ---------------------------------------------------------------------------
// Quotes and variations
// ---------------------------------------------------------------------------

export interface QuoteLineInput { category: CostLine['category']; description: string; quantityMilli: number; unitRateCents: number; timeWindow?: CostLine['timeWindow'] }

/** Contractor submits a quote or variation (contractor cost). Ridgeline prices it before it goes to the customer. */
export async function submitQuote(db: Db, actor: Actor, jobId: string, kind: 'quote' | 'variation', description: string, lines: QuoteLineInput[]) {
  if (!description?.trim()) throw new AppError('Describe the proposed work');
  if (!lines.length) throw new AppError('Add at least one line');
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    assertAssigned(actor, job);
    if (!['assigned', 'on_site', 'in_progress', 'evidence_rejected'].includes(job.status)) throw new AppError('Quotes and variations can only be raised on active jobs', 409);
    const trade = await one(c, 'SELECT * FROM trades WHERE id = $1', [job.trade_id]);
    const costLines: CostLine[] = lines.map((l) => ({
      category: kind === 'variation' && l.category === 'labour' ? 'variation' : l.category,
      description: l.description, quantityMilli: l.quantityMilli, unitRateCents: l.unitRateCents,
      amountCents: Math.round((l.quantityMilli * l.unitRateCents) / 1000), timeWindow: l.timeWindow ?? 'standard',
    }));
    const contractorCost = costLines.reduce((s, l) => s + l.amountCents, 0);
    const rules = await loadApprovedRules(c, job.customer_id);
    const pricing = priceCostLines(costLines, { customerId: job.customer_id, tradeId: trade.id, tradeIsSpecialist: trade.is_specialist, priority: job.priority }, rules,
      await getSettings(c));
    // Variations/quotes are priced without the job-level minimum (that applies to the final invoice).
    const lineSubtotal = pricing.lines.filter((l) => l.description !== 'Minimum job charge adjustment').reduce((s, l) => s + l.amountExGstCents, 0);
    const gst = pricing.gstRateBps ? Math.round((lineSubtotal * pricing.gstRateBps) / 10000) : 0;
    const q = await one(c,
      `INSERT INTO quotes (job_id, contractor_id, kind, description, lines, contractor_cost_cents, customer_price_ex_gst_cents, customer_gst_cents,
         customer_total_cents, pricing, submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [jobId, actor.contractorId, kind, description.trim(), JSON.stringify(costLines), contractorCost, lineSubtotal, gst, lineSubtotal + gst,
       JSON.stringify(pricing), actor.id]);
    await recordJobEvent(c, actor, jobId, `${kind}.submitted`, { note: `${description} (contractor cost ${formatNzd(contractorCost)})` });
    await notifyStaff(c, ['ops', 'admin'], { template: 'quote_submitted', subject: `${kind === 'quote' ? 'Quote' : 'Variation'} submitted for ${job.ref}`,
      body: `${description}\nContractor cost ${formatNzd(contractorCost)}; customer price ${formatNzd(lineSubtotal + gst)} incl GST.\n${link(`/admin/jobs/${jobId}`)}`,
      idempotencyKey: `quote-submitted:${q.id}` });
    return q;
  });
}

/** Ridgeline reviews a quote/variation and sends it to the customer for approval (or withdraws it). */
export async function reviewQuote(db: Db, actor: Actor, quoteId: string, decision: 'send' | 'withdraw') {
  if (!isStaff(actor) || actor.role === 'finance') throw new ForbiddenError();
  return tx(db, async (c) => {
    const q = await maybeOne(c, 'SELECT * FROM quotes WHERE id = $1 FOR UPDATE', [quoteId]);
    if (!q) throw new NotFoundError('Quote');
    if (q.status !== 'submitted') throw new AppError('Quote has already been reviewed', 409);
    const status = decision === 'send' ? 'sent_to_customer' : 'withdrawn';
    await c.query('UPDATE quotes SET status = $2, reviewed_by = $3 WHERE id = $1', [quoteId, status, actor.id]);
    const job = await one(c, 'SELECT * FROM jobs WHERE id = $1', [q.job_id]);
    if (decision === 'send') {
      await notifyCustomer(c, job.customer_id, { template: 'quote_for_approval', subject: `${q.kind === 'quote' ? 'Quote' : 'Variation'} for approval: ${job.ref}`,
        body: `${q.description}\nPrice: ${formatNzd(q.customer_total_cents)} incl GST.\nApprove or decline: ${link(`/app/jobs/${job.id}`)}`,
        idempotencyKey: `quote-sent:${quoteId}` });
    }
    await recordJobEvent(c, actor, q.job_id, `${q.kind}.${status}`);
    await audit(c, actor, { action: `quote.${status}`, entityType: 'quote', entityId: quoteId, customerId: job.customer_id });
  });
}

/** Customer approver approves or declines a quote/variation. Approval extends the authorised contractor scope. */
export async function customerDecideQuote(db: Db, actor: Actor, quoteId: string, decision: 'approved' | 'declined') {
  return tx(db, async (c) => {
    const q = await maybeOne(c, 'SELECT * FROM quotes WHERE id = $1 FOR UPDATE', [quoteId]);
    if (!q) throw new NotFoundError('Quote');
    const job = await lockJob(c, q.job_id);
    if (actor.role !== 'customer' || actor.customerId !== job.customer_id) throw new NotFoundError('Quote');
    if (!['owner', 'approver'].includes(actor.customerRole ?? '')) throw new ForbiddenError('Only owners and approvers can approve quotes and variations');
    if (actor.customerRole === 'approver' && actor.approvalLimitCents != null && decision === 'approved' && q.customer_total_cents > actor.approvalLimitCents) {
      throw new ForbiddenError('This exceeds your approval limit');
    }
    if (q.status !== 'sent_to_customer') throw new AppError('This quote is not awaiting your decision', 409);
    await c.query('UPDATE quotes SET status = $2, customer_decision_by = $3, customer_decision_at = now() WHERE id = $1', [quoteId, decision, actor.id]);
    if (decision === 'approved') {
      // A customer approving a quote or variation on a make-safe job is their approval of work beyond make-safe.
      await recordScopeExtension(c, actor, job, 'customer_approval', `Customer approved ${q.kind}: ${q.description} (${formatNzd(q.customer_total_cents)})`);
      if (q.kind === 'quote') {
        await c.query('UPDATE jobs SET authorised_contractor_cost_cents = GREATEST(COALESCE(authorised_contractor_cost_cents,0), $2) WHERE id = $1', [job.id, q.contractor_cost_cents]);
      } else {
        await c.query('UPDATE jobs SET authorised_contractor_cost_cents = COALESCE(authorised_contractor_cost_cents,0) + $2 WHERE id = $1', [job.id, q.contractor_cost_cents]);
      }
      // A quote replaces the estimate as the committed amount; a variation adds to it.
      await c.query(
        q.kind === 'quote'
          ? `UPDATE job_commitments SET amount_cents = GREATEST(amount_cents, $2) WHERE job_id = $1 AND status = 'active'`
          : `UPDATE job_commitments SET amount_cents = amount_cents + $2 WHERE job_id = $1 AND status = 'active'`,
        [job.id, q.customer_total_cents]);
    }
    await recordJobEvent(c, actor, job.id, `${q.kind}.${decision}`, { note: `${q.description} (${formatNzd(q.customer_total_cents)})` });
    await notifyContractor(c, q.contractor_id, { template: 'quote_decided', subject: `${q.kind === 'quote' ? 'Quote' : 'Variation'} ${decision}: ${job.ref}`,
      body: `The customer has ${decision} your ${q.kind}: ${q.description}`, idempotencyKey: `quote-decided:${quoteId}` });
    await audit(c, actor, { action: `quote.customer_${decision}`, entityType: 'quote', entityId: quoteId, customerId: job.customer_id });
  });
}
