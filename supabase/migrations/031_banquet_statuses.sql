-- MVP banquets, four statuses and an activity log.
--
-- A banquet opens only once its MVP logs in after the reset, and then stays
-- open until 50 players anywhere in the game have claimed it. So each one is:
--   Claimable      someone saw the gift: a mark 'open', which does not expire
--   Not logged in  someone saw no icon: the mark 'not-yet', as before
--   Full           someone saw the portrait: the mark 'full', as before
--   Needs a look   no mark: posted, nobody has looked since
-- A claim is a gift seen, so it marks the banquet open unless it is full.
--
-- Each claim and mark is also kept as an event with its time, so the page can
-- show who did what and when, not only the latest state. Posts are read from
-- banquet_uids, which already says who posted what and when.

alter table public.banquet_marks drop constraint if exists banquet_marks_state_check;
alter table public.banquet_marks add constraint banquet_marks_state_check check (state in ('full', 'not-yet', 'open'));

create table if not exists public.banquet_events (
  id         bigint generated always as identity primary key,
  round      date not null,
  grp        smallint not null,
  uid        bigint not null,
  -- claim, unclaim, open, full, not-yet, clear (a mark taken off)
  kind       text not null check (kind in ('claim', 'unclaim', 'open', 'full', 'not-yet', 'clear')),
  discord_id text not null,
  by_name    text not null,
  at         timestamptz not null default clock_timestamp() -- not now(): two presses in one transaction keep their order
);
create index if not exists banquet_events_round on public.banquet_events (round, grp, at desc);
alter table public.banquet_events enable row level security;
revoke all on public.banquet_events from anon, authenticated;

create or replace function public.banquet_claim(target bigint, claimed boolean, g smallint default null)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  you record;
  r date := public.banquet_round();
  gg smallint;
  n int;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  gg := public.banquet_group_for(you.sees_all, you.groups, g);
  if not public.banquet_shared(you.sees_all, you.discord_id, r, gg) then raise exception 'Add four UIDs first.'; end if;
  if claimed then
    if not exists (select 1 from public.banquet_uids where round = r and grp = gg and uid = target) then
      raise exception 'That banquet is not in this round.';
    end if;
    insert into public.banquet_claims (round, grp, uid, discord_id, by_name)
    values (r, gg, target, you.discord_id, you.display)
    on conflict do nothing;
    get diagnostics n = row_count;
    -- Claimed means the gift was there: open, unless someone has seen it full.
    insert into public.banquet_marks (round, grp, uid, state, by_name)
    values (r, gg, target, 'open', you.display)
    on conflict (round, grp, uid) do update set state = 'open', by_name = excluded.by_name, marked_at = now()
      where banquet_marks.state = 'not-yet';
  else
    delete from public.banquet_claims where round = r and grp = gg and uid = target and discord_id = you.discord_id;
    get diagnostics n = row_count;
  end if;
  if n > 0 then
    insert into public.banquet_events (round, grp, uid, kind, discord_id, by_name)
    values (r, gg, target, case when claimed then 'claim' else 'unclaim' end, you.discord_id, you.display);
  end if;
end;
$$;

-- Full, not-yet or open, set by anyone in the group and cleared by anyone (null).
create or replace function public.banquet_mark(target bigint, state text, g smallint default null)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  you record;
  r date := public.banquet_round();
  gg smallint;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  gg := public.banquet_group_for(you.sees_all, you.groups, g);
  if not public.banquet_shared(you.sees_all, you.discord_id, r, gg) then raise exception 'Add four UIDs first.'; end if;
  if state is null then
    delete from public.banquet_marks m where m.round = r and m.grp = gg and m.uid = target;
    if found then
      insert into public.banquet_events (round, grp, uid, kind, discord_id, by_name)
      values (r, gg, target, 'clear', you.discord_id, you.display);
    end if;
    return;
  end if;
  if state not in ('full', 'not-yet', 'open') then raise exception 'Unknown state.'; end if;
  if not exists (select 1 from public.banquet_uids where round = r and grp = gg and uid = target) then
    raise exception 'That banquet is not in this round.';
  end if;
  insert into public.banquet_marks (round, grp, uid, state, by_name)
  values (r, gg, target, banquet_mark.state, you.display)
  on conflict (round, grp, uid) do update set state = excluded.state, by_name = excluded.by_name, marked_at = now();
  insert into public.banquet_events (round, grp, uid, kind, discord_id, by_name)
  values (r, gg, target, banquet_mark.state, you.discord_id, you.display);
end;
$$;

-- As 025, plus each banquet's open mark and when it was marked full, and the
-- round's activity: the last 200 claims, marks and posts, newest first.
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
                           where m.round = r and m.grp = k.grp and m.uid = k.uid and m.state = 'open')
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
