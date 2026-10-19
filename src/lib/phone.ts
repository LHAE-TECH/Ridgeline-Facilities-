/**
 * New Zealand phone numbers in E.164 (+64…). Accepts "021 555 0199", "0215550199", "+64 21 555 0199", "64215550199".
 * Returns null when the input is not a plausible NZ number.
 */
export function normaliseNzPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('64') && !s.startsWith('+')) s = `+${s}`;
  if (s.startsWith('0')) s = `+64${s.slice(1)}`;
  return /^\+64[0-9]{8,10}$/.test(s) ? s : null;
}

/** NZ mobile numbers start +642 (021, 022, 027, 029, 020…). */
export function isNzMobile(e164: string | null | undefined): boolean {
  return !!e164 && /^\+642[0-9]{7,9}$/.test(e164);
}
