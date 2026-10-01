#!/bin/sh
# Sets up another Discord server's banquet database, a Supabase project of its
# own.  sh tools/setup-server.sh TIDE
#
# Everything comes from .env (see .env.example), so no password or bot token is
# typed anywhere a transcript keeps it. In order:
#
#   1. every migration, oldest first, the first time only: the same schema and
#      rules as the first server, from the same files
#   2. supabase/banquet_check.sql, which proves the rules and rolls back
#   3. this server's Discord settings: server, role, channel, viewer roles, and
#      the bot token into Vault
#
# Safe to run again: step 1 is skipped once the tables are there, and step 3
# overwrites the settings with what .env says now.
set -eu
cd "$(dirname "$0")/.."
. ./.env
n=${1:?which server, e.g. TIDE}

eval "db=\${SUPABASE_DB_URL_$n:?SUPABASE_DB_URL_$n is not in .env}"
eval "guild=\${BANQUET_${n}_GUILD:?}" "role=\${BANQUET_${n}_ROLE:?}" "channel=\${BANQUET_${n}_CHANNEL:?}"
eval "viewers=\${BANQUET_${n}_VIEWERS:-}" "token=\${BANQUET_${n}_BOT_TOKEN:?}"
q() { psql "$db" -v ON_ERROR_STOP=1 -q "$@"; }

if [ "$(q -tAc "select to_regclass('public.banquet_access') is not null")" = t ]; then
  echo "migrations: already there"
else
  for f in supabase/migrations/0*.sql; do echo "migration: $f"; q -f "$f"; done
fi

q -f supabase/banquet_check.sql

q -v guild="$guild" -v role="$role" -v channel="$channel" -v viewers="$viewers" -v token="$token" <<'SQL'
update public.banquet_settings set guild_id = :'guild', viewer_roles = coalesce(string_to_array(nullif(:'viewers', ''), ','), '{}');
insert into public.banquet_groups (grp, role_id, channel_id) values (1, :'role', :'channel')
  on conflict (grp) do update set role_id = excluded.role_id, channel_id = excluded.channel_id;
select vault.update_secret(id, :'token') from vault.secrets where name = 'banquet_bot_token';
select vault.create_secret(:'token', 'banquet_bot_token')
 where not exists (select 1 from vault.secrets where name = 'banquet_bot_token');
SQL
echo "settings: saved. The channel is read within 15 seconds: $(q -tAc "select public.banquet_sync()")"
