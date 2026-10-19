import { Router } from 'express';
import { integrationStatus } from '../config.js';
import { maybeOne, one, pool, query } from '../db.js';
import { AppError, ForbiddenError } from '../lib/errors.js';
import { multiplierToBps, percentToBps } from '../lib/money.js';
import { acceptAssessment, latestAssessment, runAssessment } from '../services/assessment.js';
import { approveContractorInvoice, getContractorInvoiceForActor, rejectContractorInvoice, validateContractorInvoice } from '../services/contractorInvoices.js';
import { contractorProfile, createContractor, DOCUMENT_TYPES, reviewComplianceDocument, setContractorTrade, setRateCard, updateContractor, addComplianceDocument } from '../services/contractors.js';
import { applyPrepaidToInvoice, createCreditNote, getCustomerInvoiceForActor, issueCustomerInvoice, outstandingCents, recalculateDraft } from '../services/customerInvoices.js';
import { CUSTOMER_CATEGORIES, hashPassword, NZ_REGIONS, portfolio, SERVICE_LEVELS, updateCustomerTerms } from '../services/customers.js';
import { assessContractorsForJob, dispatchJob, manualAssign, unassign } from '../services/dispatch.js';
import { raiseDispute, resolveDispute, setDisputeInvestigating } from '../services/disputes.js';
import { reviewEvidence, reviewQuote, withdrawEvidence } from '../services/evidence.js';
import { cancelJob, closeChecks, closeJob, getJobForActor, grantFundingException } from '../services/jobs.js';
import { JOB_STATUS_LABELS } from '../services/jobState.js';
import { accountBalances, accountPosition, reconcileCustomerBalance } from '../services/ledger.js';
import { approveForPayment, confirmContractorPayment, createPaymentBatch, decideAdjustment, exportBatchCsv, failContractorPayment, holdPayable,
  markDocumentationVerified, payableAmount, proposeAdjustment, reconcileBankStatement, releaseHold, workingCapitalWarning } from '../services/payables.js';
import { adjustPrepaidBalance, confirmPayment, decideRefund, failPayment, markRefundPaid, recordBankReceipt, reversePayment } from '../services/payments.js';
import { customerInvoicePdf, statementPdf } from '../services/pdf.js';
import { approveRule, createDraftRule, retireRule, RULE_CATEGORIES, RULE_CATEGORY_LABELS } from '../services/pricing.js';
import { dashboard, journalCsv } from '../services/reports.js';
import { getSettings, SETTING_DEFAULTS, SETTING_DESCRIPTIONS, type SettingKey, updateSetting } from '../services/settings.js';
import { saveFile } from '../services/storage.js';
import { requeueSync } from '../services/xero.js';
import { audit } from '../services/audit.js';
import { runWorkerCycle } from '../worker.js';
import { action, actor, arr, bool, dollars, int, multipart, newKey, num, optDollars, optInt, optStr, requireRole, str, uploadedFiles , pid } from '../web/helpers.js';

export const adminRouter = Router();
adminRouter.use(requireRole('admin', 'ops', 'finance'));

function requireAdmin(req: any): void {
  if (actor(req).role !== 'admin') throw new ForbiddenError('Administrator access required');
}

function monthRange(q: any): { from: string; to: string } {
  // Default: month to date in New Zealand time.
  const nzToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date());
  const from = str(q.from) || `${nzToday.slice(0, 7)}-01`;
  const to = str(q.to) || nzToday;
  return { from, to };
}

adminRouter.get('/', async (req, res) => {
  const period = monthRange(req.query);
  res.render('admin/dashboard', { d: await dashboard(pool, period), integrations: integrationStatus() });
});

// ---------------------------------------------------------------- Customers
adminRouter.get('/customers', async (req, res) => {
  const q = str(req.query.q);
  const customers = await query(pool, `SELECT c.*, COALESCE((SELECT SUM(amount_cents) FROM job_commitments WHERE customer_id = c.id AND status = 'active'),0)::bigint AS committed,
      (SELECT COALESCE(SUM(unit_count),0) FROM facilities WHERE customer_id = c.id AND is_active)::int AS units
    FROM customers c WHERE ($1 = '' OR c.name ILIKE '%' || $1 || '%' OR c.account_ref ILIKE '%' || $1 || '%') ORDER BY c.name LIMIT 300`, [q]);
  res.render('admin/customers', { customers, q });
});

adminRouter.get('/customers/:id', async (req, res) => {
  const a = actor(req);
  const customer = await maybeOne(pool, 'SELECT * FROM customers WHERE id = $1', [pid(req)]);
  if (!customer) throw new AppError('Customer not found', 404);
  const [data, position, assessment, txns, payments, jobs, users, invoices, recon, refunds, consent] = await Promise.all([
    portfolio(pool, a, customer.id), accountPosition(pool, customer.id), latestAssessment(pool, customer.id),
    query(pool, `SELECT * FROM prepaid_transactions WHERE customer_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [customer.id]),
    query(pool, `SELECT * FROM customer_payments WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`, [customer.id]),
    query(pool, `SELECT * FROM jobs WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`, [customer.id]),
    query(pool, `SELECT id, name, email, customer_role, approval_limit_cents, is_active FROM users WHERE customer_id = $1 ORDER BY name`, [customer.id]),
    query(pool, `SELECT * FROM customer_invoices WHERE customer_id = $1 AND status <> 'void' ORDER BY created_at DESC LIMIT 50`, [customer.id]),
    reconcileCustomerBalance(pool, customer.id),
    query(pool, `SELECT * FROM refunds WHERE customer_id = $1 ORDER BY created_at DESC`, [customer.id]),
    maybeOne(pool, `SELECT * FROM auto_topup_consents WHERE customer_id = $1 AND revoked_at IS NULL`, [customer.id]),
  ]);
  res.render('admin/customer', { customer, ...data, position, assessment, txns, payments, jobs, users, invoices, recon, refunds, consent,
    categories: CUSTOMER_CATEGORIES, levels: SERVICE_LEVELS, key: newKey(), outstandingCents });
});

adminRouter.post('/customers/:id/terms', action(async (req) => {
  await updateCustomerTerms(pool, actor(req), pid(req), {
    customerCategory: optStr(req.body.customer_category), serviceLevel: optStr(req.body.service_level), emergencyCover: optStr(req.body.emergency_cover) as any,
    authorityLimitCents: optDollars(req.body.authority_limit, 'Authority limit'), paymentTermsDays: optInt(req.body.payment_terms_days, 'Payment terms'),
    poRequired: bool(req.body.po_required), acknowledgementRequired: bool(req.body.acknowledgement_required), cancellationFeesApply: bool(req.body.cancellation_fees_apply),
    autoApplyPrepaid: bool(req.body.auto_apply_prepaid), status: (optStr(req.body.status) as any) ?? undefined,
  });
  return { redirect: `/admin/customers/${pid(req)}`, message: 'Account terms updated' };
}));

adminRouter.post('/customers/:id/assessment', action(async (req) => {
  await runAssessment(pool, actor(req), pid(req));
  return { redirect: `/admin/customers/${pid(req)}#assessment`, message: 'Assessment recalculated' };
}));

adminRouter.post('/assessments/:id/accept', action(async (req) => {
  const c = await acceptAssessment(pool, actor(req), pid(req), { agreedCents: optDollars(req.body.agreed, 'Agreed amount'), notes: optStr(req.body.notes) });
  return { redirect: `/admin/customers/${c.id}`, message: 'Minimum balance agreed' };
}));

adminRouter.post('/customers/:id/receipts', action(async (req) => {
  const r = await recordBankReceipt(pool, actor(req), { customerId: pid(req), amountCents: dollars(req.body.amount), purpose: (optStr(req.body.purpose) as any) ?? undefined,
    customerInvoiceId: optStr(req.body.invoice_id) ?? null, receivedDate: str(req.body.received_date), bankReference: str(req.body.bank_reference), idempotencyKey: `receipt:${str(req.body.key)}` });
  return { redirect: `/admin/customers/${pid(req)}`, message: r.credited ? 'Receipt recorded' : 'Receipt was already recorded (no duplicate created)' };
}));

adminRouter.post('/customers/:id/adjust', action(async (req) => {
  const sign = str(req.body.direction) === 'debit' ? -1 : 1;
  await adjustPrepaidBalance(pool, actor(req), pid(req), sign * dollars(req.body.amount), str(req.body.reason), str(req.body.key));
  return { redirect: `/admin/customers/${pid(req)}`, message: 'Balance adjusted' };
}));

adminRouter.get('/customers/:id/statement.pdf', async (req, res) => {
  res.type('application/pdf').send(await statementPdf(pool, pid(req)));
});

// ---------------------------------------------------------------- Jobs & dispatch
adminRouter.get('/jobs', async (req, res) => {
  const status = str(req.query.status);
  const q = str(req.query.q);
  const jobs = await query(pool,
    `SELECT j.*, c.name AS customer_name, t.name AS trade_name, k.legal_name AS contractor_name FROM jobs j JOIN customers c ON c.id = j.customer_id
       JOIN trades t ON t.id = j.trade_id LEFT JOIN contractors k ON k.id = j.assigned_contractor_id
      WHERE ($1 = '' OR j.status = $1) AND ($2 = '' OR j.ref ILIKE '%' || $2 || '%' OR j.title ILIKE '%' || $2 || '%' OR c.name ILIKE '%' || $2 || '%')
      ORDER BY j.created_at DESC LIMIT 300`, [status, q]);
  res.render('admin/jobs', { jobs, status, q, statuses: JOB_STATUS_LABELS });
});

adminRouter.get('/dispatch', async (_req, res) => {
  const jobs = await query(pool,
    `SELECT j.*, c.name AS customer_name, s.region, t.name AS trade_name, k.legal_name AS contractor_name,
            (SELECT COUNT(*) FROM job_offers o WHERE o.job_id = j.id AND o.status = 'offered')::int AS live_offers
       FROM jobs j JOIN customers c ON c.id = j.customer_id JOIN sites s ON s.id = j.site_id JOIN trades t ON t.id = j.trade_id
       LEFT JOIN contractors k ON k.id = j.assigned_contractor_id
      WHERE j.status IN ('pending_funds','awaiting_customer_approval','dispatch','offered','assigned','on_site','in_progress','evidence_submitted','evidence_rejected')
      ORDER BY j.priority = 'emergency' DESC, j.priority = 'urgent' DESC, j.respond_by`);
  const columns: [string, string[]][] = [
    ['On hold', ['pending_funds', 'awaiting_customer_approval']], ['Awaiting dispatch', ['dispatch']], ['Offered', ['offered']],
    ['Assigned', ['assigned']], ['On site / in progress', ['on_site', 'in_progress']], ['Evidence review', ['evidence_submitted', 'evidence_rejected']],
  ];
  res.render('admin/dispatch', { columns: columns.map(([title, statuses]) => ({ title, jobs: jobs.filter((j) => statuses.includes(j.status)) })), now: new Date() });
});

adminRouter.get('/jobs/:id', async (req, res) => {
  const a = actor(req);
  const job = await getJobForActor(pool, a, pid(req));
  const [events, offers, evidence, reports, quotes, contractorInvoices, customerInvoice, disputes, candidates, checks, commitment, auditRows] = await Promise.all([
    query(pool, `SELECT e.*, u.name AS actor_name FROM job_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.job_id = $1 ORDER BY e.id`, [job.id]),
    query(pool, `SELECT o.*, k.legal_name FROM job_offers o JOIN contractors k ON k.id = o.contractor_id WHERE o.job_id = $1 ORDER BY o.offered_at DESC`, [job.id]),
    query(pool, `SELECT e.*, f.sha256, f.original_name FROM job_evidence e JOIN files f ON f.id = e.file_id WHERE e.job_id = $1 ORDER BY e.uploaded_at`, [job.id]),
    query(pool, `SELECT * FROM completion_reports WHERE job_id = $1 ORDER BY version DESC`, [job.id]),
    query(pool, `SELECT * FROM quotes WHERE job_id = $1 ORDER BY created_at`, [job.id]),
    query(pool, `SELECT * FROM contractor_invoices WHERE job_id = $1 ORDER BY created_at DESC`, [job.id]),
    maybeOne(pool, `SELECT * FROM customer_invoices WHERE job_id = $1 AND status <> 'void'`, [job.id]),
    query(pool, `SELECT * FROM disputes WHERE job_id = $1 ORDER BY created_at`, [job.id]),
    assessContractorsForJob(pool, job.id),
    closeChecks(pool, job.id),
    maybeOne(pool, `SELECT * FROM job_commitments WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`, [job.id]),
    query(pool, `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.entity_type = 'job' AND a.entity_id = $1 ORDER BY a.id`, [job.id]),
  ]);
  res.render('admin/job', { job, events, offers, evidence, reports, quotes, contractorInvoices, customerInvoice, disputes, candidates, checks, commitment, auditRows });
});

adminRouter.post('/jobs/:id/dispatch', action(async (req) => {
  const r = await dispatchJob(pool, actor(req), pid(req));
  return { redirect: `/admin/jobs/${pid(req)}`, message: `${r.offered} new offer(s) sent; ${r.eligible} eligible contractor(s)` };
}));
adminRouter.post('/jobs/:id/assign', action(async (req) => {
  await manualAssign(pool, actor(req), pid(req), str(req.body.contractor_id), optStr(req.body.override_reason));
  return { redirect: `/admin/jobs/${pid(req)}`, message: 'Contractor assigned' };
}));
adminRouter.post('/jobs/:id/unassign', action(async (req) => {
  await unassign(pool, actor(req), pid(req), str(req.body.reason));
  return { redirect: `/admin/jobs/${pid(req)}`, message: 'Returned to dispatch queue' };
}));
adminRouter.post('/jobs/:id/evidence-review', action(async (req) => {
  await reviewEvidence(pool, actor(req), pid(req), str(req.body.decision) === 'approve' ? 'approve' : 'reject', optStr(req.body.notes));
  return { redirect: `/admin/jobs/${pid(req)}`, message: 'Evidence review recorded' };
}));
adminRouter.post('/evidence/:id/withdraw', action(async (req) => {
  await withdrawEvidence(pool, actor(req), pid(req), str(req.body.reason));
  return { message: 'Evidence withdrawn (original retained)', redirect: str(req.body.back) || '/admin/jobs' };
}));
adminRouter.post('/quotes/:id/review', action(async (req) => {
  await reviewQuote(pool, actor(req), pid(req), str(req.body.decision) === 'send' ? 'send' : 'withdraw');
  return { message: 'Quote updated', redirect: str(req.body.back) || '/admin/jobs' };
}));
adminRouter.post('/jobs/:id/cancel', action(async (req) => {
  const r = await cancelJob(pool, actor(req), pid(req), str(req.body.reason));
  return { redirect: `/admin/jobs/${pid(req)}`, message: `Job cancelled${r.billable ? ' (billable late cancellation)' : ''}` };
}));
adminRouter.post('/jobs/:id/close', action(async (req) => {
  await closeJob(pool, actor(req), pid(req));
  return { redirect: `/admin/jobs/${pid(req)}`, message: 'Job closed' };
}));
adminRouter.post('/jobs/:id/funding-exception', action(async (req) => {
  await grantFundingException(pool, actor(req), pid(req), str(req.body.reason));
  return { redirect: `/admin/jobs/${pid(req)}`, message: 'Funding exception granted; job released to dispatch' };
}));
adminRouter.post('/jobs/:id/dispute', action(async (req) => {
  await raiseDispute(pool, actor(req), pid(req), str(req.body.reason));
  return { redirect: `/admin/jobs/${pid(req)}`, message: 'Dispute opened' };
}));

// ---------------------------------------------------------------- Contractors
adminRouter.get('/contractors', async (_req, res) => {
  const contractors = await query(pool, `SELECT k.*,
      (SELECT string_agg(t.name, ', ' ORDER BY t.name) FROM contractor_trades ct JOIN trades t ON t.id = ct.trade_id WHERE ct.contractor_id = k.id) AS trades,
      (SELECT MIN(expires_at) FROM compliance_documents d WHERE d.contractor_id = k.id AND d.status = 'verified') AS next_expiry,
      (SELECT COUNT(*) FROM compliance_documents d WHERE d.contractor_id = k.id AND d.status = 'pending')::int AS pending_docs
    FROM contractors k ORDER BY k.status, k.legal_name`);
  res.render('admin/contractors', { contractors });
});

adminRouter.get('/contractors/new', async (_req, res) => {
  res.render('admin/contractor-new', { trades: await query(pool, 'SELECT id, name FROM trades WHERE is_active ORDER BY name'), regions: NZ_REGIONS });
});

adminRouter.post('/contractors', action(async (req) => {
  const c = await createContractor(pool, actor(req), {
    legalName: str(req.body.legal_name), tradingName: optStr(req.body.trading_name), nzbn: optStr(req.body.nzbn), businessAddress: optStr(req.body.address),
    email: str(req.body.email), phone: optStr(req.body.phone), gstRegistered: bool(req.body.gst_registered), gstNumber: optStr(req.body.gst_number),
    bankAccountName: optStr(req.body.bank_account_name), bankAccountNumber: optStr(req.body.bank_account_number), paymentTermsDays: optInt(req.body.payment_terms_days),
    serviceRegions: arr(req.body.regions), tradeIds: arr(req.body.trades).map((t) => int(t)), afterHoursAvailable: bool(req.body.after_hours),
    emergencyAvailable: bool(req.body.emergency), maxConcurrentJobs: optInt(req.body.max_concurrent_jobs), contactName: str(req.body.contact_name), password: str(req.body.password),
  });
  return { redirect: `/admin/contractors/${c.id}`, message: 'Contractor created (pending). Verify trades, documents and agree rates before approving.' };
}));

adminRouter.get('/contractors/:id', async (req, res) => {
  const profile = await contractorProfile(pool, actor(req), pid(req));
  const trades = await query(pool, 'SELECT id, name FROM trades WHERE is_active ORDER BY name');
  const payables = await query(pool, `SELECT p.*, ci.invoice_number, j.ref AS job_ref FROM contractor_payables p JOIN contractor_invoices ci ON ci.id = p.contractor_invoice_id
    JOIN jobs j ON j.id = p.job_id WHERE p.contractor_id = $1 ORDER BY p.created_at DESC LIMIT 50`, [pid(req)]);
  res.render('admin/contractor', { ...profile, allTrades: trades, regions: NZ_REGIONS, documentTypes: DOCUMENT_TYPES, payables, payableAmount });
});

adminRouter.post('/contractors/:id', action(async (req) => {
  await updateContractor(pool, actor(req), pid(req), {
    legalName: optStr(req.body.legal_name), tradingName: optStr(req.body.trading_name), nzbn: optStr(req.body.nzbn), phone: optStr(req.body.phone),
    gstRegistered: bool(req.body.gst_registered), gstNumber: optStr(req.body.gst_number) ?? '', paymentTermsDays: optInt(req.body.payment_terms_days),
    serviceRegions: arr(req.body.regions), serviceRadiusKm: optInt(req.body.service_radius_km), afterHoursAvailable: bool(req.body.after_hours),
    emergencyAvailable: bool(req.body.emergency), maxConcurrentJobs: optInt(req.body.max_concurrent_jobs), available: bool(req.body.available),
    bankAccountName: optStr(req.body.bank_account_name), bankAccountNumber: optStr(req.body.bank_account_number),
  });
  return { redirect: `/admin/contractors/${pid(req)}`, message: 'Contractor updated' };
}));

adminRouter.post('/contractors/:id/status', action(async (req) => {
  const status = str(req.body.status);
  if (!['approved', 'suspended', 'pending', 'archived'].includes(status)) throw new AppError('Invalid status');
  if (status === 'approved' && actor(req).role === 'finance') throw new ForbiddenError();
  await updateContractor(pool, actor(req), pid(req), { status });
  return { redirect: `/admin/contractors/${pid(req)}`, message: `Contractor ${status}` };
}));

adminRouter.post('/contractors/:id/trades', action(async (req) => {
  await setContractorTrade(pool, actor(req), pid(req), int(req.body.trade_id, 'Trade'), { qualification: optStr(req.body.qualification), verified: bool(req.body.verified), remove: bool(req.body.remove) });
  return { redirect: `/admin/contractors/${pid(req)}`, message: 'Trades updated' };
}));

adminRouter.post('/contractors/:id/rate-cards', action(async (req) => {
  await setRateCard(pool, actor(req), pid(req), {
    tradeId: int(req.body.trade_id, 'Trade'), labourRateCents: dollars(req.body.labour_rate, 'Labour rate'), calloutCents: optDollars(req.body.callout) ?? 0,
    emergencyCalloutCents: optDollars(req.body.emergency_callout) ?? 0, afterHoursMultiplierBps: multiplierToBps(str(req.body.after_hours_multiplier) || '1.5'),
    weekendMultiplierBps: multiplierToBps(str(req.body.weekend_multiplier) || '1.5'), publicHolidayMultiplierBps: multiplierToBps(str(req.body.public_holiday_multiplier) || '2'),
    overnightMultiplierBps: multiplierToBps(str(req.body.overnight_multiplier) || '2'), travelPerKmCents: optDollars(req.body.travel_per_km) ?? 0,
    minChargeCents: optDollars(req.body.min_charge) ?? 0, materialsMarginBps: percentToBps(str(req.body.materials_margin) || '0'),
    cancellationFeeCents: optDollars(req.body.cancellation_fee) ?? 0,
  });
  return { redirect: `/admin/contractors/${pid(req)}`, message: 'Rate card agreed' };
}));

adminRouter.post('/contractors/:id/documents', ...multipart('file', 1), action(async (req) => {
  const files = uploadedFiles(req);
  const file = files[0] ? await saveFile(pool, actor(req), { ...files[0], purpose: 'compliance', contractorId: pid(req) }) : null;
  await addComplianceDocument(pool, actor(req), pid(req), { docType: str(req.body.doc_type), reference: optStr(req.body.reference), expiresAt: optStr(req.body.expires_at) ?? null, fileId: file?.id ?? null });
  return { redirect: `/admin/contractors/${pid(req)}`, message: 'Document added' };
}));

adminRouter.post('/documents/:id/review', action(async (req) => {
  const doc = await reviewComplianceDocument(pool, actor(req), pid(req), str(req.body.decision) === 'verified' ? 'verified' : 'rejected');
  return { redirect: `/admin/contractors/${doc.contractor_id}`, message: `Document ${doc.status}` };
}));

// ---------------------------------------------------------------- Contractor invoices
adminRouter.get('/contractor-invoices', async (req, res) => {
  const status = str(req.query.status) || 'open';
  const invoices = await query(pool, `SELECT ci.*, j.ref AS job_ref, c.name AS customer_name FROM contractor_invoices ci JOIN jobs j ON j.id = ci.job_id JOIN customers c ON c.id = j.customer_id
    WHERE ($1 = 'all' OR ($1 = 'open' AND ci.status IN ('submitted','flagged')) OR ci.status = $1) ORDER BY ci.created_at DESC LIMIT 300`, [status]);
  res.render('admin/contractor-invoices', { invoices, status });
});

adminRouter.get('/contractor-invoices/:id', async (req, res) => {
  const data = await getContractorInvoiceForActor(pool, actor(req), pid(req));
  const flags = ['submitted', 'flagged'].includes(data.invoice.status) ? await validateContractorInvoice(pool, pid(req)) : (data.invoice.validation?.flags ?? []);
  const job = await one(pool, 'SELECT * FROM jobs WHERE id = $1', [data.invoice.job_id]);
  const report = await maybeOne(pool, 'SELECT * FROM completion_reports WHERE job_id = $1 ORDER BY version DESC LIMIT 1', [job.id]);
  const rateCard = await maybeOne(pool, `SELECT * FROM contractor_rate_cards WHERE contractor_id = $1 AND trade_id = $2 AND status = 'approved' ORDER BY created_at DESC LIMIT 1`,
    [data.invoice.contractor_id, job.trade_id]);
  const customerInvoice = await maybeOne(pool, `SELECT * FROM customer_invoices WHERE contractor_invoice_id = $1 AND status <> 'void'`, [pid(req)]);
  res.render('admin/contractor-invoice', { ...data, flags, job, report, rateCard, customerInvoice });
});

adminRouter.post('/contractor-invoices/:id/approve', action(async (req) => {
  const r = await approveContractorInvoice(pool, actor(req), pid(req), optStr(req.body.override_reason));
  return { redirect: `/admin/customer-invoices/${r.draftId}`, message: 'Contractor invoice approved. Review the customer invoice draft below.' };
}));

adminRouter.post('/contractor-invoices/:id/reject', action(async (req) => {
  await rejectContractorInvoice(pool, actor(req), pid(req), str(req.body.reason));
  return { redirect: '/admin/contractor-invoices', message: 'Invoice rejected; contractor notified' };
}));

// ---------------------------------------------------------------- Customer invoices
adminRouter.get('/customer-invoices', async (req, res) => {
  const status = str(req.query.status);
  const invoices = await query(pool, `SELECT ci.*, j.ref AS job_ref, c.name AS customer_name FROM customer_invoices ci JOIN jobs j ON j.id = ci.job_id JOIN customers c ON c.id = ci.customer_id
    WHERE ($1 = '' OR ci.status = $1) AND ci.status <> 'void' ORDER BY ci.created_at DESC LIMIT 300`, [status]);
  res.render('admin/customer-invoices', { invoices, status, outstandingCents });
});

adminRouter.get('/customer-invoices/:id', async (req, res) => {
  const data = await getCustomerInvoiceForActor(pool, actor(req), pid(req));
  const customer = await one(pool, 'SELECT * FROM customers WHERE id = $1', [data.invoice.customer_id]);
  const position = await accountPosition(pool, customer.id);
  const disputes = await query(pool, `SELECT * FROM disputes WHERE job_id = $1 AND status IN ('open','investigating')`, [data.invoice.job_id]);
  res.render('admin/customer-invoice', { ...data, customer, position, disputes, key: newKey() });
});

adminRouter.post('/customer-invoices/:id/issue', action(async (req) => {
  const inv = await issueCustomerInvoice(pool, actor(req), pid(req));
  return { redirect: `/admin/customer-invoices/${inv.id}`, message: `Invoice ${inv.invoice_number} issued; email queued to the customer` };
}));
adminRouter.post('/customer-invoices/:id/recalculate', action(async (req) => {
  const inv = await recalculateDraft(pool, actor(req), pid(req));
  return { redirect: `/admin/customer-invoices/${inv.id}`, message: 'Draft recalculated from current pricing rules' };
}));
adminRouter.post('/customer-invoices/:id/credit-note', action(async (req) => {
  await createCreditNote(pool, actor(req), pid(req), { amountExGstCents: dollars(req.body.amount, 'Credit amount'), reason: str(req.body.reason) });
  return { redirect: `/admin/customer-invoices/${pid(req)}`, message: 'Credit note issued' };
}));
adminRouter.post('/customer-invoices/:id/apply-prepaid', action(async (req) => {
  await applyPrepaidToInvoice(pool, actor(req), pid(req));
  return { redirect: `/admin/customer-invoices/${pid(req)}`, message: 'Prepaid credit applied' };
}));
adminRouter.get('/customer-invoices/:id/pdf', async (req, res) => {
  res.type('application/pdf').send(await customerInvoicePdf(pool, pid(req)));
});

// ---------------------------------------------------------------- Customer payments & refunds
adminRouter.get('/payments', async (_req, res) => {
  const pending = await query(pool, `SELECT p.*, c.name AS customer_name, c.account_ref FROM customer_payments p JOIN customers c ON c.id = p.customer_id
    WHERE p.status = 'pending' ORDER BY p.created_at`);
  const recent = await query(pool, `SELECT p.*, c.name AS customer_name FROM customer_payments p JOIN customers c ON c.id = p.customer_id
    WHERE p.status <> 'pending' ORDER BY COALESCE(p.confirmed_at, p.created_at) DESC LIMIT 100`);
  res.render('admin/payments', { pending, recent });
});
adminRouter.post('/payments/:id/confirm', action(async (req) => {
  const r = await confirmPayment(pool, actor(req), pid(req), { receivedDate: optStr(req.body.received_date), bankReference: optStr(req.body.bank_reference) });
  return { redirect: '/admin/payments', message: r.credited ? 'Payment confirmed and credited' : 'Payment was already confirmed' };
}));
adminRouter.post('/payments/:id/fail', action(async (req) => {
  await failPayment(pool, actor(req), pid(req), str(req.body.reason) || 'Not received');
  return { redirect: '/admin/payments', message: 'Payment marked failed; customer notified' };
}));
adminRouter.post('/payments/:id/reverse', action(async (req) => {
  await reversePayment(pool, actor(req), pid(req), str(req.body.reason));
  return { redirect: '/admin/payments', message: 'Payment reversed' };
}));

adminRouter.get('/refunds', async (_req, res) => {
  const refunds = await query(pool, `SELECT r.*, c.name AS customer_name, c.prepaid_balance_cents FROM refunds r JOIN customers c ON c.id = r.customer_id ORDER BY r.status = 'requested' DESC, r.created_at DESC LIMIT 200`);
  res.render('admin/refunds', { refunds });
});
adminRouter.post('/refunds/:id/decide', action(async (req) => {
  await decideRefund(pool, actor(req), pid(req), str(req.body.decision) === 'approve' ? 'approved' : 'rejected', optStr(req.body.note));
  return { redirect: '/admin/refunds', message: 'Refund decision recorded' };
}));
adminRouter.post('/refunds/:id/paid', action(async (req) => {
  await markRefundPaid(pool, actor(req), pid(req), { paidReference: str(req.body.reference), paidDate: str(req.body.paid_date) });
  return { redirect: '/admin/refunds', message: 'Refund recorded as paid' };
}));

// ---------------------------------------------------------------- Contractor payables
adminRouter.get('/payables', async (_req, res) => {
  const payables = await query(pool, `SELECT p.*, ci.invoice_number, ci.gst_registered, j.ref AS job_ref, k.legal_name, k.bank_account_number,
      (SELECT COUNT(*) FROM payable_adjustments a WHERE a.payable_id = p.id AND a.status = 'proposed')::int AS pending_adjustments
    FROM contractor_payables p JOIN contractor_invoices ci ON ci.id = p.contractor_invoice_id JOIN jobs j ON j.id = p.job_id JOIN contractors k ON k.id = p.contractor_id
    WHERE p.status <> 'paid' OR p.paid_at > now() - interval '30 days' ORDER BY p.status = 'paid', p.due_date`);
  for (const p of payables) p.warning = p.status === 'paid' ? null : await workingCapitalWarning(pool, p);
  const adjustments = await query(pool, `SELECT a.*, j.ref AS job_ref, k.legal_name FROM payable_adjustments a JOIN contractor_payables p ON p.id = a.payable_id
    JOIN jobs j ON j.id = p.job_id JOIN contractors k ON k.id = p.contractor_id WHERE a.status = 'proposed'`);
  const batches = await query(pool, `SELECT b.*, (SELECT COUNT(*) FROM contractor_payments cp WHERE cp.batch_id = b.id)::int AS n,
      (SELECT COALESCE(SUM(amount_cents),0) FROM contractor_payments cp WHERE cp.batch_id = b.id)::bigint AS total FROM payment_batches b ORDER BY b.created_at DESC LIMIT 20`);
  const scheduled = await query(pool, `SELECT cp.*, k.legal_name, b.ref AS batch_ref, ci.invoice_number FROM contractor_payments cp JOIN contractors k ON k.id = cp.contractor_id
    LEFT JOIN payment_batches b ON b.id = cp.batch_id JOIN contractor_payables p ON p.id = cp.payable_id JOIN contractor_invoices ci ON ci.id = p.contractor_invoice_id
    WHERE cp.status = 'scheduled' ORDER BY cp.scheduled_date`);
  res.render('admin/payables', { payables, adjustments, batches, scheduled, payableAmount, today: new Date().toISOString().slice(0, 10) });
});
adminRouter.post('/payables/:id/approve', action(async (req) => {
  await approveForPayment(pool, actor(req), pid(req));
  return { redirect: '/admin/payables', message: 'Approved for payment' };
}));
adminRouter.post('/payables/:id/hold', action(async (req) => {
  await holdPayable(pool, actor(req), pid(req), str(req.body.reason));
  return { redirect: '/admin/payables', message: 'Payable held' };
}));
adminRouter.post('/payables/:id/release', action(async (req) => {
  await releaseHold(pool, actor(req), pid(req));
  return { redirect: '/admin/payables', message: 'Hold released' };
}));
adminRouter.post('/payables/:id/documentation', action(async (req) => {
  await markDocumentationVerified(pool, actor(req), pid(req), str(req.body.note));
  return { redirect: '/admin/payables', message: 'Documentation verified' };
}));
adminRouter.post('/payables/:id/adjustments', action(async (req) => {
  const sign = str(req.body.direction) === 'deduct' ? -1 : 1;
  await proposeAdjustment(pool, actor(req), pid(req), sign * dollars(req.body.amount), str(req.body.reason), bool(req.body.contractor_agreed));
  return { redirect: '/admin/payables', message: 'Adjustment proposed; an administrator must approve it' };
}));
adminRouter.post('/adjustments/:id/decide', action(async (req) => {
  await decideAdjustment(pool, actor(req), pid(req), str(req.body.decision) === 'approve' ? 'approved' : 'rejected');
  return { redirect: '/admin/payables', message: 'Adjustment decided' };
}));
adminRouter.post('/batches', action(async (req) => {
  const b = await createPaymentBatch(pool, actor(req), { dueOnOrBefore: str(req.body.due_on_or_before), payableIds: arr(req.body.payable_ids) });
  return { redirect: '/admin/payables', message: `Batch ${b.ref} created. Export it, pay through your bank, then confirm each payment.` };
}));
adminRouter.get('/batches/:id.csv', async (req, res) => {
  const { filename, csv } = await exportBatchCsv(pool, actor(req), pid(req));
  res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});
adminRouter.post('/contractor-payments/:id/confirm', action(async (req) => {
  await confirmContractorPayment(pool, actor(req), pid(req), { paidDate: str(req.body.paid_date), reference: str(req.body.reference) });
  return { redirect: '/admin/payables', message: 'Payment confirmed; contractor notified' };
}));
adminRouter.post('/contractor-payments/:id/fail', action(async (req) => {
  await failContractorPayment(pool, actor(req), pid(req), str(req.body.reason) || 'Payment failed');
  return { redirect: '/admin/payables', message: 'Payment marked failed and returned to the queue' };
}));
adminRouter.post('/bank-statement', ...multipart('statement', 1), action(async (req) => {
  const f = uploadedFiles(req)[0] ?? ((req.files as any[])?.[0] ? { buffer: (req.files as any[])[0].buffer } : null);
  const text = f ? f.buffer.toString('utf8') : str(req.body.csv);
  if (!text) throw new AppError('Upload a CSV bank statement or paste its contents');
  const r = await reconcileBankStatement(pool, actor(req), text);
  return { redirect: '/admin/payables', message: `${r.matched.length} payment(s) reconciled; ${r.unmatched.length} statement line(s) unmatched` };
}));

// ---------------------------------------------------------------- Disputes
adminRouter.get('/disputes', async (_req, res) => {
  const disputes = await query(pool, `SELECT d.*, j.ref AS job_ref, j.title, c.name AS customer_name, u.name AS raised_by_name FROM disputes d JOIN jobs j ON j.id = d.job_id
    JOIN customers c ON c.id = j.customer_id LEFT JOIN users u ON u.id = d.raised_by ORDER BY d.status IN ('open','investigating') DESC, d.created_at DESC LIMIT 200`);
  res.render('admin/disputes', { disputes });
});
adminRouter.post('/disputes/:id/investigate', action(async (req) => {
  await setDisputeInvestigating(pool, actor(req), pid(req));
  return { redirect: '/admin/disputes', message: 'Marked as investigating' };
}));
adminRouter.post('/disputes/:id/resolve', action(async (req) => {
  await resolveDispute(pool, actor(req), pid(req), { outcome: str(req.body.outcome) === 'rejected' ? 'rejected' : 'resolved', resolution: str(req.body.resolution),
    creditExGstCents: optDollars(req.body.credit, 'Credit amount') });
  return { redirect: '/admin/disputes', message: 'Dispute closed' };
}));

// ---------------------------------------------------------------- Settings
adminRouter.get('/settings', async (_req, res) => {
  const [settings, facilityTypes, coverage, rules, trades, holidays, customers] = await Promise.all([
    getSettings(pool), query(pool, 'SELECT * FROM facility_types ORDER BY is_active DESC, category, name'),
    query(pool, 'SELECT * FROM coverage_factors ORDER BY customer_category, service_level'),
    query(pool, `SELECT r.*, c.name AS customer_name, t.name AS trade_name, u.name AS approved_by_name FROM pricing_rules r LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN trades t ON t.id = r.trade_id LEFT JOIN users u ON u.id = r.approved_by WHERE r.status <> 'retired' OR r.retired_at > now() - interval '90 days'
      ORDER BY r.status = 'draft' DESC, r.category, r.customer_id NULLS FIRST`),
    query(pool, 'SELECT * FROM trades ORDER BY name'), query(pool, `SELECT * FROM public_holidays WHERE holiday_date >= CURRENT_DATE - 30 ORDER BY holiday_date`),
    query(pool, `SELECT id, name FROM customers WHERE status <> 'closed' ORDER BY name`),
  ]);
  res.render('admin/settings', { settings, facilityTypes, coverage, rules, trades, holidays, customers, categories: RULE_CATEGORIES, categoryLabels: RULE_CATEGORY_LABELS,
    descriptions: SETTING_DESCRIPTIONS, defaults: SETTING_DEFAULTS, customerCategories: CUSTOMER_CATEGORIES });
});

adminRouter.post('/settings', action(async (req) => {
  requireAdmin(req);
  const a = actor(req);
  const current = await getSettings(pool);
  for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
    const raw = req.body[`s_${key}`];
    if (raw === undefined) continue;
    const def = SETTING_DEFAULTS[key] as unknown;
    let value: unknown;
    if (typeof def === 'boolean') value = raw === 'true';
    else if (typeof def === 'number') { value = Number(raw); if (!Number.isFinite(value as number)) throw new AppError(`${key} must be a number`); }
    else { try { value = JSON.parse(String(raw)); } catch { throw new AppError(`${key} must be valid JSON`); } }
    if (JSON.stringify(value) !== JSON.stringify(current[key])) await updateSetting(pool, a, key, value);
  }
  return { redirect: '/admin/settings', message: 'Settings saved' };
}));

adminRouter.post('/facility-types/:id', action(async (req) => {
  requireAdmin(req);
  const before = await one(pool, 'SELECT * FROM facility_types WHERE id = $1', [pid(req)]);
  const after = await one(pool, `UPDATE facility_types SET name = $2, jobs_per_unit_per_month = $3, avg_contractor_cost_cents = $4, callout_share_bps = $5,
      avg_callout_cost_cents = $6, emergency_share_bps = $7, emergency_cost_multiplier_bps = $8, planned_monthly_cost_per_unit_cents = $9, is_active = $10,
      updated_by = $11, updated_at = now() WHERE id = $1 RETURNING *`,
    [pid(req), str(req.body.name), num(req.body.jobs_per_unit_per_month), dollars(req.body.avg_contractor_cost), percentToBps(str(req.body.callout_share)),
     dollars(req.body.avg_callout_cost), percentToBps(str(req.body.emergency_share)), multiplierToBps(str(req.body.emergency_multiplier)),
     dollars(req.body.planned_monthly_cost || '0'), bool(req.body.is_active), actor(req).id]);
  await audit(pool, actor(req), { action: 'facility_type.updated', entityType: 'facility_type', entityId: pid(req), details: { before, after } });
  return { redirect: '/admin/settings#facility-types', message: 'Assumptions updated. Existing agreed balances are unchanged until reassessed.' };
}));

adminRouter.post('/facility-types', action(async (req) => {
  requireAdmin(req);
  const row = await one(pool, `INSERT INTO facility_types (code, name, category, unit_label, jobs_per_unit_per_month, avg_contractor_cost_cents, callout_share_bps,
      avg_callout_cost_cents, emergency_share_bps, emergency_cost_multiplier_bps, is_custom, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11) RETURNING id`,
    [str(req.body.code).toLowerCase().replace(/[^a-z0-9_]/g, '_'), str(req.body.name), str(req.body.category) || 'custom', str(req.body.unit_label) || 'unit',
     num(req.body.jobs_per_unit_per_month), dollars(req.body.avg_contractor_cost), percentToBps(str(req.body.callout_share) || '100'), dollars(req.body.avg_callout_cost || '0'),
     percentToBps(str(req.body.emergency_share) || '10'), multiplierToBps(str(req.body.emergency_multiplier) || '1.6'), actor(req).id]);
  await audit(pool, actor(req), { action: 'facility_type.created', entityType: 'facility_type', entityId: String(row.id) });
  return { redirect: '/admin/settings#facility-types', message: 'Facility type added' };
}));

adminRouter.post('/coverage-factors', action(async (req) => {
  requireAdmin(req);
  await pool.query(`INSERT INTO coverage_factors (customer_category, service_level, factor_bps, description) VALUES ($1,$2,$3,$4)
    ON CONFLICT (customer_category, service_level) DO UPDATE SET factor_bps = EXCLUDED.factor_bps, description = EXCLUDED.description`,
    [str(req.body.customer_category), str(req.body.service_level), multiplierToBps(str(req.body.factor)), optStr(req.body.description) ?? null]);
  await audit(pool, actor(req), { action: 'coverage_factor.set', entityType: 'coverage_factor', details: { ...req.body, _csrf: undefined } });
  return { redirect: '/admin/settings#coverage', message: 'Coverage factor saved' };
}));

adminRouter.post('/pricing-rules', action(async (req) => {
  const method = str(req.body.method) as any;
  await createDraftRule(pool, actor(req), {
    category: str(req.body.category) as any, customerId: optStr(req.body.customer_id) ?? null, tradeId: optInt(req.body.trade_id) ?? null,
    priority: (optStr(req.body.priority) as any) ?? null, method,
    markupBps: method === 'markup' ? percentToBps(str(req.body.markup)) : null,
    customerRateCents: method === 'fixed_rate' ? dollars(req.body.customer_rate, 'Customer rate') : null,
    customerMultiplierBps: method === 'standard_multiplier' ? multiplierToBps(str(req.body.multiplier)) : null,
    minimumCents: method === 'minimum' ? dollars(req.body.minimum, 'Minimum') : null,
    referenceContractorRateCents: optDollars(req.body.reference_rate) ?? null, unit: str(req.body.unit) || 'each', description: optStr(req.body.description),
  });
  return { redirect: '/admin/settings#pricing', message: 'Draft rule created. An administrator must approve it before it applies.' };
}));
adminRouter.post('/pricing-rules/:id/approve', action(async (req) => {
  await approveRule(pool, actor(req), pid(req));
  return { redirect: '/admin/settings#pricing', message: 'Rule approved and now in effect. Ensure it is disclosed in the customer agreement.' };
}));
adminRouter.post('/pricing-rules/:id/retire', action(async (req) => {
  await retireRule(pool, actor(req), pid(req));
  return { redirect: '/admin/settings#pricing', message: 'Rule retired' };
}));

adminRouter.post('/trades', action(async (req) => {
  requireAdmin(req);
  await pool.query(`INSERT INTO trades (code, name, is_specialist, required_documents, default_estimate_hours, before_photo_required) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_specialist = EXCLUDED.is_specialist, required_documents = EXCLUDED.required_documents,
      default_estimate_hours = EXCLUDED.default_estimate_hours, before_photo_required = EXCLUDED.before_photo_required`,
    [str(req.body.code).toLowerCase().replace(/[^a-z0-9_]/g, '_'), str(req.body.name), bool(req.body.is_specialist), arr(req.body.required_documents).filter(Boolean),
     num(req.body.default_estimate_hours) ?? 1.5, bool(req.body.before_photo_required)]);
  await audit(pool, actor(req), { action: 'trade.saved', entityType: 'trade', entityId: str(req.body.code) });
  return { redirect: '/admin/settings#trades', message: 'Trade saved' };
}));

adminRouter.post('/holidays', action(async (req) => {
  requireAdmin(req);
  await pool.query(`INSERT INTO public_holidays (holiday_date, name, region) VALUES ($1,$2,'NZ') ON CONFLICT DO NOTHING`, [str(req.body.date), str(req.body.name)]);
  await audit(pool, actor(req), { action: 'holiday.added', entityType: 'public_holiday', entityId: str(req.body.date), details: { name: str(req.body.name) } });
  return { redirect: '/admin/settings#holidays', message: 'Holiday added' };
}));

// ---------------------------------------------------------------- Users, notifications, integrations, audit, reports
adminRouter.get('/users', async (req, res) => {
  requireAdmin(req);
  const users = await query(pool, `SELECT id, name, email, role, is_active, last_login_at FROM users WHERE role IN ('admin','ops','finance') ORDER BY role, name`);
  res.render('admin/users', { users });
});
adminRouter.post('/users', action(async (req) => {
  requireAdmin(req);
  const role = str(req.body.role);
  if (!['admin', 'ops', 'finance'].includes(role)) throw new AppError('Invalid role');
  const u = await one(pool, `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id`,
    [str(req.body.email), await hashPassword(str(req.body.password)), str(req.body.name), role]).catch((e) => {
      if (e.code === '23505') throw new AppError('Email already in use');
      throw e;
    });
  await audit(pool, actor(req), { action: 'staff_user.created', entityType: 'user', entityId: u.id, details: { role } });
  return { redirect: '/admin/users', message: 'Staff user created' };
}));
adminRouter.post('/users/:id/active', action(async (req) => {
  requireAdmin(req);
  if (pid(req) === actor(req).id) throw new AppError('You cannot deactivate yourself');
  await pool.query('UPDATE users SET is_active = $2 WHERE id = $1', [pid(req), bool(req.body.active)]);
  await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb ->> 'userId' = $1`, [pid(req)]);
  await audit(pool, actor(req), { action: bool(req.body.active) ? 'user.activated' : 'user.deactivated', entityType: 'user', entityId: pid(req) });
  return { redirect: back(req), message: 'User updated' };
}));

adminRouter.get('/notifications', async (_req, res) => {
  const notifications = await query(pool, `SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200`);
  res.render('admin/notifications', { notifications });
});

adminRouter.get('/integrations', async (_req, res) => {
  const sync = await query(pool, `SELECT * FROM integration_sync ORDER BY created_at DESC LIMIT 100`);
  const webhooks = await query(pool, `SELECT provider, event_id, event_type, result, received_at FROM webhook_events ORDER BY received_at DESC LIMIT 50`);
  res.render('admin/integrations', { status: integrationStatus(), sync, webhooks });
});
adminRouter.post('/integrations/requeue', action(async (req) => {
  requireAdmin(req);
  await requeueSync(pool, optStr(req.body.id));
  return { redirect: '/admin/integrations', message: 'Re-queued' };
}));
adminRouter.post('/worker/run', action(async (req) => {
  requireAdmin(req);
  const r = await runWorkerCycle(pool);
  return { redirect: back(req), message: r ? `Background tasks ran: ${Object.entries(r).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}` : 'Worker already running elsewhere' };
}));

adminRouter.get('/audit', async (req, res) => {
  const entity = str(req.query.entity);
  const rows = await query(pool, `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    WHERE ($1 = '' OR a.entity_type = $1 OR a.entity_id = $1) ORDER BY a.id DESC LIMIT 300`, [entity]);
  res.render('admin/audit', { rows, entity });
});

adminRouter.get('/reports', async (req, res) => {
  const period = monthRange(req.query);
  res.render('admin/reports', { balances: await accountBalances(pool), period });
});
adminRouter.get('/reports/journal.csv', async (req, res) => {
  if (!['admin', 'finance'].includes(actor(req).role)) throw new ForbiddenError();
  const { from, to } = monthRange(req.query);
  res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="journal-${from}-to-${to}.csv"`);
  res.send(await journalCsv(pool, from, to));
});

function back(req: any): string {
  const ref = req.get('referer');
  try { return ref ? new URL(ref).pathname : '/admin'; } catch { return '/admin'; }
}

