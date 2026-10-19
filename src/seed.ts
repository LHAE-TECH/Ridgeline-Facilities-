import bcrypt from 'bcryptjs';
import type { Db } from './db.js';
import { maybeOne } from './db.js';

/**
 * Reference data required for the system to operate. Idempotent: existing rows are left untouched so
 * administrator edits are never overwritten.
 *
 * IMPORTANT: facility-type cost assumptions and pricing rules below are INITIAL STARTING POINTS for
 * Ridgeline to review in Admin → Settings. They are not quotes or fixed prices.
 */

export const LEDGER_ACCOUNTS: [string, string, string][] = [
  ['BANK', 'Bank account', 'asset'],
  ['STRIPE_CLEARING', 'Card payments clearing (Stripe)', 'asset'],
  ['ACCOUNTS_RECEIVABLE', 'Customer receivables', 'asset'],
  ['GST_INPUT', 'GST paid on contractor costs', 'asset'],
  ['CUSTOMER_PREPAID', 'Customer prepaid maintenance balances (liability)', 'liability'],
  ['CONTRACTOR_PAYABLE', 'Contractor payables', 'liability'],
  ['GST_OUTPUT', 'GST collected on customer invoices', 'liability'],
  ['MAINTENANCE_REVENUE', 'Maintenance revenue', 'income'],
  ['CONTRACTOR_COSTS', 'Contractor costs (cost of sales)', 'expense'],
];

export const TRADES: { code: string; name: string; specialist?: boolean; docs?: string[]; hours?: number; before?: boolean }[] = [
  { code: 'general', name: 'General maintenance / handyman', hours: 1.5 },
  { code: 'plumbing', name: 'Plumbing & drainage', docs: ['pgdb_licence'], hours: 1.5 },
  { code: 'electrical', name: 'Electrical', docs: ['ewrb_licence'], hours: 1.5 },
  { code: 'hvac', name: 'Heating, ventilation & air conditioning', specialist: true, hours: 2 },
  { code: 'roofing', name: 'Roofing & gutters', docs: ['working_at_height'], hours: 2 },
  { code: 'locksmith', name: 'Locksmith & security', hours: 1 },
  { code: 'painting', name: 'Painting & decorating', hours: 3 },
  { code: 'carpentry', name: 'Carpentry & joinery', hours: 2 },
  { code: 'glazing', name: 'Glazing', hours: 1.5 },
  { code: 'cleaning', name: 'Cleaning & rubbish removal', hours: 2, before: true },
  { code: 'grounds', name: 'Grounds & gardening', hours: 2 },
  { code: 'appliance', name: 'Appliance repair', hours: 1 },
  { code: 'fire_safety', name: 'Fire safety & compliance (specialist)', specialist: true, docs: ['fire_protection_cert'], hours: 1.5 },
  { code: 'lift', name: 'Lift / elevator (specialist)', specialist: true, hours: 2 },
];

// [code, name, category, unit_label, jobs/unit/month, avg contractor cost ($), callout share %, avg callout ($), emergency share %, emergency multiplier, planned $/unit/month, custom]
export const FACILITY_TYPES: [string, string, string, string, number, number, number, number, number, number, number, boolean][] = [
  ['res_studio_1bed', 'Studio / one-bedroom residential unit', 'residential', 'unit', 0.08, 220, 100, 85, 10, 1.6, 0, false],
  ['res_2bed_plus', 'Two-bedroom, three-bedroom or larger residential unit', 'residential', 'unit', 0.11, 250, 100, 85, 10, 1.6, 0, false],
  ['apartment_building', 'Apartment building / multi-unit complex (building services)', 'residential', 'building', 2.0, 320, 100, 85, 15, 1.6, 0, false],
  ['body_corporate_common', 'Body corporate common areas', 'body_corporate', 'complex', 1.5, 300, 100, 85, 12, 1.6, 0, false],
  ['office_small', 'Small commercial office (under 250 m²)', 'commercial', 'office', 0.6, 280, 100, 85, 10, 1.6, 0, false],
  ['office_medium', 'Medium commercial office (250–1,000 m²)', 'commercial', 'office', 1.2, 320, 100, 85, 10, 1.6, 0, false],
  ['office_large', 'Large commercial office (over 1,000 m²)', 'commercial', 'office', 2.5, 380, 100, 85, 12, 1.6, 0, false],
  ['retail', 'Retail premises', 'retail', 'premises', 0.8, 300, 100, 85, 12, 1.6, 0, false],
  ['warehouse_industrial', 'Warehouse / industrial facility', 'industrial', 'facility', 1.5, 400, 100, 95, 15, 1.6, 0, false],
  ['custom', 'Custom facility type (set assumptions per account)', 'custom', 'unit', 0.5, 300, 100, 85, 10, 1.6, 0, true],
];

// [category, service_level, factor (x), description]
export const COVERAGE_FACTORS: [string, string, number, string][] = [
  ['residential', 'standard', 3.0, 'Three months of estimated spend'],
  ['residential', 'priority', 4.0, 'Four months, priority response agreements'],
  ['commercial', 'standard', 2.0, 'Two months of estimated spend'],
  ['commercial', 'priority', 3.0, 'Three months, priority response agreements'],
  ['body_corporate', 'standard', 3.0, 'Three months of estimated spend'],
  ['body_corporate', 'priority', 4.0, 'Four months, priority response agreements'],
  ['retail', 'standard', 2.0, 'Two months of estimated spend'],
  ['retail', 'priority', 3.0, 'Three months, priority response agreements'],
  ['industrial', 'standard', 2.0, 'Two months of estimated spend'],
  ['industrial', 'priority', 3.0, 'Three months, priority response agreements'],
  ['mixed', 'standard', 2.5, 'Two and a half months of estimated spend'],
  ['mixed', 'priority', 3.5, 'Three and a half months, priority response agreements'],
  ['custom', 'standard', 3.0, 'Default for custom arrangements'],
  ['custom', 'priority', 4.0, 'Default for custom priority arrangements'],
];

// Default customer pricing: 35% markup on approved contractor cost for every category, plus a minimum job charge.
// reference_contractor_rate is the typical contractor cost used only for pre-booking estimates.
export const DEFAULT_PRICING_RULES: { category: string; method: string; markup?: number; minimum?: number; ref?: number; unit: string; description: string }[] = [
  { category: 'standard_labour', method: 'markup', markup: 3500, ref: 8500, unit: 'hour', description: 'Standard labour: approved contractor cost + 35%' },
  { category: 'standard_callout', method: 'markup', markup: 3500, ref: 8500, unit: 'each', description: 'Standard callout: contractor callout + 35%' },
  { category: 'emergency_callout', method: 'markup', markup: 3500, ref: 15000, unit: 'each', description: 'Emergency callout: contractor emergency callout + 35%' },
  { category: 'after_hours', method: 'markup', markup: 3500, ref: 12750, unit: 'hour', description: 'Weekday after-hours labour: contractor after-hours cost + 35%' },
  { category: 'weekend', method: 'markup', markup: 3500, ref: 12750, unit: 'hour', description: 'Weekend labour: contractor weekend cost + 35%' },
  { category: 'public_holiday', method: 'markup', markup: 3500, ref: 17000, unit: 'hour', description: 'Public holiday labour: contractor holiday cost + 35%' },
  { category: 'overnight', method: 'markup', markup: 3500, ref: 17000, unit: 'hour', description: 'Overnight (22:00–06:00) labour: contractor overnight cost + 35%' },
  { category: 'travel', method: 'markup', markup: 3500, ref: 120, unit: 'km', description: 'Travel and mileage: contractor charge + 35%' },
  { category: 'materials', method: 'markup', markup: 3500, unit: 'each', description: 'Materials and parts: contractor cost + 35%' },
  { category: 'specialist', method: 'markup', markup: 3500, ref: 11000, unit: 'hour', description: 'Specialist trades: contractor cost + 35%' },
  { category: 'minimum_charge', method: 'minimum', minimum: 13500, unit: 'job', description: 'Minimum customer charge per attended job (ex GST)' },
  { category: 'variation', method: 'markup', markup: 3500, unit: 'each', description: 'Approved variations: contractor cost + 35%' },
  { category: 'cancellation', method: 'markup', markup: 3500, unit: 'each', description: 'Cancellation / failed attendance (where contractually permitted): contractor charge + 35%' },
];

// New Zealand national public holidays (Mondayised where applicable). Add regional anniversary days in Admin → Settings.
export const NZ_HOLIDAYS: [string, string][] = [
  ['2026-01-01', "New Year's Day"], ['2026-01-02', "Day after New Year's Day"], ['2026-02-06', 'Waitangi Day'],
  ['2026-04-03', 'Good Friday'], ['2026-04-06', 'Easter Monday'], ['2026-04-27', 'ANZAC Day (observed)'],
  ['2026-06-01', "King's Birthday"], ['2026-07-10', 'Matariki'], ['2026-10-26', 'Labour Day'],
  ['2026-12-25', 'Christmas Day'], ['2026-12-28', 'Boxing Day (observed)'],
  ['2027-01-01', "New Year's Day"], ['2027-01-04', "Day after New Year's Day (observed)"], ['2027-02-08', 'Waitangi Day (observed)'],
  ['2027-03-26', 'Good Friday'], ['2027-03-29', 'Easter Monday'], ['2027-04-26', 'ANZAC Day (observed)'],
  ['2027-06-07', "King's Birthday"], ['2027-06-25', 'Matariki'], ['2027-10-25', 'Labour Day'],
  ['2027-12-27', 'Christmas Day (observed)'], ['2027-12-28', 'Boxing Day (observed)'],
];

export async function seedReferenceData(db: Db): Promise<void> {
  for (const [code, name, type] of LEDGER_ACCOUNTS) {
    await db.query('INSERT INTO ledger_accounts (code, name, type) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING', [code, name, type]);
  }
  for (const t of TRADES) {
    await db.query(
      `INSERT INTO trades (code, name, is_specialist, required_documents, default_estimate_hours, before_photo_required)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
      [t.code, t.name, t.specialist ?? false, t.docs ?? [], t.hours ?? 1.5, t.before ?? true],
    );
  }
  for (const f of FACILITY_TYPES) {
    const [code, name, category, unitLabel, jobs, avgCost, calloutShare, avgCallout, emShare, emMult, planned, custom] = f;
    await db.query(
      `INSERT INTO facility_types (code, name, category, unit_label, jobs_per_unit_per_month, avg_contractor_cost_cents,
         callout_share_bps, avg_callout_cost_cents, emergency_share_bps, emergency_cost_multiplier_bps, planned_monthly_cost_per_unit_cents, is_custom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (code) DO NOTHING`,
      [code, name, category, unitLabel, jobs, avgCost * 100, calloutShare * 100, avgCallout * 100, emShare * 100, Math.round(emMult * 10000), planned * 100, custom],
    );
  }
  for (const [cat, level, factor, desc] of COVERAGE_FACTORS) {
    await db.query(
      `INSERT INTO coverage_factors (customer_category, service_level, factor_bps, description) VALUES ($1,$2,$3,$4)
       ON CONFLICT (customer_category, service_level) DO NOTHING`,
      [cat, level, Math.round(factor * 10000), desc],
    );
  }
  const anyRule = await maybeOne(db, 'SELECT 1 FROM pricing_rules LIMIT 1');
  if (!anyRule) {
    for (const r of DEFAULT_PRICING_RULES) {
      await db.query(
        `INSERT INTO pricing_rules (category, method, markup_bps, minimum_cents, reference_contractor_rate_cents, unit, description, status, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'approved', now())`,
        [r.category, r.method, r.markup ?? null, r.minimum ?? null, r.ref ?? null, r.unit, r.description],
      );
    }
  }
  for (const [date, name] of NZ_HOLIDAYS) {
    await db.query(`INSERT INTO public_holidays (holiday_date, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [date, name]);
  }
}

export async function seedAdmin(db: Db, email: string, password: string, name: string): Promise<boolean> {
  const existing = await maybeOne(db, `SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (existing) return false;
  if (!email || !password || password.length < 12) {
    throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 12 characters) to create the first administrator');
  }
  const hash = await bcrypt.hash(password, 12);
  await db.query(`INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,'admin')`, [email, hash, name]);
  return true;
}
