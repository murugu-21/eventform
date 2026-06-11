#!/bin/bash
# Idempotent: PUT to /connectors/<name>/config creates or updates.
set -euo pipefail
CONNECT_URL="${CONNECT_URL:-http://localhost:8083}"
DIR="$(cd "$(dirname "$0")" && pwd)"

curl -fsS -X PUT \
  -H "Content-Type: application/json" \
  --data @"$DIR/eventform-outbox.json" \
  "$CONNECT_URL/connectors/eventform-outbox/config" > /dev/null

echo "connector registered; status:"
curl -fsS "$CONNECT_URL/connectors/eventform-outbox/status"
echo
