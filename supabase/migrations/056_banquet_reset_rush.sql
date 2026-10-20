-- The reset, with everyone there at once. Run after 055.
--
-- 14 Oct, 8:01 to 8:08 Manila: 28 people signed in and three lists loaded.
-- At the reset a covered group's list opens (033), and every page that has
-- it open asks for the whole list within its next 10-second poll. The list
-- is kept built (banquet_snap, 041) so that a crowd shares one copy, but only
-- once a copy exists: a member's copy of a covered group's list is first
-- asked for at the reset, so every one of those pages built it at once, on a
-- server with 400 MB for the database and the API together (049). Each went
-- past the 8 s limit, every page said "Could not load", and the backoff took
-- until 8:09 to let them back.
--
-- 1. A copy nobody has built: one request builds it, the rest wait for that
--    one and take it, as a stale copy already did.
-- 2. Every group's copies, built each minute from 7:00 to 8:59 Manila (23:00
--    to 00:59 UTC), so at the reset the copy is already there. The list does
--    not depend on the time of day, only on the gold rush, so a copy built
--    at 7:59 is the one wanted at 8:00.
-- 3. Around a reset (45 minutes before to 90 after), a member Discord said
--    yes to in the last 7 days is not asked about again: the check costs a
--    request to Discord each, held open up to 5 s, just when everyone signs in.
--    A role taken away is noticed at the first check after that.
-- 4. The Discord reader (the second server's, every 15 s) skips 7:50 to 8:45
--    Manila on a reset day; the posts it skipped are read on the next run.
-- 5. The leaderboards had the same gap as 1: with none built yet, every
--    request built its own. Now one does and the rest wait for it.
--
-- The second server: the same file through setup-server.sh's moved() rewrite.

-- Is `at` within this window around the current gold rush's reset?
create or replace function public.banquet_near_reset(before_ interval, after_ interval, at timestamptz default now())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select at >= public.banquet_opens(public.banquet_round(at)) - before_
     and at <  public.banquet_opens(public.banquet_round(at)) + after_;
$$;
revoke all on function public.banquet_near_reset(interval, interval, timestamptz) from public, anon, authenticated;

-- 1.
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
  k     integer := hashtext(r::text || ':' || g || ':' || with_grp);
begin
  select * into s from public.banquet_snap x where x.round = r and x.grp = g and x.with_grp = banquet_snap_get.with_grp;
  if found and s.packed is not null
     and (s.since > start - interval '30 seconds'
          or not exists (select 1 from public.banquet_feed f where f.round = r and f.grp = g and f.at >= s.since - interval '30 seconds')
          or not pg_try_advisory_xact_lock(hashtext('banquet_snap'), k)) then
    return s;
  end if;
  if not found or s.packed is null then
    -- None yet: wait for whoever is building it, then take theirs.
    perform pg_advisory_xact_lock(hashtext('banquet_snap'), k);
    select * into s from public.banquet_snap x where x.round = r and x.grp = g and x.with_grp = banquet_snap_get.with_grp;
    if found and s.packed is not null then return s; end if;
  end if;
  body_ := public.banquet_cards(r, array[g], null, with_grp, null);
  s := (r, g, with_grp, start, body_, public.banquet_pack(body_, (r - 10)::timestamp at time zone 'UTC', with_grp, false));
  insert into public.banquet_snap values (s.*)
  on conflict on constraint banquet_snap_pkey do update set since = excluded.since, body = excluded.body, packed = excluded.packed;
  return s;
end;
$$;

-- 2.
create or replace function public.banquet_warm()
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  r date := public.banquet_round();
  g smallint;
begin
  for g in select grp from public.banquet_groups order by grp loop
    perform public.banquet_snap_get(r, g, false);
    perform public.banquet_snap_get(r, g, true);
  end loop;
end;
$$;
revoke all on function public.banquet_warm() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'banquet-warm';
select cron.schedule('banquet-warm', '* 23,0 * * *', 'select public.banquet_warm()');

-- 3. and 4. Edit the functions as they stand, as 054 and 055 do.
do $$
declare
  d text := pg_get_functiondef('public.banquet_check()'::regprocedure);
  was text := 'case when held.ok then interval ''10 minutes'' else interval ''1 minute'' end';
begin
  if d like '%banquet_near_reset%' then return; end if;
  if d not like '%' || was || '%' then raise exception 'banquet_check: no 10-minute recheck to change'; end if;
  execute replace(d, was, 'case when not held.ok then interval ''1 minute''
      when public.banquet_near_reset(interval ''45 minutes'', interval ''90 minutes'') then interval ''7 days''
      else interval ''10 minutes'' end');
end;
$$;

do $$
declare
  d text := pg_get_functiondef('public.banquet_sync()'::regprocedure);
  was text := 'if tok is null then return ''no token''; end if;';
begin
  if d like '%banquet_near_reset%' then return; end if;
  if d not like '%' || was || '%' then raise exception 'banquet_sync: no token line to pause after'; end if;
  execute replace(d, was, was || '
  if public.banquet_near_reset(interval ''10 minutes'', interval ''45 minutes'') then return ''paused for the reset''; end if;');
end;
$$;

-- 5.
do $$
declare
  d text := pg_get_functiondef('public.banquet_leaders(date, boolean)'::regprocedure);
  was text := '    select * into c from public.banquet_leaders_cache x where x.round = key_ and x.grp = g;
';
begin
  if d like '%None built yet%' then return; end if;
  if d not like '%' || was || '%' then raise exception 'banquet_leaders: no cache read to wait after'; end if;
  execute replace(d, was, was || '    if c.built_at is null then
      -- None built yet: wait for whoever is building it, then take theirs.
      perform pg_advisory_xact_lock(hashtext(''banquet_leaders''), g);
      select * into c from public.banquet_leaders_cache x where x.round = key_ and x.grp = g;
    end if;
');
end;
$$;
