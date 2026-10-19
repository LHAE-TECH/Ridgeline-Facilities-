/**
 * Integer money arithmetic. All amounts are NZD cents; rates are basis points (bps).
 *   100 bps = 1%, 10000 bps = 1.0x.
 * Rounding is half-up (away from zero for positives), applied once per calculated amount.
 */

/** Computes round(a * num / den) using integer arithmetic with half-up rounding. */
export function mulDiv(a: number, num: number, den: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(num) || !Number.isInteger(den) || den === 0) {
    throw new Error(`mulDiv requires integers (got ${a}, ${num}, ${den})`);
  }
  const big = BigInt(a) * BigInt(num);
  const d = BigInt(den);
  const neg = (big < 0n) !== (d < 0n);
  const absN = big < 0n ? -big : big;
  const absD = d < 0n ? -d : d;
  let q = absN / absD;
  if ((absN % absD) * 2n >= absD) q += 1n;
  return Number(neg ? -q : q);
}

/** Applies a multiplier expressed in bps (10000 = 1.0x). */
export function applyBps(cents: number, bps: number): number {
  return mulDiv(cents, bps, 10000);
}

/** Adds a percentage markup expressed in bps (3500 = 35%). */
export function addMarkup(cents: number, markupBps: number): number {
  return mulDiv(cents, 10000 + markupBps, 10000);
}

/** Amount for quantity (thousandths) × unit rate (cents). */
export function qtyAmount(quantityMilli: number, unitRateCents: number): number {
  return mulDiv(quantityMilli, unitRateCents, 1000);
}

/** GST on a GST-exclusive amount. */
export function gstOn(exGstCents: number, gstRateBps: number): number {
  return mulDiv(exGstCents, gstRateBps, 10000);
}

/** GST component of a GST-inclusive amount (e.g. 3/23 for 15%). */
export function gstComponentOfInclusive(incCents: number, gstRateBps: number): number {
  return mulDiv(incCents, gstRateBps, 10000 + gstRateBps);
}

export function formatNzd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-NZ');
  const c = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}$${dollars}.${c}`;
}

/** Parses a user-entered dollar string ("1,234.50", "$200") into integer cents. */
export function parseDollars(input: string | number | null | undefined): number {
  if (input === null || input === undefined) throw new Error('Amount is required');
  const s = String(input).replace(/[$,\s]/g, '').replace(/^NZ/i, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid amount: ${input}`);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return neg ? -cents : cents;
}

/** Parses a decimal quantity ("1.5") into thousandths. */
export function parseQuantity(input: string | number): number {
  const s = String(input).trim();
  if (!/^\d+(\.\d{1,3})?$/.test(s)) throw new Error(`Invalid quantity: ${input}`);
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
}

export function formatQuantity(milli: number): string {
  const v = milli / 1000;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '');
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.00$/, '')}%`;
}

export function formatMultiplier(bps: number): string {
  return `${(bps / 10000).toFixed(2).replace(/0$/, '')}x`;
}

export function percentToBps(input: string | number): number {
  const n = Number(String(input).replace('%', ''));
  if (!Number.isFinite(n)) throw new Error(`Invalid percentage: ${input}`);
  return Math.round(n * 100);
}

export function multiplierToBps(input: string | number): number {
  const n = Number(String(input).replace(/x$/i, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid multiplier: ${input}`);
  return Math.round(n * 10000);
}
