# Ridgeline Facilities – Job Booking & Contractor Management System

A production-ready operating system for **Ridgeline Facilities** (ridgelinefacilities.com), a trading name of **LHA Holdings Limited** (NZBN 9429052390173): prepaid maintenance accounts, online job booking, contractor dispatch, photographic proof of work, contractor invoicing to Ridgeline, 35% markup customer invoicing, prepaid settlement and contractor payments, with one double-entry ledger underneath.

| Document | Purpose |
| --- | --- |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Hosting, environment variables, first-run, go-live checklist |
| [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) | Day-to-day operation for Ridgeline staff |
| [docs/BACKUP.md](docs/BACKUP.md) | Backups, restore and disaster recovery |
| [docs/COSTS.md](docs/COSTS.md) | Itemised recurring costs |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Live / test / unconfigured integrations and how to enable them |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Data model, ledger design, security and acceptance-test map |
| [docs/LEGAL_REVIEW_BRIEF.md](docs/LEGAL_REVIEW_BRIEF.md) | Specific questions for the lawyer reviewing the agreements |
| [docs/GST_TIMING.md](docs/GST_TIMING.md) | GST on prepaid top-ups: current assumption, open questions, what changes if it is wrong |

## What it does

1. Customer registers, adds sites, buildings (facilities) and units.
2. The **assessment engine** calculates the recommended minimum prepaid balance: *estimated monthly maintenance spend × coverage factor*. Every assumption is admin-configurable and the calculation is shown step by step. NZ$1,000 floor; above NZ$15,000 the account is **flagged for a custom arrangement** (never silently capped).
3. Ridgeline agrees the minimum; the customer pays the deposit (bank transfer confirmed by finance, or card via Stripe when configured). The balance is held as a **customer liability**, not revenue.
4. Customer books a job (site, unit, trade, priority, description, photos, access, site contact, attendance window, PO) and sees an **estimate** with the applicable callout/after-hours rate before booking.
5. Eligibility rules are applied: jobs are held (`pending_funds`) if the balance is below the agreed minimum or available funds don't cover the estimate, unless an authorised funding exception or the emergency rule applies. Estimates above the authority limit need an authorised customer approver.
6. Funded jobs get a unique `RF-J-…` reference, the estimate is committed against the available balance, and the job is offered to every **eligible** contractor (trade and verified qualification, region/radius, availability, capacity, emergency/after-hours capability, agreed rate card, valid insurance and licences).
7. The first contractor to accept wins. Row locks plus a unique index make duplicate assignment impossible. Declined or expired offers return to the queue; operations are alerted about unassigned jobs and SLA risk.
8. Contractor records arrival, start and completion (server timestamps, optional GPS), uploads before/after photos (SHA-256 recorded, never overwritten), labour, materials, notes and site acknowledgement. Completion is blocked until all mandatory evidence exists.
9. Operations approve the evidence or request more. Excess labour, location mismatches and suspicious photo times are flagged automatically.
10. Contractor invoices **Ridgeline** (never the customer). The invoice is validated against the job, the rate card, the authorised scope (estimate or quote plus approved variations) and the evidence. Duplicates, wrong job references and bad GST are rejected outright; rate discrepancies and overruns are flagged and need a recorded override.
11. Finance approves it, which creates the contractor payable and drafts the **customer invoice from Ridgeline's own pricing rules**: by default *approved contractor cost ex GST × 1.35*, with separate rules for callout, emergency, after-hours, weekend, public holiday, overnight, travel, materials, specialist, minimum charge, variations and cancellations. One rule prices each line, so premiums never stack.
12. Issuing the invoice applies prepaid credit, books any remainder as a receivable, recognises revenue and GST, and emails the invoice, completion report and statement as PDFs.
13. Contractor payables move through payment approval, adjustments (only with approval; deductions need the contractor's agreement), a batch with bank CSV export, and **confirmation with a bank reference and date**. Only then is anything marked paid. Bank statement CSVs can be reconciled automatically.
14. The job closes only when evidence is approved, the contractor invoice is approved, the customer invoice is settled, the contractor payment is confirmed and no dispute is open.

**Service levels.** Jobs are classified at intake into the published matrix (P1 Emergency: 2 h on site in metro Auckland, made safe in 4 h, 24/7, with 4 h / 8 h in Rodney and Franklin, clock from booking; P2 Urgent: 8 business hrs / 2 business days; P3 Standard: 48 business hrs / 10 business days; P4 Scheduled: agreed date). Each job runs an SLA clock against NZ business hours and holidays, with breach flagging. Dispatch offers jobs in waves ranked by SLA risk, with SMS offers, acceptance confirmations and escalation to on-call staff phones when nobody accepts (10 minutes for P1). SLA performance appears on the ops dashboard and in an optional monthly customer report (off by default, enabled per customer).

**Automatic top-ups** charge a saved card off-session (Stripe) with explicit consent, crediting the balance only when Stripe confirms the payment.

Exceptions are supported throughout: disputes (hold invoicing and payment, resolve with credit notes), rejected evidence, quotes and variations, billable late cancellations, emergency work, refunds, failed and reversed payments, and automatic top-ups with explicit consent.

## Technology

- Node.js 22, TypeScript, Express 5, server-rendered EJS. Mobile-first CSS with no client framework.
- PostgreSQL 16, accessed with plain SQL migrations via `pg`. Money is stored as integer cents and rates as basis points.
- Double-entry general ledger with a balance check at commit, plus an append-only customer prepaid sub-ledger.
- Private file storage on a local persistent disk or any S3-compatible bucket.
- Optional integrations, active only when credentials are set: SMTP email, Stripe Checkout, Xero Custom Connection.
- In-process background worker (offer expiry, SLA alerts, low-balance alerts and auto top-up requests, compliance expiry, email delivery, Xero sync, auto-close) protected by a Postgres advisory lock.

The existing ridgelinefacilities.com site could not be reached from the build environment and the repository was empty, so this is a standalone application. It is intended to run at a subdomain such as `app.ridgelinefacilities.com`, linked from the marketing site.

## Quick start (development)

```bash
# Requires Node 22+ and PostgreSQL 16
createdb ridgeline_dev
cp .env.example .env            # set DATABASE_URL, SESSION_SECRET
npm install
npm run migrate
npm run seed -- --demo          # reference data + demo users (password: demo-password-123)
npm run dev                     # http://localhost:3000
```

Demo logins: `admin@`, `ops@`, `finance@`, `customer@`, `contractor@demo.ridgeline.test`.

Or with Docker: `docker compose up --build`, then `docker compose exec app node dist/seed-cli.js --demo`.

## Tests

```bash
createdb ridgeline_test
npm test            # 119 tests: unit, service, HTTP and a Playwright end-to-end run (phone + desktop); live suites skip
npm run test:live   # real Stripe test mode + real Twilio SMS (required before go-live; see docs/INTEGRATIONS.md)
```

The test suite rebuilds the `ridgeline_test` schema from the migrations on each run. Each of the 18 acceptance criteria maps to named tests; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#acceptance-criteria--tests).

## Important notes for Ridgeline

- **Accounting and tax treatment** (prepaid balances held as customer advances with GST charged on the tax invoice when applied; contractor GST input claims; taxable supply information) is implemented conservatively and is configurable. **Confirm it with your accountant** before go-live.
- **Default cost assumptions and pricing rules are starting points.** Review them in Admin → Settings. The default pricing applies a 35% markup to every category.
- Customer pricing rules must be **disclosed in each customer's service agreement**. Draft rules have no effect until an administrator approves them.
- The customer service agreement, contractor agreement and privacy statement name LHA Holdings Limited trading as Ridgeline Facilities. They are **drafts for legal review**.
- Enter LHA Holdings Limited's **GST number** in Settings: GST invoices cannot be issued until it is set.
