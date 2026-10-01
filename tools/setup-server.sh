#!/bin/sh
# Sets up another Discord server's banquets, in a schema of its own in the
# same database.  sh tools/setup-server.sh tide
#
# The schema is the banquet migrations (013 onwards) with every banquet name in
# them moved into it: tables, functions, scheduled jobs, the bot token's name in
# Vault. Its functions name nothing of the first server's, which public keeps,
# and the script refuses to apply a copy that does. The one thing both share is
# public.tracker_caller(): who you are on Discord, read from the sign-in.
#
# Everything comes from .env (see .env.example), so no password or bot token is
# typed anywhere a transcript keeps it. In order:
#
#   1. the schema, the first time only; later, any migration files named after
#      the schema: sh tools/setup-server.sh tide supabase/migrations/029_x.sql
#   2. supabase/banquet_check.sql, moved the same way: proves the rules in the
#      new schema, then rolls back
#   3. the server's Discord settings: server, role, channel, viewers (Discord
#      user IDs), and
#      the bot token into Vault. Skipped while they are not in .env; run again
#      once they are
#
# Then, once, in the dashboard: Project Settings -> Data API -> Exposed schemas,
# add the schema, or the page gets "not finished being set up yet".
set -eu
cd "$(dirname "$0")/.."
. ./.env
s=${1:?which server schema, e.g. tide}
shift
case $s in *[!a-z]*|public) echo "a schema name is lower-case letters, not public" >&2; exit 1 ;; esac
up=$(echo "$s" | tr a-z A-Z)

eval "guild=\${BANQUET_${up}_GUILD:-}" "role=\${BANQUET_${up}_ROLE:-}" "channel=\${BANQUET_${up}_CHANNEL:-}"
eval "viewers=\${BANQUET_${up}_VIEWERS:-}" "token=\${BANQUET_${up}_BOT_TOKEN:-}"
q() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q "$@"; }

# A file with its \i lines filled in (banquet_check.sql loads the migrations
# itself), less any Windows line endings, which would end up in the file names.
expand() {
  tr -d '\r' < "$1" | while IFS= read -r line || [ -n "$line" ]; do
    case $line in '\i '*) expand "${line#\\i }" ;; *) printf '%s\n' "$line" ;; esac
  done
}
# That file, moved into the schema.
moved() {
  expand "$1" | sed \
    -e "s/public\.banquet_/$s.banquet_/g" \
    -e "s/search_path = public/search_path = $s, public/g" \
    -e "s/'banquet-/'$s-banquet-/g" \
    -e "s/'banquet_bot_token'/'${s}_banquet_bot_token'/g" \
    -e "s/'public'/'$s'/g" \
    -e "s/'public\.' ||/'$s.' ||/g" \
    -e "s/public\.%I/$s.%I/g"
}

# The wall, checked before anything runs: nothing of public's but who you are.
guard() {
  left=$(grep -oE "public\.[a-z_%]+|'public'" "$1" | grep -v '^public\.tracker_caller$' || true)
  if [ -n "$left" ]; then echo "refusing: the $s copy still names public: $left" >&2; exit 1; fi
}

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if [ $# -gt 0 ]; then
  files="$*"
elif [ "$(q -tAc "select to_regclass('$s.banquet_access') is not null")" = t ]; then
  files=""; echo "schema $s: already there"
else
  files=$(ls supabase/migrations/0*_banquet*.sql)
  { echo "create schema if not exists $s;"; echo "grant usage on schema $s to anon, authenticated;"; } > "$tmp/0.sql"
  q -f "$tmp/0.sql"
fi
for f in $files; do
  moved "$f" > "$tmp/m.sql"; guard "$tmp/m.sql"
  echo "$s: $f"; q -f "$tmp/m.sql"
done

moved supabase/banquet_check.sql > "$tmp/check.sql"; guard "$tmp/check.sql"
q -f "$tmp/check.sql"

# Without them the schema is still built; the page says "not set up yet" until a rerun with them.
if [ -z "$guild" ] || [ -z "$role" ] || [ -z "$channel" ] || [ -z "$token" ]; then
  echo "settings: skipped, BANQUET_${up}_GUILD, _ROLE, _CHANNEL and _BOT_TOKEN are not all in .env yet"
  exit 0
fi
q -v guild="$guild" -v role="$role" -v channel="$channel" -v viewers="$viewers" -v token="$token" -v name="${s}_banquet_bot_token" <<SQL
update $s.banquet_settings set guild_id = :'guild', viewer_ids = coalesce(string_to_array(nullif(:'viewers', ''), ','), '{}');
insert into $s.banquet_groups (grp, role_id, channel_id) values (1, :'role', :'channel')
  on conflict (grp) do update set role_id = excluded.role_id, channel_id = excluded.channel_id;
select vault.update_secret(id, :'token') from vault.secrets where name = :'name';
select vault.create_secret(:'token', :'name') where not exists (select 1 from vault.secrets where name = :'name');
SQL
echo "settings: saved. First read of the channel: $(q -tAc "select $s.banquet_sync()")"
