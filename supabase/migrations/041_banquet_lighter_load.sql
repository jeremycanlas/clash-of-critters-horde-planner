-- A lighter full load (the load test on 8 Oct: 34 ms to build, 25 ms more to
-- fingerprint, per person, 114-242 ms under load). Run after 040.
--
--   The group's shared snapshot goes out as it is. It was unpacked and every
--   card rebuilt per person to add "claimed" and "mine_site"; those go as two
--   short lists the page marks on the cards itself. Cards moved since the
--   snapshot come fresh after it, with `gone` for those since removed.
--   No fingerprint: the page asks what changed every 10 s and loads the whole
--   list only on opening, hourly, or when told to, so "same as before" saved
--   little, and hashing 0.4 MB every time cost almost as much as building it.

-- A card's key as the page writes it: the UID, and the group for someone who sees several.
create or replace function public.banquet_key(g smallint, u bigint, with_grp boolean)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object('uid', u::text) || case when with_grp then jsonb_build_object('grp', g) else '{}' end;
$$;
revoke all on function public.banquet_key(smallint, bigint, boolean) from public, anon, authenticated;

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
  moved_ bigint[];
  gone_  jsonb := '[]';
  claimed_ jsonb := '[]';
  site_  jsonb := '[]';
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  r := coalesce(r, now_);
  shared := public.banquet_shared(you.sees_all, you.discord_id, r, you.groups[1]);

  if r < now_ or shared then
    foreach g in array you.groups loop
      s := public.banquet_snap_get(r, g, you.sees_all);
      -- What changed since the snapshot was built comes fresh after it, so a full
      -- load is never behind; the page keeps the later of a card sent twice.
      moved_ := array(select distinct f.uid from public.banquet_feed f
                       where f.round = r and f.grp = g and f.at >= s.since - interval '30 seconds');
      cards := cards || s.body
        || case when cardinality(moved_) > 0 then public.banquet_cards(r, array[g], moved_, you.sees_all) else '[]' end;
      gone_ := gone_ || (select coalesce(jsonb_agg(public.banquet_key(g, x, you.sees_all)), '[]') from unnest(moved_) x
                          where not exists (select 1 from public.banquet_uids u where u.round = r and u.grp = g and u.uid = x));
      -- Yours, apart: the page marks them on the cards, rather than every card rebuilt here per person.
      claimed_ := claimed_ || (select coalesce(jsonb_agg(public.banquet_key(g, x.uid, you.sees_all)), '[]') from public.banquet_claims x
                                where x.round = r and x.grp = g and x.discord_id = you.discord_id);
      site_ := site_ || (select coalesce(jsonb_agg(public.banquet_key(g, x.uid, you.sees_all)), '[]') from public.banquet_uids x
                          where x.round = r and x.grp = g and x.discord_id = you.discord_id and x.source = 'site');
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
    'gone', gone_,
    'my_claims', claimed_,
    'my_site', site_,
    'events', case when r < now_ or shared then public.banquet_events_for(r, you.groups, you.sees_all) else '[]'::jsonb end
  ) || jsonb_build_object('synced_at', (select min(g2.synced_at) from public.banquet_groups g2 where g2.grp = any (you.groups)))
    || case when you.sees_all then jsonb_build_object(
         'groups', to_jsonb(you.groups),
         'names', (select jsonb_object_agg(g2.grp, coalesce(g2.name, 'Group ' || g2.grp)) from public.banquet_groups g2 where g2.grp = any (you.groups)),
         'private', (select coalesce(jsonb_agg(g2.grp order by g2.grp), '[]') from public.banquet_groups g2 where g2.grp = any (you.groups) and g2.private))
       else '{}' end;
end;
$$;

-- `known` is still taken, so a page open since before this keeps working; it is ignored.
create or replace function public.banquet_state(r date default null, known text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  full_ jsonb := public.banquet_state_full(r);   -- refuses anyone not let in, before anything is noted
  you   record;
  v     bigint;
begin
  select * into you from public.banquet_you();
  if not you.sees_all and public.banquet_covered((full_ ->> 'round')::date, you.groups[1]) then
    full_ := full_ || jsonb_build_object('covered', true);
  end if;
  v := public.banquet_visit(you.discord_id, you.display, you.groups, coalesce(r, public.banquet_round()));
  update public.banquet_access
     set last_at = now(), reads = reads + 1, groups = you.groups, display = you.display
   where id = v;
  return full_;
end;
$$;
