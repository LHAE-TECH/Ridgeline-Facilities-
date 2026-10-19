import type { Db } from './db.js';
import { pool, query } from './db.js';
import { advanceDispatchWaves, escalateUnassigned, expireOffers } from './services/dispatch.js';
import { checkSlaBreaches } from './services/sla.js';
import { processAutoTopUps } from './services/autoTopUp.js';
import { sendMonthlyReports } from './services/monthlyReport.js';
import { autoCloseJobs } from './services/jobs.js';
import { deliverPending, link, notifyContractor, notifyStaff } from './services/notifications.js';
import { processLowBalances } from './services/payments.js';
import { processXeroQueue } from './services/xero.js';

async function complianceExpiryAlerts(db: Db): Promise<number> {
  const docs = await query(db, `SELECT d.*, k.legal_name FROM compliance_documents d JOIN contractors k ON k.id = d.contractor_id
    WHERE d.status = 'verified' AND d.expires_at IS NOT NULL AND d.expires_at <= CURRENT_DATE + 30 AND d.expiry_alerted_at IS NULL`);
  for (const d of docs) {
    await notifyContractor(db, d.contractor_id, { template: 'compliance_expiring', subject: 'Compliance document expiring',
      body: `Your ${d.doc_type.replace(/_/g, ' ')} expires on ${d.expires_at}. Upload a renewed document to keep receiving jobs.\n${link('/c/profile')}`,
      idempotencyKey: `compliance-expiry:${d.id}` });
    await notifyStaff(db, ['ops', 'admin'], { template: 'compliance_expiring_staff', subject: `Compliance expiring: ${d.legal_name}`,
      body: `${d.legal_name}'s ${d.doc_type} expires on ${d.expires_at}.`, idempotencyKey: `compliance-expiry-staff:${d.id}` });
    await db.query('UPDATE compliance_documents SET expiry_alerted_at = now() WHERE id = $1', [d.id]);
  }
  return docs.length;
}

export interface CycleResult { [task: string]: unknown }

/** One pass of all background tasks. Guarded by an advisory lock so only one instance runs at a time. */
export async function runWorkerCycle(db: Db = pool): Promise<CycleResult | null> {
  const client = 'connect' in db ? await (db as typeof pool).connect() : null;
  const conn: Db = client ?? db;
  try {
    const { rows } = await conn.query('SELECT pg_try_advisory_lock(727002) AS ok');
    if (!rows[0].ok) return null;
    const result: CycleResult = {};
    const tasks: [string, () => Promise<unknown>][] = [
      ['expiredOffers', () => expireOffers(db)],
      ['dispatchWaves', () => advanceDispatchWaves(db)],
      ['escalations', () => escalateUnassigned(db)],
      ['sla', () => checkSlaBreaches(db)],
      ['autoTopUps', () => processAutoTopUps(db)],
      ['lowBalances', () => processLowBalances(db)],
      ['monthlyReports', () => sendMonthlyReports(db)],
      ['complianceAlerts', () => complianceExpiryAlerts(db)],
      ['closedJobs', () => autoCloseJobs(db)],
      ['xero', () => processXeroQueue(db)],
      ['emails', () => deliverPending(db)],
    ];
    for (const [name, fn] of tasks) {
      try { result[name] = await fn(); } catch (err) { result[name] = { error: (err as Error).message }; console.error(`[worker] ${name} failed`, err); }
    }
    await conn.query('SELECT pg_advisory_unlock(727002)');
    return result;
  } finally {
    client?.release();
  }
}

export function startWorker(intervalMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runWorkerCycle(); } finally { running = false; }
  }, intervalMs);
  return () => clearInterval(timer);
}
