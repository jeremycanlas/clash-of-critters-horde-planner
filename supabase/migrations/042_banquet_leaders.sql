-- Leaderboards (banquet-leaders.html). Run after 041.
--
-- Four boards, per group, for one gold rush or all of them, rewarding the work
-- that helps everyone rather than taking:
--   scout      UIDs you were the first to check (open, full or not logged in)
--   responder  UIDs you were the first to mark open in the hour after the reset
--   sharer     UIDs you posted first that someone else then claimed from
--   likes      buildings you were the first to note the likes of before the reset
-- Each UID counts once. A mark the same person changes or takes back within 5
-- minutes (Undo, a misclick) does not count. Names and counts only: no UIDs, no
-- Discord ids leave the database, so a covered group can see it too.
--
-- Load: a group's boards are built at most once every 5 minutes, by one request
-- at a time (the rest are handed the last build), so a rush of people opening
-- the page costs about what one does.

create table if not exists public.banquet_leaders_cache (
  round    date not null,              -- '0001-01-01' for all time
  grp      smallint not null,
  -- {board: {people, top: [{id, name, n, rank}] (10), ranks: {discord_id: {rank, n}}}}:
  -- everything a request needs, worked out once per build.
  body     jsonb not null,
  built_at timestamptz not null default now(),
  primary key (round, grp)
);
alter table public.banquet_leaders_cache enable row level security;
revoke all on public.banquet_leaders_cache from anon, authenticated;

create index if not exists banquet_events_leaders on public.banquet_events (grp, round, uid, discord_id, at);

-- One group's four boards, for round rr (null: every round), ranked.
create or replace function public.banquet_leaders_build(rr date, g smallint)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select e.round, e.uid, e.kind, e.discord_id, e.at,
           lead(e.at) over (partition by e.round, e.uid, e.discord_id order by e.at, e.id) as next_at
      from public.banquet_events e
     where e.grp = g and (rr is null or e.round = rr) and e.kind in ('open', 'full', 'not-yet', 'clear')),
  -- A check that stood: not changed or taken back by the same person within 5 minutes.
  ok as (select * from ev where kind <> 'clear' and (next_at is null or next_at > at + interval '5 minutes')),
  scout as (select distinct on (round, uid) discord_id from ok order by round, uid, at),
  responder as (select distinct on (round, uid) discord_id from ok
                 where kind = 'open' and at >= public.banquet_opens(round) and at < public.banquet_opens(round) + interval '1 hour'
                 order by round, uid, at),
  posts as (select distinct on (round, uid) round, uid, discord_id from public.banquet_uids
             where grp = g and (rr is null or round = rr) order by round, uid, added_at),
  sharer as (select p.discord_id from posts p
              where exists (select 1 from public.banquet_claims c
                             where c.round = p.round and c.grp = g and c.uid = p.uid and c.discord_id <> p.discord_id)),
  -- Before a round's reset: from the reset before it.
  rounds as (select round, lag(round) over (order by round) as prev from (select distinct round from public.banquet_uids) x),
  likes as (select distinct on (r.round, l.uid) l.discord_id
              from rounds r
              join public.banquet_likes l on l.grp = g and l.at < public.banquet_opens(r.round)
                                         and (r.prev is null or l.at >= public.banquet_opens(r.prev))
             where rr is null or r.round = rr
             order by r.round, l.uid, l.at),
  credit as (select 'scout' as board, discord_id from scout
             union all select 'responder', discord_id from responder
             union all select 'sharer', discord_id from sharer
             union all select 'likes', discord_id from likes),
  counted as (select board, discord_id, count(*) as n from credit group by board, discord_id),
  ranked as (select c.board, c.discord_id, c.n,
                    rank() over (partition by c.board order by c.n desc) as rk,
                    row_number() over (partition by c.board order by c.n desc, c.discord_id) as rn,
                    coalesce(m.display,
                      (select u.by_name from public.banquet_uids u where u.discord_id = c.discord_id limit 1),
                      (select e.by_name from public.banquet_events e where e.discord_id = c.discord_id limit 1),
                      'Someone') as name
               from counted c left join public.banquet_members m on m.discord_id = c.discord_id)
  select coalesce(jsonb_object_agg(board, jsonb_build_object('people', people, 'top', top, 'ranks', ranks)), '{}')
    from (select board, count(*) as people,
                 jsonb_agg(jsonb_build_object('id', discord_id, 'name', name, 'n', n, 'rank', rk) order by rn) filter (where rn <= 10) as top,
                 jsonb_object_agg(discord_id, jsonb_build_object('rank', rk, 'n', n)) as ranks
            from ranked group by board) b;
$$;
revoke all on function public.banquet_leaders_build(date, smallint) from public, anon, authenticated;

-- Your groups' boards: the top 10 of each, and where you stand.
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

  foreach g in array you.groups loop
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
                 from (select distinct round as x from public.banquet_uids where grp = any (you.groups)) t),
    'groups', out_);
end;
$$;
revoke all on function public.banquet_leaders(date, boolean) from public, anon;
grant execute on function public.banquet_leaders(date, boolean) to authenticated;
