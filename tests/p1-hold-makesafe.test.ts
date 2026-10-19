import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { one, query } from '../src/db.js';
import { addEvidence, completeJob, recordArrival, startWork } from '../src/services/evidence.js';
import { acceptOffer } from '../src/services/dispatch.js';
import { bookFollowUp, dismissFollowUp, openFollowUps } from '../src/services/followUps.js';
import { closeChecks, releaseHeldP1OnCall } from '../src/services/jobs.js';
import { p1Exposure, p1HoldReport, unfundedPosition } from '../src/services/p1Scope.js';
import { completionReportPdf } from '../src/services/pdf.js';
import { recordBankReceipt } from '../src/services/payments.js';
import { updateSetting } from '../src/services/settings.js';
import { activeCustomer, approvedContractor, book, count, db, pdfText, photo, resetDb, staff, today } from './helpers.js';

beforeEach(resetDb);

const period = () => {
  const m = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date()).slice(0, 7);
  return { from: `${m}-01`, to: `${m}-31` };
};

async function unfundedCustomer() {
  const fx = await activeCustomer();
  await db.query('UPDATE customers SET prepaid_balance_cents = 0 WHERE id = $1', [fx.customerId]);
  return fx;
}

async function onCallStaff(phone: string) {
  const ops = await staff('ops');
  await db.query('UPDATE users SET on_call_p1_release = true, phone = $2 WHERE id = $1', [ops.id, phone]);
  return ops;
}

/** One unfunded P1 dispatched (unfunded NZ$1,725 ≥ NZ$1,000 threshold), then a second one booked and held. */
async function heldP1() {
  await approvedContractor();
  const admin = await staff('admin');
  await updateSetting(db, admin, 'escalation_staff_phones', ['021 999 0000']);
  await updateSetting(db, admin, 'p1_unfunded_suspend_threshold_cents', 100000);
  const fx = await unfundedCustomer();
  await book(fx, { priority: 'emergency', preferredStart: null });
  const { job } = await book(fx, { priority: 'emergency', preferredStart: null, title: 'Second leak' });
  return { fx, job, admin };
}

describe('P1 held at the unfunded threshold', () => {
  it('alerts the on-call release holders, who can release it for make-safe only, with a reason, fully audited; the clock never pauses', async () => {
    const onCall = await onCallStaff('021 888 0000');
    const other = await staff('ops');
    const { job } = await heldP1();
    expect(job.status).toBe('pending_funds');
    expect(job.p1_held_at).not.toBeNull();
    const phones = (await query(db, `SELECT recipient_phone FROM notifications WHERE template = 'p1_hold_sms'`)).map((r) => r.recipient_phone).sort();
    expect(phones).toEqual(['+64218880000', '+64219990000']);
    const clockBefore = await one(db, 'SELECT sla_started_at, sla_onsite_due, sla_resolve_due, created_at FROM jobs WHERE id = $1', [job.id]);
    expect(new Date(clockBefore.sla_started_at).toISOString()).toBe(new Date(clockBefore.created_at).toISOString());
    await db.query(`UPDATE jobs SET p1_held_at = now() - interval '25 minutes' WHERE id = $1`, [job.id]);

    await expect(releaseHeldP1OnCall(db, other, job.id, 'x')).rejects.toThrow(/on-call P1 release right/);
    await expect(releaseHeldP1OnCall(db, onCall, job.id, '  ')).rejects.toThrow(/reason/);
    await releaseHeldP1OnCall(db, onCall, job.id, 'Water through light fittings; occupant elderly');

    const j = await one(db, 'SELECT * FROM jobs WHERE id = $1', [job.id]);
    expect(['dispatch', 'offered']).toContain(j.status);
    expect(j).toMatchObject({ p1_scope: 'make_safe', p1_hold_release_kind: 'on_call', p1_hold_released_by: onCall.id, scope_extended_at: null });
    // Clock untouched by the hold and the release.
    for (const k of ['sla_started_at', 'sla_onsite_due', 'sla_resolve_due']) expect(new Date(j[k]).toISOString()).toBe(new Date(clockBefore[k]).toISOString());
    const ex = await one(db, 'SELECT * FROM funding_exceptions WHERE job_id = $1', [job.id]);
    expect(ex).toMatchObject({ kind: 'on_call_make_safe', approved_by: onCall.id, reason: 'Water through light fittings; occupant elderly' });
    const auditRow = await one(db, `SELECT * FROM audit_log WHERE action = 'job.p1_on_call_release' AND entity_id = $1`, [job.id]);
    expect(auditRow.details).toMatchObject({ onCallRight: true, heldMinutes: 25 });
    expect(await count(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = $1 AND event_type = 'p1.on_call_release'`, [job.id])).toBe(1);
    await expect(releaseHeldP1OnCall(db, onCall, job.id, 'again')).rejects.toThrow(/held at the unfunded threshold/);

    // Reported separately from SLA performance.
    const holds = await p1HoldReport(db, period());
    expect(holds).toMatchObject({ count: 1, stillHeld: 0, avgHoldMinutes: 25 });
  });

  it('records a hold that ends when the customer funds it, and never pauses the clock', async () => {
    const { fx, job, admin } = await heldP1();
    expect(job.status).toBe('pending_funds');
    await recordBankReceipt(db, await staff('finance'), { customerId: fx.customerId, amountCents: 2000000, receivedDate: today(), bankReference: 'TOPUP-1', idempotencyKey: 'topup-held' });
    const j = await one(db, 'SELECT * FROM jobs WHERE id = $1', [job.id]);
    expect(['dispatch', 'offered']).toContain(j.status);
    expect(j.p1_hold_release_kind).toBe('funded');
    expect(new Date(j.sla_started_at).toISOString()).toBe(new Date(j.created_at).toISOString());
    expect(admin).toBeTruthy();
  });

  it('with p1_hold_at_threshold off, keeps dispatching for make-safe and only alerts staff', async () => {
    await approvedContractor();
    const admin = await staff('admin');
    await updateSetting(db, admin, 'p1_unfunded_suspend_threshold_cents', 100000);
    await updateSetting(db, admin, 'p1_hold_at_threshold', false);
    const fx = await unfundedCustomer();
    await book(fx, { priority: 'emergency', preferredStart: null });
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null, title: 'Second' });
    expect(['dispatch', 'offered']).toContain(job.status);
    expect(job.p1_held_at).toBeNull();
    expect(job.p1_scope).toBe('make_safe');
    expect(await count(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = $1 AND event_type = 'p1.threshold_exceeded'`, [job.id])).toBe(1);
  });
});

describe('make-safe defined operationally', () => {
  async function makeSafeJobOnSite() {
    const c = await approvedContractor();
    const fx = await unfundedCustomer();
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    const offer = await one(db, `SELECT id FROM job_offers WHERE job_id = $1 AND contractor_id = $2`, [job.id, c.contractorId]);
    await acceptOffer(db, c.actor, offer.id);
    await recordArrival(db, c.actor, job.id);
    await addEvidence(db, c.actor, job.id, 'before_photo', [photo()]);
    await startWork(db, c.actor, job.id);
    await addEvidence(db, c.actor, job.id, 'after_photo', [photo()]);
    return { c, fx, job };
  }

  it('requires what was made safe and what remains outstanding, and raises a follow-up that must be booked or dismissed', async () => {
    const { c, fx, job } = await makeSafeJobOnSite();
    const base = { workPerformed: 'Isolated supply', labourMinutes: 1 };
    await expect(completeJob(db, c.actor, job.id, base)).rejects.toThrow(/what was made safe and what remains outstanding/);
    await expect(completeJob(db, c.actor, job.id, { ...base, madeSafeSummary: 'Water isolated' })).rejects.toThrow(/both required/);
    await completeJob(db, c.actor, job.id, { ...base, madeSafeSummary: 'Water isolated at toby; ceiling cordoned off', outstandingWork: 'Replace burst copper pipe in ceiling; repair ceiling lining' });

    const report = await one(db, 'SELECT * FROM completion_reports WHERE job_id = $1', [job.id]);
    expect(report).toMatchObject({ made_safe_summary: 'Water isolated at toby; ceiling cordoned off', outstanding_work: 'Replace burst copper pipe in ceiling; repair ceiling lining' });
    expect(pdfText(await completionReportPdf(db, job.id))).toMatch(/Still outstanding/);
    expect((await closeChecks(db, job.id)).outstanding).not.toContain('Make-safe report must state what was made safe and what remains outstanding');

    const [f] = await openFollowUps(db);
    expect(f).toMatchObject({ job_id: job.id, description: 'Replace burst copper pipe in ceiling; repair ceiling lining', status: 'open' });
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'follow_up_suggested'`)).toBeGreaterThan(0);

    const ops = await staff('ops');
    await expect(dismissFollowUp(db, ops, f.id, '')).rejects.toThrow(/reason/);
    await expect(bookFollowUp(db, await staff('finance'), f.id, { priority: 'standard' })).rejects.toThrow(/operations staff/);
    await db.query('UPDATE customers SET prepaid_balance_cents = 5000000 WHERE id = $1', [fx.customerId]);
    const followUp = await bookFollowUp(db, ops, f.id, { priority: 'standard', preferredStart: new Date(Date.now() + 7 * 86400000).toISOString() });
    expect(followUp.title).toMatch(new RegExp(`^Follow-up to ${job.ref}`));
    expect(followUp.description).toMatch(/Replace burst copper pipe/);
    expect(await one(db, 'SELECT status, follow_up_job_id FROM follow_up_suggestions WHERE id = $1', [f.id])).toMatchObject({ status: 'booked', follow_up_job_id: followUp.id });
    expect(await openFollowUps(db)).toHaveLength(0);
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'follow_up.booked'`)).toBe(1);
  });

  it('does not ask for make-safe fields once further work has been approved', async () => {
    const { c, fx, job } = await makeSafeJobOnSite();
    const { extendP1Scope } = await import('../src/services/p1Scope.js');
    await extendP1Scope(db, fx.owner, job.id, 'Go ahead with the full repair');
    await completeJob(db, c.actor, job.id, { workPerformed: 'Replaced pipe', labourMinutes: 1 });
    expect(await openFollowUps(db)).toHaveLength(0);
  });
});

describe('concurrent P1s at the same site', () => {
  async function partlyFunded() {
    await approvedContractor();
    const fx = await activeCustomer();
    // NZ$1,000 in the account (below the agreed minimum), so both emergencies are make-safe with a NZ$1,725 reservation.
    await db.query('UPDATE customers SET prepaid_balance_cents = 100000 WHERE id = $1', [fx.customerId]);
    return fx;
  }
  const bookBoth = (fx: any) => Promise.all([
    book(fx, { priority: 'emergency', preferredStart: null, title: 'Burst pipe unit 1', idempotencyKey: 'p1-a' }),
    book(fx, { priority: 'emergency', preferredStart: null, title: 'Burst pipe unit 2', idempotencyKey: 'p1-b' }),
  ]);

  it('never double-spends the balance and counts the combined unfunded exposure once', async () => {
    const fx = await partlyFunded();
    const [a, b] = await bookBoth(fx);
    for (const r of [a, b]) expect(['dispatch', 'offered']).toContain(r.job.status);
    const commits = await query(db, `SELECT amount_cents FROM job_commitments WHERE customer_id = $1 AND status = 'active'`, [fx.customerId]);
    expect(commits.map((c) => Number(c.amount_cents))).toEqual([172500, 172500]);
    const unfunded = [Number(a.job.unfunded_cents), Number(b.job.unfunded_cents)].sort((x, y) => x - y);
    // Whichever is released first uses the NZ$1,000 balance; the other gets none of it.
    expect(unfunded).toEqual([72500, 172500]);
    const funded = 345000 - (unfunded[0] + unfunded[1]);
    expect(funded).toBe(100000); // exactly the balance, used once
    expect(Number((await one(db, 'SELECT prepaid_balance_cents FROM customers WHERE id = $1', [fx.customerId])).prepaid_balance_cents)).toBe(100000);
    const pos = await unfundedPosition(db, fx.customerId);
    expect(pos.openP1UnfundedCents).toBe(245000);
    expect((await p1Exposure(db)).totalCents).toBe(245000);
    // A top-up reduces the exposure immediately.
    await db.query('UPDATE customers SET prepaid_balance_cents = 200000 WHERE id = $1', [fx.customerId]);
    expect((await unfundedPosition(db, fx.customerId)).openP1UnfundedCents).toBe(145000);
  });

  it('also holds for P1s at two different sites of the same customer', async () => {
    const fx = await partlyFunded();
    const { addSite } = await import('../src/services/customers.js');
    const site2 = await addSite(db, fx.owner, fx.customerId, { name: 'Second building', address: '2 Queen Street', suburb: 'Ponsonby', city: 'Auckland', region: 'Auckland' });
    const [a, b] = await Promise.all([
      book(fx, { priority: 'emergency', preferredStart: null, title: 'Site 1', idempotencyKey: 'p1-s1' }),
      book({ ...fx, siteId: site2.id }, { priority: 'emergency', preferredStart: null, title: 'Site 2', idempotencyKey: 'p1-s2' }),
    ]);
    expect([Number(a.job.unfunded_cents), Number(b.job.unfunded_cents)].sort((x, y) => x - y)).toEqual([72500, 172500]);
    expect((await unfundedPosition(db, fx.customerId)).openP1UnfundedCents).toBe(245000);
  });

  it('applies the threshold to the combined exposure, whichever booking wins the race', async () => {
    const fx = await partlyFunded();
    await updateSetting(db, await staff('admin'), 'p1_unfunded_suspend_threshold_cents', 50000);
    const results = await bookBoth(fx);
    const statuses = results.map((r) => r.job.status);
    // The first released leaves NZ$725 unfunded (over the NZ$500 threshold), so exactly one is held.
    expect(statuses.filter((s) => s === 'pending_funds')).toHaveLength(1);
    expect(statuses.filter((s) => ['dispatch', 'offered'].includes(s))).toHaveLength(1);
    expect((await unfundedPosition(db, fx.customerId))).toMatchObject({ openP1UnfundedCents: 72500, suspended: true });
    const held = results.find((r) => r.job.status === 'pending_funds')!.job;
    expect(held.p1_held_at).not.toBeNull();
    expect(Number(held.unfunded_cents)).toBe(0);
  });
});

describe('pages', () => {
  async function login(email: string) {
    const agent = request.agent(createApp());
    const page = await agent.get('/login');
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
    expect((await agent.post('/login').type('form').send({ _csrf: csrf, email, password: 'correct-horse-battery' })).status).toBe(302);
    return agent;
  }
  const csrfOf = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)![1];

  it('lets the on-call holder release a held P1 from the job page and shows the hold, follow-ups and staff pages', async () => {
    const onCall = await onCallStaff('021 888 0000');
    const { job, admin, fx } = await heldP1();
    const agent = await login(onCall.email!);
    const page = await agent.get(`/admin/jobs/${job.id}`);
    expect(page.text).toMatch(/P1 held: unfunded threshold reached/);
    expect(page.text).toMatch(/Release for make-safe/);
    const res = await agent.post(`/admin/jobs/${job.id}/on-call-release`).type('form').send({ _csrf: csrfOf(page.text), reason: 'Ceiling collapse risk' });
    expect(res.status).toBe(302);
    expect((await one(db, 'SELECT p1_hold_release_kind FROM jobs WHERE id = $1', [job.id])).p1_hold_release_kind).toBe('on_call');
    expect((await agent.get(`/admin/jobs/${job.id}`)).text).toMatch(/Held at the unfunded threshold/);
    expect((await (await login(fx.owner.email!)).get(`/app/jobs/${job.id}`)).text).toMatch(/clock was not paused/);
    expect((await agent.get('/admin/follow-ups')).status).toBe(200);
    expect((await agent.get('/admin')).text).toMatch(/P1 held at threshold/);

    const adminAgent = await login(admin.email!);
    const users = await adminAgent.get('/admin/users');
    expect(users.text).toMatch(/receive P1 hold alerts but belong to nobody with the on-call release right/); // 021 999 0000
    const other = await staff('ops');
    const grant = await adminAgent.post(`/admin/users/${other.id}/on-call`).type('form').send({ _csrf: csrfOf(users.text), on_call: 'true', phone: '' });
    expect(grant.status).toBe(302);
    expect((await one(db, 'SELECT on_call_p1_release FROM users WHERE id = $1', [other.id])).on_call_p1_release).toBe(false); // no mobile: refused
    await adminAgent.post(`/admin/users/${other.id}/on-call`).type('form').send({ _csrf: csrfOf(users.text), on_call: 'true', phone: '021 999 0000' });
    expect((await one(db, 'SELECT on_call_p1_release, phone FROM users WHERE id = $1', [other.id]))).toMatchObject({ on_call_p1_release: true, phone: '+64219990000' });
    expect((await adminAgent.get('/admin/users')).text).not.toMatch(/belong to nobody with the on-call release right/);
  });
});
