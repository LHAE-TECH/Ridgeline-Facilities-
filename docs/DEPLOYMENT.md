# Deployment

## Recommended hosting (lowest operating effort)

One container plus managed PostgreSQL. The application is a single Node process: the web server and background worker run together, and a Postgres advisory lock prevents duplicate worker runs if you scale out later.

| Component | Recommended | Alternatives |
| --- | --- | --- |
| App | Render web service (Docker), Starter plan, Singapore region | Fly.io, Railway, any VPS running Docker |
| Database | Render Postgres (Basic) | Neon, Supabase, AWS RDS, DigitalOcean Managed Postgres |
| Files | Render persistent disk at `/data/uploads` | Cloudflare R2 / AWS S3 / Backblaze B2 (`STORAGE_DRIVER=s3`) |
| Email | Postmark or Amazon SES over SMTP | Any SMTP provider |
| Card payments | Stripe (optional) | Bank transfer only |
| Accounting | Xero Custom Connection (optional) | Journal CSV export to any accounting system |

`render.yaml` is a ready-made Render Blueprint with two environments, each with its own web service, database and disk:

| | Production (`ridgeline-facilities`) | Staging (`ridgeline-facilities-staging`) |
| --- | --- | --- |
| Deploys | Manually (`autoDeploy: false`), after staging passes | Automatically from `main` |
| `DEPLOYMENT_ENVIRONMENT` | `production` | `staging` (shows a STAGING banner on every page) |
| Stripe | Live keys | **Test keys only**: the app refuses to start on staging with an `sk_live_` key |
| Twilio | Production account | Dedicated subaccount with a low spend cap |
| Email | Production SMTP | Sandbox / test inbox: staging must never email real customers |
| Data | Real | Test customers, sites and contractors only (staff handsets as contractor mobiles) |

Staging runs the same image and the same `NODE_ENV=production` code paths as production, so a gate passed there means something. The demo seed is refused on both. Australian regions (e.g. Sydney on AWS/Fly) also work; Render currently offers Singapore as its closest region.

> A persistent disk ties the service to one instance. To run more than one instance, switch to `STORAGE_DRIVER=s3` first.

## Environment variables

See `.env.example` for the full list. Required in production:

| Variable | Notes |
| --- | --- |
| `NODE_ENV=production` | Enables secure cookies; refuses to start without `SESSION_SECRET` |
| `DATABASE_URL` | Postgres connection string. Set `DATABASE_SSL=true` if your provider requires TLS |
| `SESSION_SECRET` | 32+ random bytes (`openssl rand -hex 32`) |
| `APP_BASE_URL` | e.g. `https://app.ridgelinefacilities.com` (used in emails and Stripe redirects) |
| `UPLOAD_DIR` | Persistent, **non-public** directory (default `/data/uploads` in Docker) |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | First administrator (12+ char password); used once by the seed command |

Optional: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` / `TWILIO_MESSAGING_SERVICE_SID`, `SMTP_*`, `EMAIL_FROM`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_*_ACCOUNT_CODE`, `XERO_SCOPES`, `S3_*`, `RUN_WORKER_IN_PROCESS`, `WORKER_INTERVAL_MS`.

Keep all secrets in the host's secret manager, never in the repository.

## First deployment (Render)

1. Push this repository to GitHub. In Render: **New → Blueprint** → select the repo. Render creates the web service, database and disk from `render.yaml`.
2. Fill the `sync: false` variables: `APP_BASE_URL`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and email/Stripe/Xero credentials if you have them.
3. Deploy. The container runs `node dist/migrate-cli.js` (idempotent) before starting the server.
4. Open a Render shell and run `node dist/seed-cli.js` to create reference data and the first administrator. In production this also marks the database as production, so demo data can never be loaded into it. Then remove `SEED_ADMIN_PASSWORD` from the environment.
5. Add a custom domain (`app.ridgelinefacilities.com`) with a CNAME at your DNS provider. Render issues the TLS certificate.
6. Add a link from the marketing site (ridgelinefacilities.com) to `/login` and `/register`.
7. Sign in as the administrator and complete the go-live checklist below.

## Docker on any host

```bash
docker build -t ridgeline .
docker run -d --name ridgeline -p 3000:3000 --env-file .env -v ridgeline-uploads:/data/uploads ridgeline
docker exec ridgeline node dist/seed-cli.js
```

Put a TLS-terminating reverse proxy (Caddy, nginx, Cloudflare) in front. The app trusts one proxy hop for client IPs and secure cookies.

## Manual (no Docker)

```bash
npm ci && npm run build
npm run migrate:prod && npm run seed:prod
NODE_ENV=production node dist/server.js        # or run under systemd / pm2
```

To run the worker separately: set `RUN_WORKER_IN_PROCESS=false` on the web process and run `node dist/worker-cli.js` as a second process.

## Upgrades

Deploy the new image. Migrations in `migrations/` are applied in order at start-up, each in a transaction, under an advisory lock. Take a backup first (see BACKUP.md). Migrations are forward-only; to roll back, restore the backup.

## Go-live gates (BLOCKING)

Do not take real bookings until **every gate below has passed and been recorded** (date, who, evidence). These are not checklist steps that can be deferred; if a gate fails, go-live stops until it passes.

1. **GATE 1: Live Stripe test passes.** `npm run test:live` with `STRIPE_TEST_SECRET_KEY` set: a saved card charged off-session and credited once, the webhook replay credits nothing, a declined card credits nothing (INTEGRATIONS.md).
2. **GATE 2: Live Twilio test passes.** `npm run test:live` with live `TWILIO_*` credentials and `SMS_TEST_MOBILE`: a real SMS delivered to a real NZ mobile, its delivery receipt recorded, and a failing number recorded as failed (INTEGRATIONS.md).
3. **GATE 3: Twilio's delivery callback reaches STAGING.** The live test can only replay the callback unless it has a public URL, so it is proven on the deployed staging service first:
   - on staging, book a test P1 at a test site, with a test contractor whose mobile is a staff handset;
   - confirm the SMS arrives on the handset;
   - confirm **Admin → Notifications** shows that SMS with delivery status **delivered**, set by Twilio's request to `https://<staging-host>/webhooks/sms/twilio` (signature verified with the staging auth token);
   - repeat with an undeliverable number and confirm it shows **failed**;
   - hold a P1 at the unfunded threshold and confirm the on-call release holder's handset gets the hold SMS and that person can release it.

   If the status stays at `queued`/`sent`, Twilio cannot reach the callback (DNS, TLS, firewall, wrong `APP_BASE_URL`, or a signature mismatch from a proxy rewriting the URL). **Stop and fix before promoting to production.**
4. **GATE 4: the same callback check on PRODUCTION, before the first real booking.** Production has its own host name, TLS certificate, `APP_BASE_URL` and Twilio credentials, so staging cannot prove them. After the first production deploy, and before any customer is invited, repeat the delivered and failed checks from Gate 3 on production with a staff test customer and contractor, then cancel the test jobs. **Do not take real bookings until it passes.** This gate also applies after any change to the production domain, `APP_BASE_URL` or Twilio account.

Credentials for these tests come from the environment only (hosting secrets or CI secrets). They are never written to files, logs, tickets or docs. Use a dedicated Twilio subaccount with a low spend cap for testing, and rotate its credentials afterwards.

## Go-live checklist

- [ ] Admin → Settings → **Contracting entity & GST**: confirm LHA Holdings Limited / NZBN 9429052390173 and **enter the GST number**. GST invoices are blocked until it is set. Also enter the address and the bank account for customer payments.
- [ ] Confirm the GST rate and `ridgeline_gst_registered`.
- [ ] Review the **facility assessment assumptions** and **coverage factors** against your real cost history.
- [ ] Review the **pricing rules** (default 35% markup on every category, NZ$135 minimum job charge) and the reference contractor rates used for estimates. Make sure customer agreements disclose them.
- [ ] Review the **public holidays** list and add regional anniversary days (they affect business-hour SLA clocks).
- [ ] Confirm the **SLA settings**: `sla_areas` (Auckland metro / Rodney and Franklin suburb lists), P1 non-metro targets (4 h on site / 8 h made safe), `sla_business_hours`, escalation windows, and enter `escalation_staff_phones` (on-call mobiles). Check every customer site shows a confirmed SLA area.
- [ ] Monthly customer report: leave `monthly_report_enabled` off until Ridgeline decides to switch it on (then enable per customer).
- [ ] Unfunded emergencies: confirm `p1_unfunded_cap_ex_gst_cents` (default NZ$1,500 ex GST make-safe cap) and `p1_unfunded_suspend_threshold_cents` (default NZ$3,000), and set per-customer values where needed.
- [ ] Clear the dashboard's **Area unconfirmed** list (pin each site or extend `sla_areas`).
- [ ] Grant the **on-call P1 release** right (Admin → Staff users) to everyone on the on-call roster, with their mobile. The users page warns if any escalation phone belongs to nobody with the right, or if nobody holds it.
- [ ] Decide `p1_hold_at_threshold` (default on: hold unfunded P1s at the threshold for an on-call release).
- [ ] Make sure every emergency-capable contractor has a **mobile number**.
- [ ] Create staff users with least privilege (ops / finance / admin).
- [ ] Onboard contractors: verify trades, insurance and licences, agree rate cards, approve.
- [ ] Configure SMTP and send yourself a test (Admin → Notifications shows real delivery status).
- [ ] If using Stripe: set keys, add the webhook endpoint `https://<host>/webhooks/stripe` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.succeeded` and `payment_intent.payment_failed`, copy the signing secret into `STRIPE_WEBHOOK_SECRET`, and **run `tests/stripe-live.test.ts` with a test-mode key** (see INTEGRATIONS.md).
- [ ] If using Xero: create a Custom Connection, set credentials and account codes, then re-queue skipped items in Admin → Integrations.
- [ ] Schedule backups (BACKUP.md) and do a test restore.
- [ ] Have your accountant confirm the prepaid / GST treatment (docs/GST_TIMING.md: **open**), and your lawyer review the agreements using docs/LEGAL_REVIEW_BRIEF.md.
