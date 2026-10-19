import type { Db } from '../db.js';
import { maybeOne, query } from '../db.js';
import { link, notifyCustomer } from './notifications.js';
import { getSettings } from './settings.js';

/** The previous calendar month in NZ time, as YYYY-MM. */
export function previousMonth(now = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(now);
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/** Monthly reports ship off: they go out only when the global switch AND the customer's own toggle are both on. */
export async function monthlyReportsEnabledFor(db: Db, customerId: string): Promise<boolean> {
  if (!(await getSettings(db)).monthly_report_enabled) return false;
  const c = await maybeOne<{ monthly_report_enabled: boolean }>(db, 'SELECT monthly_report_enabled FROM customers WHERE id = $1', [customerId]);
  return c?.monthly_report_enabled === true;
}

/** Worker: emails each opted-in customer their monthly report for the previous month (once per customer per month). */
export async function sendMonthlyReports(db: Db, now = new Date()): Promise<number> {
  const settings = await getSettings(db);
  if (!settings.monthly_report_enabled) return 0;
  const month = previousMonth(now);
  const customers = await query(db,
    `SELECT c.id, c.account_ref FROM customers c WHERE c.status IN ('active','suspended') AND c.monthly_report_enabled
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.customer_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.idempotency_key LIKE 'monthly-report:' || c.id || ':' || $1 || '%')`, [month]);
  for (const c of customers) {
    await notifyCustomer(db, c.id, {
      template: 'monthly_report', subject: `Monthly maintenance report – ${month}`,
      body: `Your monthly maintenance report for ${month} is attached: jobs, service-level performance and your prepaid account.\n${link(`/app/reports?month=${month}`)}`,
      attachments: [{ kind: 'monthly_report_pdf', id: `${c.id}|${month}`, filename: `ridgeline-report-${c.account_ref}-${month}.pdf` }],
      idempotencyKey: `monthly-report:${c.id}:${month}`,
    }, { includeBillingEmail: true });
  }
  return customers.length;
}
