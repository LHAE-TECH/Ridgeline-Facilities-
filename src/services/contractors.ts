import type { Db } from '../db.js';
import { isUniqueViolation, maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { audit } from './audit.js';
import { hashPassword } from './customers.js';

export const DOCUMENT_TYPES: Record<string, string> = {
  public_liability: 'Public liability insurance',
  ewrb_licence: 'Electrical Workers Registration Board practising licence',
  pgdb_licence: 'Plumbers, Gasfitters & Drainlayers Board licence',
  working_at_height: 'Working at height certification',
  fire_protection_cert: 'Fire protection qualification',
  site_safe: 'Site Safe passport',
  professional_indemnity: 'Professional indemnity insurance',
  other: 'Other document',
};

export function assertContractorAccess(actor: Actor, contractorId: string): void {
  if (isStaff(actor)) return;
  if (actor.role === 'contractor' && actor.contractorId === contractorId) return;
  throw new ForbiddenError();
}

export interface ContractorInput {
  legalName: string;
  tradingName?: string;
  nzbn?: string;
  businessAddress?: string;
  email: string;
  phone?: string;
  gstRegistered: boolean;
  gstNumber?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
  paymentTermsDays?: number;
  serviceRegions: string[];
  baseLat?: number | null;
  baseLng?: number | null;
  serviceRadiusKm?: number | null;
  afterHoursAvailable?: boolean;
  emergencyAvailable?: boolean;
  maxConcurrentJobs?: number;
  tradeIds?: number[];
}

/** Creates a contractor (status 'pending') and a login. Used by public applications and staff onboarding. */
export async function createContractor(db: Db, actor: Actor, input: ContractorInput & { contactName: string; password: string; independentContractorAck?: boolean }) {
  if (!input.legalName?.trim()) throw new AppError('Legal name is required');
  if (input.gstRegistered && !input.gstNumber?.trim()) throw new AppError('GST number is required for GST-registered contractors');
  if (!input.serviceRegions?.length) throw new AppError('Select at least one service region');
  const hash = await hashPassword(input.password);
  return tx(db, async (c) => {
    const contractor = await one(c,
      `INSERT INTO contractors (legal_name, trading_name, nzbn, business_address, email, phone, gst_registered, gst_number, bank_account_name,
         bank_account_number, payment_terms_days, service_regions, base_lat, base_lng, service_radius_km, after_hours_available,
         emergency_available, max_concurrent_jobs, independent_contractor_ack_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, CASE WHEN $19 THEN now() END) RETURNING *`,
      [input.legalName.trim(), input.tradingName || null, input.nzbn || null, input.businessAddress || null, input.email, input.phone || null,
       input.gstRegistered, input.gstRegistered ? input.gstNumber!.trim() : null, input.bankAccountName || null, input.bankAccountNumber || null,
       input.paymentTermsDays ?? 7, input.serviceRegions, input.baseLat ?? null, input.baseLng ?? null, input.serviceRadiusKm ?? null,
       input.afterHoursAvailable ?? false, input.emergencyAvailable ?? false, input.maxConcurrentJobs ?? 5, input.independentContractorAck ?? false]);
    try {
      await c.query(`INSERT INTO users (email, password_hash, name, phone, role, contractor_id) VALUES ($1,$2,$3,$4,'contractor',$5)`,
        [input.email, hash, input.contactName, input.phone || null, contractor.id]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('A user with that email already exists', 409);
      throw err;
    }
    for (const tid of input.tradeIds ?? []) {
      await c.query('INSERT INTO contractor_trades (contractor_id, trade_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [contractor.id, tid]);
    }
    await audit(c, actor, { action: 'contractor.created', entityType: 'contractor', entityId: contractor.id, contractorId: contractor.id });
    return contractor;
  });
}

export async function updateContractor(db: Db, actor: Actor, contractorId: string, input: Partial<ContractorInput> & { status?: string; available?: boolean }) {
  assertContractorAccess(actor, contractorId);
  if (actor.role === 'contractor') {
    // Contractors may update availability and contact details only; commercial terms are staff-controlled.
    const allowed = ['phone', 'available', 'afterHoursAvailable', 'emergencyAvailable', 'businessAddress', 'bankAccountName', 'bankAccountNumber'];
    for (const k of Object.keys(input)) if (!allowed.includes(k)) throw new ForbiddenError(`Contractors cannot change ${k}`);
  }
  if (input.status && !isStaff(actor)) throw new ForbiddenError();
  return tx(db, async (c) => {
    const before = await maybeOne(c, 'SELECT * FROM contractors WHERE id = $1 FOR UPDATE', [contractorId]);
    if (!before) throw new NotFoundError('Contractor');
    const gstRegistered = input.gstRegistered ?? before.gst_registered;
    const gstNumber = input.gstNumber !== undefined ? (input.gstNumber || null) : before.gst_number;
    if (gstRegistered && !gstNumber) throw new AppError('GST number is required for GST-registered contractors');
    const after = await one(c,
      `UPDATE contractors SET legal_name = COALESCE($2, legal_name), trading_name = COALESCE($3, trading_name), nzbn = COALESCE($4, nzbn),
         business_address = COALESCE($5, business_address), phone = COALESCE($6, phone), gst_registered = $7, gst_number = $8,
         bank_account_name = COALESCE($9, bank_account_name), bank_account_number = COALESCE($10, bank_account_number),
         payment_terms_days = COALESCE($11, payment_terms_days), service_regions = COALESCE($12, service_regions),
         service_radius_km = COALESCE($13, service_radius_km), after_hours_available = COALESCE($14, after_hours_available),
         emergency_available = COALESCE($15, emergency_available), max_concurrent_jobs = COALESCE($16, max_concurrent_jobs),
         status = COALESCE($17, status), available = COALESCE($18, available), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [contractorId, input.legalName ?? null, input.tradingName ?? null, input.nzbn ?? null, input.businessAddress ?? null, input.phone ?? null,
       gstRegistered, gstRegistered ? gstNumber : null, input.bankAccountName ?? null, input.bankAccountNumber ?? null, input.paymentTermsDays ?? null,
       input.serviceRegions ?? null, input.serviceRadiusKm ?? null, input.afterHoursAvailable ?? null, input.emergencyAvailable ?? null,
       input.maxConcurrentJobs ?? null, input.status ?? null, input.available ?? null]);
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(after)) {
      if (k === 'updated_at') continue;
      if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) changed[k] = k === 'bank_account_number' ? 'changed' : { from: before[k], to: after[k] };
    }
    await audit(c, actor, { action: 'contractor.updated', entityType: 'contractor', entityId: contractorId, contractorId, details: changed });
    return after;
  });
}

export async function setContractorTrade(db: Db, actor: Actor, contractorId: string, tradeId: number, opts: { qualification?: string; verified?: boolean; remove?: boolean }) {
  if (!isStaff(actor)) throw new ForbiddenError();
  if (opts.remove) {
    await db.query('DELETE FROM contractor_trades WHERE contractor_id = $1 AND trade_id = $2', [contractorId, tradeId]);
  } else {
    await db.query(
      `INSERT INTO contractor_trades (contractor_id, trade_id, qualification, verified) VALUES ($1,$2,$3,$4)
       ON CONFLICT (contractor_id, trade_id) DO UPDATE SET qualification = COALESCE(EXCLUDED.qualification, contractor_trades.qualification), verified = EXCLUDED.verified`,
      [contractorId, tradeId, opts.qualification ?? null, opts.verified ?? false]);
  }
  await audit(db, actor, { action: opts.remove ? 'contractor.trade_removed' : 'contractor.trade_set', entityType: 'contractor', entityId: contractorId, contractorId, details: { tradeId, ...opts } });
}

export async function addComplianceDocument(db: Db, actor: Actor, contractorId: string, input: { docType: string; reference?: string; issuedAt?: string | null; expiresAt?: string | null; fileId?: string | null }) {
  assertContractorAccess(actor, contractorId);
  if (!DOCUMENT_TYPES[input.docType]) throw new AppError('Unknown document type');
  const doc = await one(db,
    `INSERT INTO compliance_documents (contractor_id, doc_type, reference, issued_at, expires_at, file_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [contractorId, input.docType, input.reference || null, input.issuedAt || null, input.expiresAt || null, input.fileId ?? null]);
  await audit(db, actor, { action: 'compliance.submitted', entityType: 'compliance_document', entityId: doc.id, contractorId, details: input });
  return doc;
}

export async function reviewComplianceDocument(db: Db, actor: Actor, docId: string, decision: 'verified' | 'rejected') {
  if (!isStaff(actor) || actor.role === 'finance') throw new ForbiddenError('Only operations staff can verify compliance documents');
  return tx(db, async (c) => {
    const doc = await maybeOne(c, 'SELECT * FROM compliance_documents WHERE id = $1 FOR UPDATE', [docId]);
    if (!doc) throw new NotFoundError('Document');
    if (decision === 'verified') {
      if (doc.expires_at && doc.expires_at < new Date().toISOString().slice(0, 10)) throw new AppError('Cannot verify an expired document');
      // Older verified documents of the same type are superseded.
      await c.query(`UPDATE compliance_documents SET status = 'superseded' WHERE contractor_id = $1 AND doc_type = $2 AND status = 'verified' AND id <> $3`,
        [doc.contractor_id, doc.doc_type, docId]);
    }
    const updated = await one(c, `UPDATE compliance_documents SET status = $2, verified_by = $3, verified_at = now() WHERE id = $1 RETURNING *`, [docId, decision, actor.id]);
    await audit(c, actor, { action: `compliance.${decision}`, entityType: 'compliance_document', entityId: docId, contractorId: doc.contractor_id });
    return updated;
  });
}

export interface RateCardInput {
  tradeId: number;
  labourRateCents: number;
  calloutCents?: number;
  emergencyCalloutCents?: number;
  afterHoursMultiplierBps?: number;
  weekendMultiplierBps?: number;
  publicHolidayMultiplierBps?: number;
  overnightMultiplierBps?: number;
  travelPerKmCents?: number;
  minChargeCents?: number;
  materialsMarginBps?: number;
  cancellationFeeCents?: number;
  effectiveFrom?: string;
}

/** Records an agreed contractor rate card, retiring the previous card for the same trade. */
export async function setRateCard(db: Db, actor: Actor, contractorId: string, input: RateCardInput) {
  if (actor.role !== 'admin' && actor.role !== 'ops') throw new ForbiddenError('Only administrators or operations can agree contractor rates');
  return tx(db, async (c) => {
    await c.query(`UPDATE contractor_rate_cards SET status = 'retired', effective_to = CURRENT_DATE WHERE contractor_id = $1 AND trade_id = $2 AND status = 'approved'`,
      [contractorId, input.tradeId]);
    const card = await one(c,
      `INSERT INTO contractor_rate_cards (contractor_id, trade_id, labour_rate_cents, callout_cents, emergency_callout_cents, after_hours_multiplier_bps,
         weekend_multiplier_bps, public_holiday_multiplier_bps, overnight_multiplier_bps, travel_per_km_cents, min_charge_cents, materials_margin_bps,
         cancellation_fee_cents, effective_from, approved_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::date, CURRENT_DATE),$15,'approved') RETURNING *`,
      [contractorId, input.tradeId, input.labourRateCents, input.calloutCents ?? 0, input.emergencyCalloutCents ?? 0, input.afterHoursMultiplierBps ?? 15000,
       input.weekendMultiplierBps ?? 15000, input.publicHolidayMultiplierBps ?? 20000, input.overnightMultiplierBps ?? 20000, input.travelPerKmCents ?? 0,
       input.minChargeCents ?? 0, input.materialsMarginBps ?? 0, input.cancellationFeeCents ?? 0, input.effectiveFrom ?? null, actor.id]);
    await audit(c, actor, { action: 'rate_card.approved', entityType: 'contractor_rate_card', entityId: card.id, contractorId, details: { ...input } });
    return card;
  });
}

export async function currentRateCard(db: Db, contractorId: string, tradeId: number) {
  return maybeOne(db,
    `SELECT * FROM contractor_rate_cards WHERE contractor_id = $1 AND trade_id = $2 AND status = 'approved'
       AND effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
     ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [contractorId, tradeId]);
}

export async function contractorProfile(db: Db, actor: Actor, contractorId: string) {
  assertContractorAccess(actor, contractorId);
  const contractor = await maybeOne(db, 'SELECT * FROM contractors WHERE id = $1', [contractorId]);
  if (!contractor) throw new NotFoundError('Contractor');
  const trades = await query(db,
    `SELECT ct.*, t.name, t.code, t.required_documents FROM contractor_trades ct JOIN trades t ON t.id = ct.trade_id WHERE ct.contractor_id = $1 ORDER BY t.name`, [contractorId]);
  const documents = await query(db, `SELECT * FROM compliance_documents WHERE contractor_id = $1 ORDER BY created_at DESC`, [contractorId]);
  const rateCards = await query(db,
    `SELECT r.*, t.name AS trade_name FROM contractor_rate_cards r JOIN trades t ON t.id = r.trade_id WHERE r.contractor_id = $1 ORDER BY r.status, t.name, r.created_at DESC`, [contractorId]);
  return { contractor, trades, documents, rateCards };
}
