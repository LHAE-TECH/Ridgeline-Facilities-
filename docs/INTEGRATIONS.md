# Integrations: status and setup

The system never claims an external action succeeded unless the provider confirmed it. Each integration's live state is shown at **Admin → Integrations** and printed when the server starts.

| Integration | Mode in this delivery | Behaviour when unconfigured | Needs from Ridgeline |
| --- | --- | --- | --- |
| **Email** (SMTP) | **Unconfigured** | Notifications are queued and marked `not_sent_unconfigured`. Nothing is reported as sent | SMTP account (Postmark/SES), verified sending domain (SPF/DKIM) |
| **Stripe** card top-ups and invoice payments | **Unconfigured** (code tested with Stripe's test signature tooling) | Card options are hidden; bank transfer only | Stripe account (NZ), secret key, webhook signing secret |
| **Xero** accounting sync | **Unconfigured** (code tested against a mocked Xero API) | Sync items marked `skipped_unconfigured`; can be re-queued after setup | Xero subscription + Custom Connection (paid, per organisation) |
| **Private file storage** | **Live**: local disk | – | Persistent disk, or an S3-compatible bucket with `STORAGE_DRIVER=s3` |
| **SMS** | Not built (email only) | – | Choose a provider; a later phase |
| **Contractor payouts** | Manual bank batch (CSV export plus confirmation) | – | A payout provider and approved credentials if wanted later |
| **Bank feeds** | Manual CSV statement import for contractor payment reconciliation | – | – |

## Email (SMTP)

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` and `EMAIL_FROM`. Messages are written to the outbox in the same transaction as the business change, then delivered by the worker with retries and exponential backoff (6 attempts). Invoice emails attach the tax invoice, completion report and account statement as PDFs. `customer_invoices.sent_at` is only set after the SMTP server accepts the message.

## Stripe

1. Set `STRIPE_SECRET_KEY` (`sk_test_…` for test mode, `sk_live_…` for live) and `STRIPE_WEBHOOK_SECRET`.
2. In Stripe → Developers → Webhooks, add `https://<host>/webhooks/stripe` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.
3. Funds are credited **only** from a signature-verified webhook with `payment_status = paid`, never from the browser redirect. Webhooks are de-duplicated on the Stripe event ID in the same transaction as the credit; the prepaid ledger also has its own idempotency key per payment.

**Automatic top-ups:** the system records the customer's explicit consent (text, user and timestamp) and creates a pending top-up request plus notification when the balance falls below the agreed threshold. It does **not** charge saved cards off-session; that would need Stripe saved payment methods and a mandate, which is a later enhancement.

## Xero

1. In the Xero Developer portal create a **Custom Connection** for the Ridgeline organisation, with scopes `accounting.transactions accounting.contacts` (or the granular equivalents for newer apps; override with `XERO_SCOPES`).
2. Set `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` and account codes `XERO_SALES_ACCOUNT_CODE`, `XERO_COST_ACCOUNT_CODE`, `XERO_BANK_ACCOUNT_CODE`.
3. Admin → Integrations → **Re-queue failed / skipped**.

What syncs: issued customer invoices (ACCREC), approved contractor invoices (bills, ACCPAY) and confirmed contractor payments. Duplicate protection: before creating a document, the sync looks it up by invoice number (and supplier for bills) and links to the existing one if found. Each entity can be queued only once.

Not synced automatically: prepaid top-ups, prepaid applications, refunds and credit notes. In Xero these sit against a **Customer Prepayments liability** account. Use **Admin → Reports → Download journal (CSV)** to post or reconcile them, and agree the approach with your accountant.

## S3-compatible storage

Set `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` (for R2/B2), `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Keep the bucket **private**: files are only ever served through the application's access checks.
