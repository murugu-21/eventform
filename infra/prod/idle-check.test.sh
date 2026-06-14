#!/bin/sh
# Tests idle-check.sh decision logic with stubbed `aws`/`curl` on PATH, so it
# never touches real AWS. A stub `aws set-desired-capacity` creates a marker
# file; we assert the marker exists ONLY when the box should scale down.
#   Run: sh infra/prod/idle-check.test.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/idle-check.sh"
pass=0
fail=0

run_case() {
  name="$1"     # case label
  content="$2"  # what to write into the activity file, or "MISSING"
  expect="$3"   # yes = should scale down, no = should not

  tmp="$(mktemp -d)"
  bin="$tmp/bin"
  mkdir -p "$bin"
  marker="$tmp/scaled-down"

  # Stub curl: IMDSv2 token + instance-id.
  cat > "$bin/curl" <<EOF
#!/bin/sh
case "\$*" in
  *api/token*)    echo "fake-token" ;;
  *instance-id*)  echo "i-0test" ;;
  *)              echo "" ;;
esac
EOF

  # Stub aws: describe → ASG name; set-desired-capacity → touch the marker.
  cat > "$bin/aws" <<EOF
#!/bin/sh
case "\$*" in
  *describe-auto-scaling-instances*) echo "asg-test" ;;
  *set-desired-capacity*)            touch "$marker" ;;
esac
EOF
  chmod +x "$bin/curl" "$bin/aws"

  af="$tmp/last-activity"
  [ "$content" = "MISSING" ] || printf '%s\n' "$content" > "$af"

  ACTIVITY_FILE="$af" IDLE_MINUTES=30 AWS_REGION=eu-central-1 PATH="$bin:$PATH" \
    sh "$SCRIPT" >/dev/null 2>&1 || true

  got="no"
  [ -f "$marker" ] && got="yes"
  if [ "$got" = "$expect" ]; then
    echo "ok   - $name"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (scaled=$got, expected=$expect)"
    fail=$((fail + 1))
  fi
  rm -rf "$tmp"
}

now="$(date +%s)"
run_case "idle 40 min -> scales down"               "$(( now - 2400 ))" yes
run_case "active 5 min ago -> stays up"             "$(( now - 300 ))"  no
run_case "29 min (just under threshold) -> stays up" "$(( now - 1740 ))" no
run_case "missing activity file -> stays up"        "MISSING"           no
run_case "garbage content -> stays up"              "not-a-number"      no
run_case "empty content -> stays up"                ""                  no

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
