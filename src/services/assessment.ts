import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { AppError, NotFoundError } from '../lib/errors.js';
import { formatBps, formatMultiplier, formatNzd, gstOn } from '../lib/money.js';
import { audit } from './audit.js';
import { getSettings, type Settings } from './settings.js';

export interface FacilityTypeAssumptions {
  id: number;
  code: string;
  name: string;
  category: string;
  unit_label: string;
  jobs_per_unit_per_month: number;
  avg_contractor_cost_cents: number;
  callout_share_bps: number;
  avg_callout_cost_cents: number;
  emergency_share_bps: number;
  emergency_cost_multiplier_bps: number;
  planned_monthly_cost_per_unit_cents: number;
}

export interface AssessmentFacilityInput {
  facilityId?: string;
  name: string;
  unitCount: number;
  type: FacilityTypeAssumptions;
}

export interface AssessmentInputs {
  customerCategory: string;
  serviceLevel: string;
  emergencyCover: 'none' | 'business_hours' | '24x7';
  facilities: AssessmentFacilityInput[];
}

export interface AssessmentLine {
  facility: string;
  facilityType: string;
  units: number;
  unitLabel: string;
  jobsPerMonth: number;
  costPerJobCents: number;
  emergencyLoadingBps: number;
  contractorMonthlyCents: number;
  customerMonthlyExGstCents: number;
  explanation: string;
}

export interface AssessmentResult {
  effectiveCategory: string;
  lines: AssessmentLine[];
  contractorMonthlyCents: number;
  customerMonthlyExGstCents: number;
  gstCents: number;
  monthlySpendCents: number;
  /** Monthly spend after the portfolio scale taper: the amount the coverage factor is applied to. */
  coveredSpendCents: number;
  coverageFactorBps: number;
  calculatedCents: number;
  recommendedCents: number;
  requiresCustom: boolean;
  floorApplied: boolean;
  steps: string[];
}

/** Pure calculation of the recommended minimum prepaid balance. All assumptions come from configuration. */
export function computeAssessment(
  inputs: AssessmentInputs,
  coverageFactorBps: number,
  settings: Pick<Settings, 'assessment_markup_bps' | 'gst_rate_bps' | 'ridgeline_gst_registered' | 'emergency_cover_factor_bps' |
    'balance_rounding_cents' | 'min_balance_floor_cents' | 'standard_max_balance_cents' | 'assessment_scale_bands'>,
  effectiveCategory: string,
): AssessmentResult {
  if (inputs.facilities.length === 0) throw new AppError('Add at least one facility before calculating the minimum balance');
  const coverFactorBps = settings.emergency_cover_factor_bps[inputs.emergencyCover] ?? 10000;
  const markupMultiplier = 1 + settings.assessment_markup_bps / 10000;

  const lines: AssessmentLine[] = inputs.facilities.map((f) => {
    const t = f.type;
    const jobsPerMonth = f.unitCount * Number(t.jobs_per_unit_per_month);
    const costPerJob = t.avg_contractor_cost_cents + (t.callout_share_bps / 10000) * t.avg_callout_cost_cents;
    const effectiveEmergencyShare = (t.emergency_share_bps / 10000) * (coverFactorBps / 10000);
    const loading = 1 + effectiveEmergencyShare * (t.emergency_cost_multiplier_bps / 10000 - 1);
    const contractorMonthly = jobsPerMonth * costPerJob * loading + f.unitCount * t.planned_monthly_cost_per_unit_cents;
    const customerMonthly = contractorMonthly * markupMultiplier;
    return {
      facility: f.name,
      facilityType: t.name,
      units: f.unitCount,
      unitLabel: t.unit_label,
      jobsPerMonth: Math.round(jobsPerMonth * 1000) / 1000,
      costPerJobCents: Math.round(costPerJob),
      emergencyLoadingBps: Math.round(loading * 10000),
      contractorMonthlyCents: Math.round(contractorMonthly),
      customerMonthlyExGstCents: Math.round(customerMonthly),
      explanation:
        `${f.unitCount} ${t.unit_label}(s) × ${Number(t.jobs_per_unit_per_month)} jobs/${t.unit_label}/month = ${(Math.round(jobsPerMonth * 1000) / 1000)} jobs/month; ` +
        `avg cost per job ${formatNzd(Math.round(costPerJob))} (${formatNzd(t.avg_contractor_cost_cents)} work + ${formatBps(t.callout_share_bps)} × ${formatNzd(t.avg_callout_cost_cents)} callout); ` +
        `emergency loading ${formatMultiplier(Math.round(loading * 10000))} (${formatBps(t.emergency_share_bps)} emergency share × ${formatMultiplier(coverFactorBps)} cover × ${formatMultiplier(t.emergency_cost_multiplier_bps)} premium)` +
        (t.planned_monthly_cost_per_unit_cents ? `; plus planned ${formatNzd(t.planned_monthly_cost_per_unit_cents)}/${t.unit_label}` : '') +
        ` → contractor ${formatNzd(Math.round(contractorMonthly))}/month → customer ${formatNzd(Math.round(customerMonthly))}/month ex GST`,
    };
  });

  const contractorMonthlyCents = lines.reduce((s, l) => s + l.contractorMonthlyCents, 0);
  const customerMonthlyExGstCents = lines.reduce((s, l) => s + l.customerMonthlyExGstCents, 0);
  const gstCents = settings.ridgeline_gst_registered ? gstOn(customerMonthlyExGstCents, settings.gst_rate_bps) : 0;
  const monthlySpendCents = customerMonthlyExGstCents + gstCents;
  const { covered: coveredSpendCents, explanation: taperExplanation } = applyScaleTaper(monthlySpendCents, settings.assessment_scale_bands);
  const calculatedCents = Math.round((coveredSpendCents * coverageFactorBps) / 10000);
  const rounding = Math.max(1, settings.balance_rounding_cents);
  let recommendedCents = Math.ceil(calculatedCents / rounding) * rounding;
  let floorApplied = false;
  if (recommendedCents < settings.min_balance_floor_cents) {
    recommendedCents = settings.min_balance_floor_cents;
    floorApplied = true;
  }
  // Deliberately NOT capped: amounts above the standard maximum are flagged for a custom arrangement.
  const requiresCustom = recommendedCents > settings.standard_max_balance_cents;

  const steps = [
    `Estimated contractor spend: ${formatNzd(contractorMonthlyCents)} per month across ${lines.length} facility group(s).`,
    `Customer pricing (${formatBps(settings.assessment_markup_bps)} markup): ${formatNzd(customerMonthlyExGstCents)} per month excluding GST.`,
    settings.ridgeline_gst_registered
      ? `Add GST at ${formatBps(settings.gst_rate_bps)}: ${formatNzd(gstCents)} → estimated monthly maintenance spend ${formatNzd(monthlySpendCents)}.`
      : `Estimated monthly maintenance spend ${formatNzd(monthlySpendCents)} (no GST).`,
    `Coverage factor for ${effectiveCategory} / ${inputs.serviceLevel} agreements: ${formatMultiplier(coverageFactorBps)}.`,
    coveredSpendCents === monthlySpendCents
      ? `Portfolio scale adjustment: none (spend within the first band).`
      : `Portfolio scale adjustment (larger portfolios have steadier spend): ${taperExplanation} = ${formatNzd(coveredSpendCents)} of monthly spend needs coverage.`,
    `Required minimum balance = ${formatNzd(coveredSpendCents)} × ${formatMultiplier(coverageFactorBps)} = ${formatNzd(calculatedCents)}.`,
    `Rounded up to the nearest ${formatNzd(rounding)}: ${formatNzd(Math.ceil(calculatedCents / rounding) * rounding)}.`,
  ];
  if (floorApplied) steps.push(`Below the ${formatNzd(settings.min_balance_floor_cents)} account minimum, so the minimum of ${formatNzd(settings.min_balance_floor_cents)} applies.`);
  if (requiresCustom) {
    steps.push(`Exceeds the ${formatNzd(settings.standard_max_balance_cents)} standard maximum: an authorised custom arrangement is required (amount is not capped automatically).`);
  }
  steps.push(`Recommended minimum prepaid balance: ${formatNzd(recommendedCents)}.`);

  return {
    effectiveCategory, lines, contractorMonthlyCents, customerMonthlyExGstCents, gstCents, monthlySpendCents, coveredSpendCents,
    coverageFactorBps, calculatedCents, recommendedCents, requiresCustom, floorApplied, steps,
  };
}

/**
 * Marginal taper on monthly spend: each band's share of spend is multiplied by its coverage share, like tax
 * brackets. The covered amount therefore never falls as spend grows, while the per-unit requirement does.
 */
export function applyScaleTaper(spendCents: number, bands: { up_to_cents: number | null; coverage_bps: number }[]): { covered: number; explanation: string } {
  if (!bands?.length) return { covered: spendCents, explanation: '' };
  let covered = 0;
  let lower = 0;
  const parts: string[] = [];
  for (const b of bands) {
    if (spendCents <= lower) break;
    const upper = b.up_to_cents === null ? spendCents : Math.min(spendCents, b.up_to_cents);
    const slice = upper - lower;
    if (slice > 0) {
      covered += Math.round((slice * b.coverage_bps) / 10000);
      parts.push(`${formatNzd(slice)} × ${formatBps(b.coverage_bps)}`);
    }
    if (b.up_to_cents === null) break;
    lower = b.up_to_cents;
  }
  return { covered, explanation: parts.join(' + ') };
}

/** A portfolio spanning more than one facility category is assessed as 'mixed'. */
export function effectiveCategoryFor(facilityCategories: string[], fallback: string): string {
  const distinct = [...new Set(facilityCategories.filter((c) => c !== 'custom'))];
  if (distinct.length > 1) return 'mixed';
  if (distinct.length === 1) return distinct[0];
  return fallback;
}

export async function coverageFactorFor(db: Db, category: string, serviceLevel: string): Promise<number> {
  const row = await maybeOne<{ factor_bps: number }>(db,
    `SELECT factor_bps FROM coverage_factors
      WHERE (customer_category = $1 AND service_level = $2)
         OR (customer_category = $1 AND service_level = 'standard')
         OR (customer_category = 'custom' AND service_level = 'standard')
      ORDER BY (customer_category = $1 AND service_level = $2) DESC, (customer_category = $1) DESC LIMIT 1`,
    [category, serviceLevel]);
  if (!row) throw new AppError(`No coverage factor configured for ${category}/${serviceLevel}`);
  return row.factor_bps;
}

/** Calculates and stores a proposed assessment from the customer's registered facilities. */
export async function runAssessment(db: Db, actor: Actor, customerId: string): Promise<{ id: string; result: AssessmentResult }> {
  return tx(db, async (c) => {
    const customer = await maybeOne(c, 'SELECT * FROM customers WHERE id = $1', [customerId]);
    if (!customer) throw new NotFoundError('Customer');
    const facilities = await query(c,
      `SELECT f.id AS facility_id, f.name AS facility_name, f.unit_count,
              ft.id, ft.code, ft.name, ft.category, ft.unit_label, ft.jobs_per_unit_per_month, ft.avg_contractor_cost_cents,
              ft.callout_share_bps, ft.avg_callout_cost_cents, ft.emergency_share_bps, ft.emergency_cost_multiplier_bps,
              ft.planned_monthly_cost_per_unit_cents
         FROM facilities f JOIN facility_types ft ON ft.id = f.facility_type_id
        WHERE f.customer_id = $1 AND f.is_active ORDER BY f.created_at`, [customerId]);
    const settings = await getSettings(c);
    const inputs: AssessmentInputs = {
      customerCategory: customer.customer_category,
      serviceLevel: customer.service_level,
      emergencyCover: customer.emergency_cover,
      facilities: facilities.map((f) => {
        const { facility_id, facility_name, unit_count, ...type } = f;
        return { facilityId: facility_id, name: facility_name, unitCount: unit_count, type: type as FacilityTypeAssumptions };
      }),
    };

    const category = effectiveCategoryFor(inputs.facilities.map((f) => f.type.category), customer.customer_category);
    const factor = await coverageFactorFor(c, category, customer.service_level);
    const result = computeAssessment(inputs, factor, settings, category);

    await c.query(`UPDATE account_assessments SET status = 'superseded' WHERE customer_id = $1 AND status = 'proposed'`, [customerId]);
    const row = await one<{ id: string }>(c,
      `INSERT INTO account_assessments (customer_id, inputs, assumptions, breakdown, monthly_spend_cents, coverage_factor_bps,
         calculated_cents, recommended_cents, requires_custom, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [customerId, JSON.stringify(inputs), JSON.stringify({
        assessment_markup_bps: settings.assessment_markup_bps, gst_rate_bps: settings.gst_rate_bps,
        emergency_cover_factor_bps: settings.emergency_cover_factor_bps, min_balance_floor_cents: settings.min_balance_floor_cents,
        standard_max_balance_cents: settings.standard_max_balance_cents, balance_rounding_cents: settings.balance_rounding_cents,
      }), JSON.stringify(result), result.monthlySpendCents, factor, result.calculatedCents, result.recommendedCents,
      result.requiresCustom, actor.id]);
    await audit(c, actor, { action: 'assessment.calculated', entityType: 'account_assessment', entityId: row.id, customerId,
      details: { recommended: result.recommendedCents, requiresCustom: result.requiresCustom } });
    return { id: row.id, result };
  });
}

/**
 * Staff agree the minimum balance. A standard assessment is agreed at its recommendation; one requiring a
 * custom arrangement needs an explicit amount and justification from an administrator.
 */
export async function acceptAssessment(db: Db, actor: Actor, assessmentId: string, opts: { agreedCents?: number; notes?: string } = {}) {
  if (actor.role !== 'admin' && actor.role !== 'finance') throw new AppError('Only administrators or finance can agree a minimum balance', 403);
  return tx(db, async (c) => {
    const a = await maybeOne(c, 'SELECT * FROM account_assessments WHERE id = $1 FOR UPDATE', [assessmentId]);
    if (!a) throw new NotFoundError('Assessment');
    if (a.status !== 'proposed') throw new AppError('Only a proposed assessment can be accepted');
    let agreed = a.recommended_cents as number;
    let custom = false;
    if (a.requires_custom || (opts.agreedCents !== undefined && opts.agreedCents !== a.recommended_cents)) {
      if (actor.role !== 'admin') throw new AppError('A custom arrangement must be authorised by an administrator', 403);
      if (opts.agreedCents === undefined || !opts.notes?.trim()) {
        throw new AppError('A custom arrangement requires an agreed amount and the reason/authority for it');
      }
      if (opts.agreedCents <= 0) throw new AppError('Agreed minimum must be positive');
      agreed = opts.agreedCents;
      custom = true;
    }
    await c.query(`UPDATE account_assessments SET status='accepted', agreed_cents=$2, agreed_notes=$3, accepted_by=$4, accepted_at=now() WHERE id=$1`,
      [assessmentId, agreed, opts.notes ?? null, actor.id]);
    const cust = await one(c,
      `UPDATE customers SET agreed_minimum_balance_cents = $2, custom_arrangement = $3, custom_arrangement_notes = $4,
          status = CASE WHEN status IN ('pending_assessment','pending_deposit')
                        THEN (CASE WHEN prepaid_balance_cents >= $2 THEN 'active' ELSE 'pending_deposit' END) ELSE status END,
          updated_at = now()
        WHERE id = $1 RETURNING *`, [a.customer_id, agreed, custom, custom ? opts.notes : null]);
    await audit(c, actor, { action: 'assessment.accepted', entityType: 'account_assessment', entityId: assessmentId, customerId: a.customer_id,
      details: { recommended: a.recommended_cents, agreed, custom, notes: opts.notes } });
    return cust;
  });
}

export async function latestAssessment(db: Db, customerId: string) {
  return maybeOne(db, `SELECT * FROM account_assessments WHERE customer_id = $1 AND status <> 'superseded' ORDER BY created_at DESC LIMIT 1`, [customerId]);
}
