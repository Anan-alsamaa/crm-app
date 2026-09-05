#!/usr/bin/env bash
#
# backup-pg.sh — take a compressed, restorable snapshot of the Yiji CRM Postgres
# database (the system of record behind Directus).
#
# Connection is resolved in this order:
#   1. $DATABASE_URL                       (postgres://user:pass@host:port/db)
#   2. the DB_* vars used by docker-compose (DB_HOST/DB_PORT/DB_USER/...)
#
# Output: a pg_dump custom-format archive (-Fc) at
#   ${BACKUP_DIR:-./backups}/yiji-<db>-<UTC timestamp>.dump
# Custom format is compressed and restores selectively via restore-pg.sh.
#
# Usage:
#   ./scripts/backup-pg.sh
#   BACKUP_DIR=/var/backups/yiji RETENTION_DAYS=14 ./scripts/backup-pg.sh
#   DATABASE_URL=postgres://u:p@db.internal:5432/yiji_crm ./scripts/backup-pg.sh
#
# Run against the compose stack's container instead of a local client:
#   docker compose exec -T postgres sh -c \
#     'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup.dump
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "error: pg_dump not found on PATH. Install postgresql-client or use the" >&2
  echo "       'docker compose exec postgres' variant documented in this file." >&2
  exit 1
fi

# Build pg_dump connection args.
if [[ -n "${DATABASE_URL:-}" ]]; then
  CONN=("${DATABASE_URL}")
  DB_LABEL="$(printf '%s' "${DATABASE_URL}" | sed -E 's#.*/([^/?]+).*#\1#')"
else
  DB_HOST="${DB_HOST:-localhost}"
  DB_PORT="${DB_PORT:-5432}"
  DB_USER="${DB_USER:-directus}"
  DB_DATABASE="${DB_DATABASE:-yiji_crm}"
  export PGPASSWORD="${DB_PASSWORD:-${PGPASSWORD:-}}"
  CONN=(-h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" "${DB_DATABASE}")
  DB_LABEL="${DB_DATABASE}"
fi

mkdir -p "${BACKUP_DIR}"
# Portable UTC timestamp (avoids Date.now-style locale surprises).
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/yiji-${DB_LABEL}-${STAMP}.dump"

echo "→ dumping ${DB_LABEL} to ${OUT}"
pg_dump -Fc --no-owner --no-privileges -f "${OUT}" "${CONN[@]}"

SIZE="$(du -h "${OUT}" | cut -f1)"
echo "✓ backup complete: ${OUT} (${SIZE})"

# Prune backups older than the retention window.
if [[ "${RETENTION_DAYS}" -gt 0 ]]; then
  PRUNED="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'yiji-*.dump' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l | tr -d ' ')"
  if [[ "${PRUNED}" -gt 0 ]]; then
    echo "✓ pruned ${PRUNED} backup(s) older than ${RETENTION_DAYS} day(s)"
  fi
fi
