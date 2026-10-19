import bcrypt from 'bcryptjs';
import type { Db } from '../db.js';
import { isUniqueViolation, maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { audit } from './audit.js';
import { getSettings } from './settings.js';
import { link, notifyStaff } from './notifications.js';
import { refreshSiteArea } from './sla.js';
import { CUSTOMER_TERMS_VERSION } from './terms.js';

export const CUSTOMER_CATEGORIES = ['residential', 'commercial', 'body_corporate', 'retail', 'industrial', 'mixed', 'custom'];
export const SERVICE_LEVELS = ['standard', 'priority'];
export const NZ_REGIONS = ['Northland', 'Auckland', 'Waikato', 'Bay of Plenty', 'Gisborne', "Hawke's Bay", 'Taranaki',
  'Manawatū-Whanganui', 'Wellington', 'Tasman', 'Nelson', 'Marlborough', 'West Coast', 'Canterbury', 'Otago', 'Southland'];

export async function hashPassword(pw: string): Promise<string> {
  if (!pw || pw.length < 10) throw new AppError('Password must be at least 10 characters');
  return bcrypt.hash(pw, 12);
}

/** Customer users may only touch their own organisation; staff may touch any. */
export function assertCustomerAccess(actor: Actor, customerId: string): void {
  if (isStaff(actor)) return;
  if (actor.role === 'customer' && actor.customerId === customerId) return;
  throw new ForbiddenError();
}

function assertCustomerManager(actor: Actor, customerId: string): void {
  assertCustomerAccess(actor, customerId);
  if (actor.role === 'customer' && actor.customerRole !== 'owner') throw new ForbiddenError('Only the account owner can manage the organisation');
}

export interface RegisterCustomerInput {
  organisationName: string;
  legalName?: string;
  nzbn?: string;
  gstNumber?: string;
  billingEmail: string;
  phone?: string;
  billingAddress?: string;
  customerCategory: string;
  serviceLevel?: string;
  emergencyCover?: 'none' | 'business_hours' | '24x7';
  contactName: string;
  contactEmail: string;
  password: string;
  /** Acceptance of the customer service agreement (current version) at registration. */
  termsAccepted?: boolean;
}

export async function registerCustomer(db: Db, actor: Actor, input: RegisterCustomerInput) {
  if (!input.organisationName?.trim()) throw new AppError('Organisation name is required');
  if (!CUSTOMER_CATEGORIES.includes(input.customerCategory)) throw new AppError('Invalid customer category');
  const hash = await hashPassword(input.password);
  return tx(db, async (c) => {
    const customer = await one(c,
      `INSERT INTO customers (name, legal_name, nzbn, gst_number, billing_email, phone, billing_address, customer_category, service_level, emergency_cover)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [input.organisationName.trim(), input.legalName || null, input.nzbn || null, input.gstNumber || null, input.billingEmail,
       input.phone || null, input.billingAddress || null, input.customerCategory, input.serviceLevel ?? 'standard', input.emergencyCover ?? 'business_hours']);
    let user;
    try {
      user = await one(c,
        `INSERT INTO users (email, password_hash, name, role, customer_id, customer_role) VALUES ($1,$2,$3,'customer',$4,'owner') RETURNING id, email, name`,
        [input.contactEmail, hash, input.contactName, customer.id]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('An account with that email already exists', 409);
      throw err;
    }
    if (input.termsAccepted) {
      await c.query('UPDATE customers SET terms_version = $2, terms_accepted_at = now(), terms_accepted_by = $3 WHERE id = $1', [customer.id, CUSTOMER_TERMS_VERSION, user.id]);
    }
    await audit(c, { ...actor, id: actor.id ?? user.id }, { action: 'customer.registered', entityType: 'customer', entityId: customer.id, customerId: customer.id,
      details: { termsVersion: input.termsAccepted ? CUSTOMER_TERMS_VERSION : null } });
    return { customer, user };
  });
}

export async function getCustomer(db: Db, actor: Actor, customerId: string) {
  assertCustomerAccess(actor, customerId);
  const c = await maybeOne(db, 'SELECT * FROM customers WHERE id = $1', [customerId]);
  if (!c) throw new NotFoundError('Customer');
  return c;
}

export interface SiteInput { name: string; address: string; suburb?: string; city?: string; region: string; postcode?: string; lat?: number | null; lng?: number | null; accessNotes?: string; hazards?: string; slaArea?: string | null }

export async function addSite(db: Db, actor: Actor, customerId: string, input: SiteInput) {
  assertCustomerManager(actor, customerId);
  if (!input.name?.trim() || !input.address?.trim()) throw new AppError('Site name and address are required');
  if (!input.region) throw new AppError('Region is required');
  if (!input.suburb?.trim()) throw new AppError('Suburb is required: it sets the service-level area for the site');
  // The SLA area (and so the P1 target) is resolved from the suburb against the sla_areas setting at release time;
  // staff may pin a site to an area explicitly.
  const override = input.slaArea && isStaff(actor) ? await validArea(db, input.slaArea) : null;
  const site = await one(db,
    `INSERT INTO sites (customer_id, name, address, suburb, city, region, postcode, lat, lng, access_notes, hazards, sla_area_override)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [customerId, input.name.trim(), input.address.trim(), input.suburb || null, input.city || null, input.region, input.postcode || null,
     input.lat ?? null, input.lng ?? null, input.accessNotes || null, input.hazards || null, override]);
  await db.query('UPDATE customers SET region = COALESCE(region, $2) WHERE id = $1', [customerId, input.region]);
  const area = await refreshSiteArea(db, site.id);
  if (area.source === 'unconfirmed') {
    await notifyStaff(db, ['ops', 'admin'], {
      template: 'site_area_unconfirmed', subject: `Confirm SLA area: ${site.name} (${site.suburb})`,
      body: `New site ${site.address}, ${site.suburb} is not in any SLA area. Jobs (other than emergencies) cannot be booked there until staff pin it to an area or add the suburb to Settings → sla_areas.\n${link(`/admin/customers/${customerId}`)}`,
      idempotencyKey: `site-area-unconfirmed:${site.id}`,
    });
  }
  await audit(db, actor, { action: 'site.created', entityType: 'site', entityId: site.id, customerId });
  return site;
}

async function validArea(db: Db, name: string): Promise<string> {
  const areas = (await getSettings(db)).sla_areas;
  const area = areas.find((a) => a.name.toLowerCase() === name.trim().toLowerCase());
  if (!area) throw new AppError(`Unknown SLA area "${name}". Areas are configured in Settings (sla_areas).`);
  return area.name;
}

/**
 * Staff pin a site to an SLA area, or clear the pin (empty) so the suburb decides. Applies to SLA clocks started or
 * recalculated after the change.
 */
export async function setSiteArea(db: Db, actor: Actor, siteId: string, areaName: string | null) {
  if (!isStaff(actor) || actor.role === 'finance') throw new ForbiddenError();
  const value = areaName?.trim() ? await validArea(db, areaName) : null;
  const site = await maybeOne(db, 'UPDATE sites SET sla_area_override = $2 WHERE id = $1 RETURNING *', [siteId, value]);
  if (!site) throw new NotFoundError('Site');
  const area = await refreshSiteArea(db, siteId);
  Object.assign(site, { sla_area: area.area?.name ?? null, sla_area_source: area.source });
  await audit(db, actor, { action: 'site.sla_area_set', entityType: 'site', entityId: siteId, customerId: site.customer_id, details: { area: value } });
  return site;
}

export async function addFacility(db: Db, actor: Actor, customerId: string, input: { siteId: string; facilityTypeId: number; name: string; unitCount: number; notes?: string; unitLabels?: string[] }) {
  assertCustomerManager(actor, customerId);
  if (!Number.isInteger(input.unitCount) || input.unitCount < 1) throw new AppError('Unit count must be a whole number of at least 1');
  return tx(db, async (c) => {
    const site = await maybeOne(c, 'SELECT id FROM sites WHERE id = $1 AND customer_id = $2', [input.siteId, customerId]);
    if (!site) throw new NotFoundError('Site');
    const type = await maybeOne(c, 'SELECT id FROM facility_types WHERE id = $1 AND is_active', [input.facilityTypeId]);
    if (!type) throw new AppError('Unknown facility type');
    const facility = await one(c,
      `INSERT INTO facilities (customer_id, site_id, facility_type_id, name, unit_count, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [customerId, input.siteId, input.facilityTypeId, input.name?.trim() || 'Facility', input.unitCount, input.notes || null]);
    for (const label of (input.unitLabels ?? []).map((l) => l.trim()).filter(Boolean)) {
      await c.query('INSERT INTO units (customer_id, facility_id, label) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [customerId, facility.id, label]);
    }
    await audit(c, actor, { action: 'facility.created', entityType: 'facility', entityId: facility.id, customerId, details: { unitCount: input.unitCount } });
    return facility;
  });
}

export async function addUnits(db: Db, actor: Actor, customerId: string, facilityId: string, labels: string[]) {
  assertCustomerManager(actor, customerId);
  const fac = await maybeOne(db, 'SELECT id FROM facilities WHERE id = $1 AND customer_id = $2', [facilityId, customerId]);
  if (!fac) throw new NotFoundError('Facility');
  for (const label of labels.map((l) => l.trim()).filter(Boolean)) {
    await db.query('INSERT INTO units (customer_id, facility_id, label) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [customerId, facilityId, label]);
  }
}

export async function portfolio(db: Db, actor: Actor, customerId: string) {
  assertCustomerAccess(actor, customerId);
  const sites = await query(db, 'SELECT * FROM sites WHERE customer_id = $1 AND is_active ORDER BY name', [customerId]);
  const facilities = await query(db,
    `SELECT f.*, ft.name AS type_name, ft.category AS type_category, ft.unit_label,
            (SELECT COUNT(*) FROM units u WHERE u.facility_id = f.id)::int AS unit_records
       FROM facilities f JOIN facility_types ft ON ft.id = f.facility_type_id
      WHERE f.customer_id = $1 AND f.is_active ORDER BY f.name`, [customerId]);
  const units = await query(db, 'SELECT * FROM units WHERE customer_id = $1 ORDER BY label', [customerId]);
  return { sites, facilities, units };
}

export async function addCustomerUser(db: Db, actor: Actor, customerId: string, input: { name: string; email: string; password: string; customerRole: 'owner' | 'approver' | 'booker' | 'viewer'; approvalLimitCents?: number | null; phone?: string }) {
  assertCustomerManager(actor, customerId);
  if (!['owner', 'approver', 'booker', 'viewer'].includes(input.customerRole)) throw new AppError('Invalid role');
  const hash = await hashPassword(input.password);
  try {
    const user = await one(db,
      `INSERT INTO users (email, password_hash, name, phone, role, customer_id, customer_role, approval_limit_cents)
       VALUES ($1,$2,$3,$4,'customer',$5,$6,$7) RETURNING id, email, name, customer_role`,
      [input.email, hash, input.name, input.phone || null, customerId, input.customerRole, input.approvalLimitCents ?? null]);
    await audit(db, actor, { action: 'customer_user.created', entityType: 'user', entityId: user.id, customerId, details: { role: input.customerRole } });
    return user;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('A user with that email already exists', 409);
    throw err;
  }
}

export interface CustomerTermsInput {
  customerCategory?: string;
  serviceLevel?: string;
  emergencyCover?: 'none' | 'business_hours' | '24x7';
  authorityLimitCents?: number;
  paymentTermsDays?: number;
  poRequired?: boolean;
  monthlyReportEnabled?: boolean;
  /** undefined = unchanged, null = use the global setting. */
  p1CapExGstCents?: number | null;
  p1SuspendThresholdCents?: number | null;
  acknowledgementRequired?: boolean;
  cancellationFeesApply?: boolean;
  autoApplyPrepaid?: boolean;
  status?: 'active' | 'suspended' | 'closed';
}

export async function updateCustomerTerms(db: Db, actor: Actor, customerId: string, input: CustomerTermsInput) {
  if (!isStaff(actor)) throw new ForbiddenError('Only Ridgeline staff can change account terms');
  return tx(db, async (c) => {
    const before = await maybeOne(c, 'SELECT * FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
    if (!before) throw new NotFoundError('Customer');
    if (input.monthlyReportEnabled !== undefined && input.monthlyReportEnabled !== before.monthly_report_enabled && actor.role !== 'admin') {
      throw new ForbiddenError('Only an administrator can turn the monthly report on or off');
    }
    if ((input.p1CapExGstCents !== undefined || input.p1SuspendThresholdCents !== undefined) && !['admin', 'finance'].includes(actor.role)) {
      throw new ForbiddenError('Only finance or an administrator can change unfunded emergency limits');
    }
    if (input.status === 'active' && before.agreed_minimum_balance_cents === null) {
      throw new AppError('Agree a minimum balance before activating the account');
    }
    const after = await one(c,
      `UPDATE customers SET
         customer_category = COALESCE($2, customer_category), service_level = COALESCE($3, service_level),
         emergency_cover = COALESCE($4, emergency_cover), authority_limit_cents = COALESCE($5, authority_limit_cents),
         payment_terms_days = COALESCE($6, payment_terms_days), po_required = COALESCE($7, po_required),
         acknowledgement_required = COALESCE($8, acknowledgement_required), cancellation_fees_apply = COALESCE($9, cancellation_fees_apply),
         auto_apply_prepaid = COALESCE($10, auto_apply_prepaid), status = COALESCE($11, status),
         monthly_report_enabled = COALESCE($12, monthly_report_enabled),
         p1_unfunded_cap_ex_gst_cents = CASE WHEN $13 THEN $14::bigint ELSE p1_unfunded_cap_ex_gst_cents END,
         p1_unfunded_suspend_threshold_cents = CASE WHEN $15 THEN $16::bigint ELSE p1_unfunded_suspend_threshold_cents END, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [customerId, input.customerCategory ?? null, input.serviceLevel ?? null, input.emergencyCover ?? null, input.authorityLimitCents ?? null,
       input.paymentTermsDays ?? null, input.poRequired ?? null, input.acknowledgementRequired ?? null, input.cancellationFeesApply ?? null,
       input.autoApplyPrepaid ?? null, input.status ?? null, input.monthlyReportEnabled ?? null,
       input.p1CapExGstCents !== undefined, input.p1CapExGstCents ?? null, input.p1SuspendThresholdCents !== undefined, input.p1SuspendThresholdCents ?? null]);
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(after)) if (JSON.stringify(after[k]) !== JSON.stringify(before[k]) && k !== 'updated_at') changed[k] = { from: before[k], to: after[k] };
    await audit(c, actor, { action: 'customer.terms_updated', entityType: 'customer', entityId: customerId, customerId, details: changed });
    return after;
  });
}
