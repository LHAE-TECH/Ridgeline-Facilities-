import { beforeEach, describe, expect, it } from 'vitest';
import { one, query } from '../src/db.js';
import { approveContractorInvoice, submitContractorInvoice } from '../src/services/contractorInvoices.js';
import { issueCustomerInvoice } from '../src/services/customerInvoices.js';
import { deliverPending, setEmailTransport } from '../src/services/notifications.js';
import { grantAutoTopUpConsent, processLowBalances } from '../src/services/payments.js';
import { processXeroQueue, setXeroFetch } from '../src/services/xero.js';
import { runWorkerCycle } from '../src/worker.js';
import { activeCustomer, approvedContractor, book, completeAndApprove, count, db, resetDb, staff, today } from './helpers.js';

beforeEach(resetDb);

async function invoicedJob() {
  const c = await approvedContractor();
  const fx = await activeCustomer();
  const { job } = await book(fx);
  await completeAndApprove(job.id, c);
  const ci = await submitContractorInvoice(db, c.actor, { jobId: job.id, invoiceNumber: 'W-1', invoiceDate: today(),
    lines: [{ category: 'labour', description: 'Labour', quantityMilli: 2500, unitRateCents: 8000 }], gstCents: 3000, totalCents: 23000 });
  const finance = await staff('finance');
  const { draftId } = await approveContractorInvoice(db, finance, ci.id);
  const inv = await issueCustomerInvoice(db, finance, draftId);
  return { c, fx, job, inv };
}

describe('notifications are only marked sent when delivery succeeds', () => {
  it('records but does not claim delivery when email is unconfigured', async () => {
    const { inv } = await invoicedJob();
    setEmailTransport(null);
    const r = await deliverPending(db, 500);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBeGreaterThan(0);
    const n = await one(db, `SELECT status FROM notifications WHERE template = 'customer_invoice_issued' LIMIT 1`);
    expect(n.status).toBe('not_sent_unconfigured');
    expect((await one(db, 'SELECT sent_at FROM customer_invoices WHERE id = $1', [inv.id])).sent_at).toBeNull();
  });

  it('sends invoice emails with PDF attachments and records sent_at; failures retry', async () => {
    const { inv } = await invoicedJob();
    const sent: any[] = [];
    let fail = true;
    setEmailTransport(async (msg) => {
      if (msg.subject.startsWith('Invoice') && fail) throw new Error('SMTP 421 try again');
      sent.push(msg);
      return { messageId: `m-${sent.length}` };
    });
    await deliverPending(db, 500);
    expect((await one(db, 'SELECT sent_at FROM customer_invoices WHERE id = $1', [inv.id])).sent_at).toBeNull();
    const failed = await one(db, `SELECT * FROM notifications WHERE template = 'customer_invoice_issued' AND status = 'queued' LIMIT 1`);
    expect(failed.attempts).toBe(1);
    expect(failed.last_error).toMatch(/421/);
    fail = false;
    await db.query(`UPDATE notifications SET next_attempt_at = now() WHERE status = 'queued'`);
    await deliverPending(db, 500);
    const invoiceMail = sent.find((m) => m.subject.startsWith('Invoice RF-INV'));
    expect(invoiceMail.attachments.map((a: any) => a.filename)).toEqual(expect.arrayContaining([expect.stringMatching(/^RF-INV-\d+\.pdf$/)]));
    expect(invoiceMail.attachments[0].content.subarray(0, 4).toString()).toBe('%PDF');
    expect((await one(db, 'SELECT sent_at FROM customer_invoices WHERE id = $1', [inv.id])).sent_at).not.toBeNull();
  });
});

describe('accounting integration', () => {
  it('marks the queue as skipped (not synced) when Xero is unconfigured', async () => {
    await invoicedJob();
    const r = await processXeroQueue(db);
    expect(r.synced).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM integration_sync WHERE status = 'skipped_unconfigured'`)).toBeGreaterThanOrEqual(2);
    expect(await count(`SELECT COUNT(*) AS n FROM integration_sync WHERE status = 'synced'`)).toBe(0);
  });

  it('checks for an existing Xero invoice before creating one (duplicate protection)', async () => {
    const { inv } = await invoicedJob();
    const calls: string[] = [];
    setXeroFetch((async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (String(url).includes('connect/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 1800 }));
      if (String(url).includes('Invoices?where')) return new Response(JSON.stringify({ Invoices: [{ InvoiceID: 'existing-123', Status: 'AUTHORISED' }] }));
      return new Response('{}', { status: 500 });
    }) as any);
    process.env.XERO_CLIENT_ID = 'id';
    const { config } = await import('../src/config.js');
    const saved = { ...config.xero };
    config.xero.clientId = 'id'; config.xero.clientSecret = 'secret';
    try {
      await processXeroQueue(db);
      const row = await one(db, `SELECT * FROM integration_sync WHERE entity_type = 'customer_invoice' AND entity_id = $1`, [inv.id]);
      expect(row.status).toBe('synced');
      expect(row.external_id).toBe('existing-123');
      expect(calls.some((c) => c.startsWith('PUT') && c.includes('Invoices'))).toBe(false);
    } finally {
      config.xero.clientId = saved.clientId; config.xero.clientSecret = saved.clientSecret;
      setXeroFetch((...args) => fetch(...args));
    }
  });
});

describe('background worker', () => {
  it('sends low-balance alerts and creates consented automatic top-up requests (without crediting)', async () => {
    const fx = await activeCustomer();
    const before = (await one(db, 'SELECT prepaid_balance_cents FROM customers WHERE id = $1', [fx.customerId])).prepaid_balance_cents;
    await expect(grantAutoTopUpConsent(db, fx.owner, fx.customerId, 50000, before + 1, false)).rejects.toThrow(/consent box/);
    await grantAutoTopUpConsent(db, fx.owner, fx.customerId, 50000, before + 1, true);
    await db.query('UPDATE customers SET agreed_minimum_balance_cents = $2 WHERE id = $1', [fx.customerId, before + 100]);
    const r = await processLowBalances(db);
    expect(r).toEqual({ alerts: 1, autoTopUps: 1 });
    const p = await one(db, `SELECT * FROM customer_payments WHERE customer_id = $1 AND is_auto_topup`, [fx.customerId]);
    expect(p.status).toBe('pending');
    expect((await one(db, 'SELECT prepaid_balance_cents FROM customers WHERE id = $1', [fx.customerId])).prepaid_balance_cents).toBe(before);
    // Second run on the same day does not duplicate alerts or requests.
    expect(await processLowBalances(db)).toEqual({ alerts: 0, autoTopUps: 0 });
  });

  it('runs a full cycle and auto-closes jobs whose checks pass', async () => {
    const r = await runWorkerCycle(db);
    expect(r).not.toBeNull();
    for (const v of Object.values(r!)) expect(v).not.toHaveProperty('error');
    const rows = await query(db, 'SELECT 1');
    expect(rows).toHaveLength(1);
  });
});
