#!/usr/bin/env bash
# infra/prod/gen-kms-material.sh — generate the prod KMS key material.
#
# Run this ONCE, BEFORE `docker compose -f docker-compose.prod.yml up`, because
# the localstack service bind-mounts this file and the compose file requires
# KMS_KEY_MATERIAL_FILE to be set (it has no fallback in prod).
#
# Idempotent: if the file already exists it is left untouched (regenerating it
# would make every existing encrypted endpoint secret undecryptable).
#
# Required env:
#   KMS_KEY_MATERIAL_FILE   Absolute host path for the AES-256 key material
#
# Usage:
#   export KMS_KEY_MATERIAL_FILE=/etc/eventform/kms-material.b64
#   bash infra/prod/gen-kms-material.sh

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[kms]${NC} $*"; }
warn() { echo -e "${YELLOW}[kms]${NC} $*"; }
error() { echo -e "${RED}[kms] ERROR:${NC} $*" >&2; }

if [[ -z "${KMS_KEY_MATERIAL_FILE:-}" ]]; then
  error "KMS_KEY_MATERIAL_FILE is not set."
  exit 1
fi

if [[ -f "$KMS_KEY_MATERIAL_FILE" ]]; then
  info "Key material already exists at $KMS_KEY_MATERIAL_FILE — leaving it untouched."
  exit 0
fi

KMS_DIR="$(dirname "$KMS_KEY_MATERIAL_FILE")"
mkdir -p "$KMS_DIR"
openssl rand -base64 32 > "$KMS_KEY_MATERIAL_FILE"
chmod 600 "$KMS_KEY_MATERIAL_FILE"
info "Generated AES-256 key material at $KMS_KEY_MATERIAL_FILE (mode 600)."
warn "BACK THIS FILE UP. Losing it makes all encrypted endpoint secrets irrecoverable."
