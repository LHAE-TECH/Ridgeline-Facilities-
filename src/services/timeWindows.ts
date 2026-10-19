import type { Db } from '../db.js';
import { query } from '../db.js';
import type { Settings } from './settings.js';

export type TimeWindow = 'standard' | 'after_hours' | 'weekend' | 'public_holiday' | 'overnight';
export const TIME_WINDOWS: TimeWindow[] = ['standard', 'after_hours', 'weekend', 'public_holiday', 'overnight'];
export const TIME_WINDOW_LABELS: Record<TimeWindow, string> = {
  standard: 'Standard hours', after_hours: 'Weekday after-hours', weekend: 'Weekend', public_holiday: 'Public holiday', overnight: 'Overnight',
};

type WindowSettings = Pick<Settings, 'timezone' | 'business_hours' | 'overnight_hours' | 'time_window_precedence'>;

export function localParts(date: Date, timeZone: string): { date: string; weekday: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-NZ', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: weekdays[parts.weekday] ?? 1,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** All windows that apply to an instant, before precedence is applied. */
export function applicableWindows(date: Date, settings: WindowSettings, holidays: Set<string>): Set<TimeWindow> {
  const p = localParts(date, settings.timezone);
  const result = new Set<TimeWindow>();
  if (holidays.has(p.date)) result.add('public_holiday');
  const oStart = toMinutes(settings.overnight_hours.start);
  const oEnd = toMinutes(settings.overnight_hours.end);
  const overnight = oStart > oEnd ? p.minutes >= oStart || p.minutes < oEnd : p.minutes >= oStart && p.minutes < oEnd;
  if (overnight) result.add('overnight');
  if (p.weekday >= 6) result.add('weekend');
  const inBusinessDay = settings.business_hours.days.includes(p.weekday);
  const inBusinessTime = p.minutes >= toMinutes(settings.business_hours.start) && p.minutes < toMinutes(settings.business_hours.end);
  if (!(inBusinessDay && inBusinessTime)) result.add('after_hours');
  return result;
}

/**
 * Classifies an instant into exactly ONE time window using the configured precedence, so that premiums
 * for overlapping windows (e.g. a public holiday that falls on a weekend) are never stacked.
 */
export function classifyTime(date: Date, settings: WindowSettings, holidays: Set<string>): TimeWindow {
  const applicable = applicableWindows(date, settings, holidays);
  for (const w of settings.time_window_precedence as TimeWindow[]) if (applicable.has(w)) return w;
  return 'standard';
}

/** Distinct windows touched by an interval (sampled every 15 minutes). */
export function windowsDuring(start: Date, end: Date, settings: WindowSettings, holidays: Set<string>): Set<TimeWindow> {
  const set = new Set<TimeWindow>();
  const step = 15 * 60 * 1000;
  for (let t = start.getTime(); t <= end.getTime(); t += step) set.add(classifyTime(new Date(t), settings, holidays));
  set.add(classifyTime(end, settings, holidays));
  return set;
}

export async function loadHolidays(db: Db): Promise<Set<string>> {
  const rows = await query<{ d: string }>(db, `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM public_holidays`);
  return new Set(rows.map((r) => r.d));
}
