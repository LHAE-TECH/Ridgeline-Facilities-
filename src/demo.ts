import bcrypt from 'bcryptjs';
import type { Db } from './db.js';
import { maybeOne, one } from './db.js';
import type { Actor } from './lib/actor.js';
import { SYSTEM_ACTOR } from './lib/actor.js';
import { acceptAssessment, runAssessment } from './services/assessment.js';
import { addComplianceDocument, createContractor, reviewComplianceDocument, setContractorTrade, setRateCard } from './services/contractors.js';
import { addFacility, addSite, registerCustomer } from './services/customers.js';
import { recordBankReceipt } from './services/payments.js';

export const DEMO_PASSWORD = 'demo-password-123';

/**
 * Demo data for evaluation and end-to-end tests: one staff user per role, a residential customer with an active
 * prepaid account, and an approved general-maintenance contractor. Never run against production.
 */
export async function seedDemo(db: Db) {
  await assertDemoSeedAllowed(db);
  const existing = await maybeOne(db, `SELECT id FROM users WHERE email = 'ops@demo.ridgeline.test'`);
  if (existing) return demoLogins();
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const staffIds: Record<string, string> = {};
  for (const role of ['admin', 'ops', 'finance']) {
    const u = await one(db, `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id`,
      [`${role}@demo.ridgeline.test`, hash, `Demo ${role}`, role]);
    staffIds[role] = u.id;
  }
  const admin: Actor = { id: staffIds.admin, role: 'admin', name: 'Demo admin' };
  // Demo-only GST number so invoices can be issued in the demo; Ridgeline enters the real one in Settings.
  const { SETTING_DEFAULTS } = await import('./services/settings.js');
  await db.query(`INSERT INTO settings (key, value) VALUES ('company', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ ...SETTING_DEFAULTS.company, gst_number: '000-000-000' })]);
  const finance: Actor = { id: staffIds.finance, role: 'finance', name: 'Demo finance' };

  const { customer, user } = await registerCustomer(db, SYSTEM_ACTOR, {
    organisationName: 'Harbourside Property Management', billingEmail: 'accounts@harbourside.demo', customerCategory: 'residential',
    contactName: 'Hana Harbourside', contactEmail: 'customer@demo.ridgeline.test', password: DEMO_PASSWORD, phone: '09 555 0100', billingAddress: '12 Quay Street, Auckland',
  });
  const owner: Actor = { id: user.id, role: 'customer', name: 'Hana', customerId: customer.id, customerRole: 'owner' };
  const site = await addSite(db, owner, customer.id, { name: 'Harbour View Apartments', address: '88 Customs Street', city: 'Auckland', region: 'Auckland',
    lat: -36.8441, lng: 174.7652, accessNotes: 'Key safe at concierge desk, code from building manager' });
  await addFacility(db, owner, customer.id, { siteId: site.id, facilityTypeId: (await one(db, `SELECT id FROM facility_types WHERE code = 'res_studio_1bed'`)).id,
    name: 'Tower A – one-bedroom units', unitCount: 24, unitLabels: ['A101', 'A102', 'A103', 'A201', 'A202'] });
  await addFacility(db, owner, customer.id, { siteId: site.id, facilityTypeId: (await one(db, `SELECT id FROM facility_types WHERE code = 'res_2bed_plus'`)).id,
    name: 'Tower B – two/three-bedroom units', unitCount: 16 });
  const { id } = await runAssessment(db, admin, customer.id);
  const cust = await acceptAssessment(db, admin, id);
  await recordBankReceipt(db, finance, { customerId: customer.id, amountCents: cust.agreed_minimum_balance_cents + 100000,
    receivedDate: new Date().toISOString().slice(0, 10), bankReference: 'DEMO DEPOSIT', idempotencyKey: 'demo-deposit' });

  const contractor = await createContractor(db, admin, {
    legalName: 'Kiwi Fix-It Services Limited', tradingName: 'Kiwi Fix-It', email: 'contractor@demo.ridgeline.test', phone: '09 555 0199', mobilePhone: '021 555 0199', gstRegistered: true,
    gstNumber: '123-456-789', bankAccountName: 'Kiwi Fix-It Services', bankAccountNumber: '12-3456-7890123-00', serviceRegions: ['Auckland'],
    afterHoursAvailable: true, emergencyAvailable: true, contactName: 'Kiri Fixit', password: DEMO_PASSWORD, independentContractorAck: true,
  });
  for (const code of ['general', 'plumbing']) {
    const tid = (await one(db, 'SELECT id FROM trades WHERE code = $1', [code])).id;
    await setContractorTrade(db, admin, contractor.id, tid, { verified: true, qualification: code === 'plumbing' ? 'PGDB 12345' : 'Experienced' });
    await setRateCard(db, admin, contractor.id, { tradeId: tid, labourRateCents: 8000, calloutCents: 10000, emergencyCalloutCents: 15000,
      travelPerKmCents: 120, minChargeCents: 10000, cancellationFeeCents: 8000 });
  }
  for (const docType of ['public_liability', 'pgdb_licence']) {
    const d = await addComplianceDocument(db, admin, contractor.id, { docType, reference: 'DEMO-001', expiresAt: '2030-06-30' });
    await reviewComplianceDocument(db, admin, d.id, 'verified');
  }
  await db.query(`UPDATE contractors SET status = 'approved' WHERE id = $1`, [contractor.id]);
  return demoLogins();
}

export const DEMO_EMAIL_DOMAIN = '@demo.ridgeline.test';

/**
 * Demo data must never reach a real database. Refuses when:
 *  - NODE_ENV is production;
 *  - the database has been marked as production (a production server marks it on start-up);
 *  - the database contains any user or customer that is not demo data.
 */
export async function assertDemoSeedAllowed(db: Db): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to load demo data: NODE_ENV=production');
  const marker = await maybeOne(db, `SELECT value FROM settings WHERE key = 'deployment_environment'`);
  if (marker?.value === 'production') throw new Error('Refusing to load demo data: this database is marked as a production database');
  const real = await maybeOne(db,
    `SELECT (SELECT COUNT(*) FROM users WHERE email NOT LIKE '%' || $1)::int + (SELECT COUNT(*) FROM customers WHERE billing_email NOT LIKE '%.demo' AND billing_email NOT LIKE '%' || $1)::int AS n`,
    [DEMO_EMAIL_DOMAIN]);
  if (real && real.n > 0) throw new Error(`Refusing to load demo data: the database already contains ${real.n} non-demo user/customer record(s)`);
}

/** Called by the production server on start-up so demo seeding is permanently refused for this database. */
export async function markProductionDatabase(db: Db): Promise<void> {
  await db.query(`INSERT INTO settings (key, value, description) VALUES ('deployment_environment', '"production"', 'Set automatically by a production server; blocks demo data')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}

export function demoLogins() {
  return {
    password: DEMO_PASSWORD,
    admin: 'admin@demo.ridgeline.test', ops: 'ops@demo.ridgeline.test', finance: 'finance@demo.ridgeline.test',
    customer: 'customer@demo.ridgeline.test', contractor: 'contractor@demo.ridgeline.test',
  };
}
