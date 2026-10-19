import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { AppError, NotFoundError } from '../lib/errors.js';
import { addMarkup, applyBps, formatBps, formatMultiplier, formatNzd, formatQuantity, gstOn, mulDiv, qtyAmount } from '../lib/money.js';
import { audit } from './audit.js';
import type { Settings } from './settings.js';
import type { TimeWindow } from './timeWindows.js';

export type CostCategory = 'labour' | 'callout' | 'travel' | 'materials' | 'variation' | 'cancellation' | 'minimum_charge';
export const COST_CATEGORIES: CostCategory[] = ['labour', 'callout', 'travel', 'materials', 'variation', 'cancellation', 'minimum_charge'];

export type RuleCategory =
  | 'standard_labour' | 'standard_callout' | 'emergency_callout' | 'after_hours' | 'weekend' | 'public_holiday' | 'overnight'
  | 'travel' | 'materials' | 'specialist' | 'minimum_charge' | 'variation' | 'cancellation';
export const RULE_CATEGORIES: RuleCategory[] = ['standard_labour', 'standard_callout', 'emergency_callout', 'after_hours', 'weekend',
  'public_holiday', 'overnight', 'travel', 'materials', 'specialist', 'minimum_charge', 'variation', 'cancellation'];
export const RULE_CATEGORY_LABELS: Record<RuleCategory, string> = {
  standard_labour: 'Standard labour', standard_callout: 'Standard callout fee', emergency_callout: 'Emergency callout fee',
  after_hours: 'Weekday after-hours work', weekend: 'Weekend work', public_holiday: 'Public holiday work', overnight: 'Overnight work',
  travel: 'Travel and mileage', materials: 'Materials and parts', specialist: 'Specialist trades', minimum_charge: 'Minimum job charge',
  variation: 'Approved variations', cancellation: 'Cancellation / failed attendance',
};

export type Priority = 'emergency' | 'urgent' | 'standard' | 'scheduled';

export interface PricingRule {
  id: string;
  category: RuleCategory;
  customer_id: string | null;
  trade_id: number | null;
  priority: Priority | null;
  method: 'markup' | 'fixed_rate' | 'standard_multiplier' | 'minimum';
  markup_bps: number | null;
  customer_rate_cents: number | null;
  customer_multiplier_bps: number | null;
  minimum_cents: number | null;
  reference_contractor_rate_cents: number | null;
  unit: string;
  description: string | null;
}

export interface CostLine {
  category: CostCategory;
  description: string;
  quantityMilli: number;
  unitRateCents: number;
  amountCents: number;
  timeWindow: TimeWindow;
  contractorLineId?: string | null;
}

export interface PricingContext {
  customerId: string;
  tradeId: number;
  tradeIsSpecialist: boolean;
  priority: Priority;
  /** The contractor's standard labour rate; required only by 'standard_multiplier' rules. */
  standardContractorLabourRateCents?: number | null;
}

export interface PricedLine {
  category: string;
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  amountExGstCents: number;
  contractorCostCents: number;
  ruleId: string | null;
  ruleCategory: RuleCategory | null;
  explanation: string;
  contractorLineId: string | null;
}

export interface PricingResult {
  lines: PricedLine[];
  contractorCostExGstCents: number;
  subtotalExGstCents: number;
  markupCents: number;
  gstCents: number;
  totalCents: number;
  grossMarginBps: number;
  gstRateBps: number;
  gstExplanation: string;
}

/**
 * Determines which rule categories may price a line, most preferred first. Each line is priced by exactly
 * one rule, so a time-window premium and a standard rate are never both applied to the same work.
 */
export function ruleChainFor(line: Pick<CostLine, 'category' | 'timeWindow'>, ctx: Pick<PricingContext, 'priority' | 'tradeIsSpecialist'>): RuleCategory[] {
  const labourBase: RuleCategory[] = ctx.tradeIsSpecialist ? ['specialist', 'standard_labour'] : ['standard_labour'];
  switch (line.category) {
    case 'labour':
    case 'minimum_charge':
      switch (line.timeWindow) {
        case 'after_hours': return ['after_hours', ...labourBase];
        case 'overnight': return ['overnight', 'after_hours', ...labourBase];
        case 'weekend': return ['weekend', ...labourBase];
        case 'public_holiday': return ['public_holiday', 'weekend', ...labourBase];
        default: return labourBase;
      }
    case 'callout':
      return ctx.priority === 'emergency' ? ['emergency_callout', 'standard_callout'] : ['standard_callout'];
    case 'travel': return ['travel'];
    case 'materials': return ['materials'];
    case 'variation': return ['variation', ...labourBase];
    case 'cancellation': return ['cancellation'];
  }
}

function specificity(r: PricingRule): number {
  return (r.customer_id ? 4 : 0) + (r.trade_id ? 2 : 0) + (r.priority ? 1 : 0);
}

export function selectRule(rules: PricingRule[], chain: RuleCategory[], ctx: Pick<PricingContext, 'customerId' | 'tradeId' | 'priority'>): PricingRule | null {
  for (const cat of chain) {
    const candidates = rules.filter((r) => r.category === cat
      && (r.customer_id === null || r.customer_id === ctx.customerId)
      && (r.trade_id === null || r.trade_id === ctx.tradeId)
      && (r.priority === null || r.priority === ctx.priority)
      && r.method !== 'minimum');
    if (candidates.length) return candidates.sort((a, b) => specificity(b) - specificity(a))[0];
  }
  return null;
}

function describeScope(r: PricingRule): string {
  const parts = [RULE_CATEGORY_LABELS[r.category]];
  if (r.customer_id) parts.push('customer contract');
  if (r.priority) parts.push(`${r.priority} priority`);
  return parts.join(', ');
}

function priceLine(line: CostLine, rule: PricingRule, ctx: PricingContext, rules: PricingRule[]): { amount: number; explanation: string } {
  switch (rule.method) {
    case 'markup': {
      const amount = addMarkup(line.amountCents, rule.markup_bps!);
      return {
        amount,
        explanation: `${describeScope(rule)}: contractor cost ${formatNzd(line.amountCents)} + ${formatBps(rule.markup_bps!)} markup (${formatNzd(amount - line.amountCents)}) = ${formatNzd(amount)}`,
      };
    }
    case 'fixed_rate': {
      const amount = qtyAmount(line.quantityMilli, rule.customer_rate_cents!);
      return {
        amount,
        explanation: `${describeScope(rule)}: customer rate ${formatNzd(rule.customer_rate_cents!)}/${rule.unit} × ${formatQuantity(line.quantityMilli)} = ${formatNzd(amount)} (replaces markup on contractor cost)`,
      };
    }
    case 'standard_multiplier': {
      const stdRate = ctx.standardContractorLabourRateCents;
      if (!stdRate) throw new AppError(`Rule "${describeScope(rule)}" needs the contractor's standard labour rate (no approved rate card found)`);
      const stdRule = selectRule(rules, ruleChainFor({ category: 'labour', timeWindow: 'standard' }, ctx), ctx);
      if (!stdRule || stdRule.method === 'standard_multiplier') throw new AppError('A standard labour rule (markup or fixed rate) is required for multiplier pricing');
      const stdCost = qtyAmount(line.quantityMilli, stdRate);
      const stdCustomer = stdRule.method === 'markup' ? addMarkup(stdCost, stdRule.markup_bps!) : qtyAmount(line.quantityMilli, stdRule.customer_rate_cents!);
      const amount = applyBps(stdCustomer, rule.customer_multiplier_bps!);
      return {
        amount,
        explanation: `${describeScope(rule)}: standard customer price ${formatNzd(stdCustomer)} (${formatQuantity(line.quantityMilli)} × standard rate) × ${formatMultiplier(rule.customer_multiplier_bps!)} = ${formatNzd(amount)} (contractor premium not marked up again)`,
      };
    }
    default:
      throw new AppError(`Rule method ${rule.method} cannot price a line`);
  }
}

/** Prices contractor cost lines into customer charges using approved rules, then applies the minimum charge and GST. */
export function priceCostLines(
  costLines: CostLine[], ctx: PricingContext, rules: PricingRule[],
  settings: Pick<Settings, 'gst_rate_bps' | 'ridgeline_gst_registered'>,
): PricingResult {
  const lines: PricedLine[] = costLines.map((l) => {
    const chain = ruleChainFor(l, ctx);
    const rule = selectRule(rules, chain, ctx);
    if (!rule) throw new AppError(`No approved customer pricing rule for ${chain.map((c) => RULE_CATEGORY_LABELS[c]).join(' / ')}. An administrator must approve one before this can be priced.`, 409, 'no_pricing_rule');
    const { amount, explanation } = priceLine(l, rule, ctx, rules);
    return {
      category: l.category,
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: mulDiv(amount, 1000, l.quantityMilli),
      amountExGstCents: amount,
      contractorCostCents: l.amountCents,
      ruleId: rule.id,
      ruleCategory: rule.category,
      explanation,
      contractorLineId: l.contractorLineId ?? null,
    };
  });

  let subtotal = lines.reduce((s, l) => s + l.amountExGstCents, 0);
  const attended = costLines.some((l) => l.category !== 'cancellation');
  if (attended) {
    const minRule = rules
      .filter((r) => r.category === 'minimum_charge' && r.method === 'minimum'
        && (r.customer_id === null || r.customer_id === ctx.customerId)
        && (r.trade_id === null || r.trade_id === ctx.tradeId)
        && (r.priority === null || r.priority === ctx.priority))
      .sort((a, b) => specificity(b) - specificity(a))[0];
    if (minRule && subtotal < minRule.minimum_cents!) {
      const adj = minRule.minimum_cents! - subtotal;
      lines.push({
        category: 'minimum_charge', description: 'Minimum job charge adjustment', quantityMilli: 1000, unitPriceCents: adj,
        amountExGstCents: adj, contractorCostCents: 0, ruleId: minRule.id, ruleCategory: 'minimum_charge', contractorLineId: null,
        explanation: `${describeScope(minRule)}: charges of ${formatNzd(subtotal)} are below the ${formatNzd(minRule.minimum_cents!)} minimum, adjustment ${formatNzd(adj)}`,
      });
      subtotal = minRule.minimum_cents!;
    }
  }

  const contractorCost = costLines.reduce((s, l) => s + l.amountCents, 0);
  // GST is calculated once on the GST-exclusive subtotal; markup is never applied to GST.
  const gst = settings.ridgeline_gst_registered ? gstOn(subtotal, settings.gst_rate_bps) : 0;
  return {
    lines,
    contractorCostExGstCents: contractorCost,
    subtotalExGstCents: subtotal,
    markupCents: subtotal - contractorCost,
    gstCents: gst,
    totalCents: subtotal + gst,
    grossMarginBps: subtotal > 0 ? mulDiv(subtotal - contractorCost, 10000, subtotal) : 0,
    gstRateBps: settings.ridgeline_gst_registered ? settings.gst_rate_bps : 0,
    gstExplanation: settings.ridgeline_gst_registered
      ? `GST ${formatBps(settings.gst_rate_bps)} on ${formatNzd(subtotal)} (GST-exclusive) = ${formatNzd(gst)}`
      : 'Ridgeline is not GST-registered: no GST charged',
  };
}

export async function loadApprovedRules(db: Db, customerId: string | null): Promise<PricingRule[]> {
  return query<PricingRule>(db,
    `SELECT * FROM pricing_rules WHERE status = 'approved' AND (customer_id IS NULL OR customer_id = $1)`, [customerId]);
}

/** Pre-booking estimate using each rule's reference contractor rate and the trade's typical duration. */
export function buildEstimateCostLines(
  rules: PricingRule[], ctx: PricingContext, window: TimeWindow, estimateHours: number,
): CostLine[] {
  const labourChain = ruleChainFor({ category: 'labour', timeWindow: window }, ctx);
  const labourRule = labourChain.map((cat) => selectRule(rules, [cat], ctx)).find((r) => r?.reference_contractor_rate_cents);
  const stdRule = selectRule(rules, ['standard_labour'], ctx);
  const labourRate = labourRule?.reference_contractor_rate_cents ?? stdRule?.reference_contractor_rate_cents;
  if (!labourRate) throw new AppError('No reference contractor labour rate configured for estimates', 409);
  const calloutRule = ruleChainFor({ category: 'callout', timeWindow: window }, ctx)
    .map((cat) => selectRule(rules, [cat], ctx)).find((r) => r?.reference_contractor_rate_cents);
  const qty = Math.round(estimateHours * 1000);
  const lines: CostLine[] = [];
  if (calloutRule?.reference_contractor_rate_cents) {
    lines.push({ category: 'callout', description: ctx.priority === 'emergency' ? 'Emergency callout (estimated)' : 'Callout (estimated)',
      quantityMilli: 1000, unitRateCents: calloutRule.reference_contractor_rate_cents, amountCents: calloutRule.reference_contractor_rate_cents, timeWindow: window });
  }
  lines.push({ category: 'labour', description: `Labour, approx. ${estimateHours} h (estimated)`, quantityMilli: qty, unitRateCents: labourRate,
    amountCents: qtyAmount(qty, labourRate), timeWindow: window });
  return lines;
}

// ---------------------------------------------------------------------------
// Rule administration: rules are created as drafts and must be approved by an administrator.
// ---------------------------------------------------------------------------

export interface RuleInput {
  category: RuleCategory;
  customerId?: string | null;
  tradeId?: number | null;
  priority?: Priority | null;
  method: PricingRule['method'];
  markupBps?: number | null;
  customerRateCents?: number | null;
  customerMultiplierBps?: number | null;
  minimumCents?: number | null;
  referenceContractorRateCents?: number | null;
  unit?: string;
  description?: string;
}

export async function createDraftRule(db: Db, actor: Actor, input: RuleInput) {
  if (!['admin', 'finance'].includes(actor.role)) throw new AppError('Only administrators or finance can propose pricing rules', 403);
  if (!RULE_CATEGORIES.includes(input.category)) throw new AppError('Invalid pricing category');
  if (input.method === 'minimum' && input.category !== 'minimum_charge') throw new AppError('Minimum method is only valid for the minimum charge category');
  if (input.category === 'minimum_charge' && input.method !== 'minimum') throw new AppError('The minimum charge category uses the minimum method');
  if (input.markupBps != null && (input.markupBps < 0 || input.markupBps > 50000)) throw new AppError('Markup must be between 0% and 500%');
  const row = await one(db,
    `INSERT INTO pricing_rules (category, customer_id, trade_id, priority, method, markup_bps, customer_rate_cents, customer_multiplier_bps,
       minimum_cents, reference_contractor_rate_cents, unit, description, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13) RETURNING *`,
    [input.category, input.customerId || null, input.tradeId || null, input.priority || null, input.method, input.markupBps ?? null,
     input.customerRateCents ?? null, input.customerMultiplierBps ?? null, input.minimumCents ?? null, input.referenceContractorRateCents ?? null,
     input.unit ?? 'each', input.description ?? null, actor.id]).catch((err) => {
       if (err.code === '23514') throw new AppError('The chosen method is missing its rate, markup, multiplier or minimum');
       throw err;
     });
  await audit(db, actor, { action: 'pricing_rule.drafted', entityType: 'pricing_rule', entityId: row.id, customerId: input.customerId ?? null, details: { ...input } });
  return row;
}

/** Approves a draft rule, retiring any previously approved rule with the same scope. */
export async function approveRule(db: Db, actor: Actor, ruleId: string) {
  if (actor.role !== 'admin') throw new AppError('Only an administrator can approve customer pricing rules', 403);
  return tx(db, async (c) => {
    const rule = await maybeOne(c, 'SELECT * FROM pricing_rules WHERE id = $1 FOR UPDATE', [ruleId]);
    if (!rule) throw new NotFoundError('Pricing rule');
    if (rule.status !== 'draft') throw new AppError('Only draft rules can be approved');
    const retired = await query(c,
      `UPDATE pricing_rules SET status = 'retired', retired_at = now()
        WHERE status = 'approved' AND category = $1 AND customer_id IS NOT DISTINCT FROM $2 AND trade_id IS NOT DISTINCT FROM $3
          AND priority IS NOT DISTINCT FROM $4 RETURNING id`,
      [rule.category, rule.customer_id, rule.trade_id, rule.priority]);
    const approved = await one(c, `UPDATE pricing_rules SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *`, [ruleId, actor.id]);
    await audit(c, actor, { action: 'pricing_rule.approved', entityType: 'pricing_rule', entityId: ruleId, customerId: rule.customer_id,
      details: { retired: retired.map((r) => r.id) } });
    return approved;
  });
}

export async function retireRule(db: Db, actor: Actor, ruleId: string) {
  if (actor.role !== 'admin') throw new AppError('Only an administrator can retire pricing rules', 403);
  const r = await maybeOne(db, `UPDATE pricing_rules SET status = 'retired', retired_at = now() WHERE id = $1 AND status <> 'retired' RETURNING *`, [ruleId]);
  if (!r) throw new NotFoundError('Pricing rule');
  await audit(db, actor, { action: 'pricing_rule.retired', entityType: 'pricing_rule', entityId: ruleId });
  return r;
}
