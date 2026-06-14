#!/bin/sh
# EventForm idle-stop. Run by eventform-idle.timer every 5 min on the box.
# If there have been no *real* (non-/health) requests for IDLE_MINUTES, set this
# instance's ASG desired capacity to 0 — the ASG terminates the box. Neon holds
# the data and the Redpanda log is disposable, so termination is safe; the next
# wake (API Gateway -> Lambda) launches a fresh instance that boots the stack.
#
# Activity signal: the API writes the last-activity time (epoch SECONDS) into
# $ACTIVITY_FILE on startup and on every real request (throttled). EVERY failure
# path is conservative: never scale down on a missing/unreadable signal — we must
# not kill a possibly-active box on error.
set -eu

ACTIVITY_FILE="${ACTIVITY_FILE:-/opt/eventform/infra/compose/state/last-activity}"
IDLE_MINUTES="${IDLE_MINUTES:-30}"
REGION="${AWS_REGION:-eu-central-1}"

log() { echo "[idle-check] $*"; }

if [ ! -f "$ACTIVITY_FILE" ]; then
  log "no activity file ($ACTIVITY_FILE) yet — not scaling down"
  exit 0
fi

last="$(tr -d '[:space:]' < "$ACTIVITY_FILE" 2>/dev/null || true)"
case "$last" in
  ""|*[!0-9]*) log "unreadable activity timestamp — not scaling down"; exit 0 ;;
esac

now="$(date +%s)"
idle=$(( now - last ))
threshold=$(( IDLE_MINUTES * 60 ))
if [ "$idle" -le "$threshold" ]; then
  log "active ${idle}s ago (threshold ${threshold}s) — staying up"
  exit 0
fi

# Resolve our own ASG via IMDSv2.
TOKEN="$(curl -sf -X PUT 'http://169.254.169.254/latest/api/token' \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
[ -n "$TOKEN" ] || { log "no IMDS token — not scaling down"; exit 0; }
IID="$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
  'http://169.254.169.254/latest/meta-data/instance-id' || true)"
[ -n "$IID" ] || { log "no instance-id — not scaling down"; exit 0; }

ASG="$(aws autoscaling describe-auto-scaling-instances --region "$REGION" \
  --instance-ids "$IID" \
  --query 'AutoScalingInstances[0].AutoScalingGroupName' --output text 2>/dev/null || true)"
case "$ASG" in
  ""|None) log "no ASG for $IID — not scaling down"; exit 0 ;;
esac

log "idle ${idle}s > ${threshold}s — scaling $ASG to 0"
aws autoscaling set-desired-capacity --region "$REGION" \
  --auto-scaling-group-name "$ASG" --desired-capacity 0
