import { Router } from 'express';
import { maybeOne, one, pool, query } from '../db.js';
import { AppError, ForbiddenError } from '../lib/errors.js';
import { latestAssessment, runAssessment } from '../services/assessment.js';
import { getCustomerInvoiceForActor } from '../services/customerInvoices.js';
import { addCustomerUser, addFacility, addSite, addUnits, NZ_REGIONS, portfolio } from '../services/customers.js';
import { raiseDispute } from '../services/disputes.js';
import { addBookingPhotos, customerDecideQuote } from '../services/evidence.js';
import { approveJobAsCustomer, cancelJob, createBooking, estimateJob, getJobForActor, PRIORITIES, resolvePriority } from '../services/jobs.js';
import { JOB_STATUS_LABELS } from '../services/jobState.js';
import { accountPosition } from '../services/ledger.js';
import { AUTO_TOPUP_CONSENT_TEXT, grantAutoTopUpConsent, requestPayment, requestRefund, revokeAutoTopUpConsent } from '../services/payments.js';
import { completionReportPdf, customerInvoicePdf, monthlyReportPdf, statementPdf } from '../services/pdf.js';
import { monthlyReportsEnabledFor } from '../services/monthlyReport.js';
import { extendP1Scope } from '../services/p1Scope.js';
import { createCardSetupCheckout, describeCard, removeCard, savedCard } from '../services/autoTopUp.js';
import { areaUnconfirmedJobs, PRIORITY_META, TRIAGE_QUESTIONS, slaPerformance } from '../services/sla.js';
import { getSettings } from '../services/settings.js';
import { createCheckout, stripeEnabled } from '../services/stripe.js';
import { action, actor, bool, dollars, flash, int, localDateTime, multipart, newKey, optDollars, optStr, requireRole, str, uploadedFiles , pid } from '../web/helpers.js';
import { formatNzd } from '../lib/money.js';

export const customerRouter = Router();
customerRouter.use(requireRole('customer'));

const cid = (req: any): string => actor(req).customerId!;

customerRouter.get('/', async (req, res) => {
  const customerId = cid(req);
  const customer = await one(pool, 'SELECT * FROM customers WHERE id = $1', [customerId]);
  const position = await accountPosition(pool, customerId);
  const assessment = await latestAssessment(pool, customerId);
  const jobs = await query(pool, `SELECT j.*, s.name AS site_name FROM jobs j JOIN sites s ON s.id = j.site_id WHERE j.customer_id = $1 ORDER BY j.created_at DESC LIMIT 8`, [customerId]);
  const counts = await one(pool, `SELECT COUNT(*) FILTER (WHERE status NOT IN ('closed','cancelled'))::int AS open,
      COUNT(*) FILTER (WHERE status IN ('pending_funds','awaiting_customer_approval'))::int AS held FROM jobs WHERE customer_id = $1`, [customerId]);
  const outstanding = await query(pool, `SELECT * FROM customer_invoices WHERE customer_id = $1 AND status IN ('issued','partially_paid') ORDER BY due_date`, [customerId]);
  const facilities = await one(pool, `SELECT COUNT(*)::int AS n, COALESCE(SUM(unit_count),0)::int AS units FROM facilities WHERE customer_id = $1 AND is_active`, [customerId]);
  const quotes = await query(pool, `SELECT q.*, j.ref FROM quotes q JOIN jobs j ON j.id = q.job_id WHERE j.customer_id = $1 AND q.status = 'sent_to_customer'`, [customerId]);
  res.render('customer/dashboard', { customer, position, assessment, jobs, counts, outstanding, facilities, quotes });
});

// ---- Properties & facilities ----
customerRouter.get('/properties', async (req, res) => {
  const data = await portfolio(pool, actor(req), cid(req));
  const types = await query(pool, 'SELECT * FROM facility_types WHERE is_active ORDER BY category, name');
  res.render('customer/properties', { ...data, types, regions: NZ_REGIONS });
});

customerRouter.post('/sites', action(async (req) => {
  await addSite(pool, actor(req), cid(req), { name: str(req.body.name), address: str(req.body.address), suburb: optStr(req.body.suburb), city: optStr(req.body.city),
    region: str(req.body.region), postcode: optStr(req.body.postcode), accessNotes: optStr(req.body.access_notes), hazards: optStr(req.body.hazards) });
  return { redirect: '/app/properties', message: 'Site added' };
}));

customerRouter.post('/facilities', action(async (req) => {
  await addFacility(pool, actor(req), cid(req), { siteId: str(req.body.site_id), facilityTypeId: int(req.body.facility_type_id, 'Facility type'), name: str(req.body.name),
    unitCount: int(req.body.unit_count, 'Number of units'), notes: optStr(req.body.notes), unitLabels: str(req.body.unit_labels).split(/[,\n]/) });
  return { redirect: '/app/properties', message: 'Facility added. Recalculate your minimum balance when your portfolio is complete.' };
}));

customerRouter.post('/units', action(async (req) => {
  await addUnits(pool, actor(req), cid(req), str(req.body.facility_id), str(req.body.labels).split(/[,\n]/));
  return { redirect: '/app/properties', message: 'Units added' };
}));

// ---- Assessment ----
customerRouter.get('/assessment', async (req, res) => {
  const customer = await one(pool, 'SELECT * FROM customers WHERE id = $1', [cid(req)]);
  const assessment = await latestAssessment(pool, cid(req));
  res.render('customer/assessment', { customer, assessment });
});

customerRouter.post('/assessment', action(async (req) => {
  const a = actor(req);
  if (a.customerRole !== 'owner') throw new ForbiddenError('Only the account owner can request an assessment');
  await runAssessment(pool, a, cid(req));
  return { redirect: '/app/assessment', message: 'Minimum balance calculated. Ridgeline will review and confirm the agreed amount.' };
}));

// ---- Account, top-ups, refunds ----
customerRouter.get('/account', async (req, res) => {
  const customerId = cid(req);
  const customer = await one(pool, 'SELECT * FROM customers WHERE id = $1', [customerId]);
  const position = await accountPosition(pool, customerId);
  const txns = await query(pool, `SELECT * FROM prepaid_transactions WHERE customer_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, [customerId]);
  const payments = await query(pool, `SELECT * FROM customer_payments WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`, [customerId]);
  const commitments = await query(pool, `SELECT jc.*, j.ref, j.title FROM job_commitments jc JOIN jobs j ON j.id = jc.job_id WHERE jc.customer_id = $1 AND jc.status = 'active'`, [customerId]);
  const consent = await maybeOne(pool, `SELECT * FROM auto_topup_consents WHERE customer_id = $1 AND revoked_at IS NULL`, [customerId]);
  const refunds = await query(pool, `SELECT * FROM refunds WHERE customer_id = $1 ORDER BY created_at DESC`, [customerId]);
  const settings = await getSettings(pool);
  const totals = await one(pool, `SELECT
      COALESCE(SUM(amount_cents) FILTER (WHERE txn_type IN ('deposit','top_up')),0)::bigint AS topups,
      COALESCE(-SUM(amount_cents) FILTER (WHERE txn_type IN ('job_charge','receivable_settlement')),0)::bigint AS charges,
      COALESCE(SUM(amount_cents) FILTER (WHERE txn_type IN ('refund','adjustment','credit_note','reversal')),0)::bigint AS adjustments,
      (SELECT amount_cents FROM prepaid_transactions WHERE customer_id = $1 AND txn_type = 'deposit' ORDER BY created_at LIMIT 1) AS opening
    FROM prepaid_transactions WHERE customer_id = $1`, [customerId]);
  const card = await savedCard(pool, customerId);
  const merchant = `${settings.company.legal_name} trading as ${settings.company.trading_name}`;
  res.render('customer/account', { customer, position, txns, payments, commitments, consent, refunds, company: settings.company, totals, card,
    stripe: stripeEnabled(), consentText: AUTO_TOPUP_CONSENT_TEXT('the amount above', 'the threshold above', card ? describeCard(card) : null, merchant),
    paymentStatus: req.query.payment ?? null, cardStatus: req.query.card ?? null, key: newKey(), maxFailures: settings.auto_topup_max_failures });
});

customerRouter.post('/topups', action(async (req, res) => {
  const a = actor(req);
  const amount = dollars(req.body.amount);
  if (str(req.body.method) === 'card') {
    const url = await createCheckout(pool, a, { customerId: cid(req), amountCents: amount, idempotencyKey: `checkout:${str(req.body.key) || newKey()}` });
    res.redirect(303, url);
    return;
  }
  const p = await requestPayment(pool, a, { customerId: cid(req), amountCents: amount, method: 'bank_transfer', idempotencyKey: `topup:${str(req.body.key) || newKey()}` });
  return { redirect: '/app/account', message: `Top-up request ${p.reference} created for ${formatNzd(p.amount_cents)}. Pay by bank transfer using reference ${p.reference}; your balance updates when Ridgeline confirms receipt.` };
}));

customerRouter.post('/cards/setup', action(async (req, res) => {
  const url = await createCardSetupCheckout(pool, actor(req), cid(req));
  res.redirect(303, url);
}));

customerRouter.post('/cards/remove', action(async (req) => {
  await removeCard(pool, actor(req), cid(req));
  return { redirect: '/app/account', message: 'Saved card removed. Automatic top-ups will be requested by bank transfer instead.' };
}));

customerRouter.post('/auto-topup', action(async (req) => {
  await grantAutoTopUpConsent(pool, actor(req), cid(req), dollars(req.body.amount), dollars(req.body.threshold), bool(req.body.consent));
  return { redirect: '/app/account', message: 'Automatic top-up authority recorded. You can withdraw it at any time.' };
}));

customerRouter.post('/auto-topup/revoke', action(async (req) => {
  await revokeAutoTopUpConsent(pool, actor(req), cid(req));
  return { redirect: '/app/account', message: 'Automatic top-up authority withdrawn.' };
}));

customerRouter.post('/refunds', action(async (req) => {
  await requestRefund(pool, actor(req), cid(req), dollars(req.body.amount), str(req.body.reason));
  return { redirect: '/app/account', message: 'Refund request sent to Ridgeline for approval.' };
}));

customerRouter.get('/statement.pdf', async (req, res) => {
  const pdf = await statementPdf(pool, cid(req));
  res.type('application/pdf').setHeader('Content-Disposition', 'inline; filename="statement.pdf"');
  res.send(pdf);
});

// ---- Jobs ----
customerRouter.get('/jobs', async (req, res) => {
  const status = str(req.query.status);
  const jobs = await query(pool,
    `SELECT j.*, s.name AS site_name, t.name AS trade_name FROM jobs j JOIN sites s ON s.id = j.site_id JOIN trades t ON t.id = j.trade_id
      WHERE j.customer_id = $1 AND ($2 = '' OR j.status = $2) ORDER BY j.created_at DESC LIMIT 200`, [cid(req), status]);
  res.render('customer/jobs', { jobs, status, statuses: JOB_STATUS_LABELS });
});

async function bookingFormData(customerId: string) {
  const sites = await query(pool, 'SELECT * FROM sites WHERE customer_id = $1 AND is_active ORDER BY name', [customerId]);
  const facilities = await query(pool, 'SELECT * FROM facilities WHERE customer_id = $1 AND is_active ORDER BY name', [customerId]);
  const units = await query(pool, 'SELECT u.*, f.site_id FROM units u JOIN facilities f ON f.id = u.facility_id WHERE u.customer_id = $1 ORDER BY u.label', [customerId]);
  const trades = await query(pool, 'SELECT * FROM trades WHERE is_active ORDER BY name');
  const customer = await one(pool, 'SELECT * FROM customers WHERE id = $1', [customerId]);
  return { sites, facilities, units, trades, customer, priorities: PRIORITIES, priorityMeta: PRIORITY_META, triageQuestions: TRIAGE_QUESTIONS };
}

customerRouter.get('/jobs/new', async (req, res) => {
  if (actor(req).customerRole === 'viewer') throw new ForbiddenError('Your role cannot book jobs');
  res.render('customer/job-new', { ...(await bookingFormData(cid(req))), form: {}, key: newKey(), estimate: null, position: await accountPosition(pool, cid(req)) });
});

function bookingInput(req: any) {
  return {
    customerId: cid(req), siteId: str(req.body.site_id), facilityId: str(req.body.facility_id) || null, unitId: str(req.body.unit_id) || null,
    tradeId: int(req.body.trade_id, 'Job category'), priority: (str(req.body.priority) || null) as any,
    triage: { safetyRisk: str(req.body.triage_safety) === 'yes', preventsUse: str(req.body.triage_use) === 'yes', planned: str(req.body.triage_planned) === 'yes' },
    title: str(req.body.title), description: str(req.body.description),
    accessInstructions: optStr(req.body.access_instructions), siteContactName: optStr(req.body.site_contact_name), siteContactPhone: optStr(req.body.site_contact_phone),
    preferredStart: localDateTime(req.body.preferred_start), preferredEnd: localDateTime(req.body.preferred_end), poNumber: optStr(req.body.po_number),
    idempotencyKey: str(req.body.key) || undefined,
  };
}

/** Booking form posts here. 'estimate' re-renders with prices; 'book' creates the job (idempotent via form key). */
customerRouter.post('/jobs', ...multipart('photos', 6), async (req, res, next) => {
  const a = actor(req);
  try {
    const input = bookingInput(req);
    if (str(req.body.intent) === 'estimate') {
      const { priority } = resolvePriority(input.priority, input.triage);
      const estimate = await estimateJob(pool, { ...input, priority });
      return res.render('customer/job-new', { ...(await bookingFormData(cid(req))), form: req.body, key: str(req.body.key) || newKey(), estimate,
        position: await accountPosition(pool, cid(req)) });
    }
    const result = await createBooking(pool, a, input);
    const files = uploadedFiles(req);
    if (result.created && files.length) await addBookingPhotos(pool, a, result.job.id, files);
    const j = result.job;
    const message = j.status === 'pending_funds'
      ? `Job ${j.ref} is on hold until your account is topped up: ${result.funding?.reasons.join('; ') ?? ''}`
      : j.status === 'awaiting_customer_approval' ? `Job ${j.ref} needs approval by an authorised approver before dispatch.`
      : `Job ${j.ref} booked and sent to dispatch.`;
    flash(req, j.status === 'pending_funds' ? 'error' : 'success', message);
    res.redirect(`/app/jobs/${j.id}`);
  } catch (err) {
    if (err instanceof AppError && err.status < 500) {
      res.status(422);
      return res.render('customer/job-new', { ...(await bookingFormData(cid(req))), form: req.body, key: str(req.body.key) || newKey(), estimate: null,
        position: await accountPosition(pool, cid(req)), error: err.message });
    }
    next(err);
  }
});

customerRouter.get('/jobs/:id', async (req, res) => {
  const a = actor(req);
  const job = await getJobForActor(pool, a, pid(req));
  // Only customer-relevant notes are shown; internal notes (costs, evidence flags, dispatch detail) are withheld.
  const events = await query(pool, `SELECT e.event_type, e.to_status, e.occurred_at,
      CASE WHEN e.event_type IN ('created','customer.approved','status.cancelled','status.pending_funds','funding.insufficient','status.awaiting_customer_approval')
             OR e.event_type LIKE 'dispute.%' THEN e.note END AS note
    FROM job_events e WHERE e.job_id = $1 AND e.event_type NOT LIKE 'offer.%' ORDER BY e.id`, [job.id]);
  const evidence = await query(pool, `SELECT * FROM job_evidence WHERE job_id = $1 AND withdrawn_at IS NULL AND kind IN ('booking_photo','before_photo','after_photo','signature') ORDER BY uploaded_at`, [job.id]);
  const report = await maybeOne(pool, `SELECT * FROM completion_reports WHERE job_id = $1 AND review_status = 'approved' ORDER BY version DESC LIMIT 1`, [job.id]);
  const quotes = await query(pool, `SELECT id, kind, description, customer_price_ex_gst_cents, customer_gst_cents, customer_total_cents, status, created_at FROM quotes
    WHERE job_id = $1 AND status IN ('sent_to_customer','approved','declined') ORDER BY created_at`, [job.id]);
  const invoice = await maybeOne(pool, `SELECT * FROM customer_invoices WHERE job_id = $1 AND status NOT IN ('draft','void')`, [job.id]);
  const disputes = await query(pool, `SELECT * FROM disputes WHERE job_id = $1 ORDER BY created_at`, [job.id]);
  res.render('customer/job', { job, events, evidence, report, quotes, invoice, disputes });
});

customerRouter.post('/jobs/:id/approve-scope', action(async (req) => {
  await extendP1Scope(pool, actor(req), pid(req), optStr(req.body.note));
  return { redirect: `/app/jobs/${pid(req)}`, message: 'Further work approved and recorded' };
}));

customerRouter.post('/jobs/:id/approve', action(async (req) => {
  await approveJobAsCustomer(pool, actor(req), pid(req));
  return { redirect: `/app/jobs/${pid(req)}`, message: 'Job approved' };
}));

customerRouter.post('/jobs/:id/cancel', action(async (req) => {
  const r = await cancelJob(pool, actor(req), pid(req), str(req.body.reason));
  return { redirect: `/app/jobs/${pid(req)}`, message: r.billable ? 'Job cancelled. As this was a late cancellation, cancellation charges may apply under your agreement.' : 'Job cancelled.' };
}));

customerRouter.post('/jobs/:id/dispute', action(async (req) => {
  await raiseDispute(pool, actor(req), pid(req), str(req.body.reason));
  return { redirect: `/app/jobs/${pid(req)}`, message: 'Dispute raised. Ridgeline will contact you.' };
}));

customerRouter.post('/quotes/:id', action(async (req) => {
  const decision = str(req.body.decision) === 'approve' ? 'approved' : 'declined';
  await customerDecideQuote(pool, actor(req), pid(req), decision);
  return { message: decision === 'approved' ? 'Approved' : 'Declined', redirect: str(req.body.back) || '/app/jobs' };
}));

customerRouter.get('/jobs/:id/report.pdf', async (req, res) => {
  const job = await getJobForActor(pool, actor(req), pid(req));
  const pdf = await completionReportPdf(pool, job.id);
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="${job.ref}-report.pdf"`);
  res.send(pdf);
});

// ---- Invoices ----
customerRouter.get('/invoices', async (req, res) => {
  const invoices = await query(pool, `SELECT ci.*, j.ref AS job_ref, j.title FROM customer_invoices ci JOIN jobs j ON j.id = ci.job_id
    WHERE ci.customer_id = $1 AND ci.status NOT IN ('draft','void') ORDER BY ci.issue_date DESC, ci.invoice_number DESC`, [cid(req)]);
  res.render('customer/invoices', { invoices });
});

customerRouter.get('/invoices/:id', async (req, res) => {
  const data = await getCustomerInvoiceForActor(pool, actor(req), pid(req));
  res.render('customer/invoice', { ...data, stripe: stripeEnabled(), key: newKey() });
});

customerRouter.get('/invoices/:id/pdf', async (req, res) => {
  const { invoice } = await getCustomerInvoiceForActor(pool, actor(req), pid(req));
  const pdf = await customerInvoicePdf(pool, invoice.id);
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);
  res.send(pdf);
});

customerRouter.post('/invoices/:id/pay', action(async (req, res) => {
  const { invoice, outstanding } = await getCustomerInvoiceForActor(pool, actor(req), pid(req));
  if (outstanding <= 0) throw new AppError('Nothing is outstanding on this invoice');
  const url = await createCheckout(pool, actor(req), { customerId: cid(req), amountCents: outstanding, customerInvoiceId: invoice.id, idempotencyKey: `inv-checkout:${str(req.body.key)}` });
  res.redirect(303, url);
}));

// ---- Monthly reports (off unless enabled globally and for this customer) ----
customerRouter.use(async (req, res, next) => {
  res.locals.reportsEnabled = await monthlyReportsEnabledFor(pool, cid(req));
  next();
});
customerRouter.use('/reports', (req, res, next) => {
  if (!res.locals.reportsEnabled) throw new AppError('Monthly reports are not enabled for this account', 404);
  next();
});
customerRouter.get('/reports', async (req, res) => {
  const months = await query<{ m: string }>(pool, `SELECT DISTINCT to_char(created_at AT TIME ZONE 'Pacific/Auckland', 'YYYY-MM') AS m FROM jobs WHERE customer_id = $1 ORDER BY m DESC LIMIT 24`, [cid(req)]);
  const month = /^\d{4}-\d{2}$/.test(str(req.query.month)) ? str(req.query.month) : months[0]?.m ?? new Date().toISOString().slice(0, 7);
  const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  const period = { from: `${month}-01`, to: end.toISOString().slice(0, 10) };
  const sla = await slaPerformance(pool, period, cid(req));
  const unconfirmed = await areaUnconfirmedJobs(pool, period, cid(req));
  res.render('customer/reports', { months: months.map((x) => x.m), month, sla, unconfirmed });
});

customerRouter.get('/reports/:month.pdf', async (req, res) => {
  const month = String(req.params.month);
  const pdf = await monthlyReportPdf(pool, cid(req), month);
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="ridgeline-report-${month}.pdf"`);
  res.send(pdf);
});

// ---- Users (booking contacts) ----
customerRouter.get('/users', async (req, res) => {
  const users = await query(pool, `SELECT id, name, email, phone, customer_role, approval_limit_cents, is_active, last_login_at FROM users WHERE customer_id = $1 ORDER BY name`, [cid(req)]);
  res.render('customer/users', { users });
});

customerRouter.post('/users', action(async (req) => {
  await addCustomerUser(pool, actor(req), cid(req), { name: str(req.body.name), email: str(req.body.email), password: str(req.body.password), phone: optStr(req.body.phone),
    customerRole: str(req.body.customer_role) as any, approvalLimitCents: optDollars(req.body.approval_limit) ?? null });
  return { redirect: '/app/users', message: 'Contact added' };
}));

