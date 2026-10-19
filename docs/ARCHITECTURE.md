# Architecture

## Layout

```
migrations/            SQL migrations (applied in order, transactional, advisory-locked)
src/
  config.ts            Environment configuration + integration status (live/test/unconfigured)
  db.ts                pg pool, transaction helper (savepoints when nested, retries on serialization failure)
  lib/money.ts         Integer cents / basis-point arithmetic, half-up rounding
  services/            All business logic (no HTTP). Each function takes (db, actor, input)
    assessment.ts      Minimum-balance engine
    ledger.ts          Double-entry journal + prepaid sub-ledger
    jobs.ts            Booking, estimates, funding eligibility, approvals, cancellation, closing
    jobState.ts        Job state machine + server-timestamped events
    dispatch.ts        Contractor eligibility, offers, acceptance, manual assignment, SLA alerts
    evidence.ts        Attendance, evidence, completion reports, review, quotes/variations
    pricing.ts         Customer pricing rules engine (35% markup etc.), estimates, rule approval
    sla.ts             Published P1–P4 matrix: triage, targets, Auckland areas, breach/at-risk checks, performance reporting
    p1Scope.ts         Make-safe scope cap for unfunded/over-authority P1, scope extensions, unfunded exposure and suspension
    businessTime.ts    NZ business-hours arithmetic (holidays, DST) for SLA clocks
    sms.ts             Twilio transport, status-callback signature verification
    autoTopUp.ts       Saved cards (Stripe SetupIntents) and off-session automatic top-ups
    monthlyReport.ts   Monthly customer report emails
    timeWindows.ts     NZ time-window classification (standard / after-hours / weekend / holiday / overnight)
    contractorInvoices.ts  Submission + validation against job, rate card, scope, evidence; approval
    customerInvoices.ts    Drafting from Ridgeline pricing, issue + prepaid settlement, payments, credit notes
    payables.ts        Contractor payables, adjustments, batches, CSV export, confirmation, bank reconciliation
    payments.ts        Customer top-ups, receipts, failures, reversals, refunds, auto top-up consent
    disputes.ts, notifications.ts, pdf.ts, reports.ts, storage.ts, stripe.ts, xero.ts, audit.ts, settings.ts
  routes/              Express routers: auth, customer (/app), contractor (/c), admin (/admin), files, webhooks
  views/, public/      EJS templates, CSS, progressive-enhancement JS
  worker.ts            Background cycle (advisory-locked)
tests/                 Vitest suites against a real Postgres; tests/e2e uses Playwright/Chromium
```

## Data model (main tables)

- **Customers** → `sites` → `facilities` (type + unit count) → `units`; `users` (role, customer_role, approval limit); `account_assessments` (inputs, assumptions snapshot, step-by-step breakdown).
- **Contractors** → `contractor_trades`, `compliance_documents`, `contractor_rate_cards`; contractor `users`.
- **Jobs** → `job_events` (append-only), `job_offers`, `job_assignments` (unique active per job), `job_evidence` + `files` (SHA-256, immutable), `completion_reports` (versioned), `quotes` (quotes and variations), `job_commitments`, `funding_exceptions`, `disputes`.
- **Pricing**: `pricing_rules` (draft/approved/retired; at most one approved per scope), `public_holidays`, `trades`, `facility_types`, `coverage_factors`, `settings`.
- **Money**: `ledger_accounts`, `journal_entries` / `journal_lines` (append-only, balanced, idempotency key), `prepaid_transactions` (append-only sub-ledger), `customer_payments`, `refunds`, `auto_topup_consents`, `contractor_invoices` (+ lines), `customer_invoices` (+ lines), `credit_notes`, `contractor_payables`, `payable_adjustments`, `payment_batches`, `contractor_payments`.
- **Operations**: `notifications` (outbox), `integration_sync`, `webhook_events`, `audit_log` (append-only), `user_sessions`.

## Ledger design

| Event | Debit | Credit |
| --- | --- | --- |
| Top-up / deposit confirmed | BANK (or STRIPE_CLEARING) | CUSTOMER_PREPAID (liability) |
| Customer invoice issued | CUSTOMER_PREPAID (credit applied) + ACCOUNTS_RECEIVABLE (remainder) | MAINTENANCE_REVENUE (ex GST) + GST_OUTPUT |
| Invoice payment received | BANK | ACCOUNTS_RECEIVABLE |
| Contractor invoice approved | CONTRACTOR_COSTS (ex GST) + GST_INPUT | CONTRACTOR_PAYABLE |
| Contractor payment confirmed | CONTRACTOR_PAYABLE | BANK |
| Credit note | MAINTENANCE_REVENUE + GST_OUTPUT | ACCOUNTS_RECEIVABLE and/or CUSTOMER_PREPAID |
| Refund paid | CUSTOMER_PREPAID | BANK |
| Payment reversed | CUSTOMER_PREPAID (+ AR for amounts already spent) | BANK |

Guarantees:

- A deferred constraint trigger rejects any unbalanced journal at commit.
- Journals, journal lines, prepaid transactions, job events, files and the audit log are append-only: UPDATE and DELETE are blocked by triggers.
- Every financial write has a unique idempotency key (e.g. `payment:<id>`, `invoice-issue:<id>`, `contractor-payment:<id>`), so retries and duplicate webhooks write nothing new.
- Prepaid movements lock the customer row (`SELECT … FOR UPDATE`) and the balance can never go negative (CHECK constraint).
- `reconcileCustomerBalance` verifies that the cached balance, the prepaid sub-ledger and the general ledger agree; the result is shown on every customer page.
- Customer deposits are never revenue. Revenue is recognised only when a customer invoice is issued.

## Pricing engine

1. Each approved contractor line has a category (labour, callout, travel, materials, variation, cancellation, minimum charge) and a time window.
2. `ruleChainFor` maps the line to a preference chain of rule categories, for example labour@public_holiday → `public_holiday` → `weekend` → `standard_labour`.
3. `selectRule` picks the most specific approved rule (customer 4 + trade 2 + priority 1) for the first category in the chain that has one.
4. The rule's method produces the customer amount: markup, fixed rate, or a multiplier on the standard price.
5. A minimum job charge is applied if one is approved (not for cancellation-only invoices). GST is calculated once on the ex-GST subtotal.
6. No approved rule means a hard error. The engine never falls back to guesswork.

## Security

- Passwords are hashed with bcrypt (cost 12). Sessions are stored server-side in Postgres, regenerated on login, and use httpOnly, SameSite=Lax cookies (Secure in production). The login endpoint is rate-limited.
- Every state-changing form carries a per-session CSRF token. Multipart uploads verify it after parsing.
- Helmet security headers and CSP (scripts from self only).
- Data isolation is enforced in the service layer: every customer query is scoped to the actor's customer, and contractors only see jobs assigned or currently offered to them (offers show the region only, not the address). Files are served only through `/files/:id` after an access check; customers never see contractor invoices, compliance documents, costs or margins. Staff actions are role-checked again inside services.
- Secrets (database, SMTP, Stripe, Xero, S3) come only from server-side environment variables.
- Uploads are restricted to an allowlist (JPEG/PNG/WebP/HEIC/PDF) and a size limit, and stored outside the web root.
- Device timestamps and GPS are recorded as *reported* values alongside server timestamps. The system does not describe photos as tamper-proof; it stores hashes so later alteration of stored originals can be detected.

## Acceptance criteria → tests

| # | Criterion | Test file › test |
| --- | --- | --- |
| 1 | Different portfolios → different, explainable minimums | `assessment.test.ts` › produces different, explained recommendations…; NZ$1,000 floor; configurable assumptions; custom arrangement authority |
| 2 | Restricted bookings blocked when ineligible | `booking-ledger.test.ts` › refuses bookings before assessment; holds routine job below minimum; blocks when available funds short + funding exception; emergency rule; authority-limit approval |
| 3 | Top-ups recorded once and reflected in ledger | `booking-ledger.test.ts` › credits exactly once even if confirmed concurrently; receipts idempotent; activation; reversals; refunds |
| 4 | Booking generates a unique job | `booking-ledger.test.ts` › assigns unique references and is idempotent |
| 5 | Only eligible contractors; no duplicate assignment | `dispatch-evidence.test.ts` › offers only to eligible; licence required; exactly one of concurrent acceptances wins; expired/foreign/ineligible offers rejected; requeue; manual assignment rules |
| 6 | Completion requires mandatory evidence | `dispatch-evidence.test.ts` › enforces arrival → start → photos → report; acknowledgement; flags + versions + immutability |
| 7 | Contractor invoices go to Ridgeline, never the customer | `invoicing-payments.test.ts` › never sends contractor invoices to the customer |
| 8 | Invoices checked against job and rate card | `invoicing-payments.test.ts` › rejects wrong job/duplicates/bad GST; flags discrepancies; override reason required |
| 9 | NZ$200 → NZ$270 ex GST | `pricing.test.ts` › criterion 9 |
| 10 | Higher callout / after-hours rates flow through | `pricing.test.ts` › criterion 10 (callout $100→$135, emergency, after-hours markup, fixed customer rate, multiplier, no stacking); `invoicing-payments.test.ts` › after-hours flow |
| 11 | GST without duplicate charging | `pricing.test.ts` › criterion 11 |
| 12 | Charges applied against prepaid credit | `invoicing-payments.test.ts` › settles against prepaid credit; receivable when credit insufficient |
| 13 | Payables independent of customer invoices | `invoicing-payments.test.ts` › payable equals contractor invoice incl. GST, separate ledger |
| 14 | Paid only after confirmation | `invoicing-payments.test.ts` › scheduling/export do not mark paid; bank statement reconciliation |
| 15 | No duplicate financial transactions from retries/webhooks | `invoicing-payments.test.ts` › Stripe webhook processed once; journals immutable; `booking-ledger.test.ts` concurrency |
| 16 | Refunds, variations, cancellations, disputes keep audit history | `invoicing-payments.test.ts` › criterion 16 suite; `booking-ledger.test.ts` › refunds |
| 17 | No access to other parties' confidential records | `http-isolation.test.ts` (real HTTP sessions, CSRF, files, staff pages) |
| — | SLA engine | `sla.test.ts`: business-hours clock incl. holidays and DST; P1 metro/non-metro, P2, P3, P4 targets; triage; P1 clock from booking, P2–P4 from release; nothing holds a P1 (funds, authority limit, reclassified held job); booked/released in the monthly report; Auckland areas by suburb, editable lists and site pins; breach + SMS escalation; reclassification; dashboard; monthly report off by default with per-customer toggle; SLA-ranked waves |
| — | SMS dispatch | `sms.test.ts` (mocked Twilio): never-sent-unless-accepted; invalid numbers; outage retried, rejected number failed at once; signed status callbacks; P1 broadcast/confirmation/taken; 10-minute escalation. `sms-live.test.ts` (**real Twilio and handset; needs credentials and `SMS_TEST_MOBILE`; not yet run**): real delivery, delivery receipt via the webhook, failed number recorded as failed |
| — | Saved-card auto top-ups (round 2) | `auto-topup.test.ts` (logic with a fake Stripe client) and `stripe-live.test.ts` (**real Stripe test mode, needs `STRIPE_TEST_SECRET_KEY`; not yet run**) |
| — | Legal entity, assessment taper, demo guard (round 2) | `entity-assessment-demo.test.ts` |
| — | Unfunded P1 scope and unconfirmed areas | `p1-scope-areas.test.ts`: make-safe scope and cap (global and per customer), over-authority scope, beyond-make-safe blocked until customer approval or staff override with reason, invoice cap guard, unfunded exposure on the dashboard, suspension threshold and funding exception; unconfirmed site blocks P2–P4 booking, P1 accepted but excluded from SLA reporting until confirmed, recalculation on confirmation |
| 18 | Works on mobile and desktop | `e2e/workflow.test.ts` › full workflow through the UI on a 390 px phone and 1366 px desktop; every page checked for horizontal overflow |

Run: `npm test` (129 tests; the 2 live Stripe and 2 live Twilio tests are skipped unless their credentials are set). `npm run test:live` runs the live suites.
