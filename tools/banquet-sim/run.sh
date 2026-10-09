#!/bin/sh
# A simulated rush on the banquet database, locally: how many people a version
# of the database code holds before requests start queueing.
#
#   sh tools/banquet-sim/run.sh
#
# Two databases on the local Postgres of tools/local-db.sh, each loaded with a
# Duneside-sized list (seed.sql): "before" has the migrations as they were at
# 7:20 on 7 Oct (up to 035), "after" all of them. Each page is a stream of the
# requests a real one makes, sent through 10 connections as the live API has:
#
#   before   the whole list (banquet_state) every 15 s per open tab
#   after    what changed (banquet_changes) every 10 s, the whole list every 15 min
#
# and claims and marks going on all the while. For each number of people, the
# rate is what that many open tabs would ask, and the result is how long each
# request took and whether the database kept up (pgbench's "lag" is time spent
# queueing). This computer is faster than the live database's shared 2-core
# processor, so read the numbers for where each version breaks, relative to the
# other, more than as live timings.
set -eu
cd "$(dirname "$0")/../.."
BIN="${PG_BIN:-/c/Program Files/PostgreSQL/18/bin}"
PORT="${PG_LOCAL_PORT:-5499}"
SECS="${SIM_SECS:-30}"
sh tools/local-db.sh tools/banquet-sim/empty.sql >/dev/null   # starts the server
q() { "$BIN/psql" -h localhost -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

expand() {
  tr -d '\r' < "$1" | while IFS= read -r line || [ -n "$line" ]; do
    case $line in '\i '*) expand "${line#\\i }" ;; 'create extension'*) ;; *) printf '%s\n' "$line" ;; esac
  done
}
build() { # name, last migration
  q -d postgres -c "drop database if exists $1" -c "create database $1"
  q -d "$1" -f supabase/local_stub.sql
  for f in $(grep -o 'supabase/migrations/0[0-9]*_[a-z_]*\.sql' supabase/banquet_check.sql); do
    n=$(basename "$f" | cut -c1-3 | sed 's/^0*//')
    [ "$n" -le "$2" ] || continue
    expand "$f" | q -d "$1" >/dev/null
  done
  q -d "$1" -f tools/banquet-sim/seed.sql >/dev/null
}
build sim_before 35
build sim_after 39

W=tools/banquet-sim
bench() { # db, rate per second, scripts...
  db=$1; rate=$2; shift 2
  "$BIN/pgbench" -h localhost -p "$PORT" -U postgres -n -c 10 -j 4 -T "$SECS" -R "$rate" "$@" "$db" 2>&1 |
    awk '/^latency average/ {lat=$4} /^rate limit schedule lag/ {lag=$6} /^tps/ {tps=$3}
         END {printf "%8.1f ms each %9.1f ms queueing %7.1f/s done", lat, lag, tps}'
}
printf '%-8s %6s  %-58s %s\n' people "req/s" before after
for people in ${SIM_PEOPLE:-80 200 400 800 1600 3200}; do
  before_rate=$(awk "BEGIN {print $people * 4 / 60}")
  after_rate=$(awk "BEGIN {print $people * 6 / 60}")
  # Past where "before" fell over there is nothing more to learn from it.
  if [ "${stop_before:-}" ]; then b="(fell behind at $stop_before)"; else
    b=$(bench sim_before "$before_rate" -f $W/state.pgb@100 -f $W/write.pgb@2)
    done_=$(echo "$b" | awk '{print $(NF-1)}' | tr -d '/s'); awk "BEGIN {exit !($done_ < $before_rate * 0.9)}" && stop_before=$people
  fi
  a=$(bench sim_after "$after_rate" -f $W/changes.pgb@90 -f $W/state.pgb@1 -f $W/write.pgb@2)
  printf '%-8s %6s  %-58s %s\n' "$people" "$before_rate/$after_rate" "$b" "$a"
done
