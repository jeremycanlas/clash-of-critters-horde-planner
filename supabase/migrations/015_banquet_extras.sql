-- Three changes to the banquets. Run after 014.
--
-- 1. A UID is eight digits, exactly. NOT VALID: rows saved before the rule
--    stay, every new one is checked.
-- 2. Extras: a member who has shared their four can add single UIDs, a
--    banquet they heard about. Everyone sees them like any other.
-- 3. A banquet nobody lists any more loses its claims and marks. Editing a
--    slot from one UID to another, or removing an extra, would otherwise leave
--    them behind, to come back if the old UID was ever entered again. A UID
--    another member still lists keeps its marks.

alter table public.banquet_mvps drop constraint if exists banquet_mvps_uid_check;
alter table public.banquet_mvps drop constraint if exists banquet_mvps_eight_digits;
alter table public.banquet_mvps
  add constraint banquet_mvps_eight_digits check (uid between 10000000 and 99999999) not valid;

create table if not exists public.banquet_extras (
  round      date not null,
  uid        bigint not null check (uid between 10000000 and 99999999),
  discord_id text not null,
  by_name    text not null,
  added_at   timestamptz not null default now(),
  primary key (round, uid, discord_id)
);
alter table public.banquet_extras enable row level security;
revoke all on public.banquet_extras from anon, authenticated;

-- Every UID in a round, whoever entered it and how.
create or replace function public.banquet_listed(r date)
returns table (uid bigint, color smallint, by_name text)
language sql
stable
security definer
set search_path = public
as $$
  select uid, color, by_name from public.banquet_mvps where round = r
  union all
  select uid, null, by_name from public.banquet_extras where round = r;
$$;

-- Drops claims and marks on UIDs nobody in the round lists any more.
create or replace function public.banquet_sweep(r date)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.banquet_claims c where c.round = r and c.uid not in (select uid from public.banquet_listed(r));
  delete from public.banquet_full f where f.round = r and f.uid not in (select uid from public.banquet_listed(r));
$$;

create or replace function public.banquet_save_mvps(uids bigint[])
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  me  text := public.banquet_me();
  r   date := public.banquet_round();
  who text := (select display from public.tracker_caller());
begin
  if me is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if cardinality(uids) <> 4 then raise exception 'Four MVPs, one per colour.'; end if;
  if exists (select 1 from unnest(uids) u where u is not null and u not between 10000000 and 99999999) then
    raise exception 'A UID is 8 digits.';
  end if;
  if (select count(u) <> count(distinct u) from unnest(uids) u) then
    raise exception 'The same UID is in two colours.';
  end if;

  delete from public.banquet_mvps where round = r and discord_id = me;
  insert into public.banquet_mvps (round, discord_id, color, uid, by_name)
  select r, me, i, uids[i], who from generate_series(1, 4) i where uids[i] is not null;
  perform public.banquet_sweep(r);
end;
$$;

create or replace function public.banquet_extra(target bigint, added boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  me text := public.banquet_me();
  r  date := public.banquet_round();
begin
  if me is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if not public.banquet_shared(me, r) then raise exception 'Enter your four MVPs first.'; end if;
  if added then
    if target not between 10000000 and 99999999 then raise exception 'A UID is 8 digits.'; end if;
    insert into public.banquet_extras (round, uid, discord_id, by_name)
    values (r, target, me, (select display from public.tracker_caller()))
    on conflict do nothing;
  else
    delete from public.banquet_extras where round = r and uid = target and discord_id = me;
    perform public.banquet_sweep(r);
  end if;
end;
$$;

-- Claim and mark: a banquet is anything listed, extras included.
create or replace function public.banquet_claim(target bigint, claimed boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  me text := public.banquet_me();
  r  date := public.banquet_round();
begin
  if me is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if not public.banquet_shared(me, r) then raise exception 'Enter your four MVPs first.'; end if;
  if claimed then
    if not exists (select 1 from public.banquet_listed(r) l where l.uid = target) then
      raise exception 'That banquet is not in this round.';
    end if;
    insert into public.banquet_claims (round, uid, discord_id, by_name)
    values (r, target, me, (select display from public.tracker_caller()))
    on conflict do nothing;
  else
    delete from public.banquet_claims where round = r and uid = target and discord_id = me;
  end if;
end;
$$;

create or replace function public.banquet_mark(target bigint, state text)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  me text := public.banquet_me();
  r  date := public.banquet_round();
begin
  if me is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if not public.banquet_shared(me, r) then raise exception 'Enter your four MVPs first.'; end if;
  if state is null then
    delete from public.banquet_full f where f.round = r and f.uid = target;
    return;
  end if;
  if state not in ('full', 'not-yet') then raise exception 'Unknown state.'; end if;
  if not exists (select 1 from public.banquet_listed(r) l where l.uid = target) then
    raise exception 'That banquet is not in this round.';
  end if;
  insert into public.banquet_full (round, uid, by_name, state)
  values (r, target, (select display from public.tracker_caller()), banquet_mark.state)
  on conflict (round, uid) do update set by_name = excluded.by_name, state = excluded.state, marked_at = now();
end;
$$;

create or replace function public.banquet_state(r date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  me   text := public.banquet_me();
  now_ date := public.banquet_round();
  shared boolean;
begin
  if me is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  r := coalesce(r, now_);
  shared := public.banquet_shared(me, r);

  return jsonb_build_object(
    'round', r,
    'current', now_,
    'rounds', (select coalesce(jsonb_agg(x order by x desc), '[]')
                 from (select distinct round as x from public.banquet_mvps
                       union select now_) t),
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('color', color, 'uid', uid::text) order by color), '[]')
               from public.banquet_mvps where round = r and discord_id = me),
    'shared', shared,
    'total', (select count(distinct uid) from public.banquet_listed(r)),
    'banquets', case when r < now_ or shared then (
      select coalesce(jsonb_agg(b), '[]')
        from (
          select jsonb_build_object(
                   -- As text, like every UID this sends.
                   'uid', m.uid::text,
                   'colors', (select coalesce(jsonb_agg(distinct l.color) filter (where l.color is not null), '[]') from public.banquet_listed(r) l where l.uid = m.uid),
                   'entered_by', (select jsonb_agg(distinct l.by_name) from public.banquet_listed(r) l where l.uid = m.uid),
                   'extra', not exists (select 1 from public.banquet_mvps x where x.round = r and x.uid = m.uid),
                   'mine_extra', exists (select 1 from public.banquet_extras x where x.round = r and x.uid = m.uid and x.discord_id = me),
                   'claims', (select count(*) from public.banquet_claims c where c.round = r and c.uid = m.uid),
                   'claimed_by', (select coalesce(jsonb_agg(by_name order by claimed_at), '[]') from public.banquet_claims c where c.round = r and c.uid = m.uid),
                   'claimed', exists (select 1 from public.banquet_claims c where c.round = r and c.uid = m.uid and c.discord_id = me),
                   'full', (select f.by_name from public.banquet_full f where f.round = r and f.uid = m.uid and f.state = 'full'),
                   'not_yet', (select jsonb_build_object('by', f.by_name, 'at', f.marked_at) from public.banquet_full f where f.round = r and f.uid = m.uid and f.state = 'not-yet')
                 ) as b
            from (select distinct uid from public.banquet_listed(r)) m
        ) t)
      else '[]'::jsonb end
  );
end;
$$;

revoke all on function public.banquet_listed(date) from public, anon, authenticated;
revoke all on function public.banquet_sweep(date) from public, anon, authenticated;
revoke all on function public.banquet_extra(bigint, boolean) from public, anon;
grant execute on function public.banquet_extra(bigint, boolean) to authenticated;
