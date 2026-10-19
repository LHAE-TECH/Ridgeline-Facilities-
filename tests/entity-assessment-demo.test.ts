import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { one } from '../src/db.js';
import { assertDemoSeedAllowed, markProductionDatabase, seedDemo } from '../src/demo.js';
import { applyScaleTaper, computeAssessment } from '../src/services/assessment.js';
import { approveContractorInvoice, submitContractorInvoice } from '../src/services/contractorInvoices.js';
import { createCreditNote, issueCustomerInvoice } from '../src/services/customerInvoices.js';
import { deliverPending, setEmailTransport } from '../src/services/notifications.js';
import { completionReportPdf, creditNotePdf, customerInvoicePdf, statementPdf } from '../src/services/pdf.js';
import { SETTING_DEFAULTS } from '../src/services/settings.js';
import { FACILITY_TYPES } from '../src/seed.js';
import { CUSTOMER_TERMS_VERSION } from '../src/services/terms.js';
import { activeCustomer, approvedContractor, book, completeAndApprove, db, pdfText, resetDb, staff, today } from './helpers.js';

beforeEach(resetDb);

const ENTITY = 'LHA Holdings Limited';

describe('contracting entity: LHA Holdings Limited trading as Ridgeline Facilities', () => {
  it('defaults to the correct legal entity and NZBN, with no GST number until entered', () => {
    expect(SETTING_DEFAULTS.company).toMatchObject({ legal_name: ENTITY, trading_name: 'Ridgeline Facilities', nzbn: '9429052390173', gst_number: '' });
    expect(JSON.stringify(SETTING_DEFAULTS)).not.toMatch(/Ridgeline Facilities (Limited|Ltd)/);
  });

  it('names the entity on invoices, credit notes, completion reports and statements, and in email footers', async () => {
    const c = await approvedContractor();
    const fx = await activeCustomer();
    const { job } = await book(fx);
    await completeAndApprove(job.id, c);
    const ci = await submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'E-1', invoiceDate: today(),
      lines: [{ category: 'labour', description: 'Labour', quantityMilli: 2500, unitRateCents: 8000 }], gstCents: 3000, totalCents: 23000 });
    const finance = await staff('finance');
    const { draftId } = await approveContractorInvoice(db, finance, ci.id);
    const inv = await issueCustomerInvoice(db, finance, draftId);
    const cn = await createCreditNote(db, finance, inv.id, { amountExGstCents: 1000, reason: 'Goodwill' });

    const invoiceText = pdfText(await customerInvoicePdf(db, inv.id));
    expect(invoiceText).toMatch(/TAX INVOICE/);
    expect(invoiceText).toMatch(/LHA Holdings Limited trading as Ridgeline Facilities/);
    expect(invoiceText).toMatch(/NZBN 9429052390173/);
    expect(invoiceText).toMatch(/GST number: 123-456-789/);
    expect(pdfText(await creditNotePdf(db, cn.id))).toMatch(/CREDIT NOTE \(GST\).*LHA Holdings Limited/);
    expect(pdfText(await completionReportPdf(db, job.id))).toMatch(/LHA Holdings Limited trading as Ridgeline Facilities/);
    expect(pdfText(await statementPdf(db, fx.customerId))).toMatch(/LHA Holdings Limited/);

    const sent: any[] = [];
    setEmailTransport(async (m) => { sent.push(m); return { messageId: String(sent.length) }; });
    await deliverPending(db, 500);
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) expect(m.text).toMatch(/Ridgeline Facilities is a trading name of LHA Holdings Limited \(NZBN 9429052390173, GST 123-456-789\)/);
    const cnMail = sent.find((m) => m.subject.startsWith('Credit note'));
    expect(cnMail.attachments[0].filename).toBe(`${cn.credit_note_number}.pdf`);
  });

  it('refuses to issue a GST invoice until the entity GST number is entered', async () => {
    await db.query(`UPDATE settings SET value = value || '{"gst_number": ""}' WHERE key = 'company'`);
    const c = await approvedContractor();
    const fx = await activeCustomer();
    const { job } = await book(fx);
    await completeAndApprove(job.id, c);
    const ci = await submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'G-1', invoiceDate: today(),
      lines: [{ category: 'labour', description: 'Labour', quantityMilli: 2500, unitRateCents: 8000 }], gstCents: 3000, totalCents: 23000 });
    const finance = await staff('finance');
    const { draftId } = await approveContractorInvoice(db, finance, ci.id);
    await expect(issueCustomerInvoice(db, finance, draftId)).rejects.toThrow(/Enter LHA Holdings Limited's GST number/);
  });

  it('shows the entity on the agreements, privacy statement and site footer, and records acceptance at sign-up', async () => {
    const app = createApp();
    for (const path of ['/terms/customer', '/terms/contractor', '/privacy']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/LHA Holdings Limited/);
      expect(res.text).toMatch(/9429052390173/);
    }
    expect((await request(app).get('/')).text).toMatch(/Ridgeline Facilities is a trading name of LHA Holdings Limited/);
    const agent = request.agent(app);
    const page = await agent.get('/register');
    expect(page.text).toMatch(/customer service agreement<\/a> with LHA Holdings Limited trading as Ridgeline Facilities/);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
    const res = await agent.post('/register').type('form').send({ _csrf: csrf, organisation: 'Terms Test Ltd', category: 'residential', name: 'Tess',
      email: 'tess@terms.test', password: 'correct-horse-battery', password_confirm: 'correct-horse-battery', agree: 'on' });
    expect(res.status).toBe(302);
    const c = await one(db, `SELECT c.terms_version, c.terms_accepted_at FROM customers c WHERE c.name = 'Terms Test Ltd'`);
    expect(c.terms_version).toBe(CUSTOMER_TERMS_VERSION);
    expect(c.terms_accepted_at).not.toBeNull();
  });
});

describe('minimum balance scales sub-linearly with portfolio size', () => {
  const type = (code: string) => {
    const f = FACILITY_TYPES.find((t) => t[0] === code)!;
    return { id: 0, code, name: f[1], category: f[2], unit_label: f[3], jobs_per_unit_per_month: f[4], avg_contractor_cost_cents: f[5] * 100,
      callout_share_bps: f[6] * 100, avg_callout_cost_cents: f[7] * 100, emergency_share_bps: f[8] * 100, emergency_cost_multiplier_bps: Math.round(f[9] * 10000),
      planned_monthly_cost_per_unit_cents: f[10] * 100 };
  };
  const calc = (code: string, units: number) =>
    computeAssessment({ customerCategory: 'residential', serviceLevel: 'standard', emergencyCover: 'business_hours', facilities: [{ name: 'f', unitCount: units, type: type(code) }] },
      30000, SETTING_DEFAULTS as any, 'residential');

  it('per-unit requirement falls as the portfolio grows, while the total keeps rising', () => {
    for (const code of ['res_studio_1bed', 'res_2bed_plus']) {
      const sizes = [10, 40, 100, 250, 500];
      const results = sizes.map((n) => calc(code, n));
      for (let i = 1; i < sizes.length; i++) {
        expect(results[i].calculatedCents).toBeGreaterThan(results[i - 1].calculatedCents);
        expect(results[i].calculatedCents / sizes[i]).toBeLessThan(results[i - 1].calculatedCents / sizes[i - 1]);
      }
    }
    const r100 = calc('res_2bed_plus', 100);
    expect(r100.steps.join(' ')).toMatch(/Portfolio scale adjustment/);
  });

  it('applies the taper marginally, like tax brackets', () => {
    const bands = SETTING_DEFAULTS.assessment_scale_bands as any;
    expect(applyScaleTaper(50000, bands).covered).toBe(50000);
    expect(applyScaleTaper(400000, bands).covered).toBe(100000 + 170000 + 70000);
    expect(applyScaleTaper(1000000, bands).covered).toBe(100000 + 170000 + 210000 + 240000);
  });
});

describe('demo seed cannot run against a production database', () => {
  it('refuses when the database is marked production', async () => {
    await markProductionDatabase(db);
    await expect(seedDemo(db)).rejects.toThrow(/marked as a production database/);
  });

  it('refuses when real (non-demo) users or customers exist', async () => {
    await activeCustomer();
    await expect(assertDemoSeedAllowed(db)).rejects.toThrow(/non-demo/);
  });

  it('refuses when NODE_ENV=production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { await expect(assertDemoSeedAllowed(db)).rejects.toThrow(/NODE_ENV=production/); } finally { process.env.NODE_ENV = prev; }
  });

  it('allows an empty development database', async () => {
    await expect(seedDemo(db)).resolves.toMatchObject({ customer: 'customer@demo.ridgeline.test' });
  });
});
