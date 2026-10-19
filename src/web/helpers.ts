import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { maybeOne, pool } from '../db.js';
import type { Actor, Role } from '../lib/actor.js';
import { AppError, ForbiddenError } from '../lib/errors.js';
import { formatBps, formatMultiplier, formatNzd, formatQuantity, parseDollars, parseQuantity } from '../lib/money.js';
import { JOB_STATUS_LABELS } from '../services/jobState.js';
import { TIME_WINDOW_LABELS } from '../services/timeWindows.js';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    csrf?: string;
    flash?: { type: 'success' | 'error' | 'info'; message: string }[];
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { actor?: Actor }
  }
}

export function flash(req: Request, type: 'success' | 'error' | 'info', message: string): void {
  req.session.flash = [...(req.session.flash ?? []), { type, message }];
}

/** Loads the signed-in user on every request (re-reads the DB so deactivation takes effect immediately). */
export const loadUser: RequestHandler = async (req, res, next) => {
  if (req.session.userId) {
    const u = await maybeOne(pool,
      `SELECT u.*, c.name AS customer_name, k.legal_name AS contractor_name FROM users u
         LEFT JOIN customers c ON c.id = u.customer_id LEFT JOIN contractors k ON k.id = u.contractor_id
        WHERE u.id = $1 AND u.is_active`, [req.session.userId]);
    if (u) {
      req.actor = { id: u.id, role: u.role, name: u.name, email: u.email, customerId: u.customer_id, customerRole: u.customer_role,
        approvalLimitCents: u.approval_limit_cents, contractorId: u.contractor_id, ip: req.ip };
      res.locals.orgName = u.customer_name ?? u.contractor_name ?? 'Ridgeline Facilities';
    } else {
      delete req.session.userId;
    }
  }
  if (!req.session.csrf) req.session.csrf = randomBytes(24).toString('hex');
  res.locals.actor = req.actor ?? null;
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash ?? [];
  req.session.flash = [];
  res.locals.path = req.path;
  Object.assign(res.locals, viewHelpers);
  next();
};

/** Rejects state-changing requests without the session's CSRF token. */
export const verifyCsrf: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  const expected = req.session.csrf ?? '';
  if (!sent || sent.length !== expected.length || !timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
    return next(new AppError('Your session expired or the form is invalid. Please try again.', 403, 'csrf'));
  }
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    if (!req.actor) {
      if (req.method === 'GET') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return next(new AppError('Please sign in', 401));
    }
    if (!roles.includes(req.actor.role as Role)) return next(new ForbiddenError());
    next();
  };
}

export function actor(req: Request): Actor {
  if (!req.actor) throw new AppError('Please sign in', 401);
  return req.actor;
}

/**
 * Wraps a form POST: on success redirects (with an optional flash), on a business-rule error redirects back with
 * the message so the user can correct it.
 */
export function action(fn: (req: Request, res: Response) => Promise<string | { redirect: string; message?: string } | void>): RequestHandler {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (res.headersSent) return;
      if (typeof out === 'string') return res.redirect(out);
      if (out) {
        if (out.message) flash(req, 'success', out.message);
        return res.redirect(out.redirect);
      }
      res.redirect(back(req));
    } catch (err) {
      if (err instanceof AppError && err.status < 500 && err.status !== 401 && err.code !== 'csrf') {
        flash(req, 'error', err.message);
        return res.redirect(back(req));
      }
      next(err);
    }
  };
}

export function back(req: Request): string {
  const ref = req.get('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.host === req.get('host')) return u.pathname + u.search;
    } catch { /* ignore */ }
  }
  return '/';
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.storage.maxUploadBytes, files: 12 } });

/** Multipart parsing followed by CSRF verification (the token is in the multipart body). */
export function multipart(field: string, maxCount = 10): RequestHandler[] {
  return [
    (req, res, next) => upload.array(field, maxCount)(req, res, (err: unknown) => {
      if (err) return next(new AppError(err instanceof multer.MulterError ? `Upload failed: ${err.message}` : 'Upload failed', 400));
      next();
    }),
    verifyCsrf,
  ];
}

export function uploadedFiles(req: Request): { buffer: Buffer; originalName: string; mimeType: string }[] {
  return ((req.files as Express.Multer.File[] | undefined) ?? []).filter((f) => f.size > 0)
    .map((f) => ({ buffer: f.buffer, originalName: f.originalname, mimeType: f.mimetype }));
}

// ---- Form parsing helpers ----
export function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
export function optStr(v: unknown): string | undefined { const s = str(v); return s || undefined; }
export function dollars(v: unknown, label = 'Amount'): number {
  try { return parseDollars(str(v)); } catch { throw new AppError(`${label} must be a dollar amount`); }
}
export function optDollars(v: unknown, label?: string): number | undefined { return str(v) ? dollars(v, label) : undefined; }
export function int(v: unknown, label = 'Value'): number {
  const n = Number(str(v));
  if (!Number.isInteger(n)) throw new AppError(`${label} must be a whole number`);
  return n;
}
export function optInt(v: unknown, label?: string): number | undefined { return str(v) ? int(v, label) : undefined; }
export function num(v: unknown): number | null { const s = str(v); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; }
export function bool(v: unknown): boolean { return v === 'on' || v === 'true' || v === '1' || v === 'yes'; }
export function qty(v: unknown, label = 'Quantity'): number {
  try { return parseQuantity(str(v)); } catch { throw new AppError(`${label} must be a number (up to 3 decimals)`); }
}
export function arr(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : v === undefined || v === '' ? [] : [String(v)]; }
export function geo(body: any) { return { lat: num(body.lat), lng: num(body.lng), accuracy: num(body.accuracy) }; }
export function localDateTime(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  // <input type="datetime-local"> has no zone: interpret it as New Zealand time.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new AppError('Invalid date/time');
  const utcGuess = new Date(`${s}Z`);
  const nzOffsetMin = (new Date(utcGuess.toLocaleString('en-US', { timeZone: 'Pacific/Auckland' })).getTime() - new Date(utcGuess.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()) / 60000;
  return new Date(utcGuess.getTime() - nzOffsetMin * 60000).toISOString();
}
export function newKey(): string { return randomBytes(12).toString('hex'); }

export const viewHelpers = {
  money: formatNzd,
  bps: formatBps,
  mult: formatMultiplier,
  qtyFmt: formatQuantity,
  statusLabel: (s: string) => (JOB_STATUS_LABELS as Record<string, string>)[s] ?? s,
  windowLabel: (w: string) => (TIME_WINDOW_LABELS as Record<string, string>)[w] ?? w,
  humanize: (s: string | null | undefined) => (s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
  date: (d: string | Date | null | undefined) => {
    if (!d) return '—';
    // Date-only values (YYYY-MM-DD) are calendar dates: format without any timezone shift.
    if (typeof d === 'string' && d.length === 10) {
      return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    }
    return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Pacific/Auckland' });
  },
  dt: (d: string | Date | null | undefined) => d ? new Date(d).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Pacific/Auckland' }) : '—',
  dollarsInput: (cents: number | null | undefined) => (cents == null ? '' : (cents / 100).toFixed(2)),
  newKey,
};

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  const status = err instanceof AppError ? err.status : err?.status === 413 ? 413 : 500;
  if (status >= 500) console.error(err);
  if (status === 401 && req.method === 'GET') return res.redirect('/login');
  if (err instanceof AppError && err.code === 'csrf' && req.method === 'POST') {
    flash(req, 'error', err.message);
    return res.redirect(back(req));
  }
  res.status(status);
  if (req.accepts(['html', 'json']) === 'json') {
    res.json({ error: status >= 500 ? 'Internal error' : err.message });
    return;
  }
  res.render('error', { status, message: status >= 500 ? 'Something went wrong. The error has been logged.' : err.message });
}

/** The ':id' route parameter (Express 5 types params as string | string[]). */
export function pid(req: Request): string {
  const v = req.params.id;
  return Array.isArray(v) ? v[0] : String(v);
}
