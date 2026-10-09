-- Leaderboards leave out private lists (a small list of a few named people is
-- not a competition). Run after 043.

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
                 from (select distinct round as x from public.banquet_uids where grp = any (you.groups)) t),
    'groups', out_);
end;
$$;
revoke all on function public.banquet_leaders(date, boolean) from public, anon;
grant execute on function public.banquet_leaders(date, boolean) to authenticated;
