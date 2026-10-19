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

`render.yaml` is a ready-made Render Blueprint (web service + database + disk). Australian regions (e.g. Sydney on AWS/Fly) also work; Render currently offers Singapore as its closest region.

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

Optional: `SMTP_*`, `EMAIL_FROM`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_*_ACCOUNT_CODE`, `XERO_SCOPES`, `S3_*`, `RUN_WORKER_IN_PROCESS`, `WORKER_INTERVAL_MS`.

Keep all secrets in the host's secret manager, never in the repository.

## First deployment (Render)

1. Push this repository to GitHub. In Render: **New → Blueprint** → select the repo. Render creates the web service, database and disk from `render.yaml`.
2. Fill the `sync: false` variables: `APP_BASE_URL`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and email/Stripe/Xero credentials if you have them.
3. Deploy. The container runs `node dist/migrate-cli.js` (idempotent) before starting the server.
4. Open a Render shell and run `node dist/seed-cli.js` to create reference data and the first administrator. Then remove `SEED_ADMIN_PASSWORD` from the environment.
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

## Go-live checklist

- [ ] Admin → Settings → **General → company**: legal name, GST number, NZBN, address, bank account (printed on invoices and statements).
- [ ] Confirm the GST rate and `ridgeline_gst_registered`.
- [ ] Review the **facility assessment assumptions** and **coverage factors** against your real cost history.
- [ ] Review the **pricing rules** (default 35% markup on every category, NZ$135 minimum job charge) and the reference contractor rates used for estimates. Make sure customer agreements disclose them.
- [ ] Review the **public holidays** list and add regional anniversary days.
- [ ] Create staff users with least privilege (ops / finance / admin).
- [ ] Onboard contractors: verify trades, insurance and licences, agree rate cards, approve.
- [ ] Configure SMTP and send yourself a test (Admin → Notifications shows real delivery status).
- [ ] If using Stripe: set keys, add the webhook endpoint `https://<host>/webhooks/stripe` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `checkout.session.expired`, and copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
- [ ] If using Xero: create a Custom Connection, set credentials and account codes, then re-queue skipped items in Admin → Integrations.
- [ ] Schedule backups (BACKUP.md) and do a test restore.
- [ ] Have your accountant confirm the prepaid / GST treatment, and your lawyer review the privacy statement and customer terms.
