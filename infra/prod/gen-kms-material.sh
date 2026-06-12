#!/usr/bin/env bash
# infra/prod/gen-kms-material.sh — generate/restore the prod KMS key material.
#
# Durable source of truth: AWS SSM Parameter Store (SecureString, standard
# tier = free; encrypted with the AWS-managed aws/ssm key). The host file is
# the working copy that the prod LocalStack container mounts.
#
# Sync logic (idempotent, never prints the material):
#   1. SSM has the parameter            -> restore it to the file
#   2. no SSM, local file exists        -> back the file up INTO SSM
#   3. neither                          -> generate, write file, push to SSM
#   4. no AWS credentials available     -> local-only fallback (loud warning)
#
# Recommended flow: run this on a machine with the AWS profile (e.g. your
# laptop: AWS_PROFILE=eventform), then scp the file to the VPS — the VPS
# itself needs no AWS credentials.
#
# Required env:
#   KMS_KEY_MATERIAL_FILE   Path for the AES-256 key material file
# Optional env:
#   KMS_SSM_PARAM           SSM parameter name (default /eventform/kms-key-material)
#   AWS_REGION              default us-east-1

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[kms]${NC} $*"; }
warn() { echo -e "${YELLOW}[kms]${NC} $*"; }
error() { echo -e "${RED}[kms] ERROR:${NC} $*" >&2; }

if [[ -z "${KMS_KEY_MATERIAL_FILE:-}" ]]; then
  error "KMS_KEY_MATERIAL_FILE is not set."
  exit 1
fi

SSM_PARAM="${KMS_SSM_PARAM:-/eventform/kms-key-material}"
REGION="${AWS_REGION:-us-east-1}"

write_file() {
  KMS_DIR="$(dirname "$KMS_KEY_MATERIAL_FILE")"
  mkdir -p "$KMS_DIR"
  umask 177
  cat > "$KMS_KEY_MATERIAL_FILE"
  chmod 600 "$KMS_KEY_MATERIAL_FILE"
}

aws_available() {
  command -v aws >/dev/null 2>&1 && aws sts get-caller-identity >/dev/null 2>&1
}

if ! aws_available; then
  warn "No AWS credentials available — falling back to LOCAL-ONLY generation."
  warn "Run this script from a machine with the AWS profile to sync with SSM."
  if [[ -f "$KMS_KEY_MATERIAL_FILE" ]]; then
    info "Key material already exists at $KMS_KEY_MATERIAL_FILE — leaving it untouched."
    exit 0
  fi
  openssl rand -base64 32 | write_file
  info "Generated AES-256 key material at $KMS_KEY_MATERIAL_FILE (mode 600)."
  warn "BACK THIS FILE UP — it is not in SSM yet. Losing it makes all"
  warn "encrypted endpoint secrets irrecoverable."
  exit 0
fi

# ── 1. Try to restore from SSM ────────────────────────────────────────────────
if aws ssm get-parameter --name "$SSM_PARAM" --region "$REGION" >/dev/null 2>&1; then
  if [[ -f "$KMS_KEY_MATERIAL_FILE" ]]; then
    local_hash="$(shasum -a 256 < "$KMS_KEY_MATERIAL_FILE" | cut -d' ' -f1)"
    ssm_hash="$(aws ssm get-parameter --name "$SSM_PARAM" --with-decryption --region "$REGION" \
      --query Parameter.Value --output text | shasum -a 256 | cut -d' ' -f1)"
    if [[ "$local_hash" == "$ssm_hash" ]]; then
      info "Local file matches SSM ($SSM_PARAM) — nothing to do."
      exit 0
    fi
    error "Local file DIFFERS from SSM ($SSM_PARAM)."
    error "Resolve manually — overwriting either side could orphan existing ciphertexts."
    exit 1
  fi
  aws ssm get-parameter --name "$SSM_PARAM" --with-decryption --region "$REGION" \
    --query Parameter.Value --output text | write_file
  info "Restored key material from SSM ($SSM_PARAM) to $KMS_KEY_MATERIAL_FILE."
  exit 0
fi

# ── 2./3. Nothing in SSM: take the local file or generate, then push ─────────
if [[ ! -f "$KMS_KEY_MATERIAL_FILE" ]]; then
  openssl rand -base64 32 | write_file
  info "Generated new AES-256 key material at $KMS_KEY_MATERIAL_FILE (mode 600)."
fi

aws ssm put-parameter \
  --name "$SSM_PARAM" \
  --type SecureString \
  --value "$(cat "$KMS_KEY_MATERIAL_FILE")" \
  --description "EventForm prod KMS key material (base64 AES-256)" \
  --region "$REGION" >/dev/null
info "Backed up key material to SSM SecureString: $SSM_PARAM (standard tier — free)."
info "The VPS needs only the FILE — scp it over; no AWS credentials required on the box."
