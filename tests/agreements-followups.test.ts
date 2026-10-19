import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { assertKeysMatchEnvironment } from '../src/config.js';
import { one, query } from '../src/db.js';
import { addCustomerUser } from '../src/services/customers.js';
import { acceptOffer, assessContractorsForJob, MAKE_SAFE_AGREEMENT_REASON, manualAssign } from '../src/services/dispatch.js';
import { addEvidence, completeJob, recordArrival, startWork } from '../src/services/evidence.js';
import { declineFollowUp, dismissFollowUp, followUpCsv, followUpReport, followUpSummary, processFollowUpAgeing } from '../src/services/followUps.js';
import { dashboard } from '../src/services/reports.js';
import { acceptanceStatus, AGREEMENT_VERSIONS } from '../src/services/terms.js';
import { activeCustomer, approvedContractor, book, count, db, photo, resetDb, staff } from './helpers.js';

beforeEach(resetDb);

async function login(email: string) {
  const agent = request.agent(createApp());
  const page = await agent.get('/login');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, email, password: 'correct-horse-battery' });
  return { agent, location: res.headers.location as string };
}
const csrfOf = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)![1];

/** Puts a customer back on the superseded v1 terms (as an existing customer would be when v2 is published). */
async function onV1(customerId: string, userId: string) {
  await db.query(`INSERT INTO agreement_acceptances (kind, version, customer_id, accepted_by, accepted_at, source) VALUES ('customer','2026-10-v1',$1,$2, now() - interval '30 days','backfill')`, [customerId, userId]);
  await db.query(`UPDATE customers SET terms_version = '2026-10-v1', terms_accepted_at = now() - interval '30 days' WHERE id = $1`, [customerId]);
}

describe('agreement versioning policy', () => {
  it('marks versions minor or material; only a superseded material version requires re-acceptance', () => {
    expect(AGREEMENT_VERSIONS.customer.at(-1)).toMatchObject({ version: '2026-10-v2', materiality: 'material' });
    expect(AGREEMENT_VERSIONS.contractor.at(-1)).toMatchObject({ version: '2026-10-v2', materiality: 'material', includesMakeSafe: true });
    expect(acceptanceStatus('customer', '2026-10-v1').needsAcceptance).toBe(true);
    expect(acceptanceStatus('customer', null).needsAcceptance).toBe(true);
    expect(acceptanceStatus('customer', '2026-10-v2').needsAcceptance).toBe(false);
    // A later MINOR version does not force anyone on v2 to accept again (but v1 users still must).
    AGREEMENT_VERSIONS.customer.push({ version: '2026-11-v3', effective: '2026-11-01', materiality: 'minor', summary: 'Typo fixes' });
    try {
      expect(acceptanceStatus('customer', '2026-10-v2')).toMatchObject({ needsAcceptance: false, current: '2026-11-v3', required: '2026-10-v2' });
      expect(acceptanceStatus('customer', '2026-10-v1').needsAcceptance).toBe(true);
    } finally { AGREEMENT_VERSIONS.customer.pop(); }
  });

  it('customers on a superseded material version cannot book until an owner or approver accepts at sign-in', async () => {
    await approvedContractor();
    const fx = await activeCustomer();
    await onV1(fx.customerId, fx.owner.id);
    await expect(book(fx)).rejects.toThrow(/service agreement has changed/);

    const booker = await addCustomerUser(db, fx.owner, fx.customerId, { name: 'Bo', email: 'bo-terms@customer.test', password: 'correct-horse-battery', customerRole: 'booker' });
    const b = await login('bo-terms@customer.test');
    expect(b.location).toBe('/app'); // cannot accept, so not redirected
    const home = await b.agent.get('/app');
    expect(home.text).toMatch(/Ask your account owner or approver to accept it/);
    expect((await b.agent.post('/agreements/accept').type('form').send({ _csrf: csrfOf(home.text), accept: 'on' })).status).toBe(302);
    expect((await one(db, 'SELECT terms_version FROM customers WHERE id = $1', [fx.customerId])).terms_version).toBe('2026-10-v1');
    expect(booker).toBeTruthy();

    const o = await login(fx.owner.email!);
    expect(o.location).toMatch(/^\/agreements\/accept/);
    const page = await o.agent.get(o.location);
    expect(page.text).toMatch(/P1 targets run from booking/);
    await o.agent.post('/agreements/accept').type('form').send({ _csrf: csrfOf(page.text), accept: 'on', next: '/app' });
    expect((await one(db, 'SELECT terms_version FROM customers WHERE id = $1', [fx.customerId])).terms_version).toBe('2026-10-v2');
    await expect(book(fx)).resolves.toBeTruthy();

    // Record and history on the customer page.
    const history = await query(db, `SELECT version, source FROM agreement_acceptances WHERE customer_id = $1 ORDER BY accepted_at`, [fx.customerId]);
    // Registration (v2, fixture), the simulated earlier v1 acceptance, and today's re-acceptance: all kept, oldest first.
    expect(history.map((h) => h.version)).toEqual(['2026-10-v1', '2026-10-v2', '2026-10-v2']);
    expect(history.at(-1)).toMatchObject({ version: '2026-10-v2', source: 'app' });
    const adminPage = await (await login((await staff('admin')).email!)).agent.get(`/admin/customers/${fx.customerId}`);
    expect(adminPage.text).toMatch(/Up to date/);
    expect(adminPage.text).toMatch(/2026-10-v1/);
    await expect(db.query('DELETE FROM agreement_acceptances')).rejects.toThrow(/append-only/);
  });

  it('contractors without the make-safe clause never get make-safe offers, and must re-accept before accepting any offer', async () => {
    const v1 = await approvedContractor({ agreement: '2026-10-v1' });
    const current = await approvedContractor();
    const fx = await activeCustomer();
    await db.query('UPDATE customers SET prepaid_balance_cents = 0 WHERE id = $1', [fx.customerId]);
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    expect(job.p1_scope).toBe('make_safe');
    const assessment = (await assessContractorsForJob(db, job.id)).find((a) => a.contractorId === v1.contractorId)!;
    expect(assessment.reasons).toContain(MAKE_SAFE_AGREEMENT_REASON);
    const offered = (await query(db, 'SELECT contractor_id FROM job_offers WHERE job_id = $1', [job.id])).map((o) => o.contractor_id);
    expect(offered).toContain(current.contractorId);
    expect(offered).not.toContain(v1.contractorId);
    await expect(manualAssign(db, await staff('admin'), job.id, v1.contractorId, 'Only one nearby')).rejects.toThrow(/cannot be overridden/);

    // A normal (fully funded) job is offered to them, but they must accept the current agreement first.
    const funded = await activeCustomer();
    const normal = (await book(funded, { priority: 'standard' })).job;
    const offer = await one(db, 'SELECT id FROM job_offers WHERE job_id = $1 AND contractor_id = $2', [normal.id, v1.contractorId]);
    await expect(acceptOffer(db, v1.actor, offer.id)).rejects.toThrow(/contractor agreement has changed/);
    const c = await login((await one(db, 'SELECT email FROM users WHERE contractor_id = $1', [v1.contractorId])).email);
    expect(c.location).toMatch(/^\/agreements\/accept/);
    const page = await c.agent.get(c.location);
    expect(page.text).toMatch(/make-safe definition/);
    await c.agent.post('/agreements/accept').type('form').send({ _csrf: csrfOf(page.text), accept: 'on' });
    await acceptOffer(db, v1.actor, offer.id);
    expect((await one(db, 'SELECT assigned_contractor_id FROM jobs WHERE id = $1', [normal.id])).assigned_contractor_id).toBe(v1.contractorId);
    const adminPage = await (await login((await staff('admin')).email!)).agent.get(`/admin/contractors/${v1.contractorId}`);
    expect(adminPage.text).toMatch(/Has accepted the make-safe clause/);
  });
});

describe('follow-up ageing and escalation', () => {
  async function followUp() {
    const c = await approvedContractor();
    const fx = await activeCustomer();
    await db.query('UPDATE customers SET prepaid_balance_cents = 0 WHERE id = $1', [fx.customerId]);
    const { job } = await book(fx, { priority: 'emergency', preferredStart: null });
    const offer = await one(db, `SELECT id FROM job_offers WHERE job_id = $1 AND contractor_id = $2`, [job.id, c.contractorId]);
    await acceptOffer(db, c.actor, offer.id);
    await recordArrival(db, c.actor, job.id);
    await addEvidence(db, c.actor, job.id, 'before_photo', [photo()]);
    await startWork(db, c.actor, job.id);
    await addEvidence(db, c.actor, job.id, 'after_photo', [photo()]);
    await completeJob(db, c.actor, job.id, { workPerformed: 'Isolated', labourMinutes: 1, madeSafeSummary: 'Gas isolated at meter', outstandingWork: 'Replace corroded gas fitting' });
    const f = await one(db, 'SELECT * FROM follow_up_suggestions WHERE job_id = $1', [job.id]);
    return { fx, job, f };
  }

  it('tells the customer at creation, flags at 14 days, escalates to ops and admin and reminds the customer at 30, each once', async () => {
    const { f } = await followUp();
    expect(f.customer_notified_at).not.toBeNull();
    const told = await one(db, `SELECT body FROM notifications WHERE template = 'follow_up_customer' LIMIT 1`);
    expect(told.body).toMatch(/Gas isolated at meter/);
    expect(told.body).toMatch(/Replace corroded gas fitting/);
    await staff('ops'); await staff('admin');

    expect(await processFollowUpAgeing(db)).toEqual({ flagged: 0, escalated: 0 });
    await db.query(`UPDATE follow_up_suggestions SET created_at = now() - interval '15 days' WHERE id = $1`, [f.id]);
    expect(await processFollowUpAgeing(db)).toEqual({ flagged: 1, escalated: 0 });
    let s = await followUpSummary(db);
    expect(s).toMatchObject({ open: 1, current: 0, aged: 1, escalated: 0 });

    await db.query(`UPDATE follow_up_suggestions SET created_at = now() - interval '31 days' WHERE id = $1`, [f.id]);
    expect(await processFollowUpAgeing(db)).toEqual({ flagged: 0, escalated: 1 });
    expect(await processFollowUpAgeing(db)).toEqual({ flagged: 0, escalated: 0 });
    const esc = await query(db, `SELECT u.role FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE n.template = 'follow_up_escalated'`);
    expect(new Set(esc.map((r) => r.role))).toEqual(new Set(['ops', 'admin']));
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'follow_up_reminder'`)).toBeGreaterThan(0);
    s = await followUpSummary(db);
    expect(s).toMatchObject({ open: 1, aged: 0, escalated: 1 });
    const period = { from: '2000-01-01', to: '2100-01-01' };
    expect((await dashboard(db, period)).followUps).toMatchObject({ escalated: 1, current: 0 });
  });

  it('records the customer decision not to proceed with a reason, keeps dismissed ones, and reports them all', async () => {
    const a = await followUp();
    const b = await followUp();
    const booker = await addCustomerUser(db, a.fx.owner, a.fx.customerId, { name: 'Bk', email: 'bk-fu@customer.test', password: 'correct-horse-battery', customerRole: 'booker' });
    await expect(declineFollowUp(db, { id: booker.id, role: 'customer', name: 'Bk', customerId: a.fx.customerId, customerRole: 'booker' }, a.f.id, 'no')).rejects.toThrow(/owner or approver/);
    await expect(declineFollowUp(db, a.fx.owner, a.f.id, ' ')).rejects.toThrow(/reason/);
    await declineFollowUp(db, a.fx.owner, a.f.id, 'Body corporate is replacing the whole gas system next month');
    const ops = await staff('ops');
    await dismissFollowUp(db, ops, b.f.id, 'Duplicate of an existing booked job');

    const declined = await one(db, 'SELECT * FROM follow_up_suggestions WHERE id = $1', [a.f.id]);
    expect(declined).toMatchObject({ status: 'declined_by_customer', decided_by: a.fx.owner.id, decided_on_behalf_of_customer: false });
    await expect(db.query('DELETE FROM follow_up_suggestions WHERE id = $1', [b.f.id])).rejects.toThrow(/append-only|not permitted/);
    const all = await followUpReport(db, { status: 'all' });
    expect(all.map((r) => r.status).sort()).toEqual(['declined_by_customer', 'dismissed']);
    expect((await followUpReport(db, { status: 'dismissed' }))[0].decision_note).toBe('Duplicate of an existing booked job');
    const csv = followUpCsv(all);
    expect(csv).toMatch(/Body corporate is replacing the whole gas system next month/);
    expect(csv).toMatch(/Duplicate of an existing booked job/);

    const adminAgent = (await login((await staff('admin')).email!)).agent;
    expect((await adminAgent.get('/admin/follow-ups?status=dismissed')).text).toMatch(/Duplicate of an existing booked job/);
    expect((await adminAgent.get('/admin/follow-ups.csv?status=all')).text).toMatch(/declined_by_customer/);
    expect((await (await login(a.fx.owner.email!)).agent.get(`/app/jobs/${a.job.id}`)).text).toMatch(/You chose not to proceed/);
  });
});

describe('environment key guards', () => {
  it('production refuses Stripe test keys and Twilio test mode; staging refuses live Stripe keys', () => {
    expect(() => assertKeysMatchEnvironment('production', 'sk_test_abc', undefined)).toThrow(/Production refuses/);
    expect(() => assertKeysMatchEnvironment('production', 'rk_test_abc', undefined)).toThrow(/Production refuses/);
    expect(() => assertKeysMatchEnvironment('production', 'sk_live_abc', 'true')).toThrow(/TWILIO_TEST_MODE/);
    expect(() => assertKeysMatchEnvironment('production', 'sk_live_abc', undefined)).not.toThrow();
    expect(() => assertKeysMatchEnvironment('production', '', undefined)).not.toThrow(); // Stripe not configured
    expect(() => assertKeysMatchEnvironment('staging', 'sk_live_abc', undefined)).toThrow(/Staging refuses/);
    expect(() => assertKeysMatchEnvironment('staging', 'sk_test_abc', undefined)).not.toThrow();
  });
});
