#!/bin/bash
# Generates the dev KMS key material on first run. The file is gitignored —
# nothing secret-shaped lives in the repo, and each clone gets its own dev key.
# (Prod material is generated separately by infra/prod/bootstrap.sh.)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MATERIAL="$DIR/localstack/dev-key-material.b64"

if [[ -f "$MATERIAL" ]]; then
  exit 0
fi

openssl rand -base64 32 > "$MATERIAL"
chmod 600 "$MATERIAL"
echo "[dev-key] generated fresh dev KMS key material at $MATERIAL (gitignored)"
