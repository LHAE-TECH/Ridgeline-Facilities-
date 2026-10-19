import type { Db } from '../db.js';
import { one, query } from '../db.js';
import { accountBalances } from './ledger.js';
import { followUpSummary } from './followUps.js';
import { p1Exposure, p1HoldReport } from './p1Scope.js';
import { areaUnconfirmedJobs, openSlaJobs, slaPerformance, unconfirmedSites } from './sla.js';

/**
 * Operations dashboard figures. Customer prepaid balances are a LIABILITY and are reported separately from
 * cash, revenue, receivables, contractor payables and gross profit; deposits are never counted as revenue.
 */
export async function dashboard(db: Db, period: { from: string; to: string }) {
  const gl = Object.fromEntries((await accountBalances(db)).map((a) => [a.code, a.balance_cents]));
  const accounts = await one(db, `SELECT
      COUNT(*) FILTER (WHERE status = 'active')::int AS active,
      COUNT(*) FILTER (WHERE status IN ('pending_assessment','pending_deposit'))::int AS onboarding,
      COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended,
      COALESCE(SUM(agreed_minimum_balance_cents) FILTER (WHERE status = 'active'),0)::bigint AS required_minimum,
      COUNT(*) FILTER (WHERE status = 'active' AND agreed_minimum_balance_cents IS NOT NULL AND prepaid_balance_cents < agreed_minimum_balance_cents)::int AS low_balance,
      COUNT(*) FILTER (WHERE custom_arrangement)::int AS custom_arrangements
    FROM customers`);
  const facilities = await one(db, `SELECT COUNT(*)::int AS facilities, COALESCE(SUM(unit_count),0)::int AS units, (SELECT COUNT(*)::int FROM sites WHERE is_active) AS sites FROM facilities WHERE is_active`);
  const committed = await one(db, `SELECT COALESCE(SUM(amount_cents),0)::bigint AS v FROM job_commitments WHERE status = 'active'`);
  const lowBalance = await query(db, `SELECT id, name, account_ref, prepaid_balance_cents, agreed_minimum_balance_cents FROM customers
    WHERE status = 'active' AND agreed_minimum_balance_cents IS NOT NULL AND prepaid_balance_cents < agreed_minimum_balance_cents ORDER BY name LIMIT 20`);
  const jobs = Object.fromEntries((await query(db, `SELECT status, COUNT(*)::int AS n FROM jobs GROUP BY status`)).map((r) => [r.status, r.n]));
  const overdue = (await openSlaJobs(db)).slice(0, 25);
  const sla = await slaPerformance(db, period);
  const breaches = await one(db, `SELECT COUNT(*) FILTER (WHERE sla_onsite_breached_at IS NOT NULL OR sla_resolve_breached_at IS NOT NULL)::int AS breached,
      COUNT(*) FILTER (WHERE escalation_level > 0)::int AS escalated
    FROM jobs WHERE status <> 'cancelled' AND COALESCE((sla_targets->>'area_confirmed')::boolean, true)
      AND (sla_started_at AT TIME ZONE 'Pacific/Auckland')::date BETWEEN $1::date AND $2::date`, [period.from, period.to]);
  const areaUnconfirmed = { jobs: await areaUnconfirmedJobs(db, period), sites: await unconfirmedSites(db) };
  const unfundedP1 = await p1Exposure(db);
  const p1Holds = await p1HoldReport(db, period);
  const followUps = await followUpSummary(db);
  const ci = await one(db, `SELECT COUNT(*) FILTER (WHERE status IN ('submitted','flagged'))::int AS awaiting, COUNT(*) FILTER (WHERE status = 'flagged')::int AS flagged FROM contractor_invoices`);
  const custInv = await one(db, `SELECT COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts,
      COUNT(*) FILTER (WHERE status <> 'draft' AND status <> 'void' AND issue_date BETWEEN $1 AND $2)::int AS issued_in_period,
      COUNT(*) FILTER (WHERE status IN ('issued','partially_paid') AND due_date < CURRENT_DATE)::int AS overdue
    FROM customer_invoices`, [period.from, period.to]);
  const payables = await one(db, `SELECT
      COALESCE(SUM(invoice_total_cents + adjustments_cents) FILTER (WHERE status IN ('awaiting_payment_approval','approved_for_payment','in_batch','on_hold')),0)::bigint AS approved_unpaid,
      COALESCE(SUM(invoice_total_cents + adjustments_cents) FILTER (WHERE status IN ('approved_for_payment','in_batch') AND due_date <= CURRENT_DATE + 7),0)::bigint AS due_7_days,
      COUNT(*) FILTER (WHERE status IN ('approved_for_payment','in_batch') AND due_date < CURRENT_DATE)::int AS overdue,
      COUNT(*) FILTER (WHERE status = 'on_hold')::int AS on_hold
    FROM contractor_payables`);
  const paid = await one(db, `SELECT COALESCE(SUM(amount_cents),0)::bigint AS v, COUNT(*)::int AS n FROM contractor_payments WHERE status = 'confirmed' AND paid_date BETWEEN $1 AND $2`, [period.from, period.to]);
  const margin = await one(db, `SELECT COALESCE(SUM(subtotal_ex_gst_cents),0)::bigint AS sales, COALESCE(SUM(contractor_cost_ex_gst_cents),0)::bigint AS cost,
      COALESCE(SUM(markup_cents),0)::bigint AS markup, COUNT(*)::int AS n
    FROM customer_invoices WHERE status NOT IN ('draft','void') AND issue_date BETWEEN $1 AND $2`, [period.from, period.to]);
  const credits = await one(db, `SELECT COALESCE(SUM(amount_ex_gst_cents),0)::bigint AS v FROM credit_notes WHERE created_at::date BETWEEN $1 AND $2`, [period.from, period.to]);
  const byWindow = await query(db, `SELECT l.time_window, COALESCE(SUM(l.amount_cents),0)::bigint AS contractor_cost,
      COALESCE(SUM(cl.amount_ex_gst_cents),0)::bigint AS customer_price
    FROM contractor_invoice_lines l JOIN contractor_invoices i ON i.id = l.invoice_id AND i.status = 'approved'
    LEFT JOIN customer_invoice_lines cl ON cl.contractor_line_id = l.id
    LEFT JOIN customer_invoices ci ON ci.id = cl.invoice_id AND ci.status NOT IN ('draft','void')
    WHERE i.approved_at::date BETWEEN $1 AND $2 GROUP BY l.time_window ORDER BY l.time_window`, [period.from, period.to]);
  const disputes = await one(db, `SELECT COUNT(*)::int AS n FROM disputes WHERE status IN ('open','investigating')`);
  const compliance = await query(db, `SELECT d.doc_type, d.expires_at, k.id AS contractor_id, k.legal_name FROM compliance_documents d JOIN contractors k ON k.id = d.contractor_id
    WHERE d.status = 'verified' AND d.expires_at IS NOT NULL AND d.expires_at <= CURRENT_DATE + 30 AND k.status = 'approved' ORDER BY d.expires_at LIMIT 20`);
  const failures = await one(db, `SELECT
      (SELECT COUNT(*)::int FROM customer_payments WHERE status IN ('failed','reversed') AND created_at > now() - interval '30 days') AS failed_payments,
      (SELECT COUNT(*)::int FROM integration_sync WHERE status = 'failed') AS failed_sync,
      (SELECT COUNT(*)::int FROM integration_sync WHERE status = 'skipped_unconfigured') AS skipped_sync,
      (SELECT COUNT(*)::int FROM notifications WHERE status = 'failed') AS failed_notifications,
      (SELECT COUNT(*)::int FROM notifications WHERE status = 'not_sent_unconfigured') AS unsent_notifications,
      (SELECT COUNT(*)::int FROM customer_payments WHERE status = 'pending') AS pending_payments`);

  const sales = margin.sales - credits.v;
  return {
    period,
    areaUnconfirmed,
    unfundedP1,
    p1Holds,
    followUps,
    gl,
    balanceSheet: {
      cash: (gl.BANK ?? 0) + (gl.STRIPE_CLEARING ?? 0),
      customerPrepaidLiability: gl.CUSTOMER_PREPAID ?? 0,
      receivables: gl.ACCOUNTS_RECEIVABLE ?? 0,
      contractorPayables: gl.CONTRACTOR_PAYABLE ?? 0,
      gstPayableNet: (gl.GST_OUTPUT ?? 0) - (gl.GST_INPUT ?? 0),
    },
    profitAllTime: {
      revenue: gl.MAINTENANCE_REVENUE ?? 0,
      contractorCosts: gl.CONTRACTOR_COSTS ?? 0,
      grossProfit: (gl.MAINTENANCE_REVENUE ?? 0) - (gl.CONTRACTOR_COSTS ?? 0),
    },
    accounts: { ...accounts, committed: committed.v, available: (gl.CUSTOMER_PREPAID ?? 0) - committed.v },
    facilities,
    lowBalance,
    jobs: {
      awaitingFunds: (jobs.pending_funds ?? 0) + (jobs.awaiting_customer_approval ?? 0),
      awaitingDispatch: (jobs.dispatch ?? 0) + (jobs.offered ?? 0),
      inProgress: (jobs.assigned ?? 0) + (jobs.on_site ?? 0) + (jobs.in_progress ?? 0),
      awaitingEvidence: (jobs.evidence_submitted ?? 0) + (jobs.evidence_rejected ?? 0),
      awaitingInvoice: (jobs.evidence_approved ?? 0) + (jobs.invoice_submitted ?? 0),
      readyToInvoice: jobs.invoice_approved ?? 0,
      invoiced: jobs.customer_invoiced ?? 0,
      closed: jobs.closed ?? 0,
      byStatus: jobs,
    },
    overdue,
    sla,
    slaBreaches: breaches,
    contractorInvoices: ci,
    customerInvoices: custInv,
    payables: { ...payables, paidInPeriod: paid.v, paidCountInPeriod: paid.n },
    margin: {
      invoices: margin.n,
      sellingPriceExGst: sales,
      contractorCostExGst: margin.cost,
      markup: margin.markup - credits.v,
      creditNotes: credits.v,
      grossProfit: sales - margin.cost,
      grossMarginBps: sales > 0 ? Math.round(((sales - margin.cost) * 10000) / sales) : 0,
    },
    byWindow,
    disputes: disputes.n,
    compliance,
    failures,
  };
}

export async function journalCsv(db: Db, from: string, to: string): Promise<string> {
  const rows = await query(db, `SELECT e.entry_date, e.description, e.source_type, e.source_id, l.account_code, l.debit_cents, l.credit_cents,
      c.account_ref, k.legal_name AS contractor, j.ref AS job_ref
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN customers c ON c.id = l.customer_id
    LEFT JOIN contractors k ON k.id = l.contractor_id LEFT JOIN jobs j ON j.id = l.job_id
    WHERE e.entry_date BETWEEN $1 AND $2 ORDER BY e.created_at, l.id`, [from, to]);
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = 'date,description,source_type,source_id,account,debit,credit,customer,contractor,job';
  return [header, ...rows.map((r) => [r.entry_date, r.description, r.source_type, r.source_id, r.account_code, (r.debit_cents / 100).toFixed(2),
    (r.credit_cents / 100).toFixed(2), r.account_ref, r.contractor, r.job_ref].map(esc).join(','))].join('\n') + '\n';
}
