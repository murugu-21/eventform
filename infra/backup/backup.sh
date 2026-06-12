#!/bin/sh
# Nightly pg_dump → gzip → append-only S3 upload. Runs once at startup, then
# every BACKUP_INTERVAL_SECONDS (default 24h). Failures log and retry next
# cycle — a missed backup must not crash-loop the stack.
set -u

: "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}" "${BACKUP_S3_BUCKET:?}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

while true; do
  STAMP="$(date -u +%Y%m%d-%H%M%S)"
  KEY="pg/eventform-${STAMP}.dump.gz"
  echo "[backup] starting dump -> s3://${BACKUP_S3_BUCKET}/${KEY}"
  if pg_dump -Fc | gzip | aws s3 cp - "s3://${BACKUP_S3_BUCKET}/${KEY}" --expected-size 104857600; then
    echo "[backup] OK: ${KEY}"
  else
    echo "[backup] FAILED (will retry next cycle)" >&2
  fi
  sleep "$INTERVAL"
done
