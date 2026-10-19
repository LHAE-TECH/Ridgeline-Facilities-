import bcrypt from 'bcryptjs';
import type { Db } from '../db.js';
import { isUniqueViolation, maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { audit } from './audit.js';

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
    await audit(c, { ...actor, id: actor.id ?? user.id }, { action: 'customer.registered', entityType: 'customer', entityId: customer.id, customerId: customer.id });
    return { customer, user };
  });
}

export async function getCustomer(db: Db, actor: Actor, customerId: string) {
  assertCustomerAccess(actor, customerId);
  const c = await maybeOne(db, 'SELECT * FROM customers WHERE id = $1', [customerId]);
  if (!c) throw new NotFoundError('Customer');
  return c;
}

export interface SiteInput { name: string; address: string; suburb?: string; city?: string; region: string; postcode?: string; lat?: number | null; lng?: number | null; accessNotes?: string; hazards?: string }

export async function addSite(db: Db, actor: Actor, customerId: string, input: SiteInput) {
  assertCustomerManager(actor, customerId);
  if (!input.name?.trim() || !input.address?.trim()) throw new AppError('Site name and address are required');
  if (!input.region) throw new AppError('Region is required');
  const site = await one(db,
    `INSERT INTO sites (customer_id, name, address, suburb, city, region, postcode, lat, lng, access_notes, hazards)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [customerId, input.name.trim(), input.address.trim(), input.suburb || null, input.city || null, input.region, input.postcode || null,
     input.lat ?? null, input.lng ?? null, input.accessNotes || null, input.hazards || null]);
  await db.query('UPDATE customers SET region = COALESCE(region, $2) WHERE id = $1', [customerId, input.region]);
  await audit(db, actor, { action: 'site.created', entityType: 'site', entityId: site.id, customerId });
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
    if (input.status === 'active' && before.agreed_minimum_balance_cents === null) {
      throw new AppError('Agree a minimum balance before activating the account');
    }
    const after = await one(c,
      `UPDATE customers SET
         customer_category = COALESCE($2, customer_category), service_level = COALESCE($3, service_level),
         emergency_cover = COALESCE($4, emergency_cover), authority_limit_cents = COALESCE($5, authority_limit_cents),
         payment_terms_days = COALESCE($6, payment_terms_days), po_required = COALESCE($7, po_required),
         acknowledgement_required = COALESCE($8, acknowledgement_required), cancellation_fees_apply = COALESCE($9, cancellation_fees_apply),
         auto_apply_prepaid = COALESCE($10, auto_apply_prepaid), status = COALESCE($11, status), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [customerId, input.customerCategory ?? null, input.serviceLevel ?? null, input.emergencyCover ?? null, input.authorityLimitCents ?? null,
       input.paymentTermsDays ?? null, input.poRequired ?? null, input.acknowledgementRequired ?? null, input.cancellationFeesApply ?? null,
       input.autoApplyPrepaid ?? null, input.status ?? null]);
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(after)) if (JSON.stringify(after[k]) !== JSON.stringify(before[k]) && k !== 'updated_at') changed[k] = { from: before[k], to: after[k] };
    await audit(c, actor, { action: 'customer.terms_updated', entityType: 'customer', entityId: customerId, customerId, details: changed });
    return after;
  });
}
