import { config } from '../config.js';
import type { Db } from '../db.js';
import { maybeOne, one, query } from '../db.js';

/**
 * Xero integration (Custom Connection, client-credentials grant). Every financial event is queued in
 * integration_sync. When credentials are missing the queue item is marked 'skipped_unconfigured' so nobody
 * mistakes it for a successful sync. Duplicate protection: each document is looked up by its unique number
 * before creation, and the (provider, entity) pair is unique in the queue.
 */

export type SyncEntity = 'customer_invoice' | 'contractor_invoice' | 'contractor_payment';

export async function enqueueSync(db: Db, entityType: SyncEntity, entityId: string): Promise<void> {
  await db.query(`INSERT INTO integration_sync (provider, entity_type, entity_id) VALUES ('xero', $1, $2) ON CONFLICT DO NOTHING`, [entityType, entityId]);
}

export function xeroConfigured(): boolean {
  return Boolean(config.xero.clientId && config.xero.clientSecret);
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
export function setXeroFetch(f: Fetch): void { fetchImpl = f; }

let token: { value: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const res = await fetchImpl('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.xero.clientId}:${config.xero.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: process.env.XERO_SCOPES ?? 'accounting.transactions accounting.contacts' }),
  });
  if (!res.ok) throw new Error(`Xero token request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return token.value;
}

async function xero(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetchImpl(`https://api.xero.com/api.xro/2.0/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Xero ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function findInvoice(number: string, type: 'ACCREC' | 'ACCPAY', contactName?: string): Promise<string | null> {
  const where = encodeURIComponent(`Type=="${type}" AND InvoiceNumber=="${number.replace(/"/g, '')}"${contactName ? ` AND Contact.Name=="${contactName.replace(/"/g, '')}"` : ''}`);
  const json = await xero('GET', `Invoices?where=${where}`);
  const found = (json.Invoices ?? []).find((i: any) => i.Status !== 'DELETED' && i.Status !== 'VOIDED');
  return found?.InvoiceID ?? null;
}

async function syncCustomerInvoice(db: Db, id: string): Promise<string> {
  const inv = await one(db, `SELECT ci.*, c.name AS customer_name, c.billing_email, j.ref AS job_ref FROM customer_invoices ci
    JOIN customers c ON c.id = ci.customer_id JOIN jobs j ON j.id = ci.job_id WHERE ci.id = $1`, [id]);
  const existing = await findInvoice(inv.invoice_number, 'ACCREC');
  if (existing) return existing;
  const lines = await query(db, 'SELECT * FROM customer_invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [id]);
  const json = await xero('PUT', 'Invoices?SummarizeErrors=true', { Invoices: [{
    Type: 'ACCREC', InvoiceNumber: inv.invoice_number, Reference: inv.po_number || inv.job_ref, Status: 'AUTHORISED', LineAmountTypes: 'Exclusive',
    Date: inv.issue_date, DueDate: inv.due_date, Contact: { Name: inv.customer_name, EmailAddress: inv.billing_email },
    LineItems: lines.map((l) => ({ Description: l.description, Quantity: l.quantity_milli / 1000, UnitAmount: l.amount_ex_gst_cents / 100 / (l.quantity_milli / 1000),
      LineAmount: l.amount_ex_gst_cents / 100, AccountCode: config.xero.salesAccountCode, TaxType: inv.gst_cents > 0 ? 'OUTPUT2' : 'NONE' })),
  }] });
  return json.Invoices[0].InvoiceID;
}

async function syncContractorInvoice(db: Db, id: string): Promise<string> {
  const inv = await one(db, `SELECT ci.*, j.ref AS job_ref FROM contractor_invoices ci JOIN jobs j ON j.id = ci.job_id WHERE ci.id = $1`, [id]);
  const existing = await findInvoice(inv.invoice_number, 'ACCPAY', inv.contractor_legal_name);
  if (existing) return existing;
  const lines = await query(db, 'SELECT * FROM contractor_invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [id]);
  const json = await xero('PUT', 'Invoices?SummarizeErrors=true', { Invoices: [{
    Type: 'ACCPAY', InvoiceNumber: inv.invoice_number, Reference: inv.job_ref, Status: 'AUTHORISED', LineAmountTypes: 'Exclusive',
    Date: inv.invoice_date, DueDate: (await one(db, 'SELECT due_date FROM contractor_payables WHERE contractor_invoice_id = $1', [id])).due_date,
    Contact: { Name: inv.contractor_legal_name },
    LineItems: lines.map((l) => ({ Description: l.description, Quantity: l.quantity_milli / 1000, UnitAmount: l.unit_rate_cents / 100,
      AccountCode: config.xero.costAccountCode, TaxType: inv.gst_registered ? 'INPUT2' : 'NONE' })),
  }] });
  return json.Invoices[0].InvoiceID;
}

async function syncContractorPayment(db: Db, id: string): Promise<string> {
  const pay = await one(db, `SELECT cp.*, p.contractor_invoice_id FROM contractor_payments cp JOIN contractor_payables p ON p.id = cp.payable_id WHERE cp.id = $1`, [id]);
  const bill = await maybeOne(db, `SELECT external_id FROM integration_sync WHERE provider = 'xero' AND entity_type = 'contractor_invoice' AND entity_id = $1 AND status = 'synced'`,
    [pay.contractor_invoice_id]);
  if (!bill?.external_id) throw new Error('Contractor bill has not synced to Xero yet');
  const json = await xero('PUT', 'Payments', { Payments: [{ Invoice: { InvoiceID: bill.external_id }, Account: { Code: config.xero.bankAccountCode },
    Date: pay.paid_date, Amount: pay.amount_cents / 100, Reference: pay.payment_reference }] });
  return json.Payments[0].PaymentID;
}

/** Worker: processes the sync queue with exponential backoff. */
export async function processXeroQueue(db: Db, limit = 20): Promise<{ synced: number; failed: number; skipped: number }> {
  const items = await query(db, `SELECT * FROM integration_sync WHERE provider = 'xero' AND status IN ('pending','failed') AND attempts < 8 AND next_attempt_at <= now()
    ORDER BY created_at LIMIT $1`, [limit]);
  let synced = 0, failed = 0, skipped = 0;
  for (const it of items) {
    if (!xeroConfigured()) {
      await db.query(`UPDATE integration_sync SET status = 'skipped_unconfigured', last_error = 'Xero credentials not configured' WHERE id = $1`, [it.id]);
      skipped++;
      continue;
    }
    try {
      const externalId = it.entity_type === 'customer_invoice' ? await syncCustomerInvoice(db, it.entity_id)
        : it.entity_type === 'contractor_invoice' ? await syncContractorInvoice(db, it.entity_id)
        : await syncContractorPayment(db, it.entity_id);
      await db.query(`UPDATE integration_sync SET status = 'synced', external_id = $2, synced_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [it.id, externalId]);
      synced++;
    } catch (err) {
      await db.query(`UPDATE integration_sync SET status = 'failed', attempts = attempts + 1, last_error = $2,
        next_attempt_at = now() + (power(2, attempts + 1) || ' minutes')::interval WHERE id = $1`, [it.id, String((err as Error).message).slice(0, 500)]);
      failed++;
    }
  }
  return { synced, failed, skipped };
}

/** Re-queues skipped/failed items (e.g. after credentials are added). */
export async function requeueSync(db: Db, id?: string): Promise<void> {
  await db.query(`UPDATE integration_sync SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE status IN ('failed','skipped_unconfigured') AND ($1::uuid IS NULL OR id = $1)`, [id ?? null]);
}
