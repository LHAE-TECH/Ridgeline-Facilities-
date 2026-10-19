import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { SYSTEM_ACTOR, isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError } from '../lib/errors.js';
import { audit } from './audit.js';
import { addBusinessMinutes, businessDayMinutes, endOfBusinessDay } from './businessTime.js';
import { lockJob, recordJobEvent } from './jobState.js';
import { link, notifyStaff, queueSms } from './notifications.js';
import type { Priority } from './pricing.js';
import { getSettings, type Settings } from './settings.js';
import { loadHolidays } from './timeWindows.js';

/** The published priority matrix. */
export const PRIORITY_META: Record<Priority, { code: string; label: string; summary: string }> = {
  emergency: { code: 'P1', label: 'Emergency', summary: 'Risk to safety or serious damage: on site 2 hrs (metro), made safe 4 hrs' },
  urgent: { code: 'P2', label: 'Urgent', summary: 'Stops normal use: on site 8 business hrs, resolved 2 business days' },
  standard: { code: 'P3', label: 'Standard', summary: 'Repairs and defects: on site 48 business hrs, resolved 10 business days' },
  scheduled: { code: 'P4', label: 'Scheduled', summary: 'Planned work on an agreed date' },
};

export function priorityLabel(p: string): string {
  const m = PRIORITY_META[p as Priority];
  return m ? `${m.code} ${m.label}` : p;
}

// ---------------------------------------------------------------------------
// Intake triage
// ---------------------------------------------------------------------------

export interface TriageAnswers {
  /** Risk to people's safety, or risk of serious property damage (flooding, gas, electrical hazard, fire, structural, security breach). */
  safetyRisk?: boolean;
  /** Prevents normal use of the property or a unit (no hot water, only toilet blocked, no heating in winter, lift out). */
  preventsUse?: boolean;
  /** Planned work on a date agreed in advance. */
  planned?: boolean;
}

export const TRIAGE_QUESTIONS: { key: keyof TriageAnswers; text: string }[] = [
  { key: 'safetyRisk', text: "Is there a risk to people's safety, or of serious damage (flooding, gas smell, exposed wiring, fire damage, structural risk, the building can't be secured)?" },
  { key: 'preventsUse', text: 'Does it stop normal use of the property or a unit (no hot water, only toilet blocked, no power to a unit, lift out of service)?' },
  { key: 'planned', text: 'Is this planned work to be done on a date you choose (servicing, painting, inspections)?' },
];

/** Classifies priority from the intake answers. Safety outranks everything; planned work is P4. */
export function classifyPriority(a: TriageAnswers): Priority {
  if (a.safetyRisk) return 'emergency';
  if (a.preventsUse) return 'urgent';
  if (a.planned) return 'scheduled';
  return 'standard';
}

const PRIORITY_RANK: Record<Priority, number> = { emergency: 1, urgent: 2, standard: 3, scheduled: 4 };

/** True when the chosen priority is more urgent than the triage supports (needs staff review). */
export function isEscalatedAboveTriage(chosen: Priority, suggested: Priority): boolean {
  return PRIORITY_RANK[chosen] < PRIORITY_RANK[suggested];
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface SlaTargets {
  onsiteDue: Date;
  resolveDue: Date;
  onsiteLabel: string;
  resolveLabel: string;
  metro: boolean;
}

type SlaSettings = Pick<Settings, 'timezone' | 'sla_business_hours' | 'sla_p1_onsite_hours' | 'sla_p1_made_safe_hours' | 'sla_p1_non_metro_onsite_hours'
  | 'sla_p1_non_metro_made_safe_hours' | 'sla_p2_onsite_business_hours' | 'sla_p2_resolve_business_days' | 'sla_p3_onsite_business_hours' | 'sla_p3_resolve_business_days'>;

/**
 * Computes due times from the moment the clock starts. P1 uses clock hours (24/7) with a separate non-metro
 * target; P2/P3 use NZ business hours and business days; P4 uses the agreed date/window.
 */
export function computeSlaTargets(
  job: { priority: Priority; preferred_start?: string | Date | null; preferred_end?: string | Date | null },
  metro: boolean, startedAt: Date, s: SlaSettings, holidays: Set<string>,
): SlaTargets {
  const hrs = s.sla_business_hours;
  const tz = s.timezone;
  const plusClock = (h: number) => new Date(startedAt.getTime() + h * 3600000);
  const plusBusiness = (minutes: number) => addBusinessMinutes(startedAt, minutes, hrs, holidays, tz);
  switch (job.priority) {
    case 'emergency': {
      const onsite = metro ? s.sla_p1_onsite_hours : s.sla_p1_non_metro_onsite_hours;
      const safe = metro ? s.sla_p1_made_safe_hours : s.sla_p1_non_metro_made_safe_hours;
      return { onsiteDue: plusClock(onsite), resolveDue: plusClock(safe), metro,
        onsiteLabel: `On site within ${onsite} hrs (${metro ? 'metro' : 'non-metro'}, 24/7)`, resolveLabel: `Made safe within ${safe} hrs` };
    }
    case 'urgent':
      return { onsiteDue: plusBusiness(s.sla_p2_onsite_business_hours * 60), resolveDue: plusBusiness(s.sla_p2_resolve_business_days * businessDayMinutes(hrs)), metro,
        onsiteLabel: `On site within ${s.sla_p2_onsite_business_hours} business hrs`, resolveLabel: `Resolved within ${s.sla_p2_resolve_business_days} business days` };
    case 'standard':
      return { onsiteDue: plusBusiness(s.sla_p3_onsite_business_hours * 60), resolveDue: plusBusiness(s.sla_p3_resolve_business_days * businessDayMinutes(hrs)), metro,
        onsiteLabel: `On site within ${s.sla_p3_onsite_business_hours} business hrs`, resolveLabel: `Resolved within ${s.sla_p3_resolve_business_days} business days` };
    case 'scheduled': {
      if (!job.preferred_start) throw new AppError('Scheduled (P4) jobs need an agreed date');
      const start = new Date(job.preferred_start);
      const onsiteDue = job.preferred_end ? new Date(job.preferred_end) : endOfBusinessDay(start, hrs, tz);
      const resolveDue = new Date(Math.max(onsiteDue.getTime(), endOfBusinessDay(start, hrs, tz).getTime()));
      return { onsiteDue, resolveDue, metro, onsiteLabel: 'On site on the agreed date', resolveLabel: 'Completed on the agreed date' };
    }
  }
}

export function isMetroCity(city: string | null | undefined, metroCities: string[]): boolean {
  if (!city) return false;
  return metroCities.some((m) => m.trim().toLowerCase() === city.trim().toLowerCase());
}

/** Starts (or restarts after reclassification) the SLA clock. Caller holds the job lock. */
export async function startSlaClock(c: Db, job: any): Promise<SlaTargets> {
  const settings = await getSettings(c);
  const holidays = await loadHolidays(c);
  const site = await one(c, 'SELECT is_metro FROM sites WHERE id = $1', [job.site_id]);
  // The clock keeps its original start when targets are recalculated (e.g. after reclassification).
  const startedAt = job.sla_started_at ? new Date(job.sla_started_at) : new Date();
  const t = computeSlaTargets(job, site.is_metro, startedAt, settings, holidays);
  const escalation = settings.escalation_minutes[job.priority] ?? 60;
  await c.query(
    `UPDATE jobs SET sla_started_at = $2, sla_onsite_due = $3, sla_resolve_due = $4, sla_targets = $5, attend_by = $3,
        respond_by = $2::timestamptz + ($6 || ' minutes')::interval WHERE id = $1`,
    [job.id, startedAt, t.onsiteDue, t.resolveDue, JSON.stringify({ onsite: t.onsiteLabel, resolve: t.resolveLabel, metro: t.metro, priority: job.priority }), String(escalation)]);
  Object.assign(job, { sla_started_at: startedAt, sla_onsite_due: t.onsiteDue, sla_resolve_due: t.resolveDue });
  return t;
}

/** Re-evaluates met/breached flags from recorded event times (after arrival, completion or reclassification). */
export async function evaluateSla(c: Db, jobId: string): Promise<void> {
  await c.query(
    `UPDATE jobs SET
        sla_onsite_met = CASE WHEN sla_onsite_due IS NULL THEN NULL WHEN arrived_at IS NOT NULL THEN arrived_at <= sla_onsite_due
                              WHEN now() > sla_onsite_due THEN false ELSE NULL END,
        sla_resolve_met = CASE WHEN sla_resolve_due IS NULL THEN NULL
                               WHEN COALESCE(made_safe_at, completed_at) IS NOT NULL THEN LEAST(made_safe_at, completed_at) <= sla_resolve_due
                               WHEN now() > sla_resolve_due THEN false ELSE NULL END,
        sla_onsite_breached_at = CASE WHEN sla_onsite_due IS NOT NULL AND COALESCE(arrived_at, now()) > sla_onsite_due THEN COALESCE(sla_onsite_breached_at, sla_onsite_due) END,
        sla_resolve_breached_at = CASE WHEN sla_resolve_due IS NOT NULL AND COALESCE(LEAST(made_safe_at, completed_at), now()) > sla_resolve_due THEN COALESCE(sla_resolve_breached_at, sla_resolve_due) END
      WHERE id = $1`, [jobId]);
}

/** Staff reclassify a job's priority with a reason; the SLA targets are recalculated from the original start. */
export async function reclassifyPriority(db: Db, actor: Actor, jobId: string, priority: Priority, reason: string) {
  if (!isStaff(actor) || actor.role === 'finance') throw new ForbiddenError('Only operations staff can reclassify priority');
  if (!PRIORITY_META[priority]) throw new AppError('Invalid priority');
  if (!reason?.trim()) throw new AppError('A reason is required to reclassify priority');
  return tx(db, async (c) => {
    const job = await lockJob(c, jobId);
    if (['closed', 'cancelled'].includes(job.status)) throw new AppError('Closed or cancelled jobs cannot be reclassified', 409);
    const from = job.priority;
    if (from === priority) return;
    await c.query('UPDATE jobs SET priority = $2, priority_note = $3, sla_at_risk_alerted_at = NULL WHERE id = $1', [jobId, priority, reason]);
    job.priority = priority;
    if (job.sla_started_at) {
      await startSlaClock(c, job);
      await evaluateSla(c, jobId);
    }
    await recordJobEvent(c, actor, jobId, 'priority.reclassified', { note: `${priorityLabel(from)} → ${priorityLabel(priority)}: ${reason}` });
    await audit(c, actor, { action: 'job.priority_reclassified', entityType: 'job', entityId: jobId, customerId: job.customer_id, details: { from, to: priority, reason } });
  });
}

export type SlaState = 'not_started' | 'on_track' | 'at_risk' | 'breached' | 'met' | 'missed';

/** Live state of one SLA leg for display and ordering. */
export function slaLegState(due: Date | string | null, startedAt: Date | string | null, doneAt: Date | string | null, atRiskBps: number, now = new Date()): { state: SlaState; remainingMinutes: number | null; riskRatio: number } {
  if (!due || !startedAt) return { state: 'not_started', remainingMinutes: null, riskRatio: 0 };
  const d = new Date(due).getTime();
  const s = new Date(startedAt).getTime();
  if (doneAt) return { state: new Date(doneAt).getTime() <= d ? 'met' : 'missed', remainingMinutes: null, riskRatio: 0 };
  const total = Math.max(1, d - s);
  const elapsed = now.getTime() - s;
  const ratio = elapsed / total;
  const remaining = Math.round((d - now.getTime()) / 60000);
  if (remaining < 0) return { state: 'breached', remainingMinutes: remaining, riskRatio: ratio };
  return { state: ratio * 10000 >= atRiskBps ? 'at_risk' : 'on_track', remainingMinutes: remaining, riskRatio: ratio };
}

/**
 * Worker: flags at-risk and breached SLAs and alerts operations. P1 breaches and at-risk P1 jobs also go to the
 * escalation phones by SMS.
 */
export async function checkSlaBreaches(db: Db): Promise<{ atRisk: number; breached: number }> {
  const settings = await getSettings(db);
  let atRisk = 0, breached = 0;
  const open = await query(db,
    `SELECT id, ref, priority, status, title, sla_started_at, sla_onsite_due, sla_resolve_due, arrived_at, made_safe_at, completed_at,
            sla_onsite_breached_at, sla_resolve_breached_at, sla_at_risk_alerted_at
       FROM jobs WHERE sla_started_at IS NOT NULL AND status NOT IN ('closed','cancelled')
        AND ((arrived_at IS NULL AND sla_onsite_breached_at IS NULL) OR (made_safe_at IS NULL AND completed_at IS NULL AND sla_resolve_breached_at IS NULL))`);
  for (const j of open) {
    const onsite = slaLegState(j.sla_onsite_due, j.sla_started_at, j.arrived_at, settings.sla_at_risk_bps);
    const resolve = slaLegState(j.sla_resolve_due, j.sla_started_at, j.made_safe_at ?? j.completed_at, settings.sla_at_risk_bps);
    const label = priorityLabel(j.priority);
    for (const [leg, st, flag] of [['on-site', onsite, j.sla_onsite_breached_at], ['resolution', resolve, j.sla_resolve_breached_at]] as const) {
      if (st.state === 'breached' && !flag) {
        await evaluateSla(db, j.id);
        await recordJobEvent(db, SYSTEM_ACTOR, j.id, `sla.${leg === 'on-site' ? 'onsite' : 'resolve'}_breached`, { note: `${label} ${leg} target breached` });
        const msg = `SLA BREACH ${j.ref} (${label}): ${leg} target passed. Status: ${j.status}. ${link(`/admin/jobs/${j.id}`)}`;
        await notifyStaff(db, ['ops', 'admin'], { template: 'sla_breach', subject: `SLA breached: ${j.ref} (${label}, ${leg})`, body: msg,
          idempotencyKey: `sla-breach:${j.id}:${leg}`, relatedType: 'job', relatedId: j.id });
        if (j.priority === 'emergency') await smsEscalationPhones(db, msg, `sla-breach-sms:${j.id}:${leg}`);
        breached++;
      }
    }
    const risky = (onsite.state === 'at_risk' && !j.arrived_at) || (resolve.state === 'at_risk' && !j.made_safe_at && !j.completed_at);
    if (risky && !j.sla_at_risk_alerted_at) {
      const leg = onsite.state === 'at_risk' && !j.arrived_at ? 'on-site' : 'resolution';
      const mins = leg === 'on-site' ? onsite.remainingMinutes : resolve.remainingMinutes;
      const msg = `SLA AT RISK ${j.ref} (${label}): ${leg} target due in ${mins} min. Status: ${j.status}. ${link(`/admin/jobs/${j.id}`)}`;
      await notifyStaff(db, ['ops', 'admin'], { template: 'sla_risk', subject: `SLA at risk: ${j.ref} (${label})`, body: msg, idempotencyKey: `sla-risk:${j.id}:${leg}`,
        relatedType: 'job', relatedId: j.id });
      if (j.priority === 'emergency') await smsEscalationPhones(db, msg, `sla-risk-sms:${j.id}:${leg}`);
      await db.query('UPDATE jobs SET sla_at_risk_alerted_at = now() WHERE id = $1', [j.id]);
      atRisk++;
    }
  }
  return { atRisk, breached };
}

export async function smsEscalationPhones(db: Db, body: string, key: string): Promise<number> {
  const settings = await getSettings(db);
  let n = 0;
  for (const phone of settings.escalation_staff_phones) {
    await queueSms(db, { phone, template: 'escalation_sms', body, idempotencyKey: `${key}:${phone}` });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface SlaPerformanceRow {
  priority: Priority;
  code: string;
  label: string;
  jobs: number;
  onsiteMeasured: number;
  onsiteMet: number;
  onsitePct: number | null;
  resolveMeasured: number;
  resolveMet: number;
  resolvePct: number | null;
  avgMinutesToSite: number | null;
}

/** SLA performance for jobs whose clock started in the period (optionally one customer). Cancelled jobs are excluded. */
export async function slaPerformance(db: Db, period: { from: string; to: string }, customerId?: string | null): Promise<SlaPerformanceRow[]> {
  const rows = await query(db,
    `SELECT priority, COUNT(*)::int AS jobs,
            COUNT(*) FILTER (WHERE sla_onsite_met IS NOT NULL)::int AS onsite_measured,
            COUNT(*) FILTER (WHERE sla_onsite_met)::int AS onsite_met,
            COUNT(*) FILTER (WHERE sla_resolve_met IS NOT NULL)::int AS resolve_measured,
            COUNT(*) FILTER (WHERE sla_resolve_met)::int AS resolve_met,
            ROUND(AVG(EXTRACT(EPOCH FROM (arrived_at - sla_started_at)) / 60) FILTER (WHERE arrived_at IS NOT NULL))::int AS avg_minutes
       FROM jobs
      WHERE sla_started_at IS NOT NULL AND status <> 'cancelled'
        AND (sla_started_at AT TIME ZONE 'Pacific/Auckland')::date BETWEEN $1::date AND $2::date
        AND ($3::uuid IS NULL OR customer_id = $3)
      GROUP BY priority`, [period.from, period.to, customerId ?? null]);
  const byPriority = new Map(rows.map((r) => [r.priority, r]));
  return (Object.keys(PRIORITY_META) as Priority[]).map((p) => {
    const r = byPriority.get(p);
    const pct = (met: number, measured: number) => (measured ? Math.round((met * 1000) / measured) / 10 : null);
    return {
      priority: p, code: PRIORITY_META[p].code, label: PRIORITY_META[p].label, jobs: r?.jobs ?? 0,
      onsiteMeasured: r?.onsite_measured ?? 0, onsiteMet: r?.onsite_met ?? 0, onsitePct: pct(r?.onsite_met ?? 0, r?.onsite_measured ?? 0),
      resolveMeasured: r?.resolve_measured ?? 0, resolveMet: r?.resolve_met ?? 0, resolvePct: pct(r?.resolve_met ?? 0, r?.resolve_measured ?? 0),
      avgMinutesToSite: r?.avg_minutes ?? null,
    };
  });
}

export async function openSlaJobs(db: Db) {
  const settings = await getSettings(db);
  const jobs = await query(db,
    `SELECT j.id, j.ref, j.title, j.priority, j.status, j.sla_started_at, j.sla_onsite_due, j.sla_resolve_due, j.arrived_at, j.made_safe_at, j.completed_at,
            c.name AS customer_name
       FROM jobs j JOIN customers c ON c.id = j.customer_id
      WHERE j.sla_started_at IS NOT NULL AND j.status IN ('dispatch','offered','assigned','on_site','in_progress')`);
  return jobs.map((j) => {
    const onsite = slaLegState(j.sla_onsite_due, j.sla_started_at, j.arrived_at, settings.sla_at_risk_bps);
    const resolve = slaLegState(j.sla_resolve_due, j.sla_started_at, j.made_safe_at ?? j.completed_at, settings.sla_at_risk_bps);
    const current = !j.arrived_at ? onsite : resolve;
    return { ...j, onsite, resolve, current };
  }).filter((j) => ['at_risk', 'breached'].includes(j.current.state))
    .sort((a, b) => b.current.riskRatio - a.current.riskRatio);
}

export async function siteIsMetro(db: Db, siteId: string): Promise<boolean> {
  return (await maybeOne(db, 'SELECT is_metro FROM sites WHERE id = $1', [siteId]))?.is_metro ?? true;
}
