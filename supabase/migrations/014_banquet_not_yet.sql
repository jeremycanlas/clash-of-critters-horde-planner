-- "Not yet available": somebody got to the camp before the banquet was up.
-- Shared like Full, and a banquet is one or the other, so the Full table
-- gains a state rather than a twin. Run after 013.

alter table public.banquet_full
  add column if not exists state text not null default 'full' check (state in ('full', 'not-yet'));

-- Anyone can mark a banquet, and anyone can take it back: whoever was just at
-- the camp knows best. A null state clears it.
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
  if not exists (select 1 from public.banquet_mvps where round = r and uid = target) then
    raise exception 'That banquet is not in this round.';
  end if;
  insert into public.banquet_full (round, uid, by_name, state)
  values (r, target, (select display from public.tracker_caller()), banquet_mark.state)
  on conflict (round, uid) do update set by_name = excluded.by_name, state = excluded.state, marked_at = now();
end;
$$;

drop function if exists public.banquet_mark_full(bigint, boolean);
revoke all on function public.banquet_mark(bigint, text) from public, anon;
grant execute on function public.banquet_mark(bigint, text) to authenticated;

-- Everything the page shows for one round (the current one when r is null).
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
    'total', (select count(distinct uid) from public.banquet_mvps where round = r),
    'banquets', case when r < now_ or shared then (
      select coalesce(jsonb_agg(b), '[]')
        from (
          select jsonb_build_object(
                   -- As text: a UID can pass 2^53, where a JSON number stops being exact.
                   'uid', m.uid::text,
                   'colors', (select jsonb_agg(distinct color) from public.banquet_mvps x where x.round = r and x.uid = m.uid),
                   'entered_by', (select jsonb_agg(distinct by_name) from public.banquet_mvps x where x.round = r and x.uid = m.uid),
                   'claims', (select count(*) from public.banquet_claims c where c.round = r and c.uid = m.uid),
                   'claimed_by', (select coalesce(jsonb_agg(by_name order by claimed_at), '[]') from public.banquet_claims c where c.round = r and c.uid = m.uid),
                   'claimed', exists (select 1 from public.banquet_claims c where c.round = r and c.uid = m.uid and c.discord_id = me),
                   'full', (select f.by_name from public.banquet_full f where f.round = r and f.uid = m.uid and f.state = 'full'),
                   'not_yet', (select jsonb_build_object('by', f.by_name, 'at', f.marked_at) from public.banquet_full f where f.round = r and f.uid = m.uid and f.state = 'not-yet')
                 ) as b
            from (select distinct uid from public.banquet_mvps where round = r) m
        ) t)
      else '[]'::jsonb end
  );
end;
$$;
