import { beforeEach, describe, expect, it } from 'vitest';
import { acceptAssessment, runAssessment } from '../src/services/assessment.js';
import { db, newCustomer, resetDb, staff } from './helpers.js';

beforeEach(resetDb);

const SCENARIOS: { name: string; facilities: { type: string; units: number }[] }[] = [
  { name: '10 one-bedroom residential units', facilities: [{ type: 'res_studio_1bed', units: 10 }] },
  { name: '40 mixed residential units', facilities: [{ type: 'res_studio_1bed', units: 20 }, { type: 'res_2bed_plus', units: 20 }] },
  { name: '100 residential units', facilities: [{ type: 'res_2bed_plus', units: 100 }] },
  { name: '5 commercial offices', facilities: [{ type: 'office_small', units: 5 }] },
  { name: '15 commercial offices', facilities: [{ type: 'office_small', units: 15 }] },
  { name: '30 commercial offices', facilities: [{ type: 'office_small', units: 30 }] },
  { name: 'mixed residential and commercial portfolio', facilities: [{ type: 'res_2bed_plus', units: 30 }, { type: 'office_small', units: 4 }, { type: 'retail', units: 2 }] },
];

describe('criterion 1: minimum balance recommendations differ by portfolio and are explainable', () => {
  it('produces different, explained recommendations for each test portfolio', async () => {
    const admin = await staff('admin');
    const results: Record<string, any> = {};
    for (const s of SCENARIOS) {
      const fx = await newCustomer({ facilities: s.facilities, category: s.facilities[0].type.startsWith('office') ? 'commercial' : 'residential' });
      const { result } = await runAssessment(db, admin, fx.customerId);
      results[s.name] = result;
      // Every assessment explains each step from configured assumptions.
      expect(result.steps.length).toBeGreaterThanOrEqual(6);
      expect(result.lines).toHaveLength(s.facilities.length);
      for (const l of result.lines) expect(l.explanation).toMatch(/jobs\/month/);
      expect(result.recommendedCents).toBeGreaterThanOrEqual(100000);
    }
    const values = Object.values(results).map((r) => r.calculatedCents);
    expect(new Set(values).size).toBe(values.length);

    // More units → larger requirement within the same facility type.
    expect(results['15 commercial offices'].calculatedCents).toBeGreaterThan(results['5 commercial offices'].calculatedCents);
    expect(results['30 commercial offices'].calculatedCents).toBeGreaterThan(results['15 commercial offices'].calculatedCents);
    expect(results['100 residential units'].calculatedCents).toBeGreaterThan(results['40 mixed residential units'].calculatedCents);

    // Mixed residential + commercial portfolios use the 'mixed' coverage factor.
    expect(results['mixed residential and commercial portfolio'].effectiveCategory).toBe('mixed');
    expect(results['40 mixed residential units'].effectiveCategory).toBe('residential');

    // Large portfolios are flagged for a custom arrangement instead of being silently capped at $15,000.
    const big = results['30 commercial offices'];
    expect(big.requiresCustom).toBe(true);
    expect(big.recommendedCents).toBeGreaterThan(1500000);
    expect(big.steps.join(' ')).toMatch(/custom arrangement/);
    expect(results['10 one-bedroom residential units'].requiresCustom).toBe(false);
  });

  it('applies the NZ$1,000 floor and says so', async () => {
    const fx = await newCustomer({ facilities: [{ type: 'res_studio_1bed', units: 2 }] });
    const { result } = await runAssessment(db, await staff('admin'), fx.customerId);
    expect(result.recommendedCents).toBe(100000);
    expect(result.floorApplied).toBe(true);
    expect(result.steps.join(' ')).toMatch(/\$1,000\.00 account minimum/);
  });

  it('recalculates from administrator-configured assumptions (nothing hardcoded)', async () => {
    const admin = await staff('admin');
    const fx = await newCustomer({ facilities: [{ type: 'res_2bed_plus', units: 50 }] });
    const before = (await runAssessment(db, admin, fx.customerId)).result.calculatedCents;
    await db.query(`UPDATE facility_types SET avg_contractor_cost_cents = avg_contractor_cost_cents * 2 WHERE code = 'res_2bed_plus'`);
    await db.query(`UPDATE coverage_factors SET factor_bps = 40000 WHERE customer_category = 'residential' AND service_level = 'standard'`);
    try {
      const after = (await runAssessment(db, admin, fx.customerId)).result;
      expect(after.calculatedCents).toBeGreaterThan(before);
      expect(after.coverageFactorBps).toBe(40000);
    } finally {
      await db.query(`UPDATE facility_types SET avg_contractor_cost_cents = avg_contractor_cost_cents / 2 WHERE code = 'res_2bed_plus'`);
      await db.query(`UPDATE coverage_factors SET factor_bps = 30000 WHERE customer_category = 'residential' AND service_level = 'standard'`);
    }
  });

  it('requires an administrator-authorised amount and reason for custom arrangements', async () => {
    const admin = await staff('admin');
    const finance = await staff('finance');
    const fx = await newCustomer({ category: 'commercial', facilities: [{ type: 'office_large', units: 20 }] });
    const { id, result } = await runAssessment(db, admin, fx.customerId);
    expect(result.requiresCustom).toBe(true);
    await expect(acceptAssessment(db, admin, id)).rejects.toThrow(/custom arrangement requires/);
    await expect(acceptAssessment(db, finance, id, { agreedCents: 2500000, notes: 'x' })).rejects.toThrow(/administrator/);
    const customer = await acceptAssessment(db, admin, id, { agreedCents: 2500000, notes: 'Board approved 18 Oct; quarterly review' });
    expect(customer.agreed_minimum_balance_cents).toBe(2500000);
    expect(customer.custom_arrangement).toBe(true);
    expect(customer.status).toBe('pending_deposit');
  });
});
