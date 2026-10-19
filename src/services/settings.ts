import type { Db } from '../db.js';
import { query } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { AppError } from '../lib/errors.js';
import { audit } from './audit.js';

/**
 * Operational settings with defaults. Stored values in the `settings` table override these.
 * Money in cents, percentages/multipliers in basis points.
 */
export const SETTING_DEFAULTS = {
  // The contracting entity. "Ridgeline Facilities" is a trading name of LHA Holdings Limited.
  company: {
    name: 'Ridgeline Facilities',
    trading_name: 'Ridgeline Facilities',
    legal_name: 'LHA Holdings Limited',
    gst_number: '',
    nzbn: '9429052390173',
    address: '',
    email: 'accounts@ridgelinefacilities.com',
    phone: '',
    website: 'ridgelinefacilities.com',
    bank_account_name: 'LHA Holdings Limited',
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
  // Portfolio scale taper: marginal share of monthly spend that needs prepaid coverage, by spend band (incl GST).
  // Larger portfolios have smoother, more predictable spend, so each extra dollar needs less coverage.
  assessment_scale_bands: [
    { up_to_cents: 100000, coverage_bps: 10000 },
    { up_to_cents: 300000, coverage_bps: 8500 },
    { up_to_cents: 600000, coverage_bps: 7000 },
    { up_to_cents: null, coverage_bps: 6000 },
  ] as { up_to_cents: number | null; coverage_bps: number }[],
  // Booking eligibility
  booking_requires_minimum_balance: true,
  low_balance_alert_bps: 10000,
  low_balance_reminder_days: 3,
  // Time windows
  business_hours: { start: '07:00', end: '17:00', days: [1, 2, 3, 4, 5] },
  overnight_hours: { start: '22:00', end: '06:00' },
  time_window_precedence: ['public_holiday', 'overnight', 'weekend', 'after_hours'],
  // Dispatch & SLA (minutes / hours)
  auto_dispatch: true,
  offer_expiry_minutes: { emergency: 10, urgent: 60, standard: 240, scheduled: 720 } as Record<string, number>,
  // Published SLA priority matrix (P1–P4). Business hours/days use sla_business_hours and exclude NZ public holidays.
  sla_p1_onsite_hours: 2,
  sla_p1_made_safe_hours: 4,
  sla_p1_non_metro_onsite_hours: 4,
  sla_p1_non_metro_made_safe_hours: 8,
  sla_p2_onsite_business_hours: 8,
  sla_p2_resolve_business_days: 2,
  sla_p3_onsite_business_hours: 48,
  sla_p3_resolve_business_days: 10,
  sla_business_hours: { start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5] },
  sla_at_risk_bps: 7500,
  // Auckland SLA areas. A site's area comes from its suburb (edit these lists to move edge suburbs; no deploy needed).
  // Metro areas get the P1 metro target; non-metro areas get the non-metro P1 target. Staff can override per site.
  sla_areas: [
    { name: 'Auckland Central', metro: true, suburbs: ['Auckland Central', 'Auckland CBD', 'City Centre', 'Ponsonby', 'Grey Lynn', 'Herne Bay', 'Freemans Bay', "St Mary's Bay", 'St Marys Bay',
      'Parnell', 'Newmarket', 'Grafton', 'Eden Terrace', 'Newton', 'Arch Hill', 'Kingsland', 'Mount Eden', 'Epsom', 'Remuera', 'Mount Albert', 'Sandringham', 'Westmere',
      'Western Springs', 'Point Chevalier', 'Morningside', 'Balmoral', 'Three Kings', 'Mount Roskill', 'Ellerslie', 'Greenlane', 'One Tree Hill', 'Royal Oak', 'Onehunga',
      'Penrose', 'Mount Wellington', 'Meadowbank', 'St Johns', 'Orakei', 'Mission Bay', 'Kohimarama', 'St Heliers', 'Glendowie', 'Panmure', 'Glen Innes', 'Point England'] },
    { name: 'North Shore', metro: true, suburbs: ['North Shore', 'Takapuna', 'Devonport', 'Bayswater', 'Belmont', 'Hauraki', 'Milford', 'Castor Bay', 'Forrest Hill', 'Sunnynook',
      'Northcote', 'Birkenhead', 'Birkdale', 'Beach Haven', 'Chatswood', 'Hillcrest', 'Glenfield', 'Totara Vale', 'Wairau Valley', 'Unsworth Heights', 'Rosedale', 'Albany',
      'Pinehill', 'Greenhithe', 'Campbells Bay', 'Mairangi Bay', 'Murrays Bay', 'Rothesay Bay', 'Browns Bay', 'Torbay', 'Long Bay'] },
    { name: 'West Auckland', metro: true, suburbs: ['West Auckland', 'Henderson', 'New Lynn', 'Glen Eden', 'Titirangi', 'Green Bay', 'Blockhouse Bay', 'Avondale', 'New Windsor',
      'Waterview', 'Kelston', 'Sunnyvale', 'Te Atatu', 'Te Atatu Peninsula', 'Te Atatu South', 'Massey', 'Westgate', 'West Harbour', 'Hobsonville', 'Whenuapai', 'Ranui',
      'Swanson', 'Lincoln', 'Oratia', 'Laingholm'] },
    { name: 'East Auckland', metro: true, suburbs: ['East Auckland', 'Howick', 'Pakuranga', 'Botany', 'Botany Downs', 'Half Moon Bay', 'Bucklands Beach', 'Eastern Beach',
      'Highland Park', 'Cockle Bay', 'Shelly Park', 'Mellons Bay', 'Farm Cove', 'Sunnyhills', 'Golflands', 'Dannemora', 'Burswood', 'East Tamaki', 'Flat Bush', 'Ormiston'] },
    { name: 'South Auckland', metro: true, suburbs: ['South Auckland', 'Manukau', 'Papatoetoe', 'Otahuhu', 'Otara', 'Mangere', 'Mangere Bridge', 'Favona', 'Middlemore', 'Wiri',
      'Clover Park', 'Manurewa', 'Clendon Park', 'Weymouth', 'Hillpark', 'Homai', 'Randwick Park', 'Totara Heights', 'Goodwood Heights', 'Takanini', 'Conifer Grove',
      'Papakura', 'Red Hill', 'Rosehill'] },
    { name: 'Rodney', metro: false, suburbs: ['Rodney', 'Orewa', 'Silverdale', 'Millwater', 'Red Beach', 'Hatfields Beach', 'Waiwera', 'Whangaparaoa', 'Stanmore Bay', 'Gulf Harbour',
      'Dairy Flat', 'Wainui', 'Puhoi', 'Warkworth', 'Snells Beach', 'Algies Bay', 'Matakana', 'Leigh', 'Omaha', 'Wellsford', 'Helensville', 'Kumeu', 'Huapai', 'Riverhead',
      'Waimauku', 'Muriwai'] },
    { name: 'Franklin', metro: false, suburbs: ['Franklin', 'Pukekohe', 'Waiuku', 'Drury', 'Karaka', 'Paerata', 'Patumahoe', 'Bombay', 'Ramarama', 'Clevedon', 'Beachlands',
      'Maraetai', 'Kawakawa Bay'] },
  ] as { name: string; metro: boolean; suburbs: string[] }[],
  // SLA-ranked dispatch: offers go out in waves, best-placed contractors first.
  dispatch_wave_size: { emergency: 0, urgent: 3, standard: 3, scheduled: 5 } as Record<string, number>,
  dispatch_wave_minutes: { emergency: 5, urgent: 20, standard: 60, scheduled: 240 } as Record<string, number>,
  travel_speed_kmh: 40,
  unknown_travel_minutes: 45,
  load_penalty_minutes: 30,
  // Escalation when nobody has accepted within this many minutes of dispatch release.
  escalation_minutes: { emergency: 10, urgent: 60, standard: 240, scheduled: 1440 } as Record<string, number>,
  escalation_staff_phones: [] as string[],
  // SMS
  sms_offer_priorities: ['emergency', 'urgent'],
  sms_offers_outside_business_hours: true,
  // Monthly customer report (emailed on the 1st for the previous month)
  // Master switch (off at launch). Reports are only emailed to customers who are also individually switched on.
  monthly_report_enabled: false,
  // Unfunded or over-authority P1 jobs are dispatched for make-safe scope only, up to this customer price (ex GST).
  // Customers can have their own cap. Work beyond needs customer approval or a staff override with a reason.
  p1_unfunded_cap_ex_gst_cents: 150000,
  // Once a customer's unfunded balance (receivables plus unfunded open P1 jobs) reaches this, P1 jobs that cannot be
  // funded are no longer dispatched automatically: they wait for a staff funding exception (staff alerted at once).
  p1_unfunded_suspend_threshold_cents: 300000,
  // A site whose suburb is in no SLA area needs staff confirmation before booking. P1 is still accepted (nothing
  // holds an emergency) unless this is switched off; such jobs are excluded from SLA reporting until confirmed.
  unconfirmed_area_allows_p1: true,
  // Saved-card automatic top-ups
  auto_topup_max_failures: 3,
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
  company: 'Contracting entity (legal name, NZBN, GST number) printed on invoices, credit notes, reports, agreements and emails',
  gst_rate_bps: 'GST rate in basis points (1500 = 15%)',
  ridgeline_gst_registered: 'Whether Ridgeline charges GST on customer invoices',
  min_balance_floor_cents: 'Lowest minimum prepaid balance for any account (cents)',
  standard_max_balance_cents: 'Above this, the account is flagged for an authorised custom arrangement (cents)',
  balance_rounding_cents: 'Recommended balances are rounded up to this increment (cents)',
  assessment_markup_bps: 'Markup applied to estimated contractor spend in assessments (bps)',
  emergency_cover_factor_bps: 'Multiplier on the emergency job share for each emergency cover level (bps)',
  booking_requires_minimum_balance: 'Hold P2–P4 bookings while the balance is below the agreed minimum',
  low_balance_alert_bps: 'Alert when balance falls below this share of the agreed minimum (10000 = 100%)',
  auto_dispatch: 'Automatically offer confirmed jobs to all eligible contractors',
  offer_expiry_minutes: 'Minutes before an unanswered job offer expires, by priority',
  sla_p1_onsite_hours: 'P1 Emergency (metro): on site within this many clock hours',
  sla_p1_made_safe_hours: 'P1 Emergency (metro): made safe within this many clock hours',
  sla_p1_non_metro_onsite_hours: 'P1 Emergency (non-metro site): on site within this many clock hours',
  sla_p1_non_metro_made_safe_hours: 'P1 Emergency (non-metro site): made safe within this many clock hours',
  sla_p2_onsite_business_hours: 'P2 Urgent: on site within this many NZ business hours',
  sla_p2_resolve_business_days: 'P2 Urgent: resolved within this many NZ business days',
  sla_p3_onsite_business_hours: 'P3 Standard: on site within this many NZ business hours',
  sla_p3_resolve_business_days: 'P3 Standard: resolved within this many NZ business days',
  sla_business_hours: 'NZ business hours used for SLA clocks (public holidays excluded)',
  sla_at_risk_bps: 'Alert operations when this share of an SLA window has elapsed (bps)',
  sla_areas: 'Auckland SLA areas: each lists its suburbs and whether it gets the metro P1 target. Sites with an unlisted suburb are treated as metro and flagged',
  monthly_report_enabled: 'Master switch for emailing monthly customer reports (each customer must also be switched on)',
  p1_unfunded_cap_ex_gst_cents: 'Make-safe cap (customer price, cents ex GST) for P1 jobs dispatched without funds or above the authority limit; per-customer override on the customer page',
  p1_unfunded_suspend_threshold_cents: 'Unfunded balance (cents incl GST: receivables plus unfunded open P1 jobs) at which automatic unfunded P1 dispatch stops for a customer; per-customer override',
  unconfirmed_area_allows_p1: 'Accept P1 bookings at a site whose SLA area is not yet confirmed (other priorities wait for staff confirmation)',
  dispatch_wave_size: 'Contractors offered per dispatch wave, best SLA fit first (0 = all who can meet the SLA)',
  dispatch_wave_minutes: 'Minutes before the next dispatch wave is offered if nobody has accepted',
  escalation_minutes: 'Escalate to staff (SMS + email) if no contractor accepts within this many minutes',
  escalation_staff_phones: 'Staff mobile numbers (+64…) that receive escalation SMS',
  sms_offer_priorities: 'Priorities whose job offers are also sent to contractors by SMS',
  sms_offers_outside_business_hours: 'Also SMS every offer made outside business hours',
  assessment_scale_bands: 'Share of monthly spend needing coverage, by spend band (falls as the portfolio grows)',
  auto_topup_max_failures: 'Pause saved-card automatic top-ups after this many consecutive failures',
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

/** SLA areas drive every P1 target, so a malformed edit is refused rather than stored. */
function validateSlaAreas(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) throw new AppError('sla_areas must be a non-empty list of areas');
  const names = new Set<string>();
  const owner = new Map<string, string>();
  for (const a of value as any[]) {
    if (!a || typeof a.name !== 'string' || !a.name.trim()) throw new AppError('Each SLA area needs a name');
    if (typeof a.metro !== 'boolean') throw new AppError(`SLA area "${a.name}" needs "metro": true or false`);
    if (!Array.isArray(a.suburbs) || a.suburbs.some((x: unknown) => typeof x !== 'string' || !x.trim())) throw new AppError(`SLA area "${a.name}" needs a list of suburb names`);
    if (names.has(a.name.toLowerCase())) throw new AppError(`SLA area "${a.name}" is listed twice`);
    names.add(a.name.toLowerCase());
    for (const sub of a.suburbs as string[]) {
      const k = sub.trim().toLowerCase();
      if (owner.has(k) && owner.get(k) !== a.name) throw new AppError(`Suburb "${sub}" is in both ${owner.get(k)} and ${a.name}`);
      owner.set(k, a.name);
    }
  }
}

export async function updateSetting(db: Db, actor: Actor, key: SettingKey, value: unknown): Promise<void> {
  if (key === 'sla_areas') validateSlaAreas(value);
  const before = (await getSettings(db))[key];
  await db.query(
    `INSERT INTO settings (key, value, description, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), SETTING_DESCRIPTIONS[key] ?? null, actor.id],
  );
  await audit(db, actor, { action: 'setting.updated', entityType: 'setting', entityId: key, details: { before, after: value } });
  if (key === 'sla_areas') {
    // Moving a suburb changes which sites are confirmed and their targets; loaded lazily to avoid a module cycle.
    const { refreshAllSiteAreas } = await import('./sla.js');
    await refreshAllSiteAreas(db);
  }
}
