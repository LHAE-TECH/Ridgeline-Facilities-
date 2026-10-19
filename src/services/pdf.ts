import PDFDocument from 'pdfkit';
import type { Db } from '../db.js';
import { maybeOne, one, query } from '../db.js';
import { NotFoundError } from '../lib/errors.js';
import { formatNzd, formatQuantity } from '../lib/money.js';
import { outstandingCents } from './customerInvoices.js';
import { accountPosition } from './ledger.js';
import { getSettings } from './settings.js';

type Doc = PDFKit.PDFDocument;

function render(build: (doc: Doc) => void | Promise<void>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Uncompressed in tests so document text can be asserted.
    const doc = new PDFDocument({ size: 'A4', margin: 50, compress: process.env.NODE_ENV !== 'test', info: { Producer: 'Ridgeline Facilities' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    Promise.resolve(build(doc)).then(() => doc.end(), reject);
  });
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d.length === 10 ? `${d}T00:00:00` : d) : d;
  return date.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Pacific/Auckland' });
}

function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Pacific/Auckland' });
}

/** "LHA Holdings Limited trading as Ridgeline Facilities" — the legal party on every document. */
export function legalEntity(company: { legal_name: string; trading_name?: string; name?: string }): string {
  return `${company.legal_name} trading as ${company.trading_name ?? company.name}`;
}

async function header(doc: Doc, db: Db, title: string) {
  const s = await getSettings(db);
  const c = s.company;
  doc.fontSize(18).font('Helvetica-Bold').text(c.trading_name ?? c.name, 50, 50);
  doc.fontSize(9).font('Helvetica').fillColor('#444');
  const lines = [`${legalEntity(c)}`, c.nzbn ? `NZBN ${c.nzbn}` : null, c.gst_number ? `GST number: ${c.gst_number}` : null,
    c.address, c.email, c.phone, c.website].filter(Boolean);
  doc.text(lines.join('\n'), { width: 290 });
  doc.fillColor('#000').fontSize(16).font('Helvetica-Bold').text(title, 350, 50, { width: 195, align: 'right' });
  doc.font('Helvetica').fontSize(10);
  doc.y = Math.max(doc.y, 150);
  doc.moveDown(1);
  doc.x = 50;
  return s;
}

function footer(doc: Doc, company: { legal_name: string; trading_name?: string; name?: string; nzbn?: string }) {
  doc.moveDown(2).fontSize(7.5).fillColor('#666')
    .text(`${company.trading_name ?? company.name} is a trading name of ${company.legal_name}${company.nzbn ? ` (NZBN ${company.nzbn})` : ''}.`, 50, doc.y, { width: 495 });
  doc.fillColor('#000');
}

function table(doc: Doc, cols: { label: string; width: number; align?: 'left' | 'right' }[], rows: string[][]) {
  const startX = 50;
  let y = doc.y + 5;
  const drawRow = (cells: string[], bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    let x = startX;
    const heights = cells.map((c, i) => doc.heightOfString(c, { width: cols[i].width - 6 }));
    const h = Math.max(...heights, 12);
    if (y + h > doc.page.height - 70) { doc.addPage(); y = 50; }
    cells.forEach((c, i) => { doc.text(c, x + 3, y, { width: cols[i].width - 6, align: cols[i].align ?? 'left' }); x += cols[i].width; });
    y += h + 4;
    doc.moveTo(startX, y - 2).lineTo(startX + cols.reduce((s, c) => s + c.width, 0), y - 2).strokeColor('#ddd').stroke();
  };
  drawRow(cols.map((c) => c.label), true);
  rows.forEach((r) => drawRow(r));
  doc.y = y + 5;
  doc.x = startX;
}

function totals(doc: Doc, rows: [string, string, boolean?][]) {
  for (const [label, value, bold] of rows) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
    const y = doc.y;
    doc.text(label, 300, y, { width: 150, align: 'right' });
    doc.text(value, 455, y, { width: 90, align: 'right' });
    doc.moveDown(0.3);
  }
  doc.x = 50;
}

/** Customer tax invoice. Shows Ridgeline's customer prices only (no contractor costs or margins). */
export async function customerInvoicePdf(db: Db, invoiceId: string): Promise<Buffer> {
  const inv = await maybeOne(db,
    `SELECT ci.*, j.ref AS job_ref, j.title AS job_title, j.completed_at, c.name AS customer_name, c.legal_name AS customer_legal_name,
            c.billing_address, c.account_ref, c.gst_number AS customer_gst, s.name AS site_name, s.address AS site_address
       FROM customer_invoices ci JOIN jobs j ON j.id = ci.job_id JOIN customers c ON c.id = ci.customer_id JOIN sites s ON s.id = j.site_id
      WHERE ci.id = $1`, [invoiceId]);
  if (!inv) throw new NotFoundError('Invoice');
  const lines = await query(db, 'SELECT * FROM customer_invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [invoiceId]);
  const credits = await query(db, 'SELECT * FROM credit_notes WHERE customer_invoice_id = $1 ORDER BY created_at', [invoiceId]);
  return render(async (doc) => {
    const company = (await getSettings(db)).company;
    const s = await header(doc, db, inv.gst_cents > 0 && company.gst_number ? 'TAX INVOICE' : 'INVOICE');
    doc.fontSize(10).font('Helvetica-Bold').text('Bill to');
    doc.font('Helvetica').text([inv.customer_legal_name || inv.customer_name, inv.billing_address, inv.customer_gst ? `GST: ${inv.customer_gst}` : null,
      `Account: ${inv.account_ref}`].filter(Boolean).join('\n'));
    doc.moveUp(4);
    doc.text([`Invoice number: ${inv.invoice_number ?? 'DRAFT'}`, `Issue date: ${fmtDate(inv.issue_date)}`, `Due date: ${fmtDate(inv.due_date)}`,
      `Job: ${inv.job_ref}`, inv.po_number ? `PO: ${inv.po_number}` : null].filter(Boolean).join('\n'), 330, doc.y, { width: 215, align: 'right' });
    doc.x = 50;
    doc.moveDown(2);
    doc.font('Helvetica-Bold').text(`${inv.job_title}`);
    doc.font('Helvetica').fontSize(9).text(`${inv.site_name}, ${inv.site_address}. Completed ${fmtDateTime(inv.completed_at)}`);
    doc.moveDown(0.5);
    table(doc, [{ label: 'Description', width: 265 }, { label: 'Qty', width: 50, align: 'right' }, { label: 'Unit price', width: 90, align: 'right' },
      { label: 'Amount (excl GST)', width: 90, align: 'right' }],
      lines.map((l) => [l.description, formatQuantity(l.quantity_milli), formatNzd(l.unit_price_cents), formatNzd(l.amount_ex_gst_cents)]));
    totals(doc, [
      ['Subtotal (excl GST)', formatNzd(inv.subtotal_ex_gst_cents)],
      [inv.gst_cents > 0 ? `GST (${(inv.pricing?.gstRateBps ?? s.gst_rate_bps) / 100}%)` : 'GST', formatNzd(inv.gst_cents)],
      ['Invoice total (incl GST)', formatNzd(inv.total_cents), true],
      ['Prepaid credit applied', `-${formatNzd(inv.prepaid_applied_cents)}`],
      ...(inv.amount_paid_cents ? [['Payments received', `-${formatNzd(inv.amount_paid_cents)}`] as [string, string]] : []),
      ...credits.map((c) => [`Credit note ${c.credit_note_number}`, `-${formatNzd(c.total_cents)}`] as [string, string]),
      ...(inv.credit_to_prepaid_cents ? [['Credit returned to prepaid balance', formatNzd(inv.credit_to_prepaid_cents)] as [string, string]] : []),
      ['Amount payable', formatNzd(outstandingCents(inv)), true],
    ]);
    doc.moveDown(1.5).fontSize(9).font('Helvetica');
    if (outstandingCents(inv) > 0) {
      doc.text(`Please pay by ${fmtDate(inv.due_date)} to ${s.company.bank_account_name} ${s.company.bank_account_number || '(bank account on request)'} using reference ${inv.invoice_number}.`);
    } else {
      doc.text('This invoice has been settled from your prepaid maintenance account. No payment is required.');
    }
    footer(doc, s.company);
  });
}

export async function statementPdf(db: Db, customerId: string): Promise<Buffer> {
  const c = await one(db, 'SELECT * FROM customers WHERE id = $1', [customerId]);
  const txns = await query(db, `SELECT * FROM prepaid_transactions WHERE customer_id = $1 ORDER BY created_at, id`, [customerId]);
  const invoices = await query(db, `SELECT * FROM customer_invoices WHERE customer_id = $1 AND status IN ('issued','partially_paid') ORDER BY issue_date`, [customerId]);
  const pos = await accountPosition(db, customerId);
  return render(async (doc) => {
    await header(doc, db, 'ACCOUNT STATEMENT');
    doc.font('Helvetica-Bold').text(c.legal_name || c.name);
    doc.font('Helvetica').text(`Account ${c.account_ref}\nStatement date: ${fmtDate(new Date())}`);
    doc.moveDown();
    totals(doc, [
      ['Agreed minimum balance', formatNzd(c.agreed_minimum_balance_cents)],
      ['Prepaid balance', formatNzd(pos.balanceCents), true],
      ['Committed to booked jobs', formatNzd(pos.committedCents)],
      ['Available balance', formatNzd(pos.availableCents), true],
    ]);
    if (pos.belowMinimum) doc.fillColor('#b00').text(`Your balance is below the agreed minimum. Please top up ${formatNzd(pos.shortfallToMinimumCents)}.`).fillColor('#000');
    doc.moveDown().font('Helvetica-Bold').text('Prepaid account transactions');
    table(doc, [{ label: 'Date', width: 75 }, { label: 'Description', width: 240 }, { label: 'Amount', width: 90, align: 'right' }, { label: 'Balance', width: 90, align: 'right' }],
      txns.map((t) => [fmtDate(t.created_at), t.description, formatNzd(t.amount_cents), formatNzd(t.balance_after_cents)]));
    if (invoices.length) {
      doc.moveDown().font('Helvetica-Bold').text('Outstanding invoices');
      table(doc, [{ label: 'Invoice', width: 110 }, { label: 'Issued', width: 90 }, { label: 'Due', width: 90 }, { label: 'Total', width: 100, align: 'right' }, { label: 'Outstanding', width: 105, align: 'right' }],
        invoices.map((i) => [i.invoice_number, fmtDate(i.issue_date), fmtDate(i.due_date), formatNzd(i.total_cents), formatNzd(outstandingCents(i))]));
    }
    doc.moveDown().fontSize(8).fillColor('#555').text(`Your prepaid balance is held as a credit on your account with ${legalEntity((await getSettings(db)).company)} under your service agreement. Charges are deducted only when a job is invoiced.`);
    footer(doc, (await getSettings(db)).company);
  });
}

export async function completionReportPdf(db: Db, jobId: string): Promise<Buffer> {
  const job = await one(db,
    `SELECT j.*, s.name AS site_name, s.address AS site_address, t.name AS trade_name, c.name AS customer_name, k.trading_name, k.legal_name AS contractor_name,
            u.label AS unit_label
       FROM jobs j JOIN sites s ON s.id = j.site_id JOIN trades t ON t.id = j.trade_id JOIN customers c ON c.id = j.customer_id
       LEFT JOIN contractors k ON k.id = j.assigned_contractor_id LEFT JOIN units u ON u.id = j.unit_id WHERE j.id = $1`, [jobId]);
  const report = await maybeOne(db, `SELECT * FROM completion_reports WHERE job_id = $1 AND review_status = 'approved' ORDER BY version DESC LIMIT 1`, [jobId])
    ?? await maybeOne(db, `SELECT * FROM completion_reports WHERE job_id = $1 ORDER BY version DESC LIMIT 1`, [jobId]);
  const evidence = await query(db, `SELECT kind, COUNT(*)::int AS n FROM job_evidence WHERE job_id = $1 AND withdrawn_at IS NULL GROUP BY kind`, [jobId]);
  return render(async (doc) => {
    await header(doc, db, 'COMPLETION REPORT');
    doc.font('Helvetica-Bold').text(`${job.ref}: ${job.title}`);
    doc.font('Helvetica').text([`Customer: ${job.customer_name}`, `Site: ${job.site_name}, ${job.site_address}${job.unit_label ? ` (unit ${job.unit_label})` : ''}`,
      `Trade: ${job.trade_name}`, `Contractor: ${job.trading_name || job.contractor_name || '—'}`, `Priority: ${job.priority}`].join('\n'));
    doc.moveDown().font('Helvetica-Bold').text('Attendance (server-recorded times)');
    doc.font('Helvetica').text([`Accepted: ${fmtDateTime(job.accepted_at)}`, `Arrived: ${fmtDateTime(job.arrived_at)}`, `Work started: ${fmtDateTime(job.started_at)}`,
      `Completed: ${fmtDateTime(job.completed_at)}`].join('\n'));
    if (report) {
      doc.moveDown().font('Helvetica-Bold').text('Work performed');
      doc.font('Helvetica').text(report.work_performed);
      doc.moveDown(0.5).text(`Labour: ${Math.floor(report.labour_minutes / 60)} h ${report.labour_minutes % 60} min (${report.workers} worker(s))`);
      if ((report.materials ?? []).length) {
        doc.moveDown(0.5).font('Helvetica-Bold').text('Materials used');
        doc.font('Helvetica').text(report.materials.map((m: any) => `• ${m.description} × ${formatQuantity(m.quantityMilli)}`).join('\n'));
      }
      if (report.issues_found) doc.moveDown(0.5).font('Helvetica-Bold').text('Issues found').font('Helvetica').text(report.issues_found);
      if (report.site_notes) doc.moveDown(0.5).font('Helvetica-Bold').text('Site notes').font('Helvetica').text(report.site_notes);
      if (report.acknowledged_by_name) doc.moveDown(0.5).text(`Acknowledged on site by ${report.acknowledged_by_name} at ${fmtDateTime(report.acknowledged_at)}`);
      doc.moveDown(0.5).text(`Report version ${report.version}; review status: ${report.review_status}`);
    }
    doc.moveDown().text(`Photographic evidence on file: ${evidence.map((e) => `${e.n} ${e.kind.replace('_', ' ')}`).join(', ') || 'none'}. Photos are available in the customer portal.`);
    doc.moveDown().fontSize(8).fillColor('#555').text('Event times are recorded by Ridgeline servers. Device-supplied photo times and locations are shown as reported and are not independently verified.');
    footer(doc, (await getSettings(db)).company);
  });
}

export async function remittancePdf(db: Db, paymentId: string): Promise<Buffer> {
  const p = await one(db,
    `SELECT cp.*, k.legal_name, ci.invoice_number, ci.total_cents AS invoice_total, j.ref AS job_ref, pb.adjustments_cents
       FROM contractor_payments cp JOIN contractors k ON k.id = cp.contractor_id JOIN contractor_payables pb ON pb.id = cp.payable_id
       JOIN contractor_invoices ci ON ci.id = pb.contractor_invoice_id JOIN jobs j ON j.id = pb.job_id WHERE cp.id = $1`, [paymentId]);
  return render(async (doc) => {
    await header(doc, db, 'REMITTANCE ADVICE');
    doc.text(`From: ${legalEntity((await getSettings(db)).company)}\nTo: ${p.legal_name}\nPayment date: ${fmtDate(p.paid_date)}\nReference: ${p.payment_reference ?? 'pending'}`);
    doc.moveDown();
    table(doc, [{ label: 'Invoice', width: 120 }, { label: 'Job', width: 110 }, { label: 'Invoice total', width: 90, align: 'right' },
      { label: 'Adjustments', width: 85, align: 'right' }, { label: 'Paid', width: 90, align: 'right' }],
      [[p.invoice_number, p.job_ref, formatNzd(p.invoice_total), formatNzd(p.adjustments_cents), formatNzd(p.amount_cents)]]);
    footer(doc, (await getSettings(db)).company);
  });
}

/** Credit note (a GST credit note where the original was a tax invoice). */
export async function creditNotePdf(db: Db, creditNoteId: string): Promise<Buffer> {
  const cn = await maybeOne(db,
    `SELECT cn.*, ci.invoice_number, ci.issue_date AS invoice_date, c.name AS customer_name, c.legal_name AS customer_legal_name, c.billing_address,
            c.account_ref, c.gst_number AS customer_gst, j.ref AS job_ref
       FROM credit_notes cn JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id JOIN customers c ON c.id = cn.customer_id JOIN jobs j ON j.id = ci.job_id
      WHERE cn.id = $1`, [creditNoteId]);
  if (!cn) throw new NotFoundError('Credit note');
  return render(async (doc) => {
    const company = (await getSettings(db)).company;
    const s = await header(doc, db, cn.gst_cents > 0 && company.gst_number ? 'CREDIT NOTE (GST)' : 'CREDIT NOTE');
    doc.font('Helvetica-Bold').text('Credit to');
    doc.font('Helvetica').text([cn.customer_legal_name || cn.customer_name, cn.billing_address, cn.customer_gst ? `GST: ${cn.customer_gst}` : null, `Account: ${cn.account_ref}`].filter(Boolean).join('\n'));
    doc.moveDown();
    doc.text([`Credit note number: ${cn.credit_note_number}`, `Date: ${fmtDate(cn.created_at)}`, `Original invoice: ${cn.invoice_number} (${fmtDate(cn.invoice_date)})`, `Job: ${cn.job_ref}`].join('\n'));
    doc.moveDown().font('Helvetica-Bold').text('Reason').font('Helvetica').text(cn.reason);
    doc.moveDown();
    totals(doc, [
      ['Credit (excl GST)', formatNzd(cn.amount_ex_gst_cents)],
      ['GST', formatNzd(cn.gst_cents)],
      ['Total credit (incl GST)', formatNzd(cn.total_cents), true],
      ['Applied to amount owing', formatNzd(cn.to_receivable_cents)],
      ['Returned to prepaid balance', formatNzd(cn.to_prepaid_cents)],
    ]);
    footer(doc, s.company);
  });
}

/** Monthly customer report: jobs, spend, SLA performance and prepaid account movement for one month (YYYY-MM). */
export async function monthlyReportPdf(db: Db, customerId: string, month: string): Promise<Buffer> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new NotFoundError('Report month');
  const { slaPerformance, priorityLabel } = await import('./sla.js');
  const from = `${month}-01`;
  const end = new Date(`${from}T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  const to = end.toISOString().slice(0, 10);
  const c = await one(db, 'SELECT * FROM customers WHERE id = $1', [customerId]);
  const sla = await slaPerformance(db, { from, to }, customerId);
  const jobs = await query(db,
    `SELECT j.ref, j.title, j.priority, j.status, j.sla_onsite_met, j.sla_resolve_met, s.name AS site_name,
            (SELECT total_cents FROM customer_invoices ci WHERE ci.job_id = j.id AND ci.status NOT IN ('draft','void')) AS invoiced
       FROM jobs j JOIN sites s ON s.id = j.site_id
      WHERE j.customer_id = $1 AND (j.created_at AT TIME ZONE 'Pacific/Auckland')::date BETWEEN $2 AND $3 ORDER BY j.created_at`, [customerId, from, to]);
  const money = await one(db,
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE txn_type IN ('deposit','top_up')),0)::bigint AS topups,
            COALESCE(-SUM(amount_cents) FILTER (WHERE txn_type IN ('job_charge','receivable_settlement')),0)::bigint AS charges,
            COALESCE(SUM(amount_cents) FILTER (WHERE txn_type NOT IN ('deposit','top_up','job_charge','receivable_settlement')),0)::bigint AS other
       FROM prepaid_transactions WHERE customer_id = $1 AND (created_at AT TIME ZONE 'Pacific/Auckland')::date BETWEEN $2 AND $3`, [customerId, from, to]);
  const closing = await maybeOne(db, `SELECT balance_after_cents FROM prepaid_transactions WHERE customer_id = $1 AND (created_at AT TIME ZONE 'Pacific/Auckland')::date <= $2
    ORDER BY created_at DESC, id DESC LIMIT 1`, [customerId, to]);
  const monthLabel = new Date(`${from}T00:00:00Z`).toLocaleDateString('en-NZ', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return render(async (doc) => {
    const s = await header(doc, db, 'MONTHLY REPORT');
    doc.font('Helvetica-Bold').text(`${c.legal_name || c.name} · ${monthLabel}`);
    doc.font('Helvetica').text(`Account ${c.account_ref}`);
    doc.moveDown().font('Helvetica-Bold').text('Service levels');
    table(doc, [{ label: 'Priority', width: 120 }, { label: 'Jobs', width: 50, align: 'right' }, { label: 'On site in target', width: 110, align: 'right' },
      { label: 'Resolved in target', width: 115, align: 'right' }, { label: 'Avg time to site', width: 100, align: 'right' }],
      sla.map((r) => [`${r.code} ${r.label}`, String(r.jobs), r.onsitePct === null ? '—' : `${r.onsiteMet}/${r.onsiteMeasured} (${r.onsitePct}%)`,
        r.resolvePct === null ? '—' : `${r.resolveMet}/${r.resolveMeasured} (${r.resolvePct}%)`,
        r.avgMinutesToSite === null ? '—' : `${Math.floor(r.avgMinutesToSite / 60)}h ${r.avgMinutesToSite % 60}m`]));
    doc.fontSize(8).fillColor('#555').text('Targets are measured from when a job is accepted for dispatch. P2/P3 targets count NZ business hours; P1 targets run 24/7. Jobs still open are measured once their target passes or the visit occurs.').fillColor('#000').fontSize(10);
    doc.moveDown().font('Helvetica-Bold').text('Prepaid account');
    totals(doc, [['Top-ups received', formatNzd(money.topups)], ['Maintenance charges', formatNzd(money.charges)], ['Refunds, credits & adjustments', formatNzd(money.other)],
      ['Balance at month end', formatNzd(closing?.balance_after_cents ?? 0), true]]);
    doc.moveDown().font('Helvetica-Bold').text(`Jobs booked (${jobs.length})`);
    table(doc, [{ label: 'Job', width: 75 }, { label: 'Site / description', width: 190 }, { label: 'Priority', width: 75 }, { label: 'SLA', width: 70 }, { label: 'Invoiced', width: 85, align: 'right' }],
      jobs.map((j) => [j.ref, `${j.site_name}: ${j.title}`, priorityLabel(j.priority),
        j.sla_onsite_met === null ? (j.status === 'cancelled' ? 'Cancelled' : 'Open') : j.sla_onsite_met && j.sla_resolve_met !== false ? 'Met' : 'Missed',
        j.invoiced ? formatNzd(j.invoiced) : '—']));
    footer(doc, s.company);
  });
}
