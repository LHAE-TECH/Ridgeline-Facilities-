import { beforeEach, describe, expect, it } from 'vitest';
import { one } from '../src/db.js';
import { acceptOffer, assessContractorsForJob, declineOffer, dispatchJob, expireOffers, manualAssign } from '../src/services/dispatch.js';
import { addEvidence, completeJob, evidenceStatus, recordArrival, reviewEvidence, startWork, withdrawEvidence } from '../src/services/evidence.js';
import { SYSTEM_ACTOR } from '../src/lib/actor.js';
import { activeCustomer, approvedContractor, book, count, db, photo, resetDb, staff, tradeId } from './helpers.js';

beforeEach(resetDb);

describe('criterion 5: contractors accept only eligible jobs and cannot duplicate an assignment', () => {
  it('offers only to eligible contractors and explains ineligibility', async () => {
    const good = await approvedContractor();
    const wrongRegion = await approvedContractor({ regions: ['Canterbury'] });
    const wrongTrade = await approvedContractor({ trade: 'painting' });
    const expired = await approvedContractor();
    await db.query(`UPDATE compliance_documents SET expires_at = '2020-01-01' WHERE contractor_id = $1 AND doc_type = 'public_liability'`, [expired.contractorId]);
    const fx = await activeCustomer();
    const { job } = await book(fx);
    expect(job.status).toBe('offered');
    const offers = await db.query(`SELECT contractor_id FROM job_offers WHERE job_id = $1`, [job.id]);
    expect(offers.rows.map((r) => r.contractor_id)).toEqual([good.contractorId]);
    const a = await assessContractorsForJob(db, job.id);
    expect(a.find((x) => x.contractorId === wrongRegion.contractorId)!.reasons.join()).toMatch(/Does not cover Auckland/);
    expect(a.find((x) => x.contractorId === wrongTrade.contractorId)!.reasons.join()).toMatch(/Not registered/);
    expect(a.find((x) => x.contractorId === expired.contractorId)!.reasons.join()).toMatch(/Public liability/);
  });

  it('licensed trades require the licence document', async () => {
    const noLicence = await approvedContractor({ trade: 'electrical' });
    await db.query(`UPDATE compliance_documents SET status = 'rejected' WHERE contractor_id = $1 AND doc_type = 'ewrb_licence'`, [noLicence.contractorId]);
    const fx = await activeCustomer();
    const { job } = await book(fx, { tradeId: await tradeId('electrical') });
    expect(job.status).toBe('dispatch');
    const a = (await assessContractorsForJob(db, job.id)).find((x) => x.contractorId === noLicence.contractorId)!;
    expect(a.reasons.join()).toMatch(/Electrical Workers Registration Board/);
  });

  it('lets exactly one of several concurrent acceptances win', async () => {
    const c1 = await approvedContractor();
    const c2 = await approvedContractor();
    const c3 = await approvedContractor();
    const fx = await activeCustomer();
    const { job } = await book(fx);
    const offers = (await db.query(`SELECT id, contractor_id FROM job_offers WHERE job_id = $1`, [job.id])).rows;
    expect(offers).toHaveLength(3);
    const byContractor = (c: { contractorId: string; actor: any }) => offers.find((o) => o.contractor_id === c.contractorId)!.id;
    const results = await Promise.allSettled([c1, c2, c3].map((c) => acceptOffer(db, c.actor, byContractor(c))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count(`SELECT COUNT(*) AS n FROM job_assignments WHERE job_id = $1 AND status = 'active'`, [job.id])).toBe(1);
    const winner = [c1, c2, c3][results.findIndex((r) => r.status === 'fulfilled')];
    // The winner cannot accept twice either.
    await expect(acceptOffer(db, winner.actor, byContractor(winner))).rejects.toThrow(/already accepted/);
    const j = await one(db, 'SELECT status, assigned_contractor_id FROM jobs WHERE id = $1', [job.id]);
    expect(j).toEqual({ status: 'assigned', assigned_contractor_id: winner.contractorId });
  });

  it('rejects acceptance of offers that belong to someone else, expired offers, or after becoming ineligible', async () => {
    const c1 = await approvedContractor();
    const c2 = await approvedContractor();
    const fx = await activeCustomer();
    const { job } = await book(fx);
    const o1 = await one(db, `SELECT id FROM job_offers WHERE job_id = $1 AND contractor_id = $2`, [job.id, c1.contractorId]);
    const o2 = await one(db, `SELECT id FROM job_offers WHERE job_id = $1 AND contractor_id = $2`, [job.id, c2.contractorId]);
    await expect(acceptOffer(db, c2.actor, o1.id)).rejects.toThrow(/not found/i);
    await db.query(`UPDATE contractors SET status = 'suspended' WHERE id = $1`, [c2.contractorId]);
    await expect(acceptOffer(db, c2.actor, o2.id)).rejects.toThrow(/not currently eligible/);
    await db.query(`UPDATE job_offers SET expires_at = now() - interval '1 minute' WHERE id = $1`, [o1.id]);
    await expect(acceptOffer(db, c1.actor, o1.id)).rejects.toThrow(/expired/);
  });

  it('returns declined or expired jobs to the dispatch queue and alerts operations', async () => {
    const c1 = await approvedContractor();
    await staff('ops');
    const fx = await activeCustomer();
    const { job } = await book(fx);
    const o1 = await one(db, `SELECT id FROM job_offers WHERE job_id = $1`, [job.id]);
    await declineOffer(db, c1.actor, o1.id, 'Fully booked');
    expect((await one(db, 'SELECT status FROM jobs WHERE id = $1', [job.id])).status).toBe('dispatch');
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'job_unassigned'`)).toBeGreaterThan(0);

    const c2 = await approvedContractor();
    await dispatchJob(db, SYSTEM_ACTOR, job.id);
    await db.query(`UPDATE job_offers SET expires_at = now() - interval '1 second' WHERE job_id = $1 AND status = 'offered'`, [job.id]);
    expect(await expireOffers(db)).toBe(1);
    expect((await one(db, 'SELECT status FROM jobs WHERE id = $1', [job.id])).status).toBe('dispatch');
    expect(c2).toBeTruthy();
  });

  it('allows manual assignment of eligible contractors, and ineligible only by admin override with reason', async () => {
    const eligible = await approvedContractor();
    const ineligible = await approvedContractor({ regions: ['Otago'] });
    const fx = await activeCustomer();
    const { job } = await book(fx);
    const ops = await staff('ops');
    await expect(manualAssign(db, ops, job.id, ineligible.contractorId)).rejects.toThrow(/not eligible/);
    await manualAssign(db, ops, job.id, eligible.contractorId);
    expect(await count(`SELECT COUNT(*) AS n FROM job_offers WHERE job_id = $1 AND status = 'offered'`, [job.id])).toBe(0);
    // Reassignment ends the previous assignment; still only one active.
    await manualAssign(db, fx.admin, job.id, ineligible.contractorId, 'Only locksmith on Waiheke today');
    expect(await count(`SELECT COUNT(*) AS n FROM job_assignments WHERE job_id = $1 AND status = 'active'`, [job.id])).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job.manually_assigned' AND entity_id = $1`, [job.id])).toBe(2);
  });
});

describe('criterion 6: completion requires all mandatory evidence', () => {
  async function assignedJob() {
    const c = await approvedContractor();
    const fx = await activeCustomer();
    const { job } = await book(fx);
    const offer = await one(db, `SELECT id FROM job_offers WHERE job_id = $1`, [job.id]);
    await acceptOffer(db, c.actor, offer.id);
    return { c, fx, job };
  }

  it('enforces arrival → start → photos → report, with server timestamps and optional GPS', async () => {
    const { c, job } = await assignedJob();
    await expect(startWork(db, c.actor, job.id)).rejects.toThrow(/Record arrival/);
    await recordArrival(db, c.actor, job.id, { lat: -36.8485, lng: 174.7633, accuracy: 12 });
    const ev = await one(db, `SELECT * FROM job_events WHERE job_id = $1 AND event_type = 'arrived'`, [job.id]);
    expect(Number(ev.lat)).toBeCloseTo(-36.8485);
    expect(new Date(ev.occurred_at).getTime()).toBeLessThanOrEqual(Date.now());
    await startWork(db, c.actor, job.id);

    const report = { workPerformed: 'Fixed', labourMinutes: 30 };
    await expect(completeJob(db, c.actor, job.id, report)).rejects.toThrow(/before photograph.*after photograph/);
    await addEvidence(db, c.actor, job.id, 'before_photo', [photo()]);
    await expect(completeJob(db, c.actor, job.id, report)).rejects.toThrow(/after photograph/);
    await addEvidence(db, c.actor, job.id, 'after_photo', [photo()]);
    await expect(completeJob(db, c.actor, job.id, { workPerformed: '', labourMinutes: 0 })).rejects.toThrow(/Description of work performed; Labour time/);

    expect((await evidenceStatus(db, job.id, report)).complete).toBe(true);
    await completeJob(db, c.actor, job.id, report);
    expect((await one(db, 'SELECT status FROM jobs WHERE id = $1', [job.id])).status).toBe('evidence_submitted');
    const file = await one(db, `SELECT f.sha256 FROM job_evidence e JOIN files f ON f.id = e.file_id WHERE e.job_id = $1 AND e.kind = 'after_photo'`, [job.id]);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires a site acknowledgement when the customer agreement says so', async () => {
    const { c, fx, job } = await assignedJob();
    await db.query('UPDATE customers SET acknowledgement_required = true WHERE id = $1', [fx.customerId]);
    await recordArrival(db, c.actor, job.id);
    await addEvidence(db, c.actor, job.id, 'before_photo', [photo()]);
    await startWork(db, c.actor, job.id);
    await addEvidence(db, c.actor, job.id, 'after_photo', [photo()]);
    await expect(completeJob(db, c.actor, job.id, { workPerformed: 'Done', labourMinutes: 5 })).rejects.toThrow(/acknowledgement/);
    await completeJob(db, c.actor, job.id, { workPerformed: 'Done', labourMinutes: 5, acknowledgedByName: 'Sam Site-Manager' });
  });

  it('flags excessive labour, lets Ridgeline request more evidence, and preserves every version', async () => {
    const { c, job } = await assignedJob();
    await recordArrival(db, c.actor, job.id);
    await addEvidence(db, c.actor, job.id, 'before_photo', [photo()]);
    await startWork(db, c.actor, job.id);
    await addEvidence(db, c.actor, job.id, 'after_photo', [photo()]);
    // Arrived moments ago but claims 8 hours of labour.
    const r1 = await completeJob(db, c.actor, job.id, { workPerformed: 'Big job', labourMinutes: 480 });
    expect(r1.review_flags.map((f: any) => f.code)).toContain('excessive_labour');

    const ops = await staff('ops');
    await expect(reviewEvidence(db, ops, job.id, 'reject')).rejects.toThrow(/Explain/);
    await reviewEvidence(db, ops, job.id, 'reject', 'Labour exceeds time on site; add photo of replaced part');
    expect((await one(db, 'SELECT status FROM jobs WHERE id = $1', [job.id])).status).toBe('evidence_rejected');

    const ev = await addEvidence(db, c.actor, job.id, 'after_photo', [photo('part.png')]);
    await withdrawEvidence(db, ops, ev[0].id, 'Blurry duplicate');
    await addEvidence(db, c.actor, job.id, 'after_photo', [photo('part2.png')]);
    await completeJob(db, c.actor, job.id, { workPerformed: 'Big job', labourMinutes: 1 });
    await reviewEvidence(db, ops, job.id, 'approve');
    expect(await count('SELECT COUNT(*) AS n FROM completion_reports WHERE job_id = $1', [job.id])).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM job_evidence WHERE job_id = $1', [job.id])).toBe(4); // withdrawn item retained
    await expect(db.query('DELETE FROM job_evidence WHERE id = $1', [ev[0].id])).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE job_events SET note = 'tampered' WHERE job_id = $1`, [job.id])).rejects.toThrow(/append-only/);
  });
});
