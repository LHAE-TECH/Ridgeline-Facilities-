#!/bin/sh
# Nightly logical backup of the Ridgeline database (and optional upload archive).
# Usage: DATABASE_URL=... BACKUP_DIR=/backups ./scripts/backup.sh
# Ship BACKUP_DIR off-site (e.g. `rclone copy` to an S3/R2/B2 bucket with object versioning enabled).
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
pg_dump --format=custom --no-owner --no-privileges --file="$BACKUP_DIR/ridgeline-$STAMP.dump" "$DATABASE_URL"
echo "Database backup written: $BACKUP_DIR/ridgeline-$STAMP.dump"
if [ "${UPLOAD_DIR:-}" ] && [ -d "$UPLOAD_DIR" ]; then
  tar -czf "$BACKUP_DIR/uploads-$STAMP.tar.gz" -C "$UPLOAD_DIR" .
  echo "Uploads archive written: $BACKUP_DIR/uploads-$STAMP.tar.gz"
fi
# Keep 35 days locally; off-site retention is controlled by the bucket lifecycle policy.
find "$BACKUP_DIR" -name 'ridgeline-*.dump' -mtime +35 -delete
find "$BACKUP_DIR" -name 'uploads-*.tar.gz' -mtime +35 -delete
