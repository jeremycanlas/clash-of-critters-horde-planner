-- The list built once per group, and pages asking only for what changed. Run after 038.
--
-- 7 Oct: every open page asked for its whole list every 15 s, and each answer
-- was built for that one person, so the database's work grew with people x
-- list size x refreshes. Duneside's 3,641 banquets and a few dozen open tabs
-- (some left open overnight) filled the processor and half the requests failed.
--
-- Now:
--   banquet_feed     one row each time a banquet changes (a trigger on every
--                    table that shows on a card): which round, group and UID, when.
--   banquet_snap     each group's cards, built once and shared by everyone in the
--                    group, rebuilt at most every 30 s and only after a change.
--   banquet_state    the whole list, as before, now served from the snapshots
--                    with each person's own bits (claimed, mine_site) added.
--   banquet_changes  what changed since a moment the page holds: only those
--                    cards, built for those UIDs alone. A page asks this every
--                    few seconds and it costs a few rows.
--
-- A moment, not a counter: a change is stamped when it is written, which can be
-- before another, earlier-numbered one commits. So "since" reaches 30 s further
-- back than asked, and a card that comes twice is simply the same card again.

-- ---------------------------------------------------------------- the feed

create table if not exists public.banquet_feed (
  id    bigint generated always as identity primary key,
  round date not null,
  grp   smallint not null,
  uid   bigint not null,
  at    timestamptz not null default clock_timestamp()
);
create index if not exists banquet_feed_at on public.banquet_feed (round, grp, at);
alter table public.banquet_feed enable row level security;
revoke all on public.banquet_feed from anon, authenticated;

create or replace function public.banquet_feed_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare row_ record := coalesce(new, old);
begin
  -- Likes belong to a building, not a round: they change this round's card.
  if tg_table_name = 'banquet_likes' then
    insert into public.banquet_feed (round, grp, uid) values (public.banquet_round(), row_.grp, row_.uid);
  else
    insert into public.banquet_feed (round, grp, uid) values (row_.round, row_.grp, row_.uid);
  end if;
  return null;
end;
$$;
revoke all on function public.banquet_feed_note() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['banquet_uids', 'banquet_claims', 'banquet_marks', 'banquet_likes'] loop
    execute format('drop trigger if exists feed on public.%I', t);
    execute format('create trigger feed after insert or update or delete on public.%I for each row execute function public.banquet_feed_note()', t);
  end loop;
end $$;

-- 038's counter is replaced by the feed.
do $$
declare t text;
begin
  foreach t in array array['banquet_uids', 'banquet_claims', 'banquet_marks', 'banquet_events', 'banquet_likes', 'banquet_group_members'] loop
    execute format('drop trigger if exists bump on public.%I', t);
  end loop;
end $$;
drop function if exists public.banquet_bump();
drop sequence if exists public.banquet_version;

-- Two days is plenty: a page more than an hour behind loads the list again.
select cron.schedule('banquet-feed-trim', '17 * * * *', $$
  delete from public.banquet_feed where at < now() - interval '2 days'
$$);

-- ---------------------------------------------------------------- cards

-- Cards for groups `grps` in round r, in one pass per table; for `uids` only
-- when given. With `who`, each card says whether it is theirs to know about
-- (claimed, mine_site); without, it is the shared card a snapshot keeps.
create or replace function public.banquet_cards(r date, grps smallint[], uids bigint[] default null,
                                                with_grp boolean default false, who text default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with k as (
    select u.grp, u.uid, min(u.added_at) as posted, jsonb_agg(distinct u.by_name) as entered_by,
           bool_or(u.discord_id = who and u.source = 'site') as mine_site
      from public.banquet_uids u
     where u.round = r and u.grp = any (grps) and (uids is null or u.uid = any (uids))
     group by u.grp, u.uid),
  c as (
    select c.grp, c.uid, count(*) as n, jsonb_agg(c.by_name order by c.claimed_at) as by_names,
           bool_or(c.discord_id = who) as mine
      from public.banquet_claims c
     where c.round = r and c.grp = any (grps) and (uids is null or c.uid = any (uids))
     group by c.grp, c.uid),
  m as (select m.grp, m.uid, m.state, m.by_name, m.marked_at from public.banquet_marks m
         where m.round = r and m.grp = any (grps) and (uids is null or m.uid = any (uids))),
  lb as (select distinct on (l.grp, l.uid) l.grp, l.uid, l.likes, l.by_name, l.at from public.banquet_likes l
          where l.grp = any (grps) and (uids is null or l.uid = any (uids)) and l.at < public.banquet_opens(r)
          order by l.grp, l.uid, l.at desc),
  ln as (select distinct on (l.grp, l.uid) l.grp, l.uid, l.likes, l.by_name, l.at from public.banquet_likes l
          where l.grp = any (grps) and (uids is null or l.uid = any (uids))
            and l.at >= public.banquet_opens(r) and l.at < public.banquet_opens(r) + interval '6 days'
          order by l.grp, l.uid, l.at desc)
  select coalesce(jsonb_agg(jsonb_build_object(
           'uid', k.uid::text,
           'posted', k.posted,
           'entered_by', k.entered_by,
           'claims', coalesce(c.n, 0),
           'claimed_by', coalesce(c.by_names, '[]'),
           'full', case when m.state = 'full' then m.by_name end,
           'full_at', case when m.state = 'full' then m.marked_at end,
           'not_yet', case when m.state = 'not-yet' then jsonb_build_object('by', m.by_name, 'at', m.marked_at) end,
           'open', case when m.state = 'open' then jsonb_build_object('by', m.by_name, 'at', m.marked_at) end,
           'likes_before', case when lb.uid is not null then jsonb_build_object('n', lb.likes, 'by', lb.by_name, 'at', lb.at) end,
           'likes_now', case when ln.uid is not null then jsonb_build_object('n', ln.likes, 'by', ln.by_name, 'at', ln.at) end
         )
         || case when who is not null then jsonb_build_object('claimed', coalesce(c.mine, false), 'mine_site', coalesce(k.mine_site, false)) else '{}' end
         || case when with_grp then jsonb_build_object('grp', k.grp) else '{}' end), '[]')
    from k
    left join c on c.grp = k.grp and c.uid = k.uid
    left join m on m.grp = k.grp and m.uid = k.uid
    left join lb on lb.grp = k.grp and lb.uid = k.uid
    left join ln on ln.grp = k.grp and ln.uid = k.uid;
$$;
revoke all on function public.banquet_cards(date, smallint[], bigint[], boolean, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- snapshots

create table if not exists public.banquet_snap (
  round    date not null,
  grp      smallint not null,
  with_grp boolean not null,
  since    timestamptz not null,   -- built from the data as at this moment
  body     jsonb not null,
  primary key (round, grp, with_grp)
);
alter table public.banquet_snap enable row level security;
revoke all on public.banquet_snap from anon, authenticated;

-- One group's shared cards. Rebuilt only after a change, at most every 30 s,
-- and by one request at a time: the rest are handed the last one, and catch
-- up through banquet_changes from its `since`.
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
begin
  select * into s from public.banquet_snap x where x.round = r and x.grp = g and x.with_grp = banquet_snap_get.with_grp;
  if found and (s.since > start - interval '30 seconds'
                or not exists (select 1 from public.banquet_feed f where f.round = r and f.grp = g and f.at >= s.since - interval '30 seconds')
                or not pg_try_advisory_xact_lock(hashtext('banquet_snap'), hashtext(r::text || ':' || g || ':' || with_grp))) then
    return s;
  end if;
  s := (r, g, with_grp, start, public.banquet_cards(r, array[g], null, with_grp, null));
  insert into public.banquet_snap values (s.*)
  on conflict on constraint banquet_snap_pkey do update set since = excluded.since, body = excluded.body;
  return s;
end;
$$;
revoke all on function public.banquet_snap_get(date, smallint, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------- the whole list

-- As 037, with the cards from each group's snapshot, each person's own bits
-- added, and the moment the page should ask banquet_changes from.
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
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('uid', uid::text, 'source', source)
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
revoke all on function public.banquet_state_full(date) from public, anon, authenticated;

-- The activity log, as 031 had it inline: the newest 200 claims, marks and
-- posts; with `since`, only those from then on (a page adds them to its own).
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
          order by at desc limit 200) e;
$$;
revoke all on function public.banquet_events_for(date, smallint[], boolean, timestamptz) from public, anon, authenticated;

-- As 038, without the counter: the fingerprint is of the answer, which is now
-- cheap to build.
create or replace function public.banquet_state(r date default null, known text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  full_ jsonb := public.banquet_state_full(r);   -- refuses anyone not let in, before anything is noted
  hash  text;
  you   record;
  v     bigint;
begin
  select * into you from public.banquet_you();
  if not you.sees_all and public.banquet_covered((full_ ->> 'round')::date, you.groups[1]) then
    full_ := full_ || jsonb_build_object('covered', true);
  end if;
  -- The minute-by-minute last read and the moment to ask from are left out, or the list would never be the same twice.
  hash := md5((full_ - 'synced_at' - 'since')::text);
  v := public.banquet_visit(you.discord_id, you.display, you.groups, coalesce(r, public.banquet_round()));
  update public.banquet_access
     set last_at = now(), reads = reads + 1, groups = you.groups, display = you.display
   where id = v;
  if known = hash then
    return jsonb_build_object('same', true, 'hash', hash, 'since', full_ -> 'since', 'synced_at', full_ -> 'synced_at');
  end if;
  return full_ || jsonb_build_object('hash', hash);
end;
$$;

-- ---------------------------------------------------------------- what changed

-- Since `since` (a moment banquet_state or this gave): the cards that changed,
-- each as the whole card, and the UIDs gone from the list. Also the small
-- parts of the answer, whole: yours, shared, total, and the activity log when
-- anything moved. `reload` when the page is too far behind or the round turned.
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
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('uid', uid::text, 'source', source)
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
revoke all on function public.banquet_changes(timestamptz, date) from public, anon;
grant execute on function public.banquet_changes(timestamptz, date) to authenticated;

-- ---------------------------------------------------------------- the channel, without churn

-- As 018, replacing only what changed: deleting and re-adding every recent
-- post every 15 s would mark each of those banquets changed every 15 s.
create or replace function public.banquet_apply(r date, g smallint, msgs jsonb, since timestamptz default null)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  with n as (
    select distinct on (u, m -> 'author' ->> 'id') u as uid, m -> 'author' ->> 'id' as discord_id,
           coalesce(nullif(m -> 'author' ->> 'global_name', ''), m -> 'author' ->> 'username') as by_name,
           m ->> 'id' as message_id, (m ->> 'timestamp')::timestamptz as added_at
      from jsonb_array_elements(msgs) m, public.banquet_parse(m ->> 'content') u
     where coalesce((m -> 'author' ->> 'bot')::boolean, false) = false
       and (since is null or (m ->> 'timestamp')::timestamptz >= since)
     order by u, m -> 'author' ->> 'id', (m ->> 'timestamp')::timestamptz),
  gone as (
    delete from public.banquet_uids b
     where b.round = r and b.grp = g and b.source = 'discord' and (since is null or b.added_at >= since)
       and not exists (select 1 from n where n.uid = b.uid and n.discord_id = b.discord_id))
  insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source, message_id, added_at)
  select r, g, n.uid, n.discord_id, n.by_name, 'discord', n.message_id, n.added_at from n
  on conflict do nothing;
  select public.banquet_sweep(r, g);
$$;
revoke all on function public.banquet_apply(date, smallint, jsonb, timestamptz) from public, anon, authenticated;
