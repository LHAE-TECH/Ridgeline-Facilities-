# Backups and disaster recovery

## What must be backed up

| Data | Where | How |
| --- | --- | --- |
| Database: all accounts, jobs, ledgers, invoices and audit history | PostgreSQL | Provider backups **and** a nightly `pg_dump` kept off-site |
| Uploaded evidence, invoices, compliance documents | `UPLOAD_DIR` disk or S3 bucket | Nightly archive (disk) or bucket versioning (S3) |
| Configuration | Host environment variables | Keep a copy in your password manager |

Every uploaded file's SHA-256 is stored in the database, so you can verify restored files against their originals.

## Provider backups

Managed Postgres plans include automated backups. Retention and point-in-time recovery vary by plan and provider, so check yours and use a plan that keeps at least 7 days. Free database tiers are not suitable for production.

## Independent nightly backup (recommended)

`scripts/backup.sh` writes a compressed `pg_dump` (custom format) and, if `UPLOAD_DIR` is set, a tarball of uploads. It keeps 35 days locally.

```bash
DATABASE_URL=postgres://... UPLOAD_DIR=/data/uploads BACKUP_DIR=/backups ./scripts/backup.sh
rclone copy /backups r2:ridgeline-backups        # off-site copy
```

Run it nightly from a Render Cron Job, a GitHub Actions schedule, or cron on any machine with network access to the database. Enable object versioning and a lifecycle rule on the bucket (for example, 90 days daily plus 7 years monthly to cover tax-record retention).

If you use S3/R2 for uploads, enable bucket versioning instead of archiving files.

## Restore

```bash
createdb ridgeline_restore
DATABASE_URL=postgres://.../ridgeline_restore ./scripts/restore.sh backups/ridgeline-20260101T000000Z.dump
tar -xzf backups/uploads-20260101T000000Z.tar.gz -C /data/uploads
```

Then point `DATABASE_URL` at the restored database (or rename it), start the app (pending migrations apply automatically) and check:

1. Admin → Customers → each customer shows **Ledger check: Balanced** (cached balance = prepaid sub-ledger = general ledger).
2. Admin → Reports → general ledger balances match your bank and Xero.
3. Open a few jobs and confirm photos load.

Restore is tested in this repository's build (`backup.sh` → `restore.sh` round trip). **Repeat a test restore every quarter.**

## Recovery objectives (suggested)

- RPO: 24 hours with nightly dumps; minutes with provider point-in-time recovery.
- RTO: about 1 hour (redeploy the container, restore the database, restore uploads).

## Data retention

Financial records (journals, invoices, payments) and their evidence are append-only in the database. Keep backups for at least 7 years to meet the NZ tax record-keeping requirement. Personal information that is no longer needed should be handled under the Privacy Act 2020: anonymise contacts on closed accounts rather than deleting financial records.
