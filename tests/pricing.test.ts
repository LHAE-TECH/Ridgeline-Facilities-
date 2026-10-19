import { describe, expect, it } from 'vitest';
import { addMarkup, gstOn, mulDiv, parseDollars } from '../src/lib/money.js';
import { type CostLine, type PricingRule, priceCostLines, ruleChainFor } from '../src/services/pricing.js';
import { SETTING_DEFAULTS } from '../src/services/settings.js';
import { classifyTime } from '../src/services/timeWindows.js';

const settings = { gst_rate_bps: 1500, ridgeline_gst_registered: true };
const ctx = { customerId: 'cust-1', tradeId: 1, tradeIsSpecialist: false, priority: 'routine' as const, standardContractorLabourRateCents: 8000 };

function rule(category: PricingRule['category'], over: Partial<PricingRule> = {}): PricingRule {
  return { id: `${category}-${over.customer_id ?? 'global'}-${over.method ?? 'markup'}`, category, customer_id: null, trade_id: null, priority: null,
    method: 'markup', markup_bps: 3500, customer_rate_cents: null, customer_multiplier_bps: null, minimum_cents: null,
    reference_contractor_rate_cents: null, unit: 'each', description: null, ...over };
}

const defaults: PricingRule[] = (['standard_labour', 'standard_callout', 'emergency_callout', 'after_hours', 'weekend', 'public_holiday', 'overnight',
  'travel', 'materials', 'specialist', 'variation', 'cancellation'] as const).map((c) => rule(c));

const line = (over: Partial<CostLine>): CostLine => ({ category: 'labour', description: 'Work', quantityMilli: 1000, unitRateCents: 20000, amountCents: 20000, timeWindow: 'standard', ...over });

describe('money arithmetic', () => {
  it('rounds half-up with integer maths', () => {
    expect(mulDiv(1, 1, 2)).toBe(1);
    expect(mulDiv(5, 1, 3)).toBe(2);
    expect(addMarkup(20000, 3500)).toBe(27000);
    expect(gstOn(27000, 1500)).toBe(4050);
    expect(parseDollars('$1,234.5')).toBe(123450);
  });
});

describe('criterion 9: 35% markup on NZ$200 contractor cost', () => {
  it('produces NZ$270 ex GST, NZ$70 markup and a 25.93% gross margin (not 35%)', () => {
    const r = priceCostLines([line({ amountCents: 20000 })], ctx, defaults, settings);
    expect(r.contractorCostExGstCents).toBe(20000);
    expect(r.subtotalExGstCents).toBe(27000);
    expect(r.markupCents).toBe(7000);
    expect(r.grossMarginBps).toBe(2593);
    expect(r.lines[0].explanation).toContain('$200.00 + 35% markup ($70.00) = $270.00');
  });
});

describe('criterion 10: higher callout and after-hours contractor rates flow into customer pricing', () => {
  it('marks up a NZ$100 standard callout to NZ$135', () => {
    const r = priceCostLines([line({ category: 'callout', amountCents: 10000, unitRateCents: 10000 })], ctx, defaults, settings);
    expect(r.subtotalExGstCents).toBe(13500);
    expect(r.lines[0].ruleCategory).toBe('standard_callout');
  });

  it('uses the emergency callout rule for emergency jobs and marks up the higher contractor callout', () => {
    const r = priceCostLines([line({ category: 'callout', amountCents: 15000, unitRateCents: 15000 })], { ...ctx, priority: 'emergency' }, defaults, settings);
    expect(r.lines[0].ruleCategory).toBe('emergency_callout');
    expect(r.subtotalExGstCents).toBe(20250);
  });

  it('marks up a higher after-hours contractor cost once (method A)', () => {
    // 2h at contractor after-hours $120/h = $240 → customer $324
    const r = priceCostLines([line({ quantityMilli: 2000, unitRateCents: 12000, amountCents: 24000, timeWindow: 'after_hours' })], ctx, defaults, settings);
    expect(r.lines[0].ruleCategory).toBe('after_hours');
    expect(r.subtotalExGstCents).toBe(32400);
  });

  it('supports a separate customer emergency rate instead of markup without double charging (method B)', () => {
    const contractRule = rule('after_hours', { customer_id: 'cust-1', method: 'fixed_rate', markup_bps: null, customer_rate_cents: 15000, unit: 'hour' });
    const r = priceCostLines([line({ quantityMilli: 2000, unitRateCents: 12000, amountCents: 24000, timeWindow: 'after_hours' })], ctx, [...defaults, contractRule], settings);
    expect(r.lines[0].ruleId).toBe(contractRule.id);
    expect(r.subtotalExGstCents).toBe(30000); // 2h × $150, NOT $240 × 1.35 + premium
    expect(r.markupCents).toBe(6000);
  });

  it('supports customer multipliers on the standard rate that ignore the contractor premium', () => {
    const mult = rule('weekend', { method: 'standard_multiplier', markup_bps: null, customer_multiplier_bps: 15000 });
    const rules = [...defaults.filter((r) => r.category !== 'weekend'), mult];
    // contractor standard $80/h; 2h standard customer = $160 × 1.35 = $216; × 1.5 = $324 regardless of contractor weekend rate
    const r = priceCostLines([line({ quantityMilli: 2000, unitRateCents: 14000, amountCents: 28000, timeWindow: 'weekend' })], ctx, rules, settings);
    expect(r.subtotalExGstCents).toBe(32400);
    expect(r.lines[0].explanation).toContain('not marked up again');
  });

  it('prices each line with exactly one rule so premiums never stack', () => {
    expect(ruleChainFor({ category: 'labour', timeWindow: 'public_holiday' }, ctx)[0]).toBe('public_holiday');
    const r = priceCostLines([line({ amountCents: 20000, timeWindow: 'public_holiday' })], ctx, defaults, settings);
    expect(r.lines).toHaveLength(1);
    expect(r.subtotalExGstCents).toBe(27000);
  });

  it('classifies a public holiday that falls on a weekend as one window', () => {
    const s = { ...SETTING_DEFAULTS, time_window_precedence: [...SETTING_DEFAULTS.time_window_precedence] } as any;
    const holidays = new Set(['2026-12-26']);
    // Saturday 26 Dec 2026 11:00 NZDT
    expect(classifyTime(new Date('2026-12-26T11:00:00+13:00'), s, holidays)).toBe('public_holiday');
    expect(classifyTime(new Date('2026-10-20T10:00:00+13:00'), s, new Set())).toBe('standard');
    expect(classifyTime(new Date('2026-10-20T19:00:00+13:00'), s, new Set())).toBe('after_hours');
    expect(classifyTime(new Date('2026-10-20T23:30:00+13:00'), s, new Set())).toBe('overnight');
    expect(classifyTime(new Date('2026-10-24T10:00:00+13:00'), s, new Set())).toBe('weekend');
  });

  it('applies the most specific approved rule (customer contract over global)', () => {
    const contract = rule('standard_labour', { customer_id: 'cust-1', markup_bps: 2500 });
    const r = priceCostLines([line({ amountCents: 20000 })], ctx, [...defaults, contract], settings);
    expect(r.subtotalExGstCents).toBe(25000);
  });

  it('refuses to price when no approved rule exists rather than guessing', () => {
    expect(() => priceCostLines([line({ category: 'travel' })], ctx, defaults.filter((r) => r.category !== 'travel'), settings)).toThrow(/No approved customer pricing rule/);
  });
});

describe('criterion 11: GST calculated once on the GST-exclusive total', () => {
  it('adds 15% GST to the marked-up subtotal and never marks up GST', () => {
    const r = priceCostLines([line({ amountCents: 20000 }), line({ category: 'callout', amountCents: 10000 })], ctx, defaults, settings);
    expect(r.subtotalExGstCents).toBe(40500);
    expect(r.gstCents).toBe(6075);
    expect(r.totalCents).toBe(46575);
  });

  it('charges no GST when Ridgeline is not GST-registered', () => {
    const r = priceCostLines([line({ amountCents: 20000 })], ctx, defaults, { ...settings, ridgeline_gst_registered: false });
    expect(r.gstCents).toBe(0);
    expect(r.totalCents).toBe(27000);
  });

  it('applies the minimum job charge before GST', () => {
    const r = priceCostLines([line({ category: 'callout', amountCents: 5000 })], ctx,
      [...defaults, rule('minimum_charge', { method: 'minimum', markup_bps: null, minimum_cents: 13500 })], settings);
    expect(r.subtotalExGstCents).toBe(13500);
    expect(r.lines.at(-1)!.description).toBe('Minimum job charge adjustment');
    expect(r.gstCents).toBe(2025);
  });
});
