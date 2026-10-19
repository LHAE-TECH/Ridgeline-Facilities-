import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { maybeOne, pool, query } from '../db.js';
import { SYSTEM_ACTOR } from '../lib/actor.js';
import { AppError } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { createContractor } from '../services/contractors.js';
import { CUSTOMER_CATEGORIES, NZ_REGIONS, registerCustomer } from '../services/customers.js';
import { action, arr, bool, flash, int, optStr, str } from '../web/helpers.js';

export const authRouter = Router();

export function homeFor(role: string): string {
  return role === 'customer' ? '/app' : role === 'contractor' ? '/c' : '/admin';
}

authRouter.get('/', (req, res) => {
  if (req.actor) return res.redirect(homeFor(req.actor.role));
  res.render('home');
});

authRouter.get('/login', (req, res) => {
  if (req.actor) return res.redirect(homeFor(req.actor.role));
  res.render('login', { next: typeof req.query.next === 'string' ? req.query.next : '' });
});

// Constant-time-ish comparison even for unknown emails, to avoid revealing which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

authRouter.post('/login', async (req, res, next) => {
  try {
    const email = str(req.body.email).toLowerCase();
    const user = await maybeOne(pool, 'SELECT * FROM users WHERE email = $1', [email]);
    const ok = await bcrypt.compare(str(req.body.password), user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || !user.is_active) {
      flash(req, 'error', 'Incorrect email or password');
      return res.redirect('/login');
    }
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]).catch(() => undefined);
      audit(pool, { id: user.id, role: user.role, name: user.name, ip: req.ip }, { action: 'user.login', entityType: 'user', entityId: user.id }).catch(() => undefined);
      const nextUrl = str(req.body.next);
      req.session.save(() => res.redirect(nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : homeFor(user.role)));
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

authRouter.get('/register', (_req, res) => res.render('register', { categories: CUSTOMER_CATEGORIES }));

authRouter.post('/register', action(async (req) => {
  if (!bool(req.body.agree)) throw new AppError('Please accept the prepaid account terms and privacy statement');
  if (str(req.body.password) !== str(req.body.password_confirm)) throw new AppError('Passwords do not match');
  const { user } = await registerCustomer(pool, SYSTEM_ACTOR, {
    organisationName: str(req.body.organisation), legalName: optStr(req.body.legal_name), nzbn: optStr(req.body.nzbn), gstNumber: optStr(req.body.gst_number),
    billingEmail: str(req.body.billing_email) || str(req.body.email), phone: optStr(req.body.phone), billingAddress: optStr(req.body.billing_address),
    customerCategory: str(req.body.category), serviceLevel: 'standard', emergencyCover: (str(req.body.emergency_cover) || 'business_hours') as any,
    contactName: str(req.body.name), contactEmail: str(req.body.email), password: str(req.body.password),
  });
  await new Promise<void>((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.userId = user.id;
  flash(req, 'success', 'Welcome! Add your sites and facilities so we can calculate your prepaid account minimum.');
  return '/app/properties';
}));

authRouter.get('/contractors/apply', async (_req, res) => {
  const trades = await query(pool, 'SELECT id, name FROM trades WHERE is_active ORDER BY name');
  res.render('contractor-apply', { trades, regions: NZ_REGIONS });
});

authRouter.post('/contractors/apply', action(async (req) => {
  if (!bool(req.body.ack)) throw new AppError('Please confirm the independent contractor declaration');
  await createContractor(pool, SYSTEM_ACTOR, {
    legalName: str(req.body.legal_name), tradingName: optStr(req.body.trading_name), nzbn: optStr(req.body.nzbn), businessAddress: optStr(req.body.address),
    email: str(req.body.email), phone: optStr(req.body.phone), gstRegistered: bool(req.body.gst_registered), gstNumber: optStr(req.body.gst_number),
    bankAccountName: optStr(req.body.bank_account_name), bankAccountNumber: optStr(req.body.bank_account_number),
    serviceRegions: arr(req.body.regions), tradeIds: arr(req.body.trades).map((t) => int(t)), afterHoursAvailable: bool(req.body.after_hours),
    emergencyAvailable: bool(req.body.emergency), contactName: str(req.body.contact_name), password: str(req.body.password), independentContractorAck: true,
  });
  return { redirect: '/login', message: 'Application received. Sign in to upload your insurance and licences; Ridgeline will verify them before offering jobs.' };
}));

authRouter.get('/privacy', (_req, res) => res.render('privacy'));
