#!/bin/sh
# Debezium Server wrapper entrypoint (prod / prod-local).
#
# Debezium's Postgres source wants discrete host/port/user/password/dbname, but
# the deployment carries one secret — DATABASE_URL (the Neon owner connection,
# DIRECT endpoint, sslmode=require). Parse it into the DEBEZIUM_SOURCE_DATABASE_*
# env vars the engine reads, then hand off to the image's normal launcher. The
# parsing stays inside the container, so the password never lands in a host log.
#
# Assumes a standard URL: postgres://user[:password]@host[:port]/db[?query]
# Neon passwords are alphanumeric (no URL-encoding); a custom password must avoid
# characters that break POSIX parameter expansion is not a concern here (no sed).
set -e

[ -n "$DATABASE_URL" ] || { echo "debezium-entrypoint: DATABASE_URL is required"; exit 1; }

u="${DATABASE_URL#*://}"          # user[:password]@host[:port]/db[?query]
creds="${u%%@*}"                  # user[:password]
hostdb="${u#*@}"                  # host[:port]/db[?query]
DB_USER="${creds%%:*}"
case "$creds" in *:*) DB_PASS="${creds#*:}";; *) DB_PASS="";; esac
hostport="${hostdb%%/*}"          # host[:port]
DB_HOST="${hostport%%:*}"
case "$hostport" in *:*) DB_PORT="${hostport#*:}";; *) DB_PORT="5432";; esac
dbq="${hostdb#*/}"                # db[?query]
DB_NAME="${dbq%%\?*}"             # db

export DEBEZIUM_SOURCE_DATABASE_HOSTNAME="$DB_HOST"
export DEBEZIUM_SOURCE_DATABASE_PORT="$DB_PORT"
export DEBEZIUM_SOURCE_DATABASE_USER="$DB_USER"
export DEBEZIUM_SOURCE_DATABASE_PASSWORD="$DB_PASS"
export DEBEZIUM_SOURCE_DATABASE_DBNAME="$DB_NAME"

echo "debezium-entrypoint: source = ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME} (sslmode=${DEBEZIUM_SOURCE_DATABASE_SSLMODE:-default})"

# Hand off to the image's launcher (cwd is /debezium per the image WORKDIR).
exec /debezium/run.sh
