import { localParts } from './timeWindows.js';

/**
 * NZ business-time arithmetic for SLA clocks. Works in the configured time zone (Pacific/Auckland) including
 * daylight-saving changes, skips weekends/non-business days and public holidays.
 */

export interface BusinessHours { start: string; end: string; days: number[] }

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Offset of the zone from UTC at an instant, in minutes (e.g. +780 for NZDT). */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** The UTC instant of a local wall-clock time (date 'YYYY-MM-DD', minutes after local midnight). */
export function zonedTime(date: string, minutes: number, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, minutes);
  let offset = zoneOffsetMinutes(new Date(guess), timeZone);
  let instant = guess - offset * 60000;
  const second = zoneOffsetMinutes(new Date(instant), timeZone);
  if (second !== offset) { offset = second; instant = guess - offset * 60000; }
  return new Date(instant);
}

function nextDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  const w = new Date(`${date}T12:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

export function isBusinessDay(date: string, hours: BusinessHours, holidays: Set<string>): boolean {
  return hours.days.includes(weekdayOf(date)) && !holidays.has(date);
}

export function businessDayMinutes(hours: BusinessHours): number {
  return toMinutes(hours.end) - toMinutes(hours.start);
}

/** Adds a number of business minutes to an instant. Time outside business hours does not count. */
export function addBusinessMinutes(start: Date, minutes: number, hours: BusinessHours, holidays: Set<string>, timeZone: string): Date {
  const open = toMinutes(hours.start);
  const close = toMinutes(hours.end);
  if (close <= open) throw new Error('Business hours end must be after start');
  let { date, minutes: cur } = localParts(start, timeZone);
  let remaining = minutes;
  for (let guard = 0; guard < 3700; guard++) {
    if (!isBusinessDay(date, hours, holidays) || cur >= close) {
      date = nextDate(date);
      cur = open;
      continue;
    }
    if (cur < open) cur = open;
    const available = close - cur;
    if (remaining <= available) return zonedTime(date, cur + remaining, timeZone);
    remaining -= available;
    date = nextDate(date);
    cur = open;
  }
  throw new Error('Business-time calculation did not converge');
}

/** Business minutes elapsed between two instants (used for performance reporting). */
export function businessMinutesBetween(from: Date, to: Date, hours: BusinessHours, holidays: Set<string>, timeZone: string): number {
  if (to <= from) return 0;
  const open = toMinutes(hours.start);
  const close = toMinutes(hours.end);
  const a = localParts(from, timeZone);
  const b = localParts(to, timeZone);
  let total = 0;
  let date = a.date;
  for (let guard = 0; guard < 3700; guard++) {
    if (isBusinessDay(date, hours, holidays)) {
      const s = date === a.date ? Math.max(open, a.minutes) : open;
      const e = date === b.date ? Math.min(close, b.minutes) : close;
      if (e > s) total += e - s;
    }
    if (date === b.date) return total;
    date = nextDate(date);
  }
  return total;
}

/** End of business on the local date of an instant (or the instant itself if later). */
export function endOfBusinessDay(instant: Date, hours: BusinessHours, timeZone: string): Date {
  const { date } = localParts(instant, timeZone);
  const end = zonedTime(date, toMinutes(hours.end), timeZone);
  return end > instant ? end : instant;
}
