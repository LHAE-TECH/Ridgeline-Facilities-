import { beforeEach, describe, expect, it } from 'vitest';
import { one } from '../src/db.js';
import { acceptAssessment, runAssessment } from '../src/services/assessment.js';
import { addCustomerUser } from '../src/services/customers.js';
import { accountBalances, accountPosition, reconcileCustomerBalance } from '../src/services/ledger.js';
import { approveJobAsCustomer, cancelJob, grantFundingException } from '../src/services/jobs.js';
import { confirmPayment, markRefundPaid, decideRefund, recordBankReceipt, requestPayment, requestRefund, reversePayment } from '../src/services/payments.js';
import { activeCustomer, approvedContractor, book, count, db, newCustomer, resetDb, staff, today } from './helpers.js';

beforeEach(resetDb);

describe('criterion 2: restricted bookings blocked when the prepaid account fails eligibility rules', () => {
  it('refuses bookings before the account is assessed', async () => {
    const fx = await newCustomer();
    await expect(book(fx)).rejects.toThrow(/assessed and agreed/);
  });

  it('holds a routine job (no dispatch, no offers, no commitment) while the balance is below the agreed minimum', async () => {
    await approvedContractor();
    const fx = await newCustomer();
    const admin = await staff('admin');
    const { id } = await runAssessment(db, admin, fx.customerId);
    await acceptAssessment(db, admin, id);
    // Deposit only half of the agreed minimum.
    const min = (await one(db, 'SELECT agreed_minimum_balance_cents AS m FROM customers WHERE id = $1', [fx.customerId])).m;
    await recordBankReceipt(db, await staff('finance'), { customerId: fx.customerId, amountCents: min / 2, receivedDate: today(), bankReference: 'B1', idempotencyKey: 'half' });

    const { job, funding } = await book(fx);
    expect(job.status).toBe('pending_funds');
    expect(funding!.ok).toBe(false);
    expect(funding!.reasons.join(' ')).toMatch(/below the agreed minimum/);
    expect(await count('SELECT COUNT(*) AS n FROM job_offers WHERE job_id = $1', [job.id])).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM job_commitments WHERE job_id = $1`, [job.id])).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'job_pending_funds'`)).toBeGreaterThan(0);

    // A top-up that restores the minimum releases the held job to dispatch automatically.
    await recordBankReceipt(db, await staff('finance'), { customerId: fx.customerId, amountCents: min, receivedDate: today(), bankReference: 'B2', idempotencyKey: 'rest' });
    const after = await one(db, 'SELECT status FROM jobs WHERE id = $1', [job.id]);
    expect(after.status).toBe('offered');
  });

  it('blocks when available funds do not cover the estimate, and allows an authorised funding exception', async () => {
    const fx = await activeCustomer();
    const bal = (await accountPosition(db, fx.customerId)).balanceCents;
    // Commit almost all funds with a large manual commitment to simulate prior bookings.
    const first = await book(fx);
    await db.query('UPDATE job_commitments SET amount_cents = $2 WHERE job_id = $1', [first.job.id, bal - 1000]);
    const { job } = await book(fx, { title: 'Second job' });
    expect(job.status).toBe('pending_funds');
    await expect(grantFundingException(db, await staff('ops'), job.id, 'x')).rejects.toThrow(/administrators or finance/);
    await grantFundingException(db, fx.finance, job.id, 'Customer confirmed top-up by phone; PO 4471');
    const released = await one(db, 'SELECT status, funding_exception_id FROM jobs WHERE id = $1', [job.id]);
    expect(released.status).toBe('dispatch');
    expect(released.funding_exception_id).not.toBeNull();
  });

  it('allows emergency jobs below the minimum when configured, flagged to finance', async () => {
    const fx = await newCustomer();
    const admin = await staff('admin');
    const { id } = await runAssessment(db, admin, fx.customerId);
    await acceptAssessment(db, admin, id);
    await db.query(`UPDATE customers SET status = 'active' WHERE id = $1`, [fx.customerId]);
    await staff('finance');
    const { job, funding } = await book(fx, { priority: 'emergency', preferredStart: null });
    expect(funding!.emergencyOverride).toBe(true);
    expect(['dispatch', 'offered']).toContain(job.status);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'emergency_underfunded'`)).toBeGreaterThan(0);
  });

  it('requires an authorised approver when the estimate exceeds the authority limit', async () => {
    const fx = await activeCustomer();
    await db.query('UPDATE customers SET authority_limit_cents = 1000 WHERE id = $1', [fx.customerId]);
    const booker = await addCustomerUser(db, fx.owner, fx.customerId, { name: 'Bob Booker', email: 'booker@customer.test', password: 'correct-horse-battery', customerRole: 'booker' });
    const bookerActor = { id: booker.id, role: 'customer' as const, name: 'Bob', customerId: fx.customerId, customerRole: 'booker' as const };
    const { job } = await book({ ...fx, owner: bookerActor });
    expect(job.status).toBe('awaiting_customer_approval');
    await expect(approveJobAsCustomer(db, bookerActor, job.id)).rejects.toThrow(/approval limit/);
    await approveJobAsCustomer(db, fx.owner, job.id);
    expect((await one(db, 'SELECT status, customer_approved_by FROM jobs WHERE id = $1', [job.id])).customer_approved_by).toBe(fx.owner.id);
  });
});

describe('criterion 4: a booking generates a unique job record', () => {
  it('assigns unique references and is idempotent for repeated submissions', async () => {
    const fx = await activeCustomer();
    const a = await book(fx, { idempotencyKey: 'form-123' });
    const again = await book(fx, { idempotencyKey: 'form-123' });
    const b = await book(fx, { idempotencyKey: 'form-456' });
    expect(again.job.id).toBe(a.job.id);
    expect(again.created).toBe(false);
    expect(b.job.ref).not.toBe(a.job.ref);
    expect(a.job.ref).toMatch(/^RF-J-\d+$/);
    expect(await count('SELECT COUNT(*) AS n FROM jobs WHERE customer_id = $1', [fx.customerId])).toBe(2);
    expect(a.estimate!.pricing.totalCents).toBeGreaterThan(0);
    expect(a.estimate!.disclaimer).toMatch(/ESTIMATE ONLY/);
  });
});

describe('criterion 3: top-ups are recorded once and reflected in the ledger', () => {
  it('credits a confirmed top-up exactly once even if confirmed repeatedly or concurrently', async () => {
    const fx = await activeCustomer();
    const before = (await accountPosition(db, fx.customerId)).balanceCents;
    const p = await requestPayment(db, fx.owner, { customerId: fx.customerId, amountCents: 50000, method: 'bank_transfer', idempotencyKey: 'topup-1' });
    const p2 = await requestPayment(db, fx.owner, { customerId: fx.customerId, amountCents: 50000, method: 'bank_transfer', idempotencyKey: 'topup-1' });
    expect(p2.id).toBe(p.id);
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(before); // pending ≠ received

    const results = await Promise.all([1, 2, 3].map(() => confirmPayment(db, fx.finance, p.id, { bankReference: 'ANZ 991' })));
    expect(results.filter((r) => r.credited)).toHaveLength(1);
    await confirmPayment(db, fx.finance, p.id);

    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(before + 50000);
    expect(await count(`SELECT COUNT(*) AS n FROM prepaid_transactions WHERE payment_id = $1`, [p.id])).toBe(1);
    const rec = await reconcileCustomerBalance(db, fx.customerId);
    expect(rec.ok).toBe(true);
    const gl = Object.fromEntries((await accountBalances(db)).map((a) => [a.code, a.balance_cents]));
    expect(gl.CUSTOMER_PREPAID).toBe(rec.cached);
    expect(gl.MAINTENANCE_REVENUE).toBe(0); // deposits are a liability, not revenue
  });

  it('records receipts via finance with idempotency keys', async () => {
    const fx = await activeCustomer();
    const before = (await accountPosition(db, fx.customerId)).balanceCents;
    const input = { customerId: fx.customerId, amountCents: 12345, receivedDate: today(), bankReference: 'WBC 1', idempotencyKey: 'stmt-line-77' };
    await recordBankReceipt(db, fx.finance, input);
    await recordBankReceipt(db, fx.finance, input);
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(before + 12345);
  });

  it('activates a pending account once the deposit meets the agreed minimum', async () => {
    const fx = await newCustomer();
    const admin = await staff('admin');
    const { id } = await runAssessment(db, admin, fx.customerId);
    const c = await acceptAssessment(db, admin, id);
    expect(c.status).toBe('pending_deposit');
    await recordBankReceipt(db, await staff('finance'), { customerId: fx.customerId, amountCents: c.agreed_minimum_balance_cents, receivedDate: today(), bankReference: 'D', idempotencyKey: 'dep' });
    expect((await one(db, 'SELECT status FROM customers WHERE id = $1', [fx.customerId])).status).toBe('active');
  });

  it('reverses a dishonoured top-up, moving any amount already spent to receivables', async () => {
    const fx = await activeCustomer();
    const p = await requestPayment(db, fx.owner, { customerId: fx.customerId, amountCents: 100000, method: 'bank_transfer' });
    await confirmPayment(db, fx.finance, p.id);
    const bal = (await accountPosition(db, fx.customerId)).balanceCents;
    // Simulate most of the balance having been spent.
    await db.query('UPDATE customers SET prepaid_balance_cents = 30000 WHERE id = $1', [fx.customerId]);
    await reversePayment(db, fx.finance, p.id, 'Dishonoured');
    const after = await one(db, 'SELECT prepaid_balance_cents FROM customers WHERE id = $1', [fx.customerId]);
    expect(after.prepaid_balance_cents).toBe(0);
    const ar = await one(db, `SELECT COALESCE(SUM(debit_cents - credit_cents),0)::bigint AS v FROM journal_lines WHERE account_code = 'ACCOUNTS_RECEIVABLE' AND customer_id = $1`, [fx.customerId]);
    expect(ar.v).toBe(70000);
    expect(bal).toBeGreaterThan(100000);
    await reversePayment(db, fx.finance, p.id, 'Dishonoured');
    expect(await count(`SELECT COUNT(*) AS n FROM prepaid_transactions WHERE payment_id = $1 AND txn_type = 'reversal'`, [p.id])).toBe(1);
  });

  it('pays refunds only after approval and confirmation, within the available balance', async () => {
    const fx = await activeCustomer();
    const pos = await accountPosition(db, fx.customerId);
    await expect(requestRefund(db, fx.owner, fx.customerId, pos.availableCents + 1, 'too much')).rejects.toThrow(/available balance/);
    const r = await requestRefund(db, fx.owner, fx.customerId, 10000, 'Selling a property');
    await expect(markRefundPaid(db, fx.finance, r.id, { paidReference: 'X', paidDate: today() })).rejects.toThrow(/approved/);
    await decideRefund(db, fx.finance, r.id, 'approved');
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(pos.balanceCents);
    await markRefundPaid(db, fx.finance, r.id, { paidReference: 'REF-1', paidDate: today() });
    await markRefundPaid(db, fx.finance, r.id, { paidReference: 'REF-1', paidDate: today() });
    expect((await accountPosition(db, fx.customerId)).balanceCents).toBe(pos.balanceCents - 10000);
    expect((await reconcileCustomerBalance(db, fx.customerId)).ok).toBe(true);
  });

  it('releases the commitment when a job is cancelled before attendance', async () => {
    const fx = await activeCustomer();
    const { job } = await book(fx);
    const committed = (await accountPosition(db, fx.customerId)).committedCents;
    expect(committed).toBe(job.estimate_total_cents);
    const r = await cancelJob(db, fx.owner, job.id, 'Tenant fixed it');
    expect(r.billable).toBe(false);
    expect((await accountPosition(db, fx.customerId)).committedCents).toBe(0);
  });
});
