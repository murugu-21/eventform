#!/usr/bin/env bash
# infra/prod/bootstrap.sh — idempotent DB hardening, run ONCE after migrations.
#
# Correct order on a fresh VPS:
#   1. gen-kms-material.sh         (generate key material — BEFORE compose up)
#   2. docker compose ... up -d postgres localstack kafka connect
#   3. docker compose ... run --rm migrate   (creates roles + tables + RLS)
#   4. bootstrap.sh                (THIS script — rotate passwords + harden)
#   5. docker compose ... up -d    (start the full app stack)
#
# This script REQUIRES the app_api / app_worker roles to already exist (created
# by the migration in step 3); it rotates their passwords away from the public
# dev defaults and revokes CREATE on the public schema. It refuses to run if the
# roles are missing, telling you to run migrations first.
#
# Required env:
#   DB_ADMIN_PASSWORD     Postgres admin password (matches the running container)
#   APP_API_PASSWORD      New password for the app_api role
#   APP_WORKER_PASSWORD   New password for the app_worker role

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[bootstrap]${NC} $*"; }
warn()  { echo -e "${YELLOW}[bootstrap]${NC} $*"; }
error() { echo -e "${RED}[bootstrap] ERROR:${NC} $*" >&2; }

# ── Preflight: required env vars ──────────────────────────────────────────────
REQUIRED_VARS=(DB_ADMIN_PASSWORD APP_API_PASSWORD APP_WORKER_PASSWORD)
MISSING=()
for v in "${REQUIRED_VARS[@]}"; do
  [[ -z "${!v:-}" ]] && MISSING+=("$v")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  error "Missing required environment variables: ${MISSING[*]}"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/../compose/docker-compose.prod.yml}"
psql_admin() {
  docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U eventform -d eventform -tAc "$1"
}

# ── Preflight: postgres reachable and roles exist ─────────────────────────────
if ! psql_admin "SELECT 1" >/dev/null 2>&1; then
  error "Cannot reach the postgres container via '$COMPOSE_FILE'."
  error "Start the infra tier first: docker compose -f docker-compose.prod.yml up -d postgres"
  exit 1
fi
for role in app_api app_worker; do
  exists="$(psql_admin "SELECT 1 FROM pg_roles WHERE rolname = '$role'")"
  if [[ "$exists" != "1" ]]; then
    error "Role '$role' does not exist yet — run migrations before bootstrap:"
    error "  docker compose -f docker-compose.prod.yml run --rm migrate"
    exit 1
  fi
done

info "Rotating app_api password..."
psql_admin "ALTER ROLE app_api PASSWORD '$APP_API_PASSWORD'" >/dev/null
info "Rotating app_worker password..."
psql_admin "ALTER ROLE app_worker PASSWORD '$APP_WORKER_PASSWORD'" >/dev/null

info "Revoking CREATE ON SCHEMA public FROM PUBLIC..."
psql_admin "REVOKE CREATE ON SCHEMA public FROM PUBLIC" >/dev/null

info "Bootstrap complete. Now start the full stack:"
info "  docker compose -f docker-compose.prod.yml up -d"
