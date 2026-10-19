import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { one } from '../src/db.js';
import { approveContractorInvoice, submitContractorInvoice, validateContractorInvoice } from '../src/services/contractorInvoices.js';
import { setSiteArea, updateCustomerTerms } from '../src/services/customers.js';
import { issueCustomerInvoice } from '../src/services/customerInvoices.js';
import { grantFundingException } from '../src/services/jobs.js';
import { extendP1Scope, p1Exposure, unfundedPosition } from '../src/services/p1Scope.js';
import { dashboard } from '../src/services/reports.js';
import { SETTING_DEFAULTS, updateSetting } from '../src/services/settings.js';
import { areaUnconfirmedJobs, slaPerformance } from '../src/services/sla.js';
import { activeCustomer, approvedContractor, book, completeAndApprove, count, db, resetDb, staff, today } from './helpers.js';

beforeEach(resetDb);

const nowMonth = () => {
  const m = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date()).slice(0, 7);
  return { from: `${m}-01`, to: `${m}-31` };
};

async function unfundedCustomer(opts: { suburb?: string } = {}) {
  const fx = await activeCustomer(opts);
  await db.query('UPDATE customers SET prepaid_balance_cents = 0 WHERE id = $1', [fx.customerId]);
  return fx;
}

describe('unfunded and over-authority P1: make-safe scope only, up to a cap', () => {
  it('dispatches an unfunded P1 immediately for make-safe only, reserving the cap and recording the unfunded amount', async () => {
    await approvedContractor();
    const fx = await unfundedCustomer();
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    expect(['dispatch', 'offered']).toContain(job.status);
    // Response is not limited: the clock still runs from booking.
    expect(new Date(job.sla_started_at).toISOString()).toBe(new Date(job.created_at).toISOString());
    expect(job).toMatchObject({ p1_scope: 'make_safe', p1_scope_reason: 'unfunded', p1_scope_cap_ex_gst_cents: 150000 });
    const commitment = await one(db, `SELECT amount_cents FROM job_commitments WHERE job_id = $1 AND status = 'active'`, [job.id]);
    expect(Number(commitment.amount_cents)).toBe(172500); // $1,500 ex GST + 15%
    expect(Number(job.unfunded_cents)).toBe(172500);
    // Authorised contractor cost is the cap translated through this job's own estimate pricing.
    const p = job.estimate.pricing;
    expect(job.authorised_contractor_cost_cents).toBe(Math.floor((p.contractorCostExGstCents * 150000) / p.subtotalExGstCents));
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'p1_make_safe_dispatch'`)).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'job_offer' AND body LIKE '%MAKE-SAFE ONLY%'`)).toBeGreaterThan(0);
  });

  it('uses a per-customer cap, which only finance or an administrator can set', async () => {
    await approvedContractor();
    const fx = await unfundedCustomer();
    await expect(updateCustomerTerms(db, await staff('ops'), fx.customerId, { p1CapExGstCents: 50000 })).rejects.toThrow(/finance or an administrator/);
    await updateCustomerTerms(db, await staff('finance'), fx.customerId, { p1CapExGstCents: 50000 });
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    expect(job.p1_scope_cap_ex_gst_cents).toBe(50000);
    expect(Number(job.unfunded_cents)).toBe(57500);
  });

  it('limits a funded P1 above the authority limit to make-safe, with nothing unfunded', async () => {
    await approvedContractor();
    const fx = await activeCustomer();
    await db.query('UPDATE customers SET authority_limit_cents = 1000 WHERE id = $1', [fx.customerId]);
    const { addCustomerUser } = await import('../src/services/customers.js');
    const booker = await addCustomerUser(db, fx.owner, fx.customerId, { name: 'Bo', email: 'bo@customer.test', password: 'correct-horse-battery', customerRole: 'booker' });
    const { job } = await book({ ...fx, owner: { id: booker.id, role: 'customer', name: 'Bo', customerId: fx.customerId, customerRole: 'booker' } },
      { priority: 'emergency', preferredStart: null });
    expect(job).toMatchObject({ p1_scope: 'make_safe', p1_scope_reason: 'over_authority' });
    expect(Number(job.unfunded_cents)).toBe(0);
    // A funded P1 within authority has full scope.
    const normal = (await book(fx, { priority: 'emergency', preferredStart: null, title: 'Owner booking' })).job;
    expect(normal.p1_scope).toBeNull();
  });

  it('blocks work beyond make-safe until the customer approves or staff override with a reason, both recorded', async () => {
    const c = await approvedContractor();
    const fx = await unfundedCustomer();
    await updateCustomerTerms(db, await staff('admin'), fx.customerId, { p1CapExGstCents: 10000 });
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    await completeAndApprove(job.id, c);
    const inv = await submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'MS-1', invoiceDate: today(),
      lines: [{ category: 'labour', description: 'Labour', quantityMilli: 2500, unitRateCents: 8000, timeWindow: 'standard' }], gstCents: 3000, totalCents: 23000 });
    const flags = await validateContractorInvoice(db, inv.id);
    expect(flags.find((f) => f.code === 'beyond_make_safe_scope')?.severity).toBe('blocking');
    const finance = await staff('finance');
    await expect(approveContractorInvoice(db, finance, inv.id, 'ok')).rejects.toThrow(/make-safe/);

    // Permissions: a booker cannot approve; finance cannot override; staff must give a reason.
    await expect(extendP1Scope(db, finance, job.id, 'x')).rejects.toThrow(/operations or administrators/);
    const ops = await staff('ops');
    await expect(extendP1Scope(db, ops, job.id, '')).rejects.toThrow(/reason/);
    await extendP1Scope(db, ops, job.id, 'Customer agreed by phone to repair the burst pipe');
    const j = await one(db, 'SELECT * FROM jobs WHERE id = $1', [job.id]);
    expect(j).toMatchObject({ scope_extension_kind: 'staff_override', scope_extension_reason: 'Customer agreed by phone to repair the burst pipe', scope_extended_by: ops.id });
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job.p1_scope_extended' AND entity_id = $1`, [job.id])).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = $1 AND event_type = 'p1.scope_extended'`, [job.id])).toBe(1);
    await expect(extendP1Scope(db, ops, job.id, 'again')).rejects.toThrow(/not limited/);
    expect((await validateContractorInvoice(db, inv.id)).some((f) => f.code === 'beyond_make_safe_scope')).toBe(false);
  });

  it('records a customer approval of further work', async () => {
    await approvedContractor();
    const fx = await unfundedCustomer();
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    await extendP1Scope(db, fx.owner, job.id, undefined);
    const j = await one(db, 'SELECT * FROM jobs WHERE id = $1', [job.id]);
    expect(j).toMatchObject({ scope_extension_kind: 'customer_approval', scope_extended_by: fx.owner.id, customer_approved_by: fx.owner.id });
    expect(j.scope_extension_reason).toMatch(/Approved by/);
    // The full estimate is now committed; the extra is unfunded (no balance).
    expect(Number(j.unfunded_cents)).toBeGreaterThanOrEqual(172500);
  });

  it('refuses to issue a customer invoice above the make-safe cap while the scope is limited', async () => {
    const c = await approvedContractor();
    const fx = await unfundedCustomer();
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    await completeAndApprove(job.id, c);
    const inv = await submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'MS-2', invoiceDate: today(),
      lines: [{ category: 'labour', description: 'Labour', quantityMilli: 1000, unitRateCents: 8000, timeWindow: 'standard' }], gstCents: 1200, totalCents: 9200 });
    const r = await approveContractorInvoice(db, await staff('finance'), inv.id, 'Make-safe labour');
    // Simulate pricing (e.g. a minimum charge) taking the customer price above a lower cap.
    await db.query('UPDATE jobs SET p1_scope_cap_ex_gst_cents = 1000 WHERE id = $1', [job.id]);
    await expect(issueCustomerInvoice(db, await staff('finance'), r.draftId)).rejects.toThrow(/make-safe work up to/);
  });
});

describe('unfunded exposure: dashboard and suspension threshold', () => {
  it('reports total unfunded P1 exposure and suspends automatic unfunded dispatch past the threshold', async () => {
    await approvedContractor();
    const admin = await staff('admin');
    await updateSetting(db, admin, 'escalation_staff_phones', ['021 999 0000']);
    await updateSetting(db, admin, 'p1_unfunded_suspend_threshold_cents', 100000);
    const fx = await unfundedCustomer();
    const first = (await book(fx, { priority: 'emergency', preferredStart: null })).job;
    expect(['dispatch', 'offered']).toContain(first.status);

    const pos = await unfundedPosition(db, fx.customerId);
    expect(pos).toMatchObject({ openP1UnfundedCents: 172500, totalCents: 172500, thresholdCents: 100000, suspended: true });
    const exposure = await p1Exposure(db);
    expect(exposure).toMatchObject({ totalCents: 172500, openUnfundedCents: 172500, openJobs: 1, suspendedCustomers: 1 });
    expect((await dashboard(db, nowMonth())).unfundedP1.totalCents).toBe(172500);

    // Next unfunded P1 is held for a staff decision; staff are alerted by email and SMS. The clock still runs from booking.
    const second = (await book(fx, { priority: 'emergency', preferredStart: null, title: 'Second leak' })).job;
    expect(second.status).toBe('pending_funds');
    expect(new Date(second.sla_started_at).toISOString()).toBe(new Date(second.created_at).toISOString());
    expect(await count(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = $1 AND event_type = 'p1.unfunded_suspended'`, [second.id])).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE channel = 'sms' AND body LIKE 'URGENT P1%HELD%'`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'p1_unfunded_suspended'`)).toBeGreaterThan(0);

    // A funding exception releases it, still for make-safe only.
    await grantFundingException(db, await staff('finance'), second.id, 'Body corporate chair confirmed payment');
    const released = await one(db, 'SELECT * FROM jobs WHERE id = $1', [second.id]);
    expect(['dispatch', 'offered']).toContain(released.status);
    expect(released.p1_scope).toBe('make_safe');

    // A per-customer threshold overrides the default.
    await updateCustomerTerms(db, await staff('finance'), fx.customerId, { p1SuspendThresholdCents: 10000000 });
    const third = (await book(fx, { priority: 'emergency', preferredStart: null, title: 'Third' })).job;
    expect(['dispatch', 'offered']).toContain(third.status);
  });
});

describe('unconfirmed SLA areas do not count as breaches', () => {
  it('needs staff confirmation before P2–P4 booking; a P1 is accepted but excluded from SLA reporting until confirmed', async () => {
    await approvedContractor();
    const fx = await activeCustomer({ suburb: 'Nowhere Flats' });
    const site = await one(db, 'SELECT * FROM sites WHERE id = $1', [fx.siteId]);
    expect(site.sla_area_source).toBe('unconfirmed');
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'site_area_unconfirmed'`)).toBeGreaterThan(0);
    await expect(book(fx, { priority: 'standard' })).rejects.toThrow(/confirm the service area/);

    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    expect(job.sla_targets).toMatchObject({ metro: true, area_confirmed: false });
    // Force a breach on the provisional target: it must not appear in SLA statistics.
    await db.query(`UPDATE jobs SET created_at = now() - interval '5 hours', sla_started_at = now() - interval '5 hours',
      sla_onsite_due = now() - interval '3 hours', sla_onsite_met = false, sla_onsite_breached_at = now() - interval '3 hours' WHERE id = $1`, [job.id]);
    const period = nowMonth();
    expect((await slaPerformance(db, period, fx.customerId)).find((r) => r.code === 'P1')!.jobs).toBe(0);
    expect((await areaUnconfirmedJobs(db, period, fx.customerId)).map((j) => j.id)).toEqual([job.id]);
    const d = await dashboard(db, period);
    expect(d.slaBreaches.breached).toBe(0);
    expect(d.areaUnconfirmed.sites.map((s: any) => s.id)).toContain(fx.siteId);
    expect(d.areaUnconfirmed.jobs.map((j: any) => j.id)).toContain(job.id);

    // Staff confirm the area (Rodney): targets recalculate for the real area and the job is now reported.
    await setSiteArea(db, await staff('ops'), fx.siteId, 'Rodney');
    const j = await one(db, 'SELECT * FROM jobs WHERE id = $1', [job.id]);
    expect(j.sla_targets).toMatchObject({ area: 'Rodney', metro: false, area_confirmed: true });
    expect(new Date(j.sla_onsite_due).getTime() - new Date(j.created_at).getTime()).toBe(4 * 3600000);
    expect((await slaPerformance(db, period, fx.customerId)).find((r) => r.code === 'P1')!.jobs).toBe(1);
    expect(await areaUnconfirmedJobs(db, period, fx.customerId)).toHaveLength(0);
    await expect(book(fx, { priority: 'standard', title: 'Now allowed' })).resolves.toBeTruthy();
  });

  it('can refuse P1 too at an unconfirmed site, and confirms sites when their suburb is added to the area lists', async () => {
    await approvedContractor();
    const admin = await staff('admin');
    const fx = await activeCustomer({ suburb: 'Kaukapakapa' });
    await updateSetting(db, admin, 'unconfirmed_area_allows_p1', false);
    await expect(book(fx, { priority: 'emergency', preferredStart: null })).rejects.toThrow(/confirm the service area/);
    const areas = SETTING_DEFAULTS.sla_areas.map((a) => (a.name === 'Rodney' ? { ...a, suburbs: [...a.suburbs, 'Kaukapakapa'] } : a));
    await updateSetting(db, admin, 'sla_areas', areas);
    expect((await one(db, 'SELECT sla_area, sla_area_source FROM sites WHERE id = $1', [fx.siteId]))).toMatchObject({ sla_area: 'Rodney', sla_area_source: 'suburb' });
    await expect(book(fx, { priority: 'standard' })).resolves.toBeTruthy();
  });
});

describe('pages', () => {
  async function login(email: string) {
    const agent = request.agent(createApp());
    const page = await agent.get('/login');
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
    const res = await agent.post('/login').type('form').send({ _csrf: csrf, email, password: 'correct-horse-battery' });
    expect(res.status).toBe(302);
    return agent;
  }

  it('shows the make-safe scope, exposure and unconfirmed areas, and records a staff override through the form', async () => {
    const c = await approvedContractor();
    const fx = await unfundedCustomer();
    await activeCustomer({ suburb: 'Nowhere Flats' });
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    const ops = await staff('ops');
    const agent = await login(ops.email!);

    const dash = await agent.get('/admin');
    expect(dash.status).toBe(200);
    expect(dash.text).toMatch(/Total unfunded P1 exposure/);
    expect(dash.text).toMatch(/Area unconfirmed/);
    expect(dash.text).toMatch(/Nowhere Flats/);

    const page = await agent.get(`/admin/jobs/${job.id}`);
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/Make-safe only/);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
    const res = await agent.post(`/admin/jobs/${job.id}/scope`).type('form').send({ _csrf: csrf, reason: 'Owner approved repair by phone' });
    expect(res.status).toBe(302);
    expect((await one(db, 'SELECT scope_extension_kind FROM jobs WHERE id = $1', [job.id])).scope_extension_kind).toBe('staff_override');

    const customer = await login(fx.owner.email!);
    expect((await customer.get(`/app/jobs/${job.id}`)).text).toMatch(/Further work beyond make-safe approved/);
    expect((await (await login((await one(db, 'SELECT email FROM users WHERE contractor_id = $1', [c.contractorId])).email)).get(`/c/jobs/${job.id}`)).status).toBe(200);
    expect((await agent.get(`/admin/customers/${fx.customerId}`)).text).toMatch(/Unfunded emergency exposure/);
  });
});
