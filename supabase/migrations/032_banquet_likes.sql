-- MVP banquets: likes, so a portrait is not mistaken for full.
--
-- Each full banquet leaves 50 likes on its MVP's building, so 100 likes means
-- MVP twice before. After the reset the building keeps showing the portrait
-- until its MVP logs in, which reads as "full" to anyone who did not know it
-- was there already. So anyone can write down the likes a building shows, at
-- any time; the last count before a round's reset is that round's starting
-- point. A portrait on that same count: not logged in. Fifty more: full.
--
-- Kept per group and UID, not per round: a member's UIDs come back each gold
-- rush, so a count taken on this round's card is the next round's "before".

create table if not exists public.banquet_likes (
  id         bigint generated always as identity primary key,
  grp        smallint not null,
  uid        bigint not null,
  likes      int not null check (likes between 0 and 100000),
  discord_id text not null,
  by_name    text not null,
  at         timestamptz not null default clock_timestamp()
);
create index if not exists banquet_likes_uid on public.banquet_likes (grp, uid, at desc);
alter table public.banquet_likes enable row level security;
revoke all on public.banquet_likes from anon, authenticated;

-- When round r began: its reset, 00:00 UTC on the date it is named after.
create or replace function public.banquet_opens(r date)
returns timestamptz
language sql
immutable
as $$ select r::timestamp at time zone 'UTC' $$;

-- The likes on a building, as someone in the group saw them just now. Only for
-- a UID the group has posted in some round: the ones that come back.
create or replace function public.banquet_likes_set(target bigint, n int, g smallint default null)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  you record;
  gg smallint;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  gg := public.banquet_group_for(you.sees_all, you.groups, g);
  if n is null or n < 0 or n > 100000 then raise exception 'Likes is a number, 0 or more.'; end if;
  if not exists (select 1 from public.banquet_uids where grp = gg and uid = target) then
    raise exception 'That UID has not been posted here.';
  end if;
  insert into public.banquet_likes (grp, uid, likes, discord_id, by_name) values (gg, target, n, you.discord_id, you.display);
end;
$$;

-- As 031, plus each banquet's likes: the last count seen before the round's
-- reset, and the last seen since.
create or replace function public.banquet_state_full(r date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  you  record;
  now_ date := public.banquet_round();
  shared boolean;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  r := coalesce(r, now_);
  shared := public.banquet_shared(you.sees_all, you.discord_id, r, you.groups[1]);

  -- Built so a one-group member's answer has no group in it anywhere.
  return jsonb_build_object(
    'round', r,
    'current', now_,
    'rounds', (select coalesce(jsonb_agg(x order by x desc), '[]')
                 from (select distinct round as x from public.banquet_uids where grp = any (you.groups)
                       union select now_) t),
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('uid', uid::text, 'source', source)
                                       || case when you.sees_all then jsonb_build_object('grp', grp) else '{}' end
                                       order by added_at), '[]')
               from public.banquet_uids where round = r and grp = any (you.groups) and discord_id = you.discord_id),
    'shared', shared,
    'total', (select count(*) from (select distinct grp, uid from public.banquet_uids where round = r and grp = any (you.groups)) t),
    'banquets', case when r < now_ or shared then (
      select coalesce(jsonb_agg(b), '[]') from (
        select jsonb_build_object(
                 'uid', k.uid::text,
                 'posted', (select min(u.added_at) from public.banquet_uids u where u.round = r and u.grp = k.grp and u.uid = k.uid),
                 'entered_by', (select jsonb_agg(distinct u.by_name) from public.banquet_uids u where u.round = r and u.grp = k.grp and u.uid = k.uid),
                 'mine_site', exists (select 1 from public.banquet_uids u where u.round = r and u.grp = k.grp and u.uid = k.uid
                                        and u.discord_id = you.discord_id and u.source = 'site'),
                 'claims', (select count(*) from public.banquet_claims c where c.round = r and c.grp = k.grp and c.uid = k.uid),
                 'claimed_by', (select coalesce(jsonb_agg(c.by_name order by c.claimed_at), '[]') from public.banquet_claims c where c.round = r and c.grp = k.grp and c.uid = k.uid),
                 'claimed', exists (select 1 from public.banquet_claims c where c.round = r and c.grp = k.grp and c.uid = k.uid and c.discord_id = you.discord_id),
                 'full', (select m.by_name from public.banquet_marks m where m.round = r and m.grp = k.grp and m.uid = k.uid and m.state = 'full'),
                 'full_at', (select m.marked_at from public.banquet_marks m where m.round = r and m.grp = k.grp and m.uid = k.uid and m.state = 'full'),
                 'not_yet', (select jsonb_build_object('by', m.by_name, 'at', m.marked_at) from public.banquet_marks m
                              where m.round = r and m.grp = k.grp and m.uid = k.uid and m.state = 'not-yet'),
                 'open', (select jsonb_build_object('by', m.by_name, 'at', m.marked_at) from public.banquet_marks m
                           where m.round = r and m.grp = k.grp and m.uid = k.uid and m.state = 'open'),
                 'likes_before', (select jsonb_build_object('n', l.likes, 'by', l.by_name, 'at', l.at) from public.banquet_likes l
                                   where l.grp = k.grp and l.uid = k.uid and l.at < public.banquet_opens(r) order by l.at desc limit 1),
                 'likes_now', (select jsonb_build_object('n', l.likes, 'by', l.by_name, 'at', l.at) from public.banquet_likes l
                                where l.grp = k.grp and l.uid = k.uid and l.at >= public.banquet_opens(r)
                                  and l.at < public.banquet_opens(r) + interval '6 days' order by l.at desc limit 1)
               ) || case when you.sees_all then jsonb_build_object('grp', k.grp) else '{}' end as b
          from (select distinct grp, uid from public.banquet_uids where round = r and grp = any (you.groups)) k
      ) t)
    else '[]'::jsonb end,
    -- ponytail: the newest 200 only; a page of older ones when a round needs it.
    'events', case when r < now_ or shared then (
      select coalesce(jsonb_agg(jsonb_build_object('uid', e.uid::text, 'kind', e.kind, 'by', e.by_name, 'at', e.at)
                                || case when you.sees_all then jsonb_build_object('grp', e.grp) else '{}' end
                                order by e.at desc), '[]')
        from (select grp, uid, kind, by_name, at from public.banquet_events where round = r and grp = any (you.groups)
              union all
              select grp, uid, 'post', by_name, added_at from public.banquet_uids where round = r and grp = any (you.groups)
              order by at desc limit 200) e)
    else '[]'::jsonb end
  ) || jsonb_build_object('synced_at', (select min(g.synced_at) from public.banquet_groups g where g.grp = any (you.groups)))
    || case when you.sees_all then jsonb_build_object(
         'groups', to_jsonb(you.groups),
         -- What to call each, and which are private: never folded into Both groups.
         'names', (select jsonb_object_agg(g.grp, coalesce(g.name, 'Group ' || g.grp)) from public.banquet_groups g where g.grp = any (you.groups)),
         'private', (select coalesce(jsonb_agg(g.grp order by g.grp), '[]') from public.banquet_groups g where g.grp = any (you.groups) and g.private))
       else '{}' end;
end;
$$;

revoke all on function public.banquet_state_full(date) from public, anon, authenticated;
revoke all on function public.banquet_opens(date) from public, anon, authenticated;
revoke all on function public.banquet_likes_set(bigint, int, smallint) from public, anon;
grant execute on function public.banquet_likes_set(bigint, int, smallint) to authenticated;
