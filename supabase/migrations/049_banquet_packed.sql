-- The banquet list, packed, for pages that ask for it (13 Oct load test).
--
-- The free plan's server has about 400 MB for the database and the API
-- together, and a gold rush's list ran to 490 KB per member (MVPgoats, 7 Oct),
-- a viewer's to 1.1 MB. 400 people opening the page in the same minute put it
-- into swap and it stopped answering for over ten minutes, while the database
-- itself sat idle: the same 400 with the list left out of the reply had no
-- errors at all. So the list goes out packed, about a sixth of the size:
--
--   {"n": [names], "b": base, "w": with group, "o": with yours, "c": [cards]}
--   card: [uid, grp if w, flags if o (1 claimed, 2 yours from the site),
--          posted, [entered by], [claimed by] or 0, full [by, at] or 0,
--          not yet [by, at] or 0, open [by, at] or 0,
--          likes before [n, by, at] or 0, likes now [n, by, at] or 0]
--
-- with every name an index into "n", every time whole seconds after "b", and
-- trailing zeros left off. The claims count is the length of claimed by. The
-- page unpacks it into the same cards as before; a page that does not ask
-- (one opened before this) is sent them as before.

create or replace function public.banquet_pack(cards jsonb, base timestamptz, w boolean, o boolean)
returns jsonb
language sql
immutable
set search_path = public
as $$
  with x as (select e, i from jsonb_array_elements(cards) with ordinality t(e, i)),
  nm as (select coalesce(array_agg(n order by n), '{}') a from (
           select distinct n from x, lateral (
             select jsonb_array_elements_text(x.e -> 'entered_by') union all
             select jsonb_array_elements_text(x.e -> 'claimed_by') union all
             select x.e ->> 'full' union all select x.e -> 'not_yet' ->> 'by' union all
             select x.e -> 'open' ->> 'by' union all select x.e -> 'likes_before' ->> 'by' union all
             select x.e -> 'likes_now' ->> 'by') t(n)
            where n is not null) s),
  ix as (select coalesce(jsonb_object_agg(n, k - 1), '{}') m from nm, unnest(nm.a) with ordinality u(n, k)),
  b as (select floor(extract(epoch from base))::bigint b0),
  packed as (
    select x.i, (select to_jsonb(v[1:coalesce((select max(k) from unnest(v) with ordinality u(f, k) where f <> '0'), 1)])
                   from (select array_remove(array[
                     to_jsonb((x.e ->> 'uid')::bigint),
                     case when w then x.e -> 'grp' end,
                     case when o then to_jsonb(case when (x.e ->> 'claimed')::boolean then 1 else 0 end
                                               + case when (x.e ->> 'mine_site')::boolean then 2 else 0 end) end,
                     to_jsonb(floor(extract(epoch from (x.e ->> 'posted')::timestamptz))::bigint - b.b0),
                     coalesce((select jsonb_agg(ix.m -> n) from jsonb_array_elements_text(x.e -> 'entered_by') n), '[]'),
                     coalesce((select jsonb_agg(ix.m -> n) from jsonb_array_elements_text(x.e -> 'claimed_by') n), '0'),
                     case when x.e ->> 'full' is not null
                          then jsonb_build_array(ix.m -> (x.e ->> 'full'), floor(extract(epoch from (x.e ->> 'full_at')::timestamptz))::bigint - b.b0)
                          else '0' end,
                     case when jsonb_typeof(x.e -> 'not_yet') = 'object'
                          then jsonb_build_array(ix.m -> (x.e -> 'not_yet' ->> 'by'), floor(extract(epoch from (x.e -> 'not_yet' ->> 'at')::timestamptz))::bigint - b.b0)
                          else '0' end,
                     case when jsonb_typeof(x.e -> 'open') = 'object'
                          then jsonb_build_array(ix.m -> (x.e -> 'open' ->> 'by'), floor(extract(epoch from (x.e -> 'open' ->> 'at')::timestamptz))::bigint - b.b0)
                          else '0' end,
                     case when jsonb_typeof(x.e -> 'likes_before') = 'object'
                          then jsonb_build_array(x.e -> 'likes_before' -> 'n', ix.m -> (x.e -> 'likes_before' ->> 'by'),
                                                 floor(extract(epoch from (x.e -> 'likes_before' ->> 'at')::timestamptz))::bigint - b.b0)
                          else '0' end,
                     case when jsonb_typeof(x.e -> 'likes_now') = 'object'
                          then jsonb_build_array(x.e -> 'likes_now' -> 'n', ix.m -> (x.e -> 'likes_now' ->> 'by'),
                                                 floor(extract(epoch from (x.e -> 'likes_now' ->> 'at')::timestamptz))::bigint - b.b0)
                          else '0' end], null) v) t) c
      from x, ix, b)
  select jsonb_build_object('n', to_jsonb(nm.a), 'b', b.b0, 'w', w, 'o', o,
                            'c', coalesce((select jsonb_agg(c order by i) from packed), '[]'))
    from nm, b;
$$;
revoke all on function public.banquet_pack(jsonb, timestamptz, boolean, boolean) from public, anon, authenticated;

-- Each group's snapshot keeps its packed copy, built with it (at most every
-- 30 s): packing the whole list takes about 0.15 s, too much for every opening.
-- A snapshot from before this has none, and is rebuilt on its next ask.
alter table public.banquet_snap add column if not exists packed jsonb;

create or replace function public.banquet_snap_get(r date, g smallint, with_grp boolean)
returns public.banquet_snap
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  s     public.banquet_snap;
  start timestamptz := clock_timestamp();
  body_ jsonb;
begin
  select * into s from public.banquet_snap x where x.round = r and x.grp = g and x.with_grp = banquet_snap_get.with_grp;
  if found and s.packed is not null
     and (s.since > start - interval '30 seconds'
          or not exists (select 1 from public.banquet_feed f where f.round = r and f.grp = g and f.at >= s.since - interval '30 seconds')
          or not pg_try_advisory_xact_lock(hashtext('banquet_snap'), hashtext(r::text || ':' || g || ':' || with_grp))) then
    return s;
  end if;
  body_ := public.banquet_cards(r, array[g], null, with_grp, null);
  s := (r, g, with_grp, start, body_, public.banquet_pack(body_, (r - 10)::timestamp at time zone 'UTC', with_grp, false));
  insert into public.banquet_snap values (s.*)
  on conflict on constraint banquet_snap_pkey do update set since = excluded.since, body = excluded.body, packed = excluded.packed;
  return s;
end;
$$;

-- The full list and what changed, packed when the page asks (packed => true).
drop function if exists public.banquet_state(date, text);
drop function if exists public.banquet_state_full(date);
drop function if exists public.banquet_changes(timestamptz, date);

create or replace function public.banquet_state_full(r date default null, packed boolean default false)
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
  packs  jsonb := '[]';
  base   timestamptz;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  r := coalesce(r, now_);
  base := (r - 10)::timestamp at time zone 'UTC';
  shared := public.banquet_shared(you.sees_all, you.discord_id, r, you.groups[1]);

  if shared then
    foreach g in array you.groups loop
      s := public.banquet_snap_get(r, g, you.sees_all);
      -- What changed since the snapshot was built comes fresh after it, so a full
      -- load is never behind; the page keeps the later of a card sent twice.
      moved_ := array(select distinct f.uid from public.banquet_feed f
                       where f.round = r and f.grp = g and f.at >= s.since - interval '30 seconds');
      if packed then
        -- The snapshot's own packed copy, built once with it; the few moved since, packed here.
        packs := packs || jsonb_build_array(coalesce(s.packed, public.banquet_pack(s.body, base, you.sees_all, false)))
          || case when cardinality(moved_) > 0
                  then jsonb_build_array(public.banquet_pack(public.banquet_cards(r, array[g], moved_, you.sees_all), base, you.sees_all, false))
                  else '[]' end;
      else
        cards := cards || s.body
          || case when cardinality(moved_) > 0 then public.banquet_cards(r, array[g], moved_, you.sees_all) else '[]' end;
      end if;
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
    'packed', case when packed then packs end,
    'gone', gone_,
    'my_claims', claimed_,
    'my_site', site_,
    'events', case when shared then public.banquet_events_for(r, you.groups, you.sees_all) else '[]'::jsonb end
  ) || jsonb_build_object('synced_at', (select min(g2.synced_at) from public.banquet_groups g2 where g2.grp = any (you.groups)))
    || case when you.sees_all then jsonb_build_object(
         'groups', to_jsonb(you.groups),
         'names', (select jsonb_object_agg(g2.grp, coalesce(g2.name, 'Group ' || g2.grp)) from public.banquet_groups g2 where g2.grp = any (you.groups)),
         'private', (select coalesce(jsonb_agg(g2.grp order by g2.grp), '[]') from public.banquet_groups g2 where g2.grp = any (you.groups) and g2.private))
       else '{}' end;
end;
$$;
revoke all on function public.banquet_state_full(date, boolean) from public, anon, authenticated;

create or replace function public.banquet_state(r date default null, known text default null, packed boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  full_ jsonb := public.banquet_state_full(r, packed);   -- refuses anyone not let in, before anything is noted
  you   record;
  v     bigint;
begin
  perform set_config('synchronous_commit', 'off', true);   -- the access log only, as banquet_changes
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
revoke all on function public.banquet_state(date, text, boolean) from public, anon;
grant execute on function public.banquet_state(date, text, boolean) to authenticated;

create or replace function public.banquet_changes(since timestamptz, r date default null, packed boolean default false)
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
  -- Only the access log is written here: it need not wait for the disk (claims and marks still do).
  perform set_config('synchronous_commit', 'off', true);
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
    -- How many there are only matters while the list is closed to you ("add N more").
    'total', case when shared then null else (select count(*) from (select distinct grp, uid from public.banquet_uids where round = rr and grp = any (you.groups)) t) end,
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('uid', uid::text, 'source', source,
                                         'likes', (select l.likes from public.banquet_likes l where l.grp = banquet_uids.grp and l.uid = banquet_uids.uid order by l.at desc limit 1))
                                       || case when you.sees_all then jsonb_build_object('grp', grp) else '{}' end
                                       order by added_at), '[]')
               from public.banquet_uids where round = rr and grp = any (you.groups) and discord_id = you.discord_id),
    'cards', case when moved.uids is not null and shared and not packed
                  then public.banquet_cards(rr, you.groups, moved.uids, you.sees_all, you.discord_id) else '[]'::jsonb end,
    'packed', case when packed then jsonb_build_array(public.banquet_pack(
                  case when moved.uids is not null and shared
                       then public.banquet_cards(rr, you.groups, moved.uids, you.sees_all, you.discord_id) else '[]'::jsonb end,
                  (rr - 10)::timestamp at time zone 'UTC', you.sees_all, true)) end,
    'gone', case when shared then moved.gone else '[]'::jsonb end,
    -- Only the newer lines: the whole log is 19 kB and a page asks every 10 s.
    'events_new', case when moved.uids is not null and shared
                       then public.banquet_events_for(rr, you.groups, you.sees_all, since - interval '30 seconds') end,
    'synced_at', (select min(g.synced_at) from public.banquet_groups g where g.grp = any (you.groups)),
    -- How often to ask, in seconds: slower as more pages are open, so a crowd
    -- spreads its asking out rather than swamping the server (600 in the 13 Oct test).
    -- ponytail: counts this server's pages only; both servers share one machine.
    'every', (select case when n > 500 then 20 when n > 250 then 15 else 10 end
                from (select count(*) as n from public.banquet_access a where a.last_at > now() - interval '1 minute') t)
  ) || case when not you.sees_all and public.banquet_covered(rr, you.groups[1]) then jsonb_build_object('covered', true) else '{}' end
    -- The groups, for someone who sees them: a new Discord role turns up without a reload.
    || case when you.sees_all then jsonb_build_object(
         'groups', to_jsonb(you.groups),
         'names', (select jsonb_object_agg(g.grp, coalesce(g.name, 'Group ' || g.grp)) from public.banquet_groups g where g.grp = any (you.groups)),
         'private', (select coalesce(jsonb_agg(g.grp order by g.grp), '[]') from public.banquet_groups g where g.grp = any (you.groups) and g.private))
       else '{}' end;
end;
$$;
revoke all on function public.banquet_changes(timestamptz, date, boolean) from public, anon;
grant execute on function public.banquet_changes(timestamptz, date, boolean) to authenticated;

-- The activity log on opening: the page shows 50 lines, and was sent 200
-- (19 kB of each opening). Later lines still come with what changed.
create or replace function public.banquet_events_for(r date, grps smallint[], with_grp boolean, since timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('uid', e.uid::text, 'kind', e.kind, 'by', e.by_name, 'at', e.at)
                            || case when with_grp then jsonb_build_object('grp', e.grp) else '{}' end
                            order by e.at desc), '[]')
    from (select grp, uid, kind, by_name, at from public.banquet_events
           where round = r and grp = any (grps) and (since is null or at >= since)
          union all
          select grp, uid, 'post', by_name, added_at from public.banquet_uids
           where round = r and grp = any (grps) and (since is null or added_at >= since)
          order by at desc limit case when since is null then 60 else 200 end) e;
$$;

notify pgrst, 'reload schema';
