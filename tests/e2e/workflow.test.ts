import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { one } from '../../src/db.js';
import { seedDemo, DEMO_PASSWORD } from '../../src/demo.js';
import { db, PNG, resetDb } from '../helpers.js';

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1366, height: 900 };

let server: Server;
let base: string;
let browser: Browser;
const overflowFailures: string[] = [];

async function session(role: string, viewport: { width: number; height: number }): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600,
    geolocation: { latitude: -36.8441, longitude: 174.7652, accuracy: 10 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`${base}/login`);
  await page.fill('#email', `${role}@demo.ridgeline.test`);
  await page.fill('#password', DEMO_PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  return { ctx, page };
}

/** Asserts the page renders without horizontal page scrolling at the current viewport. */
async function checkLayout(page: Page, label: string) {
  const r = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth, title: document.title }));
  if (r.scroll > r.width + 1) overflowFailures.push(`${label} (${page.viewportSize()?.width}px): scrollWidth ${r.scroll} > ${r.width}`);
  expect(r.title).toContain('Ridgeline');
  const errorFlash = await page.locator('.flash.error').allTextContents();
  return errorFlash;
}

async function visit(page: Page, path: string) {
  const res = await page.goto(`${base}${path}`);
  expect(res?.status(), path).toBe(200);
  await checkLayout(page, path);
}

async function submit(page: Page, selector: string) {
  await Promise.all([page.waitForNavigation(), page.click(selector)]);
  const errors = await checkLayout(page, page.url());
  expect(errors, `error after ${selector} on ${page.url()}`).toEqual([]);
}

beforeAll(async () => {
  await resetDb();
  await seedDemo(db);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
}, 60000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe('criterion 18: the full workflow works on mobile and desktop', () => {
  it('runs booking → dispatch → evidence → invoicing → settlement → payment through the UI', async () => {
    // 1. Customer books on a phone.
    const customer = await session('customer', MOBILE);
    await visit(customer.page, '/app');
    await visit(customer.page, '/app/jobs/new');
    await customer.page.fill('input[name=title]', 'Blocked bathroom basin');
    await customer.page.fill('textarea[name=description]', 'Basin in unit A101 drains very slowly.');
    await customer.page.selectOption('select[name=trade_id]', { label: 'Plumbing & drainage' });
    await customer.page.setInputFiles('input[name=photos]', { name: 'basin.png', mimeType: 'image/png', buffer: PNG });
    await submit(customer.page, 'button[value=estimate]');
    await expect(customer.page.locator('text=Estimated total').count()).resolves.toBeGreaterThan(0);
    await customer.page.setInputFiles('input[name=photos]', { name: 'basin.png', mimeType: 'image/png', buffer: PNG });
    await submit(customer.page, 'button[value=book]');
    const job = await one(db, `SELECT * FROM jobs WHERE title = 'Blocked bathroom basin'`);
    expect(job.status).toBe('offered');
    expect(customer.page.url()).toContain(`/app/jobs/${job.id}`);

    // 2. Contractor accepts and works the job on a phone.
    const contractor = await session('contractor', MOBILE);
    await visit(contractor.page, '/c');
    await submit(contractor.page, 'form[action$="/accept"] button');
    expect(contractor.page.url()).toContain(`/c/jobs/${job.id}`);
    await submit(contractor.page, 'form[action$="/arrive"] button');
    const arrived = await one(db, `SELECT lat FROM job_events WHERE job_id = $1 AND event_type = 'arrived'`, [job.id]);
    expect(Number(arrived.lat)).toBeCloseTo(-36.8441, 3); // GPS captured with permission
    await contractor.page.selectOption('form[action$="/evidence"] select[name=kind]', 'before_photo');
    await contractor.page.setInputFiles('form[action$="/evidence"] input[type=file]', { name: 'before.png', mimeType: 'image/png', buffer: PNG });
    await submit(contractor.page, 'form[action$="/evidence"] button[type=submit]');
    await submit(contractor.page, 'form[action$="/start"] button');
    await contractor.page.selectOption('form[action$="/evidence"] select[name=kind]', 'after_photo');
    await contractor.page.setInputFiles('form[action$="/evidence"] input[type=file]', { name: 'after.png', mimeType: 'image/png', buffer: PNG });
    await submit(contractor.page, 'form[action$="/evidence"] button[type=submit]');
    await contractor.page.fill('textarea[name=work_performed]', 'Cleared trap and waste pipe; tested drainage.');
    await contractor.page.fill('input[name=labour_hours]', '0.01');
    await submit(contractor.page, 'form[action$="/complete"] button[type=submit]');
    expect((await one(db, 'SELECT status FROM jobs WHERE id = $1', [job.id])).status).toBe('evidence_submitted');

    // 3. Operations reviews evidence on desktop.
    const ops = await session('ops', DESKTOP);
    await visit(ops.page, '/admin/dispatch');
    await visit(ops.page, `/admin/jobs/${job.id}`);
    await submit(ops.page, 'form[action$="/evidence-review"] button[value=approve]');
    expect((await one(db, 'SELECT status FROM jobs WHERE id = $1', [job.id])).status).toBe('evidence_approved');

    // 4. Contractor invoices Ridgeline: standard callout $100 ex GST.
    await visit(contractor.page, `/c/jobs/${job.id}`);
    await contractor.page.fill('input[name=invoice_number]', 'KFI-0001');
    const row = contractor.page.locator('#invoice-lines [data-row]').first();
    await row.locator('select[name=line_category]').selectOption('callout');
    await row.locator('input[name=line_description]').fill('Standard callout');
    await row.locator('input[name=line_quantity]').fill('1');
    await row.locator('input[name=line_rate]').fill('100');
    await submit(contractor.page, 'form[action$="/invoice"] button[type=submit]');
    const ci = await one(db, `SELECT * FROM contractor_invoices WHERE invoice_number = 'KFI-0001'`);
    expect(ci.total_cents).toBe(11500);

    // 5. Finance approves, reviews the 35% markup draft and issues it on desktop.
    const finance = await session('finance', DESKTOP);
    await visit(finance.page, '/admin/contractor-invoices');
    await visit(finance.page, `/admin/contractor-invoices/${ci.id}`);
    if (await finance.page.locator('textarea[name=override_reason]').count()) {
      await finance.page.fill('textarea[name=override_reason]', 'Reviewed');
    }
    await submit(finance.page, 'form[action$="/approve"] button');
    const draft = await one(db, `SELECT * FROM customer_invoices WHERE job_id = $1`, [job.id]);
    expect(draft.subtotal_ex_gst_cents).toBe(13500); // $100 × 1.35
    finance.page.on('dialog', (d) => d.accept());
    await submit(finance.page, 'form[action$="/issue"] button');
    const issued = await one(db, `SELECT * FROM customer_invoices WHERE id = $1`, [draft.id]);
    expect(issued.status).toBe('paid');
    expect(issued.prepaid_applied_cents).toBe(15525);

    // 6. Customer sees the invoice and statement on a phone; no internal cost data.
    await visit(customer.page, '/app/invoices');
    await visit(customer.page, `/app/invoices/${issued.id}`);
    expect(await customer.page.content()).not.toMatch(/contractor cost/i);
    await visit(customer.page, '/app/account');
    await visit(customer.page, `/app/jobs/${job.id}`);

    // 7. Finance approves, batches and confirms the contractor payment.
    await visit(finance.page, '/admin/payables');
    await submit(finance.page, 'form[action$="/approve"] button');
    const payable = await one(db, `SELECT * FROM contractor_payables WHERE contractor_invoice_id = $1`, [ci.id]);
    await finance.page.fill('form[action="/admin/batches"] input[name=due_on_or_before]', payable.due_date);
    await submit(finance.page, 'form[action="/admin/batches"] button');
    expect((await one(db, 'SELECT status FROM contractor_payables WHERE id = $1', [payable.id])).status).toBe('in_batch');
    await finance.page.fill('form[action$="/confirm"] input[name=reference]', 'ANZ-E2E-1');
    await submit(finance.page, 'form[action$="/confirm"] button');
    expect((await one(db, 'SELECT status FROM contractor_payables WHERE id = $1', [payable.id])).status).toBe('paid');

    // 8. Close the job once all checks pass.
    await visit(ops.page, `/admin/jobs/${job.id}`);
    await submit(ops.page, 'form[action$="/close"] button');
    expect((await one(db, 'SELECT status FROM jobs WHERE id = $1', [job.id])).status).toBe('closed');

    for (const s of [customer, contractor, ops, finance]) await s.ctx.close();
  });

  it('every portal page lays out without horizontal scrolling at phone and desktop widths', async () => {
    const pages: Record<string, string[]> = {
      customer: ['/app', '/app/jobs', '/app/jobs/new', '/app/account', '/app/invoices', '/app/reports', '/app/properties', '/app/assessment', '/app/users'],
      contractor: ['/c', '/c/invoices', '/c/profile'],
      admin: ['/admin', '/admin/dispatch', '/admin/jobs', '/admin/customers', '/admin/contractors', '/admin/contractor-invoices', '/admin/customer-invoices',
        '/admin/payments', '/admin/payables', '/admin/disputes', '/admin/refunds', '/admin/settings', '/admin/reports', '/admin/integrations', '/admin/notifications', '/admin/audit'],
    };
    const job = await one(db, `SELECT id FROM jobs LIMIT 1`);
    const customer = await one(db, `SELECT id FROM customers LIMIT 1`);
    const contractor = await one(db, `SELECT id FROM contractors LIMIT 1`);
    const inv = await one(db, `SELECT id FROM customer_invoices LIMIT 1`);
    pages.admin.push(`/admin/jobs/${job.id}`, `/admin/customers/${customer.id}`, `/admin/contractors/${contractor.id}`, `/admin/customer-invoices/${inv.id}`);
    pages.customer.push(`/app/jobs/${job.id}`, `/app/invoices/${inv.id}`);
    pages.contractor.push(`/c/jobs/${job.id}`);
    for (const viewport of [MOBILE, DESKTOP]) {
      for (const [role, paths] of Object.entries(pages)) {
        const s = await session(role, viewport);
        for (const p of paths) await visit(s.page, p);
        await s.ctx.close();
      }
      const anon = await browser.newContext({ viewport });
      const page = await anon.newPage();
      for (const p of ['/', '/login', '/register', '/contractors/apply', '/terms/customer', '/terms/contractor', '/privacy']) await visit(page, p);
      await anon.close();
    }
    expect(overflowFailures).toEqual([]);
  });
});
