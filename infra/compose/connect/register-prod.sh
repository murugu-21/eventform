#!/bin/sh
# Registers the Debezium outbox connector against Neon. Parses the owner
# connection (DATABASE_URL — DIRECT endpoint, sslmode=require) into the
# connector's discrete host/port/user/password/dbname fields and substitutes
# them into the connector template, then PUTs it via the Connect REST API.
#
# Parsing assumes a standard URL: postgres://user:password@host[:port]/db?query
# Neon-generated passwords are alphanumeric (no URL-encoding, no sed-special
# chars), so this is safe; if you set a custom password, avoid | & \ / characters.
set -e

[ -n "$DATABASE_URL" ] || { echo "register-prod: DATABASE_URL is required"; exit 1; }

u="${DATABASE_URL#*://}"          # user:password@host[:port]/db?query
creds="${u%%@*}"                  # user:password
hostdb="${u#*@}"                  # host[:port]/db?query
DB_USER="${creds%%:*}"
DB_PASS="${creds#*:}"
hostport="${hostdb%%/*}"          # host[:port]
DB_HOST="${hostport%%:*}"
case "$hostport" in *:*) DB_PORT="${hostport#*:}";; *) DB_PORT="5432";; esac
dbq="${hostdb#*/}"                # db?query
DB_NAME="${dbq%%\?*}"             # db

CONFIG=$(sed \
  -e "s|__DB_HOST__|$DB_HOST|g" \
  -e "s|__DB_PORT__|$DB_PORT|g" \
  -e "s|__DB_USER__|$DB_USER|g" \
  -e "s|__DB_PASSWORD__|$DB_PASS|g" \
  -e "s|__DB_NAME__|$DB_NAME|g" \
  /connector/eventform-outbox-prod.json)

# Retry until Connect accepts the connector (it may still be warming up).
i=0
until curl -fsS -X PUT -H "Content-Type: application/json" \
  --data "$CONFIG" \
  http://connect:8083/connectors/eventform-outbox/config >/dev/null; do
  i=$((i + 1)); [ "$i" -ge 30 ] && { echo "register-prod: gave up after 30 tries"; exit 1; }
  echo "register-prod: connect not ready, retrying ($i)..."; sleep 3
done
echo "register-prod: Debezium connector registered against Neon"
