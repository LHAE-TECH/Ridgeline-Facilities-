import connectPgSimple from 'connect-pg-simple';
import express from 'express';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import helmet from 'helmet';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { contractorRouter } from './routes/contractor.js';
import { customerRouter } from './routes/customer.js';
import { filesRouter } from './routes/files.js';
import { webhookRouter } from './routes/webhooks.js';
import { errorHandler, loadUser, verifyCsrf } from './web/helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', join(here, 'views'));
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', 'blob:'], 'form-action': ["'self'", 'https://checkout.stripe.com'] } },
  }));
  app.use('/static', express.static(join(here, 'public'), { maxAge: config.isProduction ? '7d' : 0 }));
  app.get('/healthz', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  // Webhooks need the raw body for signature verification, so they are mounted before body parsers.
  app.use('/webhooks', webhookRouter);

  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  const PgStore = connectPgSimple(session);
  app.use(session({
    store: new PgStore({ pool, tableName: 'user_sessions', createTableIfMissing: false, pruneSessionInterval: config.isTest ? false : 900 }),
    name: 'rf.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 8 * 60 * 60 * 1000 },
  }));
  app.use(loadUser);

  // CSRF check for urlencoded forms; multipart routes verify after parsing (see web/helpers.multipart).
  app.use((req, res, next) => (req.is('multipart/form-data') ? next() : verifyCsrf(req, res, next)));
  app.use('/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false, skip: (req) => req.method !== 'POST' }));

  app.use(authRouter);
  app.use('/files', filesRouter);
  app.use('/app', customerRouter);
  app.use('/c', contractorRouter);
  app.use('/admin', adminRouter);

  app.use((req, res) => res.status(404).render('error', { status: 404, message: 'Page not found' }));
  app.use(errorHandler);
  return app;
}
