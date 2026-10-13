# The gold rush's UID lists as CSV, one file per group and server: a copy to
# work from (or put in Google Sheets) if the site or the database is down.
#
#   sh tools/banquet-dump.sh            # into E:/caches/banquet-dumps/<time>/
#
# Read-only. Needs SUPABASE_DB_URL in .env. Names only, no Discord ids.
set -e
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
U=$(echo "$SUPABASE_DB_URL" | sed 's/:5432\//:6543\//')
OUT=E:/caches/banquet-dumps/$(date +%Y-%m-%d_%H%M)
mkdir -p "$OUT"

for s in public:MVP tide:YCT; do
  schema=${s%%:*}; server=${s#*:}
  for row in $(psql "$U" -X -At -F: -c "select grp, coalesce(nullif(name, ''), 'Group ' || grp) from $schema.banquet_groups order by grp" | tr -d '\r' | tr ' ' '_'); do
    g=${row%%:*}; name=${row#*:}
    psql "$U" -X -q -c "copy (
      with r as (select $schema.banquet_round() as r)
      select u.uid, string_agg(distinct u.by_name, ', ') as posted_by, min(u.added_at)::timestamp(0) as first_posted_utc,
             m.state as status, m.by_name as status_by, m.marked_at::timestamp(0) as status_at_utc,
             (select string_agg(c.by_name, ', ' order by c.claimed_at) from $schema.banquet_claims c
               where c.round = r.r and c.grp = $g and c.uid = u.uid) as claimed_by,
             (select l.likes from $schema.banquet_likes l where l.grp = $g and l.uid = u.uid order by l.at desc limit 1) as last_likes
        from r join $schema.banquet_uids u on u.round = r.r and u.grp = $g
        left join $schema.banquet_marks m on m.round = r.r and m.grp = $g and m.uid = u.uid
       group by r.r, u.uid, m.state, m.by_name, m.marked_at
       order by min(u.added_at)) to stdout csv header" > "$OUT/${server}_${name}.csv"
  done
done
wc -l "$OUT"/*.csv
