#!/bin/sh
# A throwaway local Postgres for the banquet database code, so checks and load
# simulations never run against the live database.
#
#   sh tools/local-db.sh                 start it and run supabase/banquet_check.sql
#   sh tools/local-db.sh some.sql        start it and run that file instead
#
# The cluster lives on E: (E:/caches/pg-banquet, port 5499, no password, local
# only) and is made the first time. Each run starts from an empty database,
# loads supabase/local_stub.sql (stand-ins for Supabase's sign-in tables,
# scheduled jobs, secrets and web calls), then the file, with its \i lines
# filled in and the extension installs the stand-ins replace left out.
set -eu
cd "$(dirname "$0")/.."
BIN="${PG_BIN:-/c/Program Files/PostgreSQL/18/bin}"
DATA="${PG_LOCAL_DATA:-E:/caches/pg-banquet}"
PORT="${PG_LOCAL_PORT:-5499}"

[ -d "$DATA" ] || "$BIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=C >/dev/null
"$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1 ||
  "$BIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=localhost" -l "$DATA/log.txt" -w start >/dev/null

q() { "$BIN/psql" -h localhost -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c "drop database if exists banquet" -c "create database banquet"

expand() {
  tr -d '\r' < "$1" | while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      '\i '*) expand "${line#\\i }" ;;
      'create extension'*) ;;
      *) printf '%s\n' "$line" ;;
    esac
  done
}
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
expand "${1:-supabase/banquet_check.sql}" > "$tmp"
q -d banquet -f supabase/local_stub.sql
q -d banquet -f "$tmp"
