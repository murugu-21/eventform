#!/bin/bash
# Idempotent: PUT to /connectors/<name>/config creates or updates, then waits
# for the connector AND its task to reach RUNNING (registration returns before
# the task is actually live, which races consumers that subscribe immediately).
set -euo pipefail
CONNECT_URL="${CONNECT_URL:-http://localhost:8083}"
DIR="$(cd "$(dirname "$0")" && pwd)"

curl -fsS -X PUT \
  -H "Content-Type: application/json" \
  --data @"$DIR/eventform-outbox.json" \
  "$CONNECT_URL/connectors/eventform-outbox/config" > /dev/null

echo "connector registered; waiting for RUNNING..."
for i in $(seq 1 30); do
  status="$(curl -fsS "$CONNECT_URL/connectors/eventform-outbox/status" 2>/dev/null || echo '{}')"
  conn_state="$(printf '%s' "$status" | grep -o '"state":"[A-Z]*"' | head -1 | cut -d'"' -f4)"
  task_state="$(printf '%s' "$status" | grep -o '"state":"[A-Z]*"' | sed -n 2p | cut -d'"' -f4)"
  if [[ "$conn_state" == "RUNNING" && "$task_state" == "RUNNING" ]]; then
    echo "connector + task RUNNING."
    exit 0
  fi
  if [[ "$conn_state" == "FAILED" || "$task_state" == "FAILED" ]]; then
    echo "connector FAILED:" >&2
    printf '%s\n' "$status" >&2
    exit 1
  fi
  sleep 2
done

echo "connector did not reach RUNNING in time:" >&2
curl -fsS "$CONNECT_URL/connectors/eventform-outbox/status" >&2
echo >&2
exit 1
