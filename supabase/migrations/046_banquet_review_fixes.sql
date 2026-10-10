-- Fixes from the 10 Oct review, and the gold rush schedule. Run after 045.
--
-- 1. The round no longer has to be edited by hand. Each gold rush is a row in
--    banquet_schedule: its reset day and when the site switches to it (two
--    days before the reset, as Duneside did, so UIDs can be added ahead). A
--    viewer sets the next one on the banquet page. Until one is set, the round
--    stays where it is, as before.
-- 2. A past round's list follows the four-UID rule too. It was open to the
--    whole group, so someone who added nothing could read the last gold rush's
--    banquets while they were still claimable.
-- 3. What changed (every 10 s per open page) no longer recounts the round's
--    UIDs once your list is open: the count only says "add N more".
-- 4. A move between groups (from the next gold rush, 045) tells the old group's
--    pages and clears its claims and marks on the cards it lost.
-- 5. Undo on a mark puts back the mark as it was, under the name of whoever
--    set it, rather than setting it again under yours; and the undone press
--    leaves the activity log and the leaderboards.
-- 6. The leaderboards' round picker always has the current gold rush.

create table if not exists public.banquet_schedule (
  round     date primary key,            -- the reset day, 00:00 UTC
  switch_at timestamptz not null         -- when the site starts taking UIDs for it
);
alter table public.banquet_schedule enable row level security;
revoke all on public.banquet_schedule from anon, authenticated;
insert into public.banquet_schedule (round, switch_at) values ('2026-10-07', '2026-10-05 00:00+00') on conflict do nothing;

-- The latest gold rush the site has switched to; before the first one in the
-- table, the 6-day cycle the site started with (013).
create or replace function public.banquet_round(at timestamptz default now())
returns date
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select max(s.round) from public.banquet_schedule s where s.switch_at <= at),
    ((timestamptz '2026-09-30 08:00+08'
      + floor(extract(epoch from at - timestamptz '2026-09-30 08:00+08') / 518400) * interval '6 days')
     at time zone 'Asia/Manila')::date);
$$;

-- The next gold rush, if one is set: for the countdown everyone sees.
create or replace function public.banquet_next()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select jsonb_build_object('round', s.round, 'switch_at', s.switch_at)
                     from public.banquet_schedule s where s.switch_at > now() order by s.switch_at limit 1),
                  'null'::jsonb);
$$;
revoke all on function public.banquet_next() from public, anon;
grant execute on function public.banquet_next() to authenticated;

-- A viewer sets (or, with remove, takes back) the next gold rush's reset day.
-- The site switches to it two days before, at 00:00 UTC.
create or replace function public.banquet_schedule_set(r date, remove boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare you record;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if not you.sees_all then raise exception 'Only those who see every group can set the gold rush.'; end if;
  if remove then
    delete from public.banquet_schedule s where s.round = r and s.switch_at > now();
  else
    if r <= public.banquet_round() then raise exception 'That gold rush has already started.'; end if;
    if public.banquet_opens(r) - interval '2 days' <= now() then raise exception 'Too soon: the site switches two days before the reset.'; end if;
    insert into public.banquet_schedule (round, switch_at) values (r, public.banquet_opens(r) - interval '2 days')
    on conflict (round) do update set switch_at = excluded.switch_at;
  end if;
  return public.banquet_next();
end;
$$;
revoke all on function public.banquet_schedule_set(date, boolean) from public, anon;
grant execute on function public.banquet_schedule_set(date, boolean) to authenticated;

-- Undo of your own mark, within 10 minutes and while nobody has marked it since:
-- your press leaves the log, and the mark is again what it was before it.
create or replace function public.banquet_mark_undo(target bigint, g smallint default null)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  you  record;
  r    date := public.banquet_round();
  gg   smallint;
  last public.banquet_events;
  prev public.banquet_events;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  gg := public.banquet_group_for(you.sees_all, you.groups, g);
  select * into last from public.banquet_events e
   where e.round = r and e.grp = gg and e.uid = target and e.kind in ('open', 'full', 'not-yet', 'clear')
   order by e.at desc, e.id desc limit 1;
  if last.id is null or last.discord_id <> you.discord_id or last.at < now() - interval '10 minutes' then
    raise exception 'Someone has marked it since. Mark it again instead.';
  end if;
  select * into prev from public.banquet_events e
   where e.round = r and e.grp = gg and e.uid = target and e.kind in ('open', 'full', 'not-yet', 'clear')
     and (e.at, e.id) < (last.at, last.id)
   order by e.at desc, e.id desc limit 1;
  delete from public.banquet_events where id = last.id;
  if prev.id is null or prev.kind = 'clear' then
    delete from public.banquet_marks m where m.round = r and m.grp = gg and m.uid = target;
  else
    insert into public.banquet_marks (round, grp, uid, state, by_name, discord_id, marked_at)
    values (r, gg, target, prev.kind, prev.by_name, prev.discord_id, prev.at)
    on conflict (round, grp, uid) do update
      set state = excluded.state, by_name = excluded.by_name, discord_id = excluded.discord_id, marked_at = excluded.marked_at;
  end if;
end;
$$;
revoke all on function public.banquet_mark_undo(bigint, smallint) from public, anon;
grant execute on function public.banquet_mark_undo(bigint, smallint) to authenticated;

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

  if shared then
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
    'events', case when shared then public.banquet_events_for(r, you.groups, you.sees_all) else '[]'::jsonb end
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
    -- How many there are only matters while the list is closed to you ("add N more").
    'total', case when shared then null else (select count(*) from (select distinct grp, uid from public.banquet_uids where round = rr and grp = any (you.groups)) t) end,
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('uid', uid::text, 'source', source,
                                         'likes', (select l.likes from public.banquet_likes l where l.grp = banquet_uids.grp and l.uid = banquet_uids.uid order by l.at desc limit 1))
                                       || case when you.sees_all then jsonb_build_object('grp', grp) else '{}' end
                                       order by added_at), '[]')
               from public.banquet_uids where round = rr and grp = any (you.groups) and discord_id = you.discord_id),
    'cards', case when moved.uids is not null and shared
                  then public.banquet_cards(rr, you.groups, moved.uids, you.sees_all, you.discord_id) else '[]'::jsonb end,
    'gone', case when shared then moved.gone else '[]'::jsonb end,
    -- Only the newer lines: the whole log is 19 kB and a page asks every 10 s.
    'events_new', case when moved.uids is not null and shared
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

create or replace function public.banquet_follow(who text, grps smallint[], r date default public.banquet_round())
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  target smallint;
  n      int;
  olds   smallint[];
  og     smallint;
begin
  select g into target from unnest(grps) g
   where not exists (select 1 from public.banquet_groups x where x.grp = g and x.private) limit 1;
  if target is null then return 0; end if;
  -- ponytail: Duneside by date; a setting if this ever needs to be chosen per round.
  if r <= '2026-10-07' then
    insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source, added_at)
    select u.round, target, u.uid, u.discord_id, u.by_name, u.source, u.added_at
      from public.banquet_uids u
     where u.round = r and u.discord_id = who and u.source = 'site' and not (u.grp = any (grps))
       and not exists (select 1 from public.banquet_groups x where x.grp = u.grp and x.private)
    on conflict do nothing;
    get diagnostics n = row_count;
    return n;
  end if;
  -- A move is a delete and an insert rather than an update, so the change feed
  -- tells both groups' open pages (an update names only the new group); then the
  -- old group's claims and marks on cards it no longer has are cleared.
  with moved as (
    delete from public.banquet_uids u
     where u.round = r and u.discord_id = who and u.source = 'site' and not (u.grp = any (grps))
       and not exists (select 1 from public.banquet_groups x where x.grp = u.grp and x.private)
    returning u.*),
  put as (
    insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source, added_at)
    select m.round, target, m.uid, m.discord_id, m.by_name, m.source, m.added_at from moved m
    on conflict do nothing)
  select count(*), array_agg(distinct moved.grp) into n, olds from moved;
  foreach og in array coalesce(olds, '{}') loop perform public.banquet_sweep(r, og); end loop;
  return n;
end;
$$;

create or replace function public.banquet_leaders(r date default null, all_time boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  you   record;
  rr    date;
  key_  date;
  g     smallint;
  c     public.banquet_leaders_cache;
  out_  jsonb := '[]';
  boards jsonb;
  board text;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  rr := case when all_time then null else coalesce(r, public.banquet_round()) end;
  key_ := coalesce(rr, '0001-01-01');

  -- Private lists have no leaderboard.
  foreach g in array array(select x from unnest(you.groups) x
                            where not exists (select 1 from public.banquet_groups gg where gg.grp = x and gg.private) order by x) loop
    select * into c from public.banquet_leaders_cache x where x.round = key_ and x.grp = g;
    -- Built by one request at a time: the rest take the last build, however old.
    if (c.built_at is null or c.built_at < now() - interval '5 minutes')
       and (c.built_at is null or pg_try_advisory_xact_lock(hashtext('banquet_leaders'), g)) then
      insert into public.banquet_leaders_cache (round, grp, body, built_at)
      values (key_, g, public.banquet_leaders_build(rr, g), now())
      on conflict (round, grp) do update set body = excluded.body, built_at = excluded.built_at
      returning * into c;
    end if;

    -- Ten names and your own place: no Discord ids out.
    boards := '{}';
    foreach board in array array['scout', 'responder', 'sharer', 'likes'] loop
      boards := boards || jsonb_build_object(board, jsonb_build_object(
        'people', coalesce((c.body -> board ->> 'people')::int, 0),
        'you', c.body -> board -> 'ranks' -> you.discord_id,
        'top', (select coalesce(jsonb_agg((x - 'id') || jsonb_build_object('you', x ->> 'id' = you.discord_id) order by i), '[]')
                  from jsonb_array_elements(coalesce(c.body -> board -> 'top', '[]')) with ordinality t(x, i))));
    end loop;

    out_ := out_ || jsonb_build_array(jsonb_build_object(
      'name', (select coalesce(gg.name, 'Group ' || gg.grp) from public.banquet_groups gg where gg.grp = g),
      'boards', boards, 'built_at', c.built_at)
      || case when you.sees_all then jsonb_build_object('grp', g) else '{}' end);
  end loop;

  return jsonb_build_object(
    'round', rr,
    'current', public.banquet_round(),
    'rounds', (select coalesce(jsonb_agg(x order by x desc), '[]')
                 from (select distinct round as x from public.banquet_uids where grp = any (you.groups)
                       union select public.banquet_round()) t),
    'groups', out_);
end;
$$;
