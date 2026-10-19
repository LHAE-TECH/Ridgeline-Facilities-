import { beforeEach, describe, expect, it } from 'vitest';
import { one } from '../src/db.js';
import { recordAcceptance } from '../src/services/agreements.js';
import { approveContractorInvoice, submitContractorInvoice } from '../src/services/contractorInvoices.js';
import { makeSafeCoverage } from '../src/services/coverage.js';
import { issueCustomerInvoice, supersededTermsHold } from '../src/services/customerInvoices.js';
import { createBooking } from '../src/services/jobs.js';
import { dashboard } from '../src/services/reports.js';
import { updateSetting } from '../src/services/settings.js';
import { activeCustomer, approvedContractor, book, completeAndApprove, count, db, resetDb, staff, standardHoursSlot, today, tradeId } from './helpers.js';

beforeEach(resetDb);

const period = { from: '2000-01-01', to: '2100-01-01' };

describe('staff bookings under superseded terms: never blocked, billing held for review', () => {
  async function v1Customer() {
    const fx = await activeCustomer();
    await db.query(`UPDATE customers SET terms_version = '2026-10-v1' WHERE id = $1`, [fx.customerId]);
    return fx;
  }

  it('lets staff book (e.g. a phoned-in emergency), tags the job, and holds its invoice until finance records a reason', async () => {
    const c = await approvedContractor();
    const fx = await v1Customer();
    const admin = await staff('admin');
    await updateSetting(db, admin, 'auto_issue_customer_invoices', true);
    await expect(book(fx)).rejects.toThrow(/service agreement has changed/); // the customer cannot book themselves
    const ops = await staff('ops');
    const { job } = await createBooking(db, ops, { customerId: fx.customerId, siteId: fx.siteId, tradeId: await tradeId('general'), priority: 'standard',
      title: 'Leak reported by phone', description: 'Tenant called', preferredStart: standardHoursSlot() });
    expect(['dispatch', 'offered']).toContain(job.status);
    expect(job).toMatchObject({ booked_under_superseded_terms: true, terms_version_at_booking: '2026-10-v1' });
    expect(await count(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = $1 AND event_type = 'terms.superseded_at_booking'`, [job.id])).toBe(1);
    expect((await dashboard(db, period)).supersededTerms.map((j: any) => j.id)).toEqual([job.id]);

    await completeAndApprove(job.id, c);
    await db.query('UPDATE jobs SET authorised_contractor_cost_cents = 50000 WHERE id = $1', [job.id]);
    const inv = await submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'ST-1', invoiceDate: today(),
      lines: [{ category: 'labour', description: 'Labour', quantityMilli: 2500, unitRateCents: 8000, timeWindow: 'standard' }], gstCents: 3000, totalCents: 23000 });
    const finance = await staff('finance');
    const { draftId } = await approveContractorInvoice(db, finance, inv.id, 'ok');
    // Auto-issue is on, but this invoice was held, not issued.
    expect((await one(db, 'SELECT status FROM customer_invoices WHERE id = $1', [draftId])).status).toBe('draft');
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'invoice_held_superseded_terms'`)).toBeGreaterThan(0);
    await expect(issueCustomerInvoice(db, finance, draftId)).rejects.toThrow(/Held for review/);

    await issueCustomerInvoice(db, finance, draftId, { supersededTermsReason: 'Customer confirmed by email they accept charges for this job' });
    const issued = await one(db, 'SELECT * FROM customer_invoices WHERE id = $1', [draftId]);
    expect(issued.status).not.toBe('draft');
    expect(issued).toMatchObject({ superseded_terms_issue_reason: 'Customer confirmed by email they accept charges for this job', superseded_terms_issued_by: finance.id });
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'customer_invoice.issued_superseded_terms'`)).toBe(1);
  });

  it('releases the hold once the customer accepts the current terms, and drops the job from the dashboard', async () => {
    await approvedContractor();
    const fx = await v1Customer();
    const { job } = await createBooking(db, await staff('ops'), { customerId: fx.customerId, siteId: fx.siteId, tradeId: await tradeId('general'), priority: 'standard',
      title: 'Phoned in', description: 'x', preferredStart: standardHoursSlot() });
    expect(await supersededTermsHold(db, job)).toMatch(/superseded terms/);
    await recordAcceptance(db, fx.owner, 'customer', fx.customerId);
    expect(await supersededTermsHold(db, job)).toBeNull();
    expect((await dashboard(db, period)).supersededTerms).toHaveLength(0);
    // A customer on current terms booking themselves is not tagged.
    expect((await book(fx)).job.booked_under_superseded_terms).toBe(false);
  });
});

describe('make-safe contractor coverage by SLA area (visibility only)', () => {
  it('counts eligible and agreement-blocked contractors per area, warns under two, and reports the go-live gate', async () => {
    let cov = await makeSafeCoverage(db);
    expect(cov.areas).toHaveLength(7);
    expect(cov.areasWithNone).toHaveLength(7);
    expect(cov.goLiveReady).toBe(false);

    await approvedContractor({ lat: -36.85, lng: 174.76 });
    const old = await approvedContractor({ lat: -36.86, lng: 174.75, agreement: '2026-10-v1' });
    await approvedContractor({ lat: -37.78, lng: 175.28, regions: ['Waikato'] }); // Hamilton: covers no Auckland area
    await approvedContractor(); // no base location: cannot be placed
    cov = await makeSafeCoverage(db);
    for (const a of cov.areas) expect(a).toMatchObject({ eligibleCount: 1, blockedCount: 1, warning: true, zero: false });
    expect(cov.areas.find((a) => a.name === 'Rodney')!.blocked[0]).toMatchObject({ id: old.contractorId, version: '2026-10-v1' });
    expect(cov.areasBelowTwo).toHaveLength(7);
    expect(cov.baseUnknown).toHaveLength(1);
    expect(cov.contractorsNotOnCurrentAgreement.map((c) => c.id)).toEqual([old.contractorId]);
    expect(cov.goLiveReady).toBe(false);

    // The blocked contractor accepts the current agreement: two eligible everywhere, gate met.
    const user = await one(db, 'SELECT id FROM users WHERE contractor_id = $1', [old.contractorId]);
    await recordAcceptance(db, { id: user.id, role: 'contractor', name: 'Old', contractorId: old.contractorId }, 'contractor', old.contractorId);
    cov = await makeSafeCoverage(db);
    for (const a of cov.areas) expect(a).toMatchObject({ eligibleCount: 2, blockedCount: 0, warning: false });
    expect(cov.goLiveReady).toBe(true);
    expect((await dashboard(db, period)).coverage.goLiveReady).toBe(true);
  });

  it('only counts contractors who could reach the area within its P1 on-site target', async () => {
    await updateSetting(db, await staff('admin'), 'travel_speed_kmh', 20); // 40 km in 2 h (metro), 80 km in 4 h (non-metro)
    await approvedContractor({ lat: -36.40, lng: 174.66 }); // Warkworth
    const cov = await makeSafeCoverage(db);
    expect(cov.areas.find((a) => a.name === 'Rodney')!.eligibleCount).toBe(1);
    expect(cov.areas.find((a) => a.name === 'South Auckland')!.eligibleCount).toBe(0);
    expect(cov.areasWithNone).toContain('South Auckland');
  });
});
