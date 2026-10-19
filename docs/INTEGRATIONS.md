# Integrations: status and setup

The system never claims an external action succeeded unless the provider confirmed it. Each integration's live state is shown at **Admin → Integrations** and printed when the server starts.

| Integration | Mode in this delivery | Behaviour when unconfigured | Needs from Ridgeline |
| --- | --- | --- | --- |
| **Email** (SMTP) | **Unconfigured** | Notifications are queued and marked `not_sent_unconfigured`. Nothing is reported as sent | SMTP account (Postmark/SES), verified sending domain (SPF/DKIM) |
| **Stripe** card top-ups, invoice payments and **saved-card automatic top-ups** | **Unconfigured. Live test-mode suite NOT yet run** (see below) | Card options and saved cards are hidden; bank transfer only | Stripe account (NZ), secret key, webhook signing secret |
| **Xero** accounting sync | **Unconfigured** (code tested against a mocked Xero API) | Sync items marked `skipped_unconfigured`; can be re-queued after setup | Xero subscription + Custom Connection (paid, per organisation) |
| **Private file storage** | **Live**: local disk | – | Persistent disk, or an S3-compatible bucket with `STORAGE_DRIVER=s3` |
| **SMS** (Twilio) | **Unconfigured: NOT DONE until the live test passes** (tested only against a mocked Twilio API; `tests/sms-live.test.ts` written, not yet run) | SMS recorded as `not_sent_unconfigured`; email still goes out | Twilio account, NZ-capable sender number or Messaging Service, auth token |
| **Contractor payouts** | Manual bank batch (CSV export plus confirmation) | – | A payout provider and approved credentials if wanted later |
| **Bank feeds** | Manual CSV statement import for contractor payment reconciliation | – | – |

## Email (SMTP)

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` and `EMAIL_FROM`. Messages are written to the outbox in the same transaction as the business change, then delivered by the worker with retries and exponential backoff (6 attempts). Invoice emails attach the tax invoice, completion report and account statement as PDFs. `customer_invoices.sent_at` is only set after the SMTP server accepts the message.

## Stripe

1. Set `STRIPE_SECRET_KEY` (`sk_test_…` for test mode, `sk_live_…` for live) and `STRIPE_WEBHOOK_SECRET`.
2. In Stripe → Developers → Webhooks, add `https://<host>/webhooks/stripe` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.
3. Checkout payments are credited **only** from a signature-verified webhook with `payment_status = paid`, never from the browser redirect. Webhooks are de-duplicated on the Stripe event ID in the same transaction as the credit; the prepaid ledger also has its own idempotency key per payment.
4. Also subscribe the webhook to `payment_intent.succeeded` and `payment_intent.payment_failed`, which are used for saved-card automatic top-ups.

### Saved-card automatic top-ups

- **Saving a card**: Stripe Checkout in *setup* mode creates a SetupIntent for off-session use. `checkout.session.completed` (mode `setup`) records the card, after verifying that the SetupIntent belongs to the account's Stripe customer.
- **Charging**: an off-session, card-only PaymentIntent (`off_session: true, confirm: true`) with idempotency key `auto-topup-pi:<payment id>`, at most once per consent per NZ day. The prepaid balance is credited only when the PaymentIntent is `succeeded` and the amount and currency match. This works from either the API response or the `payment_intent.succeeded` webhook, and is idempotent.
- **Failures**: card errors mark the payment failed with Stripe's code, notify the customer and increment the failure count; charging pauses at `auto_topup_max_failures`. A bank-authentication requirement (`requires_action`) is treated as a failure and the customer is asked to pay by bank transfer or replace the card.

### Live Stripe test-mode verification (required before go-live)

`tests/stripe-live.test.ts` runs the real flow against a **Stripe test-mode account**:

- save `pm_card_visa`, charge it off-session and check the PaymentIntent on Stripe and the Ridgeline ledger;
- replay the signed webhook (must not credit twice);
- save `pm_card_chargeCustomerFail` and confirm the decline is recorded with nothing credited.

It is skipped unless `STRIPE_TEST_SECRET_KEY` is set. It **has not been run yet**: the build environment had no Stripe key and its network policy blocks `api.stripe.com`. **Auto top-up does not count as done until it has passed.** To run it, set `STRIPE_TEST_SECRET_KEY` in the environment (never paste keys into chat or commit them) and run:

```bash
npm run test:live
```

or add `STRIPE_TEST_SECRET_KEY` as a GitHub Actions repository secret (CI passes it through). Behind an outbound HTTPS proxy, `npm run test:live` sets `NODE_USE_ENV_PROXY=1`, and the Stripe client switches to its fetch transport so the proxy is used.

## SMS (Twilio)

Twilio reaches all NZ mobile networks. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_FROM_NUMBER` (a NZ-capable number, +64…) or `TWILIO_MESSAGING_SERVICE_SID`. Alphanumeric sender IDs are not reliable on NZ networks, so use a number.

- Sent for: P1/P2 offers (plus any offer outside business hours), acceptance confirmations, "job taken" for P1, escalations and SLA breach/at-risk alerts to `escalation_staff_phones`.
- **"Sent" means Twilio accepted the message and returned a message SID.** Outages, rate limits and auth errors are retried (up to 4 attempts, 1–3 minutes apart). A request Twilio refuses outright (HTTP 400, e.g. 21211 invalid number, 21614 not a mobile, 21608 unverified number on a trial account) is marked failed at once, because retrying cannot succeed and would only delay escalation. Neither is ever marked sent. Handset delivery is recorded from Twilio's status callback at `https://<host>/webhooks/sms/twilio`, which is signature-verified with the auth token. `undelivered` or `failed` turns the notification to failed in the outbox.
- Invalid or missing numbers are recorded as failed notifications, not silently skipped.
- Contractors' mobile numbers are stored as E.164 (+64…). P1 jobs are only offered to contractors with a mobile number.
- The provider is isolated in `src/services/sms.ts`, so another NZ provider (e.g. Sinch MessageMedia) can be swapped in by replacing the transport.
- The ordinary test suite blanks `TWILIO_*`, so it can never text the fixture numbers, which could belong to real people.

### Live SMS verification (required before go-live)

`tests/sms-live.test.ts` uses real Twilio and a real handset:

1. **Real send to a real NZ mobile**: queues an SMS to `SMS_TEST_MOBILE` through the normal outbox, delivers it through the production transport, checks it is marked sent only with a real `SM…` SID, then waits for Twilio to report **delivered**.
2. **Delivery callback**: the receipt must reach the app and set `delivery_status = delivered`. With `SMS_LIVE_PUBLIC_URL` (a public HTTPS URL forwarding to the test's local port, `SMS_LIVE_PORT`, default 3999, e.g. a tunnel or staging proxy), **Twilio's own callback** is received. Without it, the final status read from Twilio's API is replayed through the same webhook with a valid signature made from the live auth token, and the test output says which mode ran. Only the public-URL mode proves Twilio can reach the endpoint. Do that once from staging, or rely on the go-live checklist step that books a test P1 on the deployed site.
3. **Failed number recorded as failed**: sends to `SMS_TEST_FAILING_NUMBER` (default `+6490000000`, an invalid Auckland number). Either Twilio rejects it (failed at once, no SID, never sent) or it is accepted and then reported `undelivered`/`failed`, which must turn the outbox record to failed.

Needs, set as environment variables or secrets (never pasted into chat or committed): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID` (**live** credentials: Twilio "test credentials" never deliver), and `SMS_TEST_MOBILE`. On a Twilio trial account the test mobile must be a verified caller ID, and messages carry a trial prefix. Outbound access to `api.twilio.com` is required.

```bash
npm run test:live     # runs both live suites (Stripe + Twilio); each skips if its settings are missing
```

**SMS dispatch does not count as done until this has passed.** It has not run yet: the build environment had no Twilio credentials and its network policy blocks `api.twilio.com`. It is deliberately not part of CI, because every run sends real, billable SMS.

## Xero

1. In the Xero Developer portal create a **Custom Connection** for the Ridgeline organisation, with scopes `accounting.transactions accounting.contacts` (or the granular equivalents for newer apps; override with `XERO_SCOPES`).
2. Set `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` and account codes `XERO_SALES_ACCOUNT_CODE`, `XERO_COST_ACCOUNT_CODE`, `XERO_BANK_ACCOUNT_CODE`.
3. Admin → Integrations → **Re-queue failed / skipped**.

What syncs: issued customer invoices (ACCREC), approved contractor invoices (bills, ACCPAY) and confirmed contractor payments. Duplicate protection: before creating a document, the sync looks it up by invoice number (and supplier for bills) and links to the existing one if found. Each entity can be queued only once.

Not synced automatically: prepaid top-ups, prepaid applications, refunds and credit notes. In Xero these sit against a **Customer Prepayments liability** account. Use **Admin → Reports → Download journal (CSV)** to post or reconcile them, and agree the approach with your accountant.

## S3-compatible storage

Set `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` (for R2/B2), `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Keep the bucket **private**: files are only ever served through the application's access checks.
