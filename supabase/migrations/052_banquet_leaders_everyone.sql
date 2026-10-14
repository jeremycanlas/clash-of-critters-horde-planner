-- Every name on every board, not the top ten. The build is unchanged otherwise,
-- and still runs at most once every 5 minutes per group (banquet_leaders).

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
  -- A round's notes: from 6 days after the last reset to 6 days after its own.
  rounds as (select round, lag(round) over (order by round) as prev from (select distinct round from public.banquet_uids) x),
  likes as (select distinct on (r.round, l.uid) l.discord_id
              from rounds r
              join public.banquet_likes l on l.grp = g and l.at < public.banquet_opens(r.round) + interval '6 days'
                                         and (r.prev is null or l.at >= public.banquet_opens(r.prev) + interval '6 days')
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
                 jsonb_agg(jsonb_build_object('id', discord_id, 'name', name, 'n', n, 'rank', rk) order by rn) as top,
                 jsonb_object_agg(discord_id, jsonb_build_object('rank', rk, 'n', n)) as ranks
            from ranked group by board) b;
$$;
revoke all on function public.banquet_leaders_build(date, smallint) from public, anon, authenticated;

delete from public.banquet_leaders_cache;

notify pgrst, 'reload schema';
