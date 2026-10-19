import bcrypt from 'bcryptjs';
import { pool, one, query } from '../src/db.js';
import type { Actor } from '../src/lib/actor.js';
import { SYSTEM_ACTOR } from '../src/lib/actor.js';
import { acceptAssessment, runAssessment } from '../src/services/assessment.js';
import { addComplianceDocument, createContractor, reviewComplianceDocument, setContractorTrade, setRateCard } from '../src/services/contractors.js';
import { addFacility, addSite, registerCustomer } from '../src/services/customers.js';
import { acceptOffer } from '../src/services/dispatch.js';
import { addEvidence, completeJob, recordArrival, reviewEvidence, startWork } from '../src/services/evidence.js';
import { type BookingInput, createBooking } from '../src/services/jobs.js';
import { recordBankReceipt } from '../src/services/payments.js';
import { setEmailTransport } from '../src/services/notifications.js';
import { setSmsTransport } from '../src/services/sms.js';
import { SETTING_DEFAULTS } from '../src/services/settings.js';
import { NZ_HOLIDAYS, seedReferenceData } from '../src/seed.js';

export const db = pool;

const TRANSACTIONAL_TABLES = [
  'audit_log', 'notifications', 'integration_sync', 'webhook_events', 'idempotency_keys', 'contractor_payments', 'payment_batches',
  'payable_adjustments', 'contractor_payables', 'credit_notes', 'disputes', 'customer_invoice_lines', 'customer_invoices',
  'contractor_invoice_lines', 'contractor_invoices', 'refunds', 'auto_topup_consents', 'customer_payments', 'job_commitments',
  'prepaid_transactions', 'journal_lines', 'journal_entries', 'quotes', 'completion_reports', 'job_evidence', 'job_assignments',
  'job_offers', 'job_events', 'funding_exceptions', 'jobs', 'account_assessments', 'contractor_rate_cards', 'compliance_documents',
  'contractor_trades', 'files', 'units', 'facilities', 'sites', 'user_sessions', 'users', 'contractors', 'customers', 'settings', 'pricing_rules',
];

/** Clears all business data between tests, keeping reference data (trades, facility types, rules, holidays). */
export async function resetDb(): Promise<void> {
  await db.query(`TRUNCATE ${TRANSACTIONAL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  // CASCADE also empties pricing_rules (FK to users); restore the default reference data.
  await seedReferenceData(db);
  // Tax invoices require the entity's GST number (blank by default until Ridgeline enters it).
  await db.query(`INSERT INTO settings (key, value) VALUES ('company', $1)`, [JSON.stringify({ ...SETTING_DEFAULTS.company, gst_number: '123-456-789' })]);
  setEmailTransport(undefined);
  setSmsTransport(undefined);
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function staff(role: 'admin' | 'ops' | 'finance' = 'admin'): Promise<Actor> {
  const email = `${role}-${uniq()}@ridgeline.test`;
  const u = await one(db, `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id`,
    [email, await bcrypt.hash('correct-horse-battery', 4), `${role} user`, role]);
  return { id: u.id, role, name: `${role} user`, email };
}

export async function tradeId(code: string): Promise<number> {
  return (await one(db, 'SELECT id FROM trades WHERE code = $1', [code])).id;
}

export async function facilityTypeId(code: string): Promise<number> {
  return (await one(db, 'SELECT id FROM facility_types WHERE code = $1', [code])).id;
}

export interface CustomerFixture { customerId: string; owner: Actor; siteId: string }

/** Registers a customer with one site and the given facilities (no assessment yet). */
export async function newCustomer(opts: { category?: string; facilities?: { type: string; units: number }[]; region?: string; suburb?: string; siteLat?: number; siteLng?: number } = {}): Promise<CustomerFixture> {
  const email = `owner-${uniq()}@customer.test`;
  const { customer, user } = await registerCustomer(db, SYSTEM_ACTOR, {
    organisationName: `Customer ${uniq()}`, billingEmail: email, customerCategory: opts.category ?? 'residential',
    contactName: 'Olivia Owner', contactEmail: email, password: 'correct-horse-battery',
  });
  const owner: Actor = { id: user.id, role: 'customer', name: 'Olivia Owner', email, customerId: customer.id, customerRole: 'owner' };
  const site = await addSite(db, owner, customer.id, { name: 'Main site', address: '1 Queen Street', suburb: opts.suburb ?? 'Auckland Central', city: 'Auckland', region: opts.region ?? 'Auckland',
    lat: opts.siteLat ?? null, lng: opts.siteLng ?? null });
  for (const f of opts.facilities ?? [{ type: 'res_studio_1bed', units: 10 }]) {
    await addFacility(db, owner, customer.id, { siteId: site.id, facilityTypeId: await facilityTypeId(f.type), name: `${f.units} x ${f.type}`, unitCount: f.units });
  }
  return { customerId: customer.id, owner, siteId: site.id };
}

/** Customer with an agreed minimum and a confirmed deposit, ready to book. */
export async function activeCustomer(opts: { deposit?: number; facilities?: { type: string; units: number }[]; region?: string; suburb?: string } = {}): Promise<CustomerFixture & { admin: Actor; finance: Actor }> {
  const fx = await newCustomer(opts);
  const admin = await staff('admin');
  const finance = await staff('finance');
  const { id } = await runAssessment(db, admin, fx.customerId);
  await acceptAssessment(db, admin, id);
  const cust = await one(db, 'SELECT agreed_minimum_balance_cents FROM customers WHERE id = $1', [fx.customerId]);
  await recordBankReceipt(db, finance, { customerId: fx.customerId, amountCents: opts.deposit ?? cust.agreed_minimum_balance_cents + 200000,
    receivedDate: today(), bankReference: `DEP-${uniq()}`, idempotencyKey: `dep-${uniq()}` });
  return { ...fx, admin, finance };
}

export interface ContractorFixture { contractorId: string; actor: Actor }

/** Approved, compliant contractor with a verified trade and agreed rate card. */
export async function approvedContractor(opts: { trade?: string; regions?: string[]; gstRegistered?: boolean; labourRate?: number; callout?: number;
  emergencyCallout?: number; emergency?: boolean; afterHours?: boolean; mobile?: string | null; lat?: number; lng?: number } = {}): Promise<ContractorFixture> {
  const admin = await staff('admin');
  const email = `contractor-${uniq()}@trade.test`;
  const gst = opts.gstRegistered ?? true;
  const c = await createContractor(db, admin, {
    legalName: `Trade Co ${uniq()} Ltd`, email, mobilePhone: opts.mobile === undefined ? '021 555 0100' : opts.mobile ?? undefined, gstRegistered: gst, gstNumber: gst ? '123-456-789' : undefined, serviceRegions: opts.regions ?? ['Auckland'],
    contactName: 'Tom Trades', password: 'correct-horse-battery', bankAccountNumber: '12-3456-7890123-00', bankAccountName: 'Trade Co',
    emergencyAvailable: opts.emergency ?? true, afterHoursAvailable: opts.afterHours ?? true,
  });
  const tid = await tradeId(opts.trade ?? 'general');
  await setContractorTrade(db, admin, c.id, tid, { verified: true, qualification: 'Verified' });
  const required = (await one(db, 'SELECT required_documents FROM trades WHERE id = $1', [tid])).required_documents as string[];
  for (const docType of ['public_liability', ...required]) {
    const d = await addComplianceDocument(db, admin, c.id, { docType, reference: 'POL-1', expiresAt: '2030-01-01' });
    await reviewComplianceDocument(db, admin, d.id, 'verified');
  }
  await setRateCard(db, admin, c.id, { tradeId: tid, labourRateCents: opts.labourRate ?? 8000, calloutCents: opts.callout ?? 10000,
    emergencyCalloutCents: opts.emergencyCallout ?? 15000, travelPerKmCents: 120, minChargeCents: 10000, cancellationFeeCents: 8000 });
  await db.query(`UPDATE contractors SET status = 'approved', base_lat = $2, base_lng = $3 WHERE id = $1`, [c.id, opts.lat ?? null, opts.lng ?? null]);
  const user = await one(db, 'SELECT id FROM users WHERE contractor_id = $1', [c.id]);
  return { contractorId: c.id, actor: { id: user.id, role: 'contractor', name: 'Tom Trades', email, contractorId: c.id } };
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A weekday at 10:00 NZ time in the future that is not a public holiday (standard hours). */
export function standardHoursSlot(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  const holidays = new Set(NZ_HOLIDAYS.map(([date]) => date));
  while ([0, 6].includes(d.getUTCDay()) || holidays.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() + 1);
  const ymd = d.toISOString().slice(0, 10);
  // 10:00 NZDT (09:00 NZST in winter): standard hours either way.
  return new Date(`${ymd}T10:00:00+13:00`).toISOString();
}

export async function book(fx: CustomerFixture, overrides: Partial<BookingInput> = {}) {
  return createBooking(db, fx.owner, {
    customerId: fx.customerId, siteId: fx.siteId, tradeId: await tradeId('general'), priority: 'standard',
    title: 'Leaking tap', description: 'Kitchen tap leaking', preferredStart: standardHoursSlot(), ...overrides,
  });
}

export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
export const photo = (name = 'photo.png') => ({ buffer: PNG, originalName: name, mimeType: 'image/png' });

/** Drives a dispatched job through acceptance, attendance, evidence and approval. */
export async function completeAndApprove(jobId: string, contractor: ContractorFixture, opts: { labourMinutes?: number; approve?: boolean } = {}) {
  const offer = await one(db, `SELECT id FROM job_offers WHERE job_id = $1 AND contractor_id = $2 AND status = 'offered'`, [jobId, contractor.contractorId]);
  await acceptOffer(db, contractor.actor, offer.id);
  await recordArrival(db, contractor.actor, jobId, { lat: -36.85, lng: 174.76 });
  await addEvidence(db, contractor.actor, jobId, 'before_photo', [photo('before.png')]);
  await startWork(db, contractor.actor, jobId);
  await addEvidence(db, contractor.actor, jobId, 'after_photo', [photo('after.png')]);
  // Arrival happened moments ago; backdate it so the reported labour fits the on-site time.
  await db.query(`UPDATE jobs SET arrived_at = now() - interval '3 hours', started_at = now() - interval '170 minutes' WHERE id = $1`, [jobId]);
  await completeJob(db, contractor.actor, jobId, { workPerformed: 'Replaced tap washer', labourMinutes: opts.labourMinutes ?? 150,
    materials: [{ description: 'Tap washer', quantity: '1', unitCostCents: 2000 }] });
  if (opts.approve !== false) await reviewEvidence(db, await staff('ops'), jobId, 'approve');
}

export async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await query(db, sql, params))[0]?.n ?? 0);
}

/** Extracts the visible text of an uncompressed pdfkit PDF (hex-encoded TJ strings). */
export function pdfText(buf: Buffer): string {
  const src = buf.toString('latin1');
  let out = '';
  for (const block of src.match(/\[([^\]]*)\]\s*TJ/g) ?? []) {
    for (const hex of block.match(/<([0-9a-fA-F]+)>/g) ?? []) out += Buffer.from(hex.slice(1, -1), 'hex').toString('latin1');
    out += ' ';
  }
  return out.replace(/\s+/g, ' ');
}
