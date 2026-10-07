-- Your own UIDs carry their building's newest likes count. Run after 039.
--
-- A covered group (033) sees no cards until the reset, so its members had no
-- way to note the likes on their own MVPs' buildings beforehand, which is when
-- that count matters (032: a portrait after the reset is read against it).
-- The page now has Likes on each of your own UIDs; this sends the count with them.

create or replace function public.banquet_state_full(r date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  you    record;
  now_   date := public.banquet_round();
  shared boolean;
  cards  jsonb := '[]';
  since_ timestamptz := clock_timestamp();
  g      smallint;
  s      public.banquet_snap;
  claimed_ bigint[];
  site_  bigint[];
  moved_ bigint[];
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  r := coalesce(r, now_);
  shared := public.banquet_shared(you.sees_all, you.discord_id, r, you.groups[1]);

  if r < now_ or shared then
    foreach g in array you.groups loop
      s := public.banquet_snap_get(r, g, you.sees_all);
      -- What changed since the snapshot was built comes fresh, so a full load is
      -- never behind; it is a handful of cards, however big the group.
      moved_ := array(select distinct f.uid from public.banquet_feed f
                       where f.round = r and f.grp = g and f.at >= s.since - interval '30 seconds');
      -- Your own bits, fetched once per group rather than looked up per card.
      claimed_ := array(select x.uid from public.banquet_claims x where x.round = r and x.grp = g and x.discord_id = you.discord_id);
      site_ := array(select x.uid from public.banquet_uids x where x.round = r and x.grp = g and x.discord_id = you.discord_id and x.source = 'site');
      cards := cards || (
        select coalesce(jsonb_agg(c || jsonb_build_object(
                 'claimed', (c ->> 'uid')::bigint = any (claimed_),
                 'mine_site', (c ->> 'uid')::bigint = any (site_))), '[]')
          from jsonb_array_elements(s.body) c
         where not ((c ->> 'uid')::bigint = any (moved_)))
        || case when cardinality(moved_) > 0 then public.banquet_cards(r, array[g], moved_, you.sees_all, you.discord_id) else '[]' end;
    end loop;
  end if;

  return jsonb_build_object(
    'round', r,
    'current', now_,
    'since', since_,
    'rounds', (select coalesce(jsonb_agg(x order by x desc), '[]')
                 from (select distinct round as x from public.banquet_uids where grp = any (you.groups)
                       union select now_) t),
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('uid', uid::text, 'source', source,
                                         'likes', (select l.likes from public.banquet_likes l where l.grp = banquet_uids.grp and l.uid = banquet_uids.uid order by l.at desc limit 1))
                                       || case when you.sees_all then jsonb_build_object('grp', grp) else '{}' end
                                       order by added_at), '[]')
               from public.banquet_uids where round = r and grp = any (you.groups) and discord_id = you.discord_id),
    'shared', shared,
    'total', (select count(*) from (select distinct grp, uid from public.banquet_uids where round = r and grp = any (you.groups)) t),
    'banquets', cards,
    'events', case when r < now_ or shared then public.banquet_events_for(r, you.groups, you.sees_all) else '[]'::jsonb end
  ) || jsonb_build_object('synced_at', (select min(g2.synced_at) from public.banquet_groups g2 where g2.grp = any (you.groups)))
    || case when you.sees_all then jsonb_build_object(
         'groups', to_jsonb(you.groups),
         'names', (select jsonb_object_agg(g2.grp, coalesce(g2.name, 'Group ' || g2.grp)) from public.banquet_groups g2 where g2.grp = any (you.groups)),
         'private', (select coalesce(jsonb_agg(g2.grp order by g2.grp), '[]') from public.banquet_groups g2 where g2.grp = any (you.groups) and g2.private))
       else '{}' end;
end;
$$;

create or replace function public.banquet_changes(since timestamptz, r date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  you    record;
  now_   date := public.banquet_round();
  rr     date;
  cursor_ timestamptz := clock_timestamp();
  shared boolean;
  moved  record;
  v      bigint;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  rr := coalesce(r, now_);
  v := public.banquet_visit(you.discord_id, you.display, you.groups, rr);
  update public.banquet_access set last_at = now(), reads = reads + 1, groups = you.groups, display = you.display where id = v;

  if since is null or since < cursor_ - interval '1 hour' then
    return jsonb_build_object('reload', true);
  end if;
  shared := public.banquet_shared(you.sees_all, you.discord_id, rr, you.groups[1]);

  select array_agg(distinct f.uid) as uids,
         coalesce(jsonb_agg(distinct jsonb_build_object('uid', f.uid::text) || case when you.sees_all then jsonb_build_object('grp', f.grp) else '{}' end)
                  filter (where not exists (select 1 from public.banquet_uids u where u.round = rr and u.grp = f.grp and u.uid = f.uid)), '[]') as gone
    into moved
    from public.banquet_feed f
   where f.round = rr and f.grp = any (you.groups) and f.at >= since - interval '30 seconds';

  return jsonb_build_object(
    'since', cursor_,
    'round', rr,
    'current', now_,
    'shared', shared,
    'total', (select count(*) from (select distinct grp, uid from public.banquet_uids where round = rr and grp = any (you.groups)) t),
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('uid', uid::text, 'source', source,
                                         'likes', (select l.likes from public.banquet_likes l where l.grp = banquet_uids.grp and l.uid = banquet_uids.uid order by l.at desc limit 1))
                                       || case when you.sees_all then jsonb_build_object('grp', grp) else '{}' end
                                       order by added_at), '[]')
               from public.banquet_uids where round = rr and grp = any (you.groups) and discord_id = you.discord_id),
    'cards', case when moved.uids is not null and (rr < now_ or shared)
                  then public.banquet_cards(rr, you.groups, moved.uids, you.sees_all, you.discord_id) else '[]'::jsonb end,
    'gone', case when rr < now_ or shared then moved.gone else '[]'::jsonb end,
    -- Only the newer lines: the whole log is 19 kB and a page asks every 10 s.
    'events_new', case when moved.uids is not null and (rr < now_ or shared)
                       then public.banquet_events_for(rr, you.groups, you.sees_all, since - interval '30 seconds') end,
    'synced_at', (select min(g.synced_at) from public.banquet_groups g where g.grp = any (you.groups))
  ) || case when not you.sees_all and public.banquet_covered(rr, you.groups[1]) then jsonb_build_object('covered', true) else '{}' end
    -- The groups, for someone who sees them: a new Discord role turns up without a reload.
    || case when you.sees_all then jsonb_build_object(
         'groups', to_jsonb(you.groups),
         'names', (select jsonb_object_agg(g.grp, coalesce(g.name, 'Group ' || g.grp)) from public.banquet_groups g where g.grp = any (you.groups)),
         'private', (select coalesce(jsonb_agg(g.grp order by g.grp), '[]') from public.banquet_groups g where g.grp = any (you.groups) and g.private))
       else '{}' end;
end;
$$;

revoke all on function public.banquet_state_full(date) from public, anon, authenticated;
revoke all on function public.banquet_changes(timestamptz, date) from public, anon;
grant execute on function public.banquet_changes(timestamptz, date) to authenticated;
