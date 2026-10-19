import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { one } from '../src/db.js';
import { addEvidence, recordArrival, startWork } from '../src/services/evidence.js';
import { acceptOffer } from '../src/services/dispatch.js';
import { activeCustomer, approvedContractor, book, db, photo, resetDb } from './helpers.js';

const app = createApp();

/** Logs in through the real login form and returns an agent holding the session + CSRF token. */
async function login(email: string, password = 'correct-horse-battery') {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, email, password });
  expect(res.status).toBe(302);
  const home = await agent.get(res.headers.location);
  const token = /name="_csrf" value="([^"]+)"/.exec(home.text)?.[1] ?? csrf;
  return { agent, csrf: token };
}

beforeAll(resetDb);

describe('criterion 17: customers and contractors cannot access other parties\' confidential records', () => {
  let a: Awaited<ReturnType<typeof activeCustomer>>;
  let b: Awaited<ReturnType<typeof activeCustomer>>;
  let jobA: any;
  let contractor: Awaited<ReturnType<typeof approvedContractor>>;
  let outsider: Awaited<ReturnType<typeof approvedContractor>>;
  let fileId: string;

  beforeEach(async () => {
    await resetDb();
    contractor = await approvedContractor();
    outsider = await approvedContractor({ regions: ['Otago'] });
    a = await activeCustomer();
    b = await activeCustomer();
    jobA = (await book(a)).job;
    const offer = await one(db, `SELECT id FROM job_offers WHERE job_id = $1 AND contractor_id = $2`, [jobA.id, contractor.contractorId]);
    await acceptOffer(db, contractor.actor, offer.id);
    await recordArrival(db, contractor.actor, jobA.id);
    await addEvidence(db, contractor.actor, jobA.id, 'before_photo', [photo()]);
    await startWork(db, contractor.actor, jobA.id);
    fileId = (await one(db, `SELECT file_id FROM job_evidence WHERE job_id = $1 LIMIT 1`, [jobA.id])).file_id;
  });

  it('customer A can see their own job and photo; customer B cannot see either', async () => {
    const ownerA = await login(a.owner.email!);
    expect((await ownerA.agent.get(`/app/jobs/${jobA.id}`)).status).toBe(200);
    expect((await ownerA.agent.get(`/files/${fileId}`)).status).toBe(200);

    const ownerB = await login(b.owner.email!);
    const job = await ownerB.agent.get(`/app/jobs/${jobA.id}`);
    expect(job.status).toBe(404);
    expect(job.text).not.toContain(jobA.title);
    expect((await ownerB.agent.get(`/files/${fileId}`)).status).toBe(403);
    expect((await ownerB.agent.get(`/app/jobs/${jobA.id}/report.pdf`)).status).toBe(404);
    // Jobs list only shows B's own jobs.
    expect((await ownerB.agent.get('/app/jobs')).text).not.toContain(jobA.ref);
  });

  it('customer B cannot act on customer A\'s job (cancel, approve, dispute)', async () => {
    const ownerB = await login(b.owner.email!);
    for (const path of ['cancel', 'approve', 'dispute']) {
      await ownerB.agent.post(`/app/jobs/${jobA.id}/${path}`).type('form').send({ _csrf: ownerB.csrf, reason: 'malicious' });
    }
    const job = await one(db, 'SELECT status FROM jobs WHERE id = $1', [jobA.id]);
    expect(job.status).toBe('in_progress');
    expect(Number((await one(db, 'SELECT COUNT(*) AS n FROM disputes')).n)).toBe(0);
  });

  it('contractors only see jobs assigned or offered to them', async () => {
    const assigned = await login(contractor.actor.email!);
    expect((await assigned.agent.get(`/c/jobs/${jobA.id}`)).status).toBe(200);
    expect((await assigned.agent.get(`/files/${fileId}`)).status).toBe(200);
    const other = await login(outsider.actor.email!);
    expect((await other.agent.get(`/c/jobs/${jobA.id}`)).status).toBe(404);
    expect((await other.agent.get(`/files/${fileId}`)).status).toBe(403);
    await other.agent.post(`/c/jobs/${jobA.id}/arrive`).type('form').send({ _csrf: other.csrf });
    expect((await one(db, 'SELECT assigned_contractor_id FROM jobs WHERE id = $1', [jobA.id])).assigned_contractor_id).toBe(contractor.contractorId);
  });

  it('customers and contractors cannot reach staff pages or another account statement', async () => {
    const ownerB = await login(b.owner.email!);
    expect((await ownerB.agent.get('/admin')).status).toBe(403);
    expect((await ownerB.agent.get(`/admin/customers/${a.customerId}`)).status).toBe(403);
    expect((await ownerB.agent.get(`/admin/customers/${a.customerId}/statement.pdf`)).status).toBe(403);
    const c = await login(contractor.actor.email!);
    expect((await c.agent.get('/admin/payables')).status).toBe(403);
    expect((await c.agent.get('/app')).status).toBe(403);
  });

  it('customer invoice pages never expose contractor cost or margin', async () => {
    const ownerA = await login(a.owner.email!);
    const page = await ownerA.agent.get('/app/account');
    expect(page.status).toBe(200);
    expect(page.text).not.toMatch(/contractor cost|markup/i);
  });

  it('rejects state-changing requests without a valid CSRF token', async () => {
    const ownerA = await login(a.owner.email!);
    const res = await ownerA.agent.post(`/app/jobs/${jobA.id}/cancel`).type('form').send({ reason: 'no token' });
    expect(res.status).toBe(302);
    expect((await one(db, 'SELECT status FROM jobs WHERE id = $1', [jobA.id])).status).toBe('in_progress');
    const forged = await ownerA.agent.post(`/app/topups`).type('form').send({ _csrf: 'x'.repeat(48), amount: '100' });
    expect(forged.status).toBe(302);
    expect(Number((await one(db, `SELECT COUNT(*) AS n FROM customer_payments WHERE status = 'pending'`)).n)).toBe(0);
  });

  it('unauthenticated users are redirected to sign in and sessions end on logout', async () => {
    expect((await request(app).get('/app')).headers.location).toMatch(/^\/login/);
    expect((await request(app).get(`/files/${fileId}`)).status).toBe(302);
    const ownerA = await login(a.owner.email!);
    await ownerA.agent.post('/logout').type('form').send({ _csrf: ownerA.csrf });
    expect((await ownerA.agent.get('/app')).status).toBe(302);
  });
});

describe('webhook endpoint', () => {
  it('rejects unsigned Stripe webhooks', async () => {
    const res = await request(app).post('/webhooks/stripe').set('Content-Type', 'application/json').send('{"id":"evt_x"}');
    expect(res.status).toBe(400);
  });
});
