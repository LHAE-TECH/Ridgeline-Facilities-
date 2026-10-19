#!/bin/sh
# Restores a backup into an EMPTY database. Never run against the live database without a fresh backup.
# Usage: DATABASE_URL=postgres://.../ridgeline_restore ./scripts/restore.sh backups/ridgeline-YYYYMMDDTHHMMSSZ.dump
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
FILE="${1:?Path to .dump file required}"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$DATABASE_URL" "$FILE"
echo "Restored $FILE. Run 'npm run migrate:prod' to apply any newer migrations, then verify ledger reconciliation in Admin → Customers."
