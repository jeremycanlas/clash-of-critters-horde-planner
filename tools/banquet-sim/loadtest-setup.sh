#!/bin/sh
# Builds the banquet tables and functions on a throwaway Supabase project for
# tools/banquet-sim/loadtest.mjs, up to a given migration, with Duneside-sized
# fake data. NEVER point it at a real server: it adds loadtest-identity.sql.
#
#   LOADTEST_DB_URL=postgresql://... sh tools/banquet-sim/loadtest-setup.sh 35 1200   # "before", 1,200 members
#   LOADTEST_DB_URL=postgresql://... sh tools/banquet-sim/loadtest-setup.sh 40 --upgrade   # then the code since
set -eu
cd "$(dirname "$0")/../.."
: "${LOADTEST_DB_URL:?set LOADTEST_DB_URL to the test project, never the live one}"
case $LOADTEST_DB_URL in *bjcumuhpblevbiqzzmli*) echo "refusing: that is the live project" >&2; exit 1 ;; esac
last=$1; users=${2:-1200}
q() { psql "$LOADTEST_DB_URL" -v ON_ERROR_STOP=1 -q "$@"; }
expand() {
  tr -d '\r' < "$1" | while IFS= read -r line || [ -n "$line" ]; do
    case $line in '\i '*) expand "${line#\i }" ;; *) printf '%s\n' "$line" ;; esac
  done
}
from=13
if [ "$users" = --upgrade ]; then from=$(q -At -c "select coalesce(max(n), 12) + 1 from loadtest_applied"); else
  q -c "create extension if not exists pg_cron" -c "create table if not exists loadtest_applied (n int)"
fi
q -f tools/banquet-sim/loadtest-identity.sql   # the migrations call tracker_caller()
for f in $(grep -o 'supabase/migrations/0[0-9]*_[a-z_]*\.sql' supabase/banquet_check.sql); do
  n=$(basename "$f" | cut -c1-3 | sed 's/^0*//')
  [ "$n" -ge "$from" ] && [ "$n" -le "$last" ] || continue
  echo "migration $n"; expand "$f" | q >/dev/null
  q -c "insert into loadtest_applied values ($n)"
done
q -f tools/banquet-sim/loadtest-identity.sql
[ "$users" = --upgrade ] || q -v users="$users" -f tools/banquet-sim/seed.sql >/dev/null
# The channel reader is not wanted here: no Discord, and it would only add noise.
q -At -c "select cron.unschedule(jobid) from cron.job where jobname like '%banquet-sync%'" >/dev/null
q -At -c "select 'ready: ' || count(*) || ' UIDs, ' || (select count(*) from public.banquet_members) || ' members' from public.banquet_uids"
