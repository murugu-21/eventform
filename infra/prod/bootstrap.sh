#!/usr/bin/env bash
# infra/prod/bootstrap.sh — idempotent first-boot hardening
# Run ONCE after initial `docker compose -f docker-compose.prod.yml up -d`.
#
# What it does:
#   (a) Generate KMS key material file if missing (must exist before compose up)
#   (b) Rotate app_api and app_worker role passwords via psql
#   (c) REVOKE CREATE ON SCHEMA public FROM PUBLIC (schema hardening)
#
# Required env vars:
#   KMS_KEY_MATERIAL_FILE    Host path for the AES-256 key material (created here if missing)
#   DB_ADMIN_PASSWORD        Postgres admin password
#   APP_API_PASSWORD         New password for app_api role
#   APP_WORKER_PASSWORD      New password for app_worker role
#
# Usage (from the directory containing docker-compose.prod.yml):
#   export KMS_KEY_MATERIAL_FILE=/etc/eventform/kms-material.b64
#   export DB_ADMIN_PASSWORD=...
#   export APP_API_PASSWORD=...
#   export APP_WORKER_PASSWORD=...
#   bash infra/prod/bootstrap.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[bootstrap]${NC} $*"; }
warn()  { echo -e "${YELLOW}[bootstrap]${NC} $*"; }
error() { echo -e "${RED}[bootstrap] ERROR:${NC} $*" >&2; }

# ── Preflight: required env vars ──────────────────────────────────────────────
REQUIRED_VARS=(KMS_KEY_MATERIAL_FILE DB_ADMIN_PASSWORD APP_API_PASSWORD APP_WORKER_PASSWORD)
MISSING=()
for v in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    MISSING+=("$v")
  fi
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  error "Missing required environment variables: ${MISSING[*]}"
  error "Set them and re-run this script."
  exit 1
fi

info "Starting eventform bootstrap..."

# ── (a) Generate KMS key material ────────────────────────────────────────────
KMS_DIR="$(dirname "$KMS_KEY_MATERIAL_FILE")"
if [[ -f "$KMS_KEY_MATERIAL_FILE" ]]; then
  info "KMS key material already exists at $KMS_KEY_MATERIAL_FILE — skipping generation."
else
  info "Generating KMS key material at $KMS_KEY_MATERIAL_FILE ..."
  if [[ ! -d "$KMS_DIR" ]]; then
    mkdir -p "$KMS_DIR"
    info "Created directory $KMS_DIR"
  fi
  # Generate 32 random bytes (AES-256), base64-encoded
  openssl rand -base64 32 > "$KMS_KEY_MATERIAL_FILE"
  chmod 600 "$KMS_KEY_MATERIAL_FILE"
  info "KMS key material generated and permissions set to 600."
  warn "NOTE: This file is the KMS key material. Back it up securely."
  warn "      Losing it means all encrypted endpoint secrets are irrecoverable."
fi

# Guard: the dev key material committed to this repo is PUBLIC. Refuse to run
# production with it — that would encrypt real secrets under known key material.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_MATERIAL="$SCRIPT_DIR/../compose/localstack/dev-key-material.b64"
if [[ -f "$DEV_MATERIAL" ]] && command -v shasum >/dev/null 2>&1; then
  if [[ "$(shasum -a 256 < "$KMS_KEY_MATERIAL_FILE")" == "$(shasum -a 256 < "$DEV_MATERIAL")" ]]; then
    error "KMS_KEY_MATERIAL_FILE ($KMS_KEY_MATERIAL_FILE) contains the COMMITTED dev key material."
    error "That file is public on GitHub — production must use freshly generated material."
    error "Delete the file and re-run this script to generate a real one."
    exit 1
  fi
fi

# ── (b) Rotate app_api and app_worker passwords ───────────────────────────────
# Determine compose file location (look next to this script → infra/compose/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/../compose/docker-compose.prod.yml}"

info "Rotating app_api password..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U eventform -d eventform -c \
  "ALTER ROLE app_api PASSWORD '$APP_API_PASSWORD';"
info "app_api password updated."

info "Rotating app_worker password..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U eventform -d eventform -c \
  "ALTER ROLE app_worker PASSWORD '$APP_WORKER_PASSWORD';"
info "app_worker password updated."

# ── (c) Schema hardening ──────────────────────────────────────────────────────
info "Applying schema hardening (REVOKE CREATE ON SCHEMA public FROM PUBLIC)..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U eventform -d eventform -c \
  "REVOKE CREATE ON SCHEMA public FROM PUBLIC;" || true
info "Schema hardening applied (idempotent — 'already exists' warnings are OK)."

info "Bootstrap complete."
info ""
info "Next steps:"
info "  1. Run migrations:   docker compose -f $COMPOSE_FILE run --rm migrate"
info "  2. Verify the stack: docker compose -f $COMPOSE_FILE ps"
info "  3. Check Caddy TLS:  https://\${WEB_HOST:-eventform.murugappan.dev}"
