import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { maybeOne, pool, query } from '../db.js';
import { SYSTEM_ACTOR } from '../lib/actor.js';
import { AppError } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { getSettings } from '../services/settings.js';
import { acceptPendingAgreement, pendingAcceptanceFor } from '../services/agreements.js';
import { CONTRACTOR_AGREEMENT_VERSION, CUSTOMER_TERMS_VERSION } from '../services/terms.js';
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
      const dest = nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : homeFor(user.role);
      // A superseded material agreement must be accepted at sign-in, by anyone able to accept it.
      pendingAcceptanceFor(pool, { id: user.id, role: user.role, name: user.name, customerId: user.customer_id, customerRole: user.customer_role, contractorId: user.contractor_id })
        .then((pending) => req.session.save(() => res.redirect(pending?.canAccept ? `/agreements/accept?next=${encodeURIComponent(dest)}` : dest)))
        .catch(next);
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
  if (!bool(req.body.agree)) throw new AppError('Please accept the customer service agreement and privacy statement');
  if (str(req.body.password) !== str(req.body.password_confirm)) throw new AppError('Passwords do not match');
  const { user } = await registerCustomer(pool, SYSTEM_ACTOR, {
    organisationName: str(req.body.organisation), legalName: optStr(req.body.legal_name), nzbn: optStr(req.body.nzbn), gstNumber: optStr(req.body.gst_number),
    billingEmail: str(req.body.billing_email) || str(req.body.email), phone: optStr(req.body.phone), billingAddress: optStr(req.body.billing_address),
    customerCategory: str(req.body.category), serviceLevel: 'standard', emergencyCover: (str(req.body.emergency_cover) || 'business_hours') as any,
    contactName: str(req.body.name), contactEmail: str(req.body.email), password: str(req.body.password), termsAccepted: true,
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
  if (!bool(req.body.agreement)) throw new AppError('Please accept the contractor agreement');
  await createContractor(pool, SYSTEM_ACTOR, {
    legalName: str(req.body.legal_name), tradingName: optStr(req.body.trading_name), nzbn: optStr(req.body.nzbn), businessAddress: optStr(req.body.address),
    email: str(req.body.email), phone: optStr(req.body.phone), mobilePhone: optStr(req.body.mobile_phone), gstRegistered: bool(req.body.gst_registered), gstNumber: optStr(req.body.gst_number),
    bankAccountName: optStr(req.body.bank_account_name), bankAccountNumber: optStr(req.body.bank_account_number),
    serviceRegions: arr(req.body.regions), tradeIds: arr(req.body.trades).map((t) => int(t)), afterHoursAvailable: bool(req.body.after_hours),
    emergencyAvailable: bool(req.body.emergency), contactName: str(req.body.contact_name), password: str(req.body.password), independentContractorAck: true,
    agreementAccepted: true,
  });
  return { redirect: '/login', message: 'Application received. Sign in to upload your insurance and licences; Ridgeline will verify them before offering jobs.' };
}));

authRouter.get('/privacy', async (_req, res) => res.render('privacy', { company: (await getSettings(pool)).company }));
authRouter.get('/agreements/accept', async (req, res) => {
  if (!req.actor) return res.redirect('/login');
  const pending = await pendingAcceptanceFor(pool, req.actor);
  if (!pending) return res.redirect(homeFor(req.actor.role));
  res.render('agreements-accept', { pending, next: str(req.query.next) });
});
authRouter.post('/agreements/accept', action(async (req) => {
  if (!req.actor) throw new AppError('Please sign in', 401);
  if (!bool(req.body.accept)) throw new AppError('Tick the box to confirm you accept the agreement');
  const version = await acceptPendingAgreement(pool, { ...req.actor, ip: req.ip });
  const nextUrl = str(req.body.next);
  return { redirect: nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : homeFor(req.actor.role), message: `Agreement ${version} accepted` };
}));

authRouter.get('/terms/customer', async (_req, res) => res.render('terms-customer', { company: (await getSettings(pool)).company, version: CUSTOMER_TERMS_VERSION }));
authRouter.get('/terms/contractor', async (_req, res) => res.render('terms-contractor', { company: (await getSettings(pool)).company, version: CONTRACTOR_AGREEMENT_VERSION }));
