import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { AppError } from '../lib/errors.js';

export type AccountCode =
  | 'BANK' | 'STRIPE_CLEARING' | 'ACCOUNTS_RECEIVABLE' | 'GST_INPUT' | 'CUSTOMER_PREPAID'
  | 'CONTRACTOR_PAYABLE' | 'GST_OUTPUT' | 'MAINTENANCE_REVENUE' | 'CONTRACTOR_COSTS';

export interface JournalLine {
  account: AccountCode;
  debit?: number;
  credit?: number;
  customerId?: string | null;
  contractorId?: string | null;
  jobId?: string | null;
}

export interface JournalInput {
  description: string;
  sourceType: string;
  sourceId?: string | null;
  idempotencyKey: string;
  lines: JournalLine[];
  reversesEntryId?: string | null;
  entryDate?: string;
}

/**
 * Posts a balanced double-entry journal. Idempotent: re-posting the same idempotency key returns the
 * original entry without writing anything. Zero-value lines are dropped.
 */
export async function postJournal(db: Db, actor: Actor, input: JournalInput): Promise<{ id: string; created: boolean }> {
  const lines = input.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  for (const l of lines) {
    if ((l.debit ?? 0) < 0 || (l.credit ?? 0) < 0) throw new Error('Journal amounts must be non-negative');
    if (!Number.isInteger(l.debit ?? 0) || !Number.isInteger(l.credit ?? 0)) throw new Error('Journal amounts must be integer cents');
  }
  const debits = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const credits = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (debits !== credits) throw new Error(`Unbalanced journal "${input.description}": debits ${debits} credits ${credits}`);
  if (lines.length === 0) throw new Error('Journal has no lines');

  return tx(db, async (c) => {
    const inserted = await maybeOne<{ id: string }>(c,
      `INSERT INTO journal_entries (entry_date, description, source_type, source_id, idempotency_key, reverses_entry_id, created_by)
       VALUES (COALESCE($1::date, CURRENT_DATE), $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [input.entryDate ?? null, input.description, input.sourceType, input.sourceId ?? null, input.idempotencyKey, input.reversesEntryId ?? null, actor.id]);
    if (!inserted) {
      const existing = await one<{ id: string }>(c, 'SELECT id FROM journal_entries WHERE idempotency_key = $1', [input.idempotencyKey]);
      return { id: existing.id, created: false };
    }
    for (const l of lines) {
      await c.query(
        `INSERT INTO journal_lines (entry_id, account_code, customer_id, contractor_id, job_id, debit_cents, credit_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [inserted.id, l.account, l.customerId ?? null, l.contractorId ?? null, l.jobId ?? null, l.debit ?? 0, l.credit ?? 0],
      );
    }
    return { id: inserted.id, created: true };
  });
}

export type PrepaidTxnType = 'deposit' | 'top_up' | 'job_charge' | 'refund' | 'adjustment' | 'credit_note' | 'reversal' | 'receivable_settlement';

export interface PrepaidMovementInput {
  customerId: string;
  type: PrepaidTxnType;
  /** Positive increases the customer's prepaid balance, negative decreases it. */
  amountCents: number;
  description: string;
  reference?: string | null;
  jobId?: string | null;
  customerInvoiceId?: string | null;
  paymentId?: string | null;
  idempotencyKey: string;
  /** The other side(s) of the journal. The CUSTOMER_PREPAID line is added automatically. */
  counterLines: JournalLine[];
  sourceType: string;
  sourceId?: string | null;
}

export interface PrepaidTxn {
  id: string;
  customer_id: string;
  txn_type: PrepaidTxnType;
  amount_cents: number;
  balance_after_cents: number;
  description: string;
  reference: string | null;
  created_at: Date;
  journal_entry_id: string;
}

/**
 * Moves money in or out of a customer's prepaid balance, writing the sub-ledger transaction and the
 * matching general-ledger journal atomically. Locks the customer row so concurrent movements serialise.
 * Idempotent by idempotencyKey: a repeated request returns the original transaction.
 */
export async function prepaidMovement(db: Db, actor: Actor, input: PrepaidMovementInput): Promise<{ txn: PrepaidTxn; created: boolean }> {
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) throw new Error('Prepaid movement must be a non-zero integer');
  return tx(db, async (c) => {
    const customer = await maybeOne<{ prepaid_balance_cents: number }>(c,
      'SELECT prepaid_balance_cents FROM customers WHERE id = $1 FOR UPDATE', [input.customerId]);
    if (!customer) throw new AppError('Customer not found', 404);

    const existing = await maybeOne<PrepaidTxn>(c, 'SELECT * FROM prepaid_transactions WHERE idempotency_key = $1', [input.idempotencyKey]);
    if (existing) return { txn: existing, created: false };

    const newBalance = customer.prepaid_balance_cents + input.amountCents;
    if (newBalance < 0) throw new AppError('Insufficient prepaid balance for this transaction', 409, 'insufficient_balance');

    const prepaidLine: JournalLine = input.amountCents > 0
      ? { account: 'CUSTOMER_PREPAID', credit: input.amountCents, customerId: input.customerId, jobId: input.jobId }
      : { account: 'CUSTOMER_PREPAID', debit: -input.amountCents, customerId: input.customerId, jobId: input.jobId };

    const journal = await postJournal(c, actor, {
      description: input.description,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      idempotencyKey: `prepaid:${input.idempotencyKey}`,
      lines: [prepaidLine, ...input.counterLines],
    });

    const txn = await one<PrepaidTxn>(c,
      `INSERT INTO prepaid_transactions (customer_id, txn_type, amount_cents, balance_after_cents, description, reference, job_id,
          customer_invoice_id, payment_id, journal_entry_id, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [input.customerId, input.type, input.amountCents, newBalance, input.description, input.reference ?? null, input.jobId ?? null,
       input.customerInvoiceId ?? null, input.paymentId ?? null, journal.id, input.idempotencyKey, actor.id]);

    await c.query('UPDATE customers SET prepaid_balance_cents = $2, updated_at = now() WHERE id = $1', [input.customerId, newBalance]);
    return { txn, created: true };
  });
}

export interface AccountPosition {
  balanceCents: number;
  committedCents: number;
  availableCents: number;
  minimumCents: number | null;
  belowMinimum: boolean;
  shortfallToMinimumCents: number;
}

export async function accountPosition(db: Db, customerId: string): Promise<AccountPosition> {
  const row = await one<{ balance: number; committed: number; minimum: number | null }>(db,
    `SELECT c.prepaid_balance_cents AS balance, c.agreed_minimum_balance_cents AS minimum,
            COALESCE((SELECT SUM(amount_cents) FROM job_commitments WHERE customer_id = c.id AND status = 'active'), 0)::bigint AS committed
       FROM customers c WHERE c.id = $1`, [customerId]);
  const minimum = row.minimum;
  return {
    balanceCents: row.balance,
    committedCents: row.committed,
    availableCents: row.balance - row.committed,
    minimumCents: minimum,
    belowMinimum: minimum !== null && row.balance < minimum,
    shortfallToMinimumCents: minimum !== null ? Math.max(0, minimum - row.balance) : 0,
  };
}

/** Verifies the cached customer balance equals the sum of its sub-ledger and GL lines. */
export async function reconcileCustomerBalance(db: Db, customerId: string): Promise<{ cached: number; subledger: number; generalLedger: number; ok: boolean }> {
  const r = await one<{ cached: number; subledger: number; gl: number }>(db,
    `SELECT c.prepaid_balance_cents AS cached,
            COALESCE((SELECT SUM(amount_cents) FROM prepaid_transactions WHERE customer_id = c.id),0)::bigint AS subledger,
            COALESCE((SELECT SUM(credit_cents - debit_cents) FROM journal_lines WHERE account_code = 'CUSTOMER_PREPAID' AND customer_id = c.id),0)::bigint AS gl
       FROM customers c WHERE c.id = $1`, [customerId]);
  return { cached: r.cached, subledger: r.subledger, generalLedger: r.gl, ok: r.cached === r.subledger && r.subledger === r.gl };
}

export async function accountBalances(db: Db): Promise<{ code: string; name: string; type: string; balance_cents: number }[]> {
  // Natural balance: debit-normal for assets/expenses, credit-normal for liabilities/income/equity.
  return query(db,
    `SELECT a.code, a.name, a.type,
            COALESCE(SUM(CASE WHEN a.type IN ('asset','expense') THEN l.debit_cents - l.credit_cents
                              ELSE l.credit_cents - l.debit_cents END), 0)::bigint AS balance_cents
       FROM ledger_accounts a LEFT JOIN journal_lines l ON l.account_code = a.code
      GROUP BY a.code, a.name, a.type ORDER BY a.type, a.code`);
}

export async function customerReceivable(db: Db, customerId: string): Promise<number> {
  const r = await one<{ v: number }>(db,
    `SELECT COALESCE(SUM(debit_cents - credit_cents),0)::bigint AS v FROM journal_lines WHERE account_code = 'ACCOUNTS_RECEIVABLE' AND customer_id = $1`,
    [customerId]);
  return r.v;
}
