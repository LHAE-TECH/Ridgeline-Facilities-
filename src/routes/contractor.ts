import { Router } from 'express';
import { maybeOne, one, pool, query } from '../db.js';
import { AppError } from '../lib/errors.js';
import { gstOn } from '../lib/money.js';
import { getContractorInvoiceForActor, submitContractorInvoice } from '../services/contractorInvoices.js';
import { addComplianceDocument, contractorProfile, currentRateCard, DOCUMENT_TYPES, updateContractor } from '../services/contractors.js';
import { raiseDispute } from '../services/disputes.js';
import { acceptOffer, declineOffer } from '../services/dispatch.js';
import { addEvidence, completeJob, evidenceStatus, markMadeSafe, recordArrival, startWork, submitQuote, type EvidenceKind } from '../services/evidence.js';
import { getJobForActor } from '../services/jobs.js';
import { payableAmount } from '../services/payables.js';
import { COST_CATEGORIES } from '../services/pricing.js';
import { getSettings } from '../services/settings.js';
import { saveFile } from '../services/storage.js';
import { TIME_WINDOWS } from '../services/timeWindows.js';
import { action, actor, arr, bool, dollars, geo, int, multipart, newKey, num, optStr, qty, requireRole, str, uploadedFiles , pid } from '../web/helpers.js';

export const contractorRouter = Router();
contractorRouter.use(requireRole('contractor'));

const kid = (req: any): string => actor(req).contractorId!;

contractorRouter.get('/', async (req, res) => {
  const contractorId = kid(req);
  const offers = await query(pool,
    `SELECT o.*, j.ref, j.title, j.priority, j.preferred_start, j.description, j.sla_onsite_due, s.suburb, s.city, s.region, t.name AS trade_name
       FROM job_offers o JOIN jobs j ON j.id = o.job_id JOIN sites s ON s.id = j.site_id JOIN trades t ON t.id = j.trade_id
      WHERE o.contractor_id = $1 AND o.status = 'offered' AND o.expires_at > now() ORDER BY j.sla_onsite_due NULLS LAST, o.expires_at`, [contractorId]);
  const jobs = await query(pool,
    `SELECT j.*, s.name AS site_name, s.address AS site_address FROM jobs j JOIN sites s ON s.id = j.site_id
      WHERE j.assigned_contractor_id = $1 AND j.status NOT IN ('closed') AND (j.status <> 'cancelled' OR j.cancellation_billable)
      ORDER BY CASE WHEN j.status IN ('assigned','on_site','in_progress','evidence_rejected') THEN 0 ELSE 1 END, j.updated_at DESC LIMIT 50`, [contractorId]);
  const contractor = await one(pool, 'SELECT * FROM contractors WHERE id = $1', [contractorId]);
  const expiring = await query(pool, `SELECT * FROM compliance_documents WHERE contractor_id = $1 AND status = 'verified' AND expires_at <= CURRENT_DATE + 30`, [contractorId]);
  res.render('contractor/dashboard', { offers, jobs, contractor, expiring });
});

contractorRouter.post('/offers/:id/accept', action(async (req) => {
  const job = await acceptOffer(pool, actor(req), pid(req));
  return { redirect: `/c/jobs/${job.id}`, message: `You have accepted ${job.ref}` };
}));

contractorRouter.post('/offers/:id/decline', action(async (req) => {
  await declineOffer(pool, actor(req), pid(req), optStr(req.body.reason));
  return { redirect: '/c', message: 'Offer declined' };
}));

contractorRouter.get('/jobs/:id', async (req, res) => {
  const a = actor(req);
  const job = await getJobForActor(pool, a, pid(req));
  const assigned = job.assigned_contractor_id === a.contractorId;
  const offer = assigned ? null : await maybeOne(pool, `SELECT * FROM job_offers WHERE job_id = $1 AND contractor_id = $2 AND status = 'offered'`, [job.id, a.contractorId]);
  const evidence = assigned ? await query(pool, `SELECT * FROM job_evidence WHERE job_id = $1 AND withdrawn_at IS NULL ORDER BY uploaded_at`, [job.id]) : [];
  const reports = assigned ? await query(pool, `SELECT * FROM completion_reports WHERE job_id = $1 ORDER BY version DESC`, [job.id]) : [];
  const status = assigned ? await evidenceStatus(pool, job.id) : null;
  const quotes = assigned ? await query(pool, `SELECT * FROM quotes WHERE job_id = $1 AND contractor_id = $2 ORDER BY created_at`, [job.id, a.contractorId]) : [];
  const invoices = assigned ? await query(pool, `SELECT * FROM contractor_invoices WHERE job_id = $1 AND contractor_id = $2 ORDER BY created_at DESC`, [job.id, a.contractorId]) : [];
  const rateCard = assigned ? await currentRateCard(pool, a.contractorId!, job.trade_id) : null;
  const contractor = await one(pool, 'SELECT gst_registered, gst_number, legal_name, nzbn, payment_terms_days FROM contractors WHERE id = $1', [a.contractorId]);
  const events = assigned ? await query(pool, `SELECT event_type, note, occurred_at FROM job_events WHERE job_id = $1 ORDER BY id`, [job.id]) : [];
  res.render('contractor/job', { job, assigned, offer, evidence, reports, status, quotes, invoices, rateCard, contractor, events,
    categories: COST_CATEGORIES, windows: TIME_WINDOWS, key: newKey(), settings: await getSettings(pool) });
});

contractorRouter.post('/jobs/:id/arrive', action(async (req) => {
  await recordArrival(pool, actor(req), pid(req), geo(req.body));
  return { redirect: `/c/jobs/${pid(req)}`, message: 'Arrival recorded' };
}));

contractorRouter.post('/jobs/:id/made-safe', action(async (req) => {
  await markMadeSafe(pool, actor(req), pid(req), str(req.body.note), geo(req.body));
  return { redirect: `/c/jobs/${pid(req)}`, message: 'Recorded: site made safe' };
}));

contractorRouter.post('/jobs/:id/start', action(async (req) => {
  await startWork(pool, actor(req), pid(req), geo(req.body));
  return { redirect: `/c/jobs/${pid(req)}`, message: 'Work started' };
}));

contractorRouter.post('/jobs/:id/evidence', ...multipart('files', 10), action(async (req) => {
  const files = uploadedFiles(req);
  await addEvidence(pool, actor(req), pid(req), str(req.body.kind) as EvidenceKind, files, { caption: optStr(req.body.caption),
    deviceCapturedAt: optStr(req.body.device_captured_at) ?? null, ...geo(req.body) });
  return { redirect: `/c/jobs/${pid(req)}`, message: `${files.length} file(s) uploaded` };
}));

contractorRouter.post('/jobs/:id/complete', action(async (req) => {
  const descriptions = arr(req.body.material_description);
  const quantities = arr(req.body.material_quantity);
  const costs = arr(req.body.material_cost);
  const materials = descriptions.map((d, i) => ({ description: d, quantity: quantities[i] || '1', unitCostCents: costs[i] ? dollars(costs[i], 'Material cost') : 0 }))
    .filter((m) => m.description.trim());
  const hours = num(req.body.labour_hours) ?? 0;
  await completeJob(pool, actor(req), pid(req), {
    workPerformed: str(req.body.work_performed), labourMinutes: Math.round(hours * 60), workers: int(req.body.workers || '1', 'Workers'), materials,
    siteNotes: optStr(req.body.site_notes), issuesFound: optStr(req.body.issues_found), acknowledgedByName: optStr(req.body.acknowledged_by_name),
  }, geo(req.body));
  return { redirect: `/c/jobs/${pid(req)}`, message: 'Completion report submitted for Ridgeline review' };
}));

function parseLines(body: any) {
  const cats = arr(body.line_category);
  const descs = arr(body.line_description);
  const qtys = arr(body.line_quantity);
  const rates = arr(body.line_rate);
  const windows = arr(body.line_window);
  const variations = arr(body.line_variation);
  return cats.map((category, i) => ({ category, description: descs[i] ?? '', q: qtys[i] ?? '', r: rates[i] ?? '', w: windows[i] || 'standard', v: variations[i] || null }))
    .filter((l) => l.description.trim() || l.q || l.r)
    .map((l, i) => ({ category: l.category as any, description: l.description, quantityMilli: qty(l.q, `Line ${i + 1} quantity`),
      unitRateCents: dollars(l.r, `Line ${i + 1} rate`), timeWindow: l.w as any, variationId: l.v }));
}

contractorRouter.post('/jobs/:id/quote', action(async (req) => {
  const kind = str(req.body.kind) === 'quote' ? 'quote' : 'variation';
  await submitQuote(pool, actor(req), pid(req), kind, str(req.body.description), parseLines(req.body));
  return { redirect: `/c/jobs/${pid(req)}`, message: `${kind === 'quote' ? 'Quote' : 'Variation'} submitted to Ridgeline` };
}));

contractorRouter.post('/jobs/:id/invoice', ...multipart('invoice_file', 1), action(async (req) => {
  const a = actor(req);
  const lines = parseLines(req.body);
  if (!lines.length) throw new AppError('Add at least one invoice line');
  const contractor = await one(pool, 'SELECT gst_registered FROM contractors WHERE id = $1', [a.contractorId]);
  const subtotal = lines.reduce((s, l) => s + Math.round((l.quantityMilli * l.unitRateCents) / 1000), 0);
  const gst = contractor.gst_registered ? gstOn(subtotal, (await getSettings(pool)).gst_rate_bps) : 0;
  const stated = str(req.body.total) ? dollars(req.body.total, 'Invoice total') : subtotal + gst;
  const files = uploadedFiles(req);
  const job = await getJobForActor(pool, a, pid(req));
  const file = files[0] ? await saveFile(pool, a, { ...files[0], purpose: 'contractor_invoice', contractorId: a.contractorId, jobId: job.id }) : null;
  const inv = await submitContractorInvoice(pool, a, { jobId: pid(req), invoiceNumber: str(req.body.invoice_number), invoiceDate: str(req.body.invoice_date),
    lines, gstCents: str(req.body.gst) ? dollars(req.body.gst, 'GST') : gst, totalCents: stated, isTaxInvoice: bool(req.body.is_tax_invoice) || contractor.gst_registered,
    notes: optStr(req.body.notes), fileId: file?.id ?? null, idempotencyKey: str(req.body.key) || undefined });
  return { redirect: `/c/invoices/${inv.id}`, message: inv.status === 'flagged' ? 'Invoice submitted. Some items were flagged for Ridgeline review.' : 'Invoice submitted to Ridgeline' };
}));

contractorRouter.post('/jobs/:id/dispute', action(async (req) => {
  await raiseDispute(pool, actor(req), pid(req), str(req.body.reason));
  return { redirect: `/c/jobs/${pid(req)}`, message: 'Issue raised with Ridgeline' };
}));

contractorRouter.get('/invoices', async (req, res) => {
  const invoices = await query(pool, `SELECT ci.*, j.ref AS job_ref, p.status AS payable_status, p.due_date, p.invoice_total_cents, p.adjustments_cents
    FROM contractor_invoices ci JOIN jobs j ON j.id = ci.job_id LEFT JOIN contractor_payables p ON p.contractor_invoice_id = ci.id
    WHERE ci.contractor_id = $1 ORDER BY ci.created_at DESC`, [kid(req)]);
  res.render('contractor/invoices', { invoices, payableAmount });
});

contractorRouter.get('/invoices/:id', async (req, res) => {
  const data = await getContractorInvoiceForActor(pool, actor(req), pid(req));
  const payable = await maybeOne(pool, 'SELECT * FROM contractor_payables WHERE contractor_invoice_id = $1', [pid(req)]);
  const payments = payable ? await query(pool, `SELECT * FROM contractor_payments WHERE payable_id = $1 ORDER BY created_at`, [payable.id]) : [];
  res.render('contractor/invoice', { ...data, payable, payments, payableAmount });
});

contractorRouter.get('/profile', async (req, res) => {
  const profile = await contractorProfile(pool, actor(req), kid(req));
  res.render('contractor/profile', { ...profile, documentTypes: DOCUMENT_TYPES });
});

contractorRouter.post('/profile', action(async (req) => {
  await updateContractor(pool, actor(req), kid(req), { available: bool(req.body.available), afterHoursAvailable: bool(req.body.after_hours), emergencyAvailable: bool(req.body.emergency),
    phone: optStr(req.body.phone), mobilePhone: str(req.body.mobile_phone), bankAccountName: optStr(req.body.bank_account_name), bankAccountNumber: optStr(req.body.bank_account_number) });
  return { redirect: '/c/profile', message: 'Profile updated' };
}));

contractorRouter.post('/documents', ...multipart('file', 1), action(async (req) => {
  const a = actor(req);
  const files = uploadedFiles(req);
  const file = files[0] ? await saveFile(pool, a, { ...files[0], purpose: 'compliance', contractorId: a.contractorId }) : null;
  await addComplianceDocument(pool, a, kid(req), { docType: str(req.body.doc_type), reference: optStr(req.body.reference), issuedAt: optStr(req.body.issued_at) ?? null,
    expiresAt: optStr(req.body.expires_at) ?? null, fileId: file?.id ?? null });
  return { redirect: '/c/profile', message: 'Document uploaded for verification' };
}));
