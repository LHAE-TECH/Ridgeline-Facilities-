import type { Db } from '../db.js';
import { query } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { audit } from './audit.js';

/**
 * Operational settings with defaults. Stored values in the `settings` table override these.
 * Money in cents, percentages/multipliers in basis points.
 */
export const SETTING_DEFAULTS = {
  company: {
    name: 'Ridgeline Facilities',
    legal_name: 'Ridgeline Facilities Limited',
    gst_number: '',
    nzbn: '',
    address: '',
    email: 'accounts@ridgelinefacilities.com',
    phone: '',
    website: 'ridgelinefacilities.com',
    bank_account_name: 'Ridgeline Facilities Limited',
    bank_account_number: '',
  },
  gst_rate_bps: 1500,
  ridgeline_gst_registered: true,
  timezone: 'Pacific/Auckland',
  // Assessment engine
  min_balance_floor_cents: 100000,
  standard_max_balance_cents: 1500000,
  balance_rounding_cents: 5000,
  assessment_markup_bps: 3500,
  emergency_cover_factor_bps: { none: 0, business_hours: 10000, '24x7': 15000 } as Record<string, number>,
  // Booking eligibility
  booking_requires_minimum_balance: true,
  allow_emergency_below_minimum: true,
  low_balance_alert_bps: 10000,
  low_balance_reminder_days: 3,
  // Time windows
  business_hours: { start: '07:00', end: '17:00', days: [1, 2, 3, 4, 5] },
  overnight_hours: { start: '22:00', end: '06:00' },
  time_window_precedence: ['public_holiday', 'overnight', 'weekend', 'after_hours'],
  // Dispatch & SLA (minutes / hours)
  auto_dispatch: true,
  offer_expiry_minutes: { routine: 240, urgent: 60, emergency: 15 } as Record<string, number>,
  sla_hours: {
    routine: { respond: 24, attend: 72 },
    urgent: { respond: 4, attend: 24 },
    emergency: { respond: 1, attend: 4 },
  } as Record<string, { respond: number; attend: number }>,
  always_required_documents: ['public_liability'],
  late_cancellation_hours: 2,
  // Evidence
  min_after_photos: 1,
  labour_tolerance_bps: 1000,
  site_distance_flag_km: 2,
  // Invoicing
  authorised_overrun_bps: 2000,
  materials_receipt_threshold_cents: 5000,
  require_contractor_invoice_document: false,
  auto_issue_customer_invoices: false,
  require_separate_payment_approver: false,
  close_requires_contractor_paid: true,
  close_requires_customer_settled: true,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
type Widen<T> = T extends readonly (infer U)[] ? Widen<U>[] : T extends string ? string : T extends number ? number : T extends boolean ? boolean : T extends object ? { [K in keyof T]: Widen<T[K]> } : T;
export type Settings = { [K in SettingKey]: Widen<(typeof SETTING_DEFAULTS)[K]> };

export const SETTING_DESCRIPTIONS: Partial<Record<SettingKey, string>> = {
  company: 'Company details printed on invoices and statements',
  gst_rate_bps: 'GST rate in basis points (1500 = 15%)',
  ridgeline_gst_registered: 'Whether Ridgeline charges GST on customer invoices',
  min_balance_floor_cents: 'Lowest minimum prepaid balance for any account (cents)',
  standard_max_balance_cents: 'Above this, the account is flagged for an authorised custom arrangement (cents)',
  balance_rounding_cents: 'Recommended balances are rounded up to this increment (cents)',
  assessment_markup_bps: 'Markup applied to estimated contractor spend in assessments (bps)',
  emergency_cover_factor_bps: 'Multiplier on the emergency job share for each emergency cover level (bps)',
  booking_requires_minimum_balance: 'Block routine/urgent bookings while the balance is below the agreed minimum',
  allow_emergency_below_minimum: 'Allow emergency jobs to be dispatched when funds are short (flagged for follow-up)',
  low_balance_alert_bps: 'Alert when balance falls below this share of the agreed minimum (10000 = 100%)',
  auto_dispatch: 'Automatically offer confirmed jobs to all eligible contractors',
  offer_expiry_minutes: 'Minutes before an unanswered job offer expires, by priority',
  sla_hours: 'Respond and attend targets in hours, by priority',
  labour_tolerance_bps: 'Labour may exceed recorded on-site time by this share before being flagged (bps)',
  authorised_overrun_bps: 'Contractor invoices may exceed the estimate by this share before being flagged (bps)',
  materials_receipt_threshold_cents: 'Materials lines above this amount need a receipt uploaded (cents)',
  require_contractor_invoice_document: 'Require an uploaded supplier invoice document before payment approval',
  auto_issue_customer_invoices: 'Issue customer invoices automatically when the contractor invoice is approved',
  require_separate_payment_approver: 'Payment approver must differ from the contractor invoice approver',
};

export async function getSettings(db: Db): Promise<Settings> {
  const rows = await query<{ key: string; value: unknown }>(db, 'SELECT key, value FROM settings');
  const result: Record<string, unknown> = structuredClone(SETTING_DEFAULTS) as Record<string, unknown>;
  for (const r of rows) {
    if (r.key in result) result[r.key] = r.value;
  }
  return result as Settings;
}

export async function updateSetting(db: Db, actor: Actor, key: SettingKey, value: unknown): Promise<void> {
  const before = (await getSettings(db))[key];
  await db.query(
    `INSERT INTO settings (key, value, description, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), SETTING_DESCRIPTIONS[key] ?? null, actor.id],
  );
  await audit(db, actor, { action: 'setting.updated', entityType: 'setting', entityId: key, details: { before, after: value } });
}
