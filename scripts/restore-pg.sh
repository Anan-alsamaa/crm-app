#!/usr/bin/env bash
#
# restore-pg.sh — restore a Yiji CRM Postgres database from a backup-pg.sh dump.
#
# DESTRUCTIVE: with --clean it drops and recreates every object in the target
# database before restoring. Stop Directus + the Node services first so nothing
# writes mid-restore. You must confirm by passing --yes (or setting FORCE=1).
#
# Connection resolution matches backup-pg.sh ($DATABASE_URL, else DB_* vars).
#
# Usage:
#   ./scripts/restore-pg.sh ./backups/yiji-yiji_crm-20260604T120000Z.dump --yes
#   FORCE=1 DATABASE_URL=postgres://u:p@host:5432/yiji_crm ./scripts/restore-pg.sh dump.dump
#
# Run against the compose stack's container instead of a local client:
#   docker compose exec -T postgres sh -c \
#     'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < backup.dump
#
set -euo pipefail

DUMP="${1:-}"
CONFIRM="${2:-}"

if [[ -z "${DUMP}" ]]; then
  echo "usage: $0 <dump-file> [--yes]" >&2
  exit 2
fi
if [[ ! -f "${DUMP}" ]]; then
  echo "error: dump file not found: ${DUMP}" >&2
  exit 1
fi
if ! command -v pg_restore >/dev/null 2>&1; then
  echo "error: pg_restore not found on PATH. Install postgresql-client or use the" >&2
  echo "       'docker compose exec postgres' variant documented in this file." >&2
  exit 1
fi

if [[ "${FORCE:-0}" != "1" && "${CONFIRM}" != "--yes" ]]; then
  echo "refusing to restore without confirmation." >&2
  echo "This DROPS existing objects in the target DB. Re-run with --yes (or FORCE=1)." >&2
  exit 3
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  CONN=(-d "${DATABASE_URL}")
  DB_LABEL="$(printf '%s' "${DATABASE_URL}" | sed -E 's#.*/([^/?]+).*#\1#')"
else
  DB_HOST="${DB_HOST:-localhost}"
  DB_PORT="${DB_PORT:-5432}"
  DB_USER="${DB_USER:-directus}"
  DB_DATABASE="${DB_DATABASE:-yiji_crm}"
  export PGPASSWORD="${DB_PASSWORD:-${PGPASSWORD:-}}"
  CONN=(-h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_DATABASE}")
  DB_LABEL="${DB_DATABASE}"
fi

echo "→ restoring ${DUMP} into ${DB_LABEL} (drop + recreate)"
# --clean --if-exists: drop objects first; --no-owner/--no-privileges: portable
# across role names; --exit-on-error off so benign "does not exist" drops on a
# fresh DB don't abort the run.
pg_restore --clean --if-exists --no-owner --no-privileges "${CONN[@]}" "${DUMP}"

echo "✓ restore complete into ${DB_LABEL}"
echo "  next: re-run bootstrap to reconcile schema, then restart the services:"
echo "    pnpm --filter @yiji/directus-bootstrap apply"
