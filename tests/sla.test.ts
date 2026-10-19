import { beforeEach, describe, expect, it } from 'vitest';
import { one, query } from '../src/db.js';
import { addBusinessMinutes, businessMinutesBetween } from '../src/services/businessTime.js';
import { acceptOffer, advanceDispatchWaves, rankForSla } from '../src/services/dispatch.js';
import { addEvidence, completeJob, markMadeSafe, recordArrival, startWork } from '../src/services/evidence.js';
import { reclassifyJob, resolvePriority } from '../src/services/jobs.js';
import { addCustomerUser, setSiteArea, updateCustomerTerms } from '../src/services/customers.js';
import { sendMonthlyReports } from '../src/services/monthlyReport.js';
import { monthlyReportPdf } from '../src/services/pdf.js';
import { dashboard } from '../src/services/reports.js';
import { SETTING_DEFAULTS, updateSetting } from '../src/services/settings.js';
import { areaForSite, checkSlaBreaches, classifyPriority, computeSlaTargets, reclassifyPriority, slaPerformance } from '../src/services/sla.js';
import { activeCustomer, approvedContractor, book, count, db, pdfText, photo, resetDb, staff } from './helpers.js';

beforeEach(resetDb);

const HOURS = SETTING_DEFAULTS.sla_business_hours as { start: string; end: string; days: number[] };
const TZ = 'Pacific/Auckland';
const HOLIDAYS = new Set(['2026-10-26']); // Labour Day
const S = { ...SETTING_DEFAULTS, sla_business_hours: HOURS } as any;
const nz = (iso: string) => new Date(iso);

describe('NZ business-hours clock', () => {
  it('counts only 08:00–17:00 Monday–Friday, skipping weekends and public holidays', () => {
    // Fri 23 Oct 2026 16:00 NZDT + 8 business hours: 1h Fri, Mon 26 is Labour Day, 7h Tue → Tue 27 Oct 15:00
    expect(addBusinessMinutes(nz('2026-10-23T16:00:00+13:00'), 8 * 60, HOURS, HOLIDAYS, TZ).toISOString()).toBe(nz('2026-10-27T15:00:00+13:00').toISOString());
    // Logged at night: clock starts at 08:00 next business day
    expect(addBusinessMinutes(nz('2026-10-20T22:30:00+13:00'), 60, HOURS, HOLIDAYS, TZ).toISOString()).toBe(nz('2026-10-21T09:00:00+13:00').toISOString());
    expect(businessMinutesBetween(nz('2026-10-23T16:00:00+13:00'), nz('2026-10-27T15:00:00+13:00'), HOURS, HOLIDAYS, TZ)).toBe(480);
  });

  it('handles the daylight-saving change (NZDT starts 27 Sep 2026)', () => {
    // Fri 25 Sep 16:00 NZST (+12) + 2 business hours → Mon 28 Sep 09:00 NZDT (+13)
    expect(addBusinessMinutes(nz('2026-09-25T16:00:00+12:00'), 120, HOURS, new Set(), TZ).toISOString()).toBe(nz('2026-09-28T09:00:00+13:00').toISOString());
  });
});

describe('published priority matrix targets', () => {
  const start = nz('2026-10-23T16:00:00+13:00'); // Friday afternoon
  it('P1: 2 h on site / 4 h made safe on the clock (24/7); non-metro uses its own setting', () => {
    const metro = computeSlaTargets({ priority: 'emergency' }, true, start, S, HOLIDAYS);
    expect(metro.onsiteDue.getTime() - start.getTime()).toBe(2 * 3600000);
    expect(metro.resolveDue.getTime() - start.getTime()).toBe(4 * 3600000);
    const rural = computeSlaTargets({ priority: 'emergency' }, false, start, { ...S, sla_p1_non_metro_onsite_hours: 5, sla_p1_non_metro_made_safe_hours: 9 }, HOLIDAYS);
    expect(rural.onsiteDue.getTime() - start.getTime()).toBe(5 * 3600000);
    expect(rural.resolveDue.getTime() - start.getTime()).toBe(9 * 3600000);
    expect(rural.onsiteLabel).toMatch(/non-metro/);
  });

  it('P2: 8 business hours on site, 2 business days resolved', () => {
    const t = computeSlaTargets({ priority: 'urgent' }, true, start, S, HOLIDAYS);
    expect(t.onsiteDue.toISOString()).toBe(nz('2026-10-27T15:00:00+13:00').toISOString());
    // 2 business days = 18 business hours: Fri 1h, Tue 9h, Wed 8h → Wed 28 Oct 16:00
    expect(t.resolveDue.toISOString()).toBe(nz('2026-10-28T16:00:00+13:00').toISOString());
  });

  it('P3: 48 business hours on site, 10 business days resolved', () => {
    const t = computeSlaTargets({ priority: 'standard' }, true, start, S, HOLIDAYS);
    expect(businessMinutesBetween(start, t.onsiteDue, HOURS, HOLIDAYS, TZ)).toBe(48 * 60);
    expect(businessMinutesBetween(start, t.resolveDue, HOURS, HOLIDAYS, TZ)).toBe(10 * 9 * 60);
  });

  it('P4: the agreed date or window', () => {
    const t = computeSlaTargets({ priority: 'scheduled', preferred_start: '2026-11-04T09:00:00+13:00', preferred_end: '2026-11-04T12:00:00+13:00' }, true, start, S, HOLIDAYS);
    expect(t.onsiteDue.toISOString()).toBe(nz('2026-11-04T12:00:00+13:00').toISOString());
    expect(t.resolveDue.toISOString()).toBe(nz('2026-11-04T17:00:00+13:00').toISOString());
    expect(() => computeSlaTargets({ priority: 'scheduled' }, true, start, S, HOLIDAYS)).toThrow(/agreed date/);
  });
});

describe('intake classification', () => {
  it('classifies from triage answers and never books a reported safety risk below P1', () => {
    expect(classifyPriority({ safetyRisk: true, planned: true })).toBe('emergency');
    expect(classifyPriority({ preventsUse: true })).toBe('urgent');
    expect(classifyPriority({ planned: true })).toBe('scheduled');
    expect(classifyPriority({})).toBe('standard');
    expect(resolvePriority('standard', { safetyRisk: true })).toMatchObject({ priority: 'emergency', note: expect.stringMatching(/Raised from P3/) });
    expect(resolvePriority('emergency', {})).toMatchObject({ priority: 'emergency', note: expect.stringMatching(/Review classification/) });
    expect(resolvePriority(null, { preventsUse: true }).priority).toBe('urgent');
  });

  it('records triage on the job; a P1 clock starts at booking, P2–P4 at release to dispatch', async () => {
    await approvedContractor();
    const fx = await activeCustomer();
    const { job } = await book(fx, { priority: null, triage: { safetyRisk: true }, preferredStart: null });
    expect(job.priority).toBe('emergency');
    expect(job.suggested_priority).toBe('emergency');
    expect(new Date(job.sla_started_at).toISOString()).toBe(new Date(job.created_at).toISOString());
    expect(job.released_at).not.toBeNull();
    expect(job.sla_targets.clock_from).toBe('booking');
    expect(new Date(job.sla_onsite_due).getTime() - new Date(job.sla_started_at).getTime()).toBe(2 * 3600000);
    expect(job.sla_targets).toMatchObject({ metro: true, area: 'Auckland Central', area_confirmed: true });

    await db.query('UPDATE customers SET prepaid_balance_cents = 0 WHERE id = $1', [fx.customerId]);
    const held = (await book(fx, { triage: {}, priority: null, title: 'Held job' })).job;
    expect(held.status).toBe('pending_funds');
    expect(held.sla_started_at).toBeNull();
    expect(held.released_at).toBeNull();
  });
});

describe('nothing holds a P1', () => {
  it('dispatches a P1 at once with no funds and above the authority limit, clock from booking, approver told', async () => {
    await approvedContractor();
    const fx = await activeCustomer();
    await db.query('UPDATE customers SET authority_limit_cents = 1000 WHERE id = $1', [fx.customerId]);
    await db.query('UPDATE customers SET prepaid_balance_cents = 0 WHERE id = $1', [fx.customerId]);
    const booker = await addCustomerUser(db, fx.owner, fx.customerId, { name: 'Bob Booker', email: 'p1-booker@customer.test', password: 'correct-horse-battery', customerRole: 'booker' });
    const bookerActor = { id: booker.id, role: 'customer' as const, name: 'Bob', customerId: fx.customerId, customerRole: 'booker' as const };
    const { job } = await book({ ...fx, owner: bookerActor }, { priority: 'emergency', preferredStart: null });
    expect(['dispatch', 'offered']).toContain(job.status);
    expect(new Date(job.sla_started_at).toISOString()).toBe(new Date(job.created_at).toISOString());
    expect(await count(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = $1 AND event_type = 'approval.retrospective'`, [job.id])).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'job_emergency_over_limit'`)).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'emergency_underfunded'`)).toBeGreaterThan(0);
  });

  it('releasing a held job raised to P1 runs the clock from the original booking time', async () => {
    await approvedContractor();
    const fx = await activeCustomer();
    await db.query('UPDATE customers SET prepaid_balance_cents = 0 WHERE id = $1', [fx.customerId]);
    const held = (await book(fx, { priority: 'standard' })).job;
    expect(held.status).toBe('pending_funds');
    await db.query(`UPDATE jobs SET created_at = now() - interval '30 minutes' WHERE id = $1`, [held.id]);
    await reclassifyJob(db, await staff('ops'), held.id, 'emergency', 'Caller reports water through ceiling lights');
    const j = await one(db, 'SELECT * FROM jobs WHERE id = $1', [held.id]);
    expect(['dispatch', 'offered']).toContain(j.status);
    expect(new Date(j.sla_started_at).toISOString()).toBe(new Date(j.created_at).toISOString());
    expect(new Date(j.released_at).getTime()).toBeGreaterThan(new Date(j.created_at).getTime() + 29 * 60000);
    // On-site due 2 h from booking, so the 30 minutes held already count against it.
    expect(new Date(j.sla_onsite_due).getTime() - new Date(j.created_at).getTime()).toBe(2 * 3600000);
  });

  it('P2–P4 clocks start at release; booked and released times both appear in the monthly report', async () => {
    await approvedContractor();
    const fx = await activeCustomer();
    const deposit = await one(db, 'SELECT prepaid_balance_cents FROM customers WHERE id = $1', [fx.customerId]);
    await db.query('UPDATE customers SET prepaid_balance_cents = 0 WHERE id = $1', [fx.customerId]);
    const held = (await book(fx, { priority: 'urgent', preferredStart: null })).job;
    expect(held.sla_started_at).toBeNull();
    await db.query(`UPDATE jobs SET created_at = now() - interval '3 hours' WHERE id = $1`, [held.id]);
    await db.query('UPDATE customers SET prepaid_balance_cents = $2 WHERE id = $1', [fx.customerId, deposit.prepaid_balance_cents]);
    const { recheckPendingFunding } = await import('../src/services/jobs.js');
    expect(await recheckPendingFunding(db, fx.customerId)).toEqual([held.id]);
    const j = await one(db, 'SELECT * FROM jobs WHERE id = $1', [held.id]);
    expect(new Date(j.sla_started_at).toISOString()).toBe(new Date(j.released_at).toISOString());
    expect(j.sla_targets.clock_from).toBe('release');
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date(j.created_at)).slice(0, 7);
    const text = pdfText(await monthlyReportPdf(db, fx.customerId, month));
    expect(text).toMatch(/Booked/);
    expect(text).toMatch(/Released/);
    expect(text).toMatch(/Avg booked to released/);
    const perf = await slaPerformance(db, { from: `${month}-01`, to: `${month}-31` }, fx.customerId);
    expect(perf.find((p) => p.code === 'P2')!.avgMinutesBookedToReleased).toBeGreaterThanOrEqual(179);
  });
});

describe('Auckland SLA areas', () => {
  const areas = SETTING_DEFAULTS.sla_areas;
  it('maps suburbs to the five metro areas and the two non-metro areas', () => {
    expect(areaForSite({ suburb: 'Takapuna' }, areas)).toMatchObject({ metro: true, source: 'suburb', area: { name: 'North Shore' } });
    expect(areaForSite({ suburb: 'mt  eden'.replace('mt', 'Mount') }, areas)).toMatchObject({ metro: true, area: { name: 'Auckland Central' } });
    expect(areaForSite({ suburb: 'Manurewa' }, areas).area!.name).toBe('South Auckland');
    expect(areaForSite({ suburb: 'Henderson' }, areas).area!.name).toBe('West Auckland');
    expect(areaForSite({ suburb: 'Howick' }, areas).area!.name).toBe('East Auckland');
    expect(areaForSite({ suburb: 'Warkworth' }, areas)).toMatchObject({ metro: false, area: { name: 'Rodney' } });
    expect(areaForSite({ suburb: 'Pukekohe' }, areas)).toMatchObject({ metro: false, area: { name: 'Franklin' } });
    // Unknown suburb: metro (stricter) target applied and flagged unconfirmed for staff.
    expect(areaForSite({ suburb: 'Nowhere Flats' }, areas)).toMatchObject({ metro: true, source: 'unconfirmed', area: null });
    // A staff pin wins over the suburb.
    expect(areaForSite({ suburb: 'Takapuna', sla_area_override: 'Rodney' }, areas)).toMatchObject({ metro: false, source: 'override' });
  });

  it('applies the non-metro P1 targets (4 h on site / 8 h made safe) in Rodney and Franklin', async () => {
    await approvedContractor();
    const fx = await activeCustomer();
    await db.query(`UPDATE sites SET suburb = 'Warkworth' WHERE id = $1`, [fx.siteId]);
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    expect(job.sla_targets).toMatchObject({ area: 'Rodney', metro: false });
    expect(new Date(job.sla_onsite_due).getTime() - new Date(job.sla_started_at).getTime()).toBe(4 * 3600000);
    expect(new Date(job.sla_resolve_due).getTime() - new Date(job.sla_started_at).getTime()).toBe(8 * 3600000);
  });

  it('moves an edge suburb between areas through settings or a site pin, without a deploy', async () => {
    await approvedContractor();
    const fx = await activeCustomer();
    const admin = await staff('admin');
    await db.query(`UPDATE sites SET suburb = 'Albany' WHERE id = $1`, [fx.siteId]);
    const moved = SETTING_DEFAULTS.sla_areas.map((a) => ({ ...a, suburbs: a.name === 'North Shore' ? a.suburbs.filter((x) => x !== 'Albany')
      : a.name === 'Rodney' ? [...a.suburbs, 'Albany'] : a.suburbs }));
    await updateSetting(db, admin, 'sla_areas', moved);
    const a = (await book(fx, { priority: 'emergency', preferredStart: null })).job;
    expect(a.sla_targets).toMatchObject({ area: 'Rodney', metro: false });

    await setSiteArea(db, await staff('ops'), fx.siteId, 'North Shore');
    const b = (await book(fx, { priority: 'emergency', preferredStart: null, title: 'Second' })).job;
    expect(b.sla_targets).toMatchObject({ area: 'North Shore', metro: true });
    await expect(setSiteArea(db, await staff('ops'), fx.siteId, 'Hamilton')).rejects.toThrow(/Unknown SLA area/);
    // A malformed or contradictory edit is refused rather than breaking every P1 target.
    await expect(updateSetting(db, admin, 'sla_areas', [{ name: 'Rodney', suburbs: ['Albany'] }])).rejects.toThrow(/metro/);
    await expect(updateSetting(db, admin, 'sla_areas', [...moved, { name: 'Extra', metro: true, suburbs: ['Albany'] }])).rejects.toThrow(/both/);
  });
});

describe('SLA tracking, breaches and reclassification', () => {
  async function p1Job() {
    const c = await approvedContractor();
    const fx = await activeCustomer();
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    const offer = await one(db, `SELECT id FROM job_offers WHERE job_id = $1`, [job.id]);
    await acceptOffer(db, c.actor, offer.id);
    return { c, fx, job };
  }

  it('marks the on-site and made-safe targets met from server timestamps', async () => {
    const { c, job } = await p1Job();
    await recordArrival(db, c.actor, job.id);
    await markMadeSafe(db, c.actor, job.id, 'Isolated water supply');
    const j = await one(db, 'SELECT sla_onsite_met, sla_resolve_met, made_safe_at FROM jobs WHERE id = $1', [job.id]);
    expect(j).toMatchObject({ sla_onsite_met: true, sla_resolve_met: true });
    expect(j.made_safe_at).not.toBeNull();
  });

  it('flags breaches, alerts operations and SMSes the escalation phones for P1', async () => {
    await staff('ops');
    await updateSetting(db, await staff('admin'), 'escalation_staff_phones', ['021 999 0000']);
    const { job } = await p1Job();
    // Move the clock back so the on-site target has passed with no arrival.
    await db.query(`UPDATE jobs SET sla_started_at = now() - interval '3 hours', sla_onsite_due = now() - interval '1 hour', sla_resolve_due = now() + interval '1 hour' WHERE id = $1`, [job.id]);
    const r = await checkSlaBreaches(db);
    expect(r.breached).toBe(1);
    const j = await one(db, 'SELECT sla_onsite_met, sla_onsite_breached_at FROM jobs WHERE id = $1', [job.id]);
    expect(j.sla_onsite_met).toBe(false);
    expect(j.sla_onsite_breached_at).not.toBeNull();
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'sla_breach' AND channel = 'email'`)).toBeGreaterThan(0);
    const sms = await one(db, `SELECT * FROM notifications WHERE template = 'escalation_sms' AND channel = 'sms' AND body LIKE 'SLA BREACH%'`);
    expect(sms.recipient_phone).toBe('+64219990000');
    // The made-safe target (75% of its window used) is also flagged at risk.
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'escalation_sms' AND body LIKE 'SLA AT RISK%'`)).toBe(1);
    // Re-running does not alert twice.
    expect((await checkSlaBreaches(db)).breached).toBe(0);
  });

  it('recalculates targets from the original start when operations reclassify', async () => {
    const c = await approvedContractor();
    const fx = await activeCustomer();
    const { job } = await book(fx, { priority: 'standard' });
    const ops = await staff('ops');
    await expect(reclassifyPriority(db, ops, job.id, 'urgent', '')).rejects.toThrow(/reason/);
    await reclassifyPriority(db, ops, job.id, 'urgent', 'Only toilet in the unit');
    const j = await one(db, 'SELECT * FROM jobs WHERE id = $1', [job.id]);
    expect(j.priority).toBe('urgent');
    expect(new Date(j.sla_started_at).toISOString()).toBe(new Date(job.sla_started_at).toISOString());
    expect(new Date(j.sla_onsite_due).getTime()).toBeLessThan(new Date(job.sla_onsite_due).getTime());
    expect(await count(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = $1 AND event_type = 'priority.reclassified'`, [job.id])).toBe(1);
    expect(c).toBeTruthy();
  });

  it('reports SLA performance on the ops dashboard and in the monthly customer report', async () => {
    const { c, fx, job } = await p1Job();
    await recordArrival(db, c.actor, job.id);
    await addEvidence(db, c.actor, job.id, 'before_photo', [photo()]);
    await startWork(db, c.actor, job.id);
    await addEvidence(db, c.actor, job.id, 'after_photo', [photo()]);
    await completeJob(db, c.actor, job.id, { workPerformed: 'Fixed', labourMinutes: 1 });
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date()).slice(0, 7);
    const period = { from: `${month}-01`, to: `${month}-31` };
    const perf = await slaPerformance(db, period, fx.customerId);
    const p1 = perf.find((p) => p.code === 'P1')!;
    expect(p1).toMatchObject({ jobs: 1, onsiteMet: 1, onsiteMeasured: 1, onsitePct: 100, resolvePct: 100 });
    const d = await dashboard(db, period);
    expect(d.sla.find((p) => p.code === 'P1')!.onsitePct).toBe(100);

    const text = pdfText(await monthlyReportPdf(db, fx.customerId, month));
    expect(text).toMatch(/MONTHLY REPORT/);
    expect(text).toMatch(/P1 Emergency/);
    expect(text).toMatch(/1\/1 \(100%\)/);
    expect(text).toMatch(/LHA Holdings Limited/);

    // Ships OFF: nothing is emailed until both the global switch and the customer's own toggle are on.
    const nextMonth = new Date(); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 2);
    const admin = await staff('admin');
    expect(SETTING_DEFAULTS.monthly_report_enabled).toBe(false);
    expect(await sendMonthlyReports(db, nextMonth)).toBe(0);
    await updateSetting(db, admin, 'monthly_report_enabled', true);
    expect(await sendMonthlyReports(db, nextMonth)).toBe(0);
    await expect(updateCustomerTerms(db, await staff('ops'), fx.customerId, { monthlyReportEnabled: true })).rejects.toThrow(/administrator/);
    await updateCustomerTerms(db, admin, fx.customerId, { monthlyReportEnabled: true });
    // Emailed once per customer for the previous month.
    expect(await sendMonthlyReports(db, nextMonth)).toBe(1);
    expect(await sendMonthlyReports(db, nextMonth)).toBe(0);
  });
});

describe('SLA-ranked dispatch', () => {
  it('ranks by whether a contractor can make the on-site target, then ETA and on-time record', () => {
    const base = { name: 'x', eligible: true, reasons: [], activeJobs: 0, distanceKm: null, hasMobile: true };
    const ranked = rankForSla([
      { ...base, contractorId: 'far', estArrivalMinutes: 150, onTimeRate: 1 },
      { ...base, contractorId: 'near-unreliable', estArrivalMinutes: 30, onTimeRate: 0.5 },
      { ...base, contractorId: 'near-reliable', estArrivalMinutes: 40, onTimeRate: 1 },
    ], 120);
    expect(ranked.map((r) => r.contractorId)).toEqual(['near-reliable', 'near-unreliable', 'far']);
    expect(ranked[2].canMeet).toBe(false);
  });

  it('offers P2+ in waves to the best-placed contractors first, widening when nobody accepts', async () => {
    // Site in central Auckland; contractors at increasing distances.
    const near = await approvedContractor({ lat: -36.85, lng: 174.76 });
    const mid = await approvedContractor({ lat: -36.95, lng: 174.80 });
    const far = await approvedContractor({ lat: -37.30, lng: 175.10 });
    const admin = await staff('admin');
    await updateSetting(db, admin, 'dispatch_wave_size', { emergency: 0, urgent: 1, standard: 1, scheduled: 1 });
    const fx = await activeCustomer();
    await db.query('UPDATE sites SET lat = -36.848, lng = 174.763 WHERE id = $1', [fx.siteId]);
    const { job } = await book(fx, { priority: 'urgent' });
    let offers = await query(db, 'SELECT contractor_id, wave, rank FROM job_offers WHERE job_id = $1 ORDER BY wave', [job.id]);
    expect(offers).toEqual([{ contractor_id: near.contractorId, wave: 1, rank: 1 }]);

    await db.query(`UPDATE jobs SET dispatch_wave_at = now() - interval '1 hour' WHERE id = $1`, [job.id]);
    expect(await advanceDispatchWaves(db)).toBe(1);
    offers = await query(db, 'SELECT contractor_id, wave FROM job_offers WHERE job_id = $1 ORDER BY wave', [job.id]);
    expect(offers.map((o) => o.contractor_id)).toEqual([near.contractorId, mid.contractorId]);
    expect(far).toBeTruthy();
  });

  it('P1 goes to every contractor who can make the target at once, and requires an SMS-capable mobile', async () => {
    const a = await approvedContractor();
    const b = await approvedContractor();
    const noMobile = await approvedContractor({ mobile: null });
    const fx = await activeCustomer();
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    const offered = (await query(db, 'SELECT contractor_id FROM job_offers WHERE job_id = $1', [job.id])).map((o) => o.contractor_id).sort();
    expect(offered).toEqual([a.contractorId, b.contractorId].sort());
    expect(offered).not.toContain(noMobile.contractorId);
  });
});

describe('dispatch retries', () => {
  it('retries a job that had no eligible contractor once one becomes available', async () => {
    const fx = await activeCustomer();
    const { job } = await book(fx, { priority: 'urgent' });
    expect(job.status).toBe('dispatch');
    expect(job.dispatch_wave_at).not.toBeNull();
    const c = await approvedContractor();
    await db.query(`UPDATE jobs SET dispatch_wave_at = now() - interval '1 hour' WHERE id = $1`, [job.id]);
    expect(await advanceDispatchWaves(db)).toBe(1);
    expect((await one(db, 'SELECT contractor_id FROM job_offers WHERE job_id = $1', [job.id])).contractor_id).toBe(c.contractorId);
  });
});
