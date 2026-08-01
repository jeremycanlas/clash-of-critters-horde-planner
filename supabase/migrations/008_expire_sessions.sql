-- Gives every sign-in an end date.
--
-- WHY THIS EXISTS
--
-- What a browser keeps after signing in is a refresh token, and by default the
-- session behind it has `not_after = null` -- no expiry, ever. So a machine that
-- is not yours, left signed in, can post, delete and upvote as you indefinitely,
-- and nothing the visitor does expires it. Sign-out is the only end, and it
-- depends on somebody remembering.
--
-- The supported fix is Dashboard -> Authentication -> Sessions -> "Time-box user
-- sessions" and "Inactivity timeout". If those are available on this project's
-- plan, USE THEM AND DO NOT RUN THIS. GoTrue enforcing its own settings beats
-- anything written here.
--
-- This is the fallback for when they are gated, and it is deliberately built to
-- enforce rather than to promise: the README tells readers their session ends,
-- and a README that claims an expiry the database is not applying is worse than
-- one that admits there is none.
--
-- WHAT IT TOUCHES
--
-- `auth`, which Supabase owns and GoTrue migrates. That is the whole risk. The
-- guard below is the mitigation: if the columns this depends on stop looking the
-- way they look today, the function raises instead of quietly matching zero rows
-- and reporting success. A loud failure in cron.job_run_details is recoverable.
-- A silent one leaves the README lying.
--
-- Nothing here reaches public.formations, and nothing here can reach a browser's
-- localStorage -- a visitor's own saved formations are not in this database at
-- all.

-- ------------------------------------------------------------ the two windows
--
-- 30 days as a hard ceiling, 7 days of disuse. The ceiling is what makes the
-- README's "expires" true; the disuse window is what actually helps the borrowed
-- laptop, since that session is idle from the moment its owner walks away.
--
-- Change them here. They are named in README.md, so change them there too.

create or replace function public.expire_stale_sessions()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  box      constant interval := interval '30 days';
  idle     constant interval := interval '7 days';
  stamped  integer;
  dropped  integer;
begin
  -- The guard. `not_after` is GoTrue's own time-box column and `refreshed_at`
  -- is how it records last use; if a GoTrue upgrade renames or removes either,
  -- every statement below silently becomes a no-op that still returns success.
  -- Refusing is the only honest outcome.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'sessions'
       and column_name in ('not_after', 'refreshed_at')
     group by table_name having count(*) = 2
  ) then
    raise exception
      'auth.sessions no longer has both not_after and refreshed_at; '
      'session expiry is NOT being enforced. Re-check this migration against '
      'the current GoTrue schema, and correct README.md until it is fixed.';
  end if;

  -- 1. Stamp the ceiling on anything that has none.
  --
  -- Setting `not_after` rather than deleting the row: this is the field GoTrue
  -- itself checks when it validates a session, so the refusal comes from the
  -- auth server on its own terms instead of from us deleting rows out from
  -- under it. It also composes with the dashboard setting -- if that is turned
  -- on later, GoTrue stamps new sessions itself and this matches nothing.
  --
  -- A session created just after a run stays unstamped for up to a day. That is
  -- harmless: the window is 30 days, so it is stamped long before it could
  -- reach one, and it is stamped from `created_at`, not from when we noticed.
  update auth.sessions
     set not_after = created_at + box
   where not_after is null;
  get diagnostics stamped = row_count;

  -- 2. Delete what is spent.
  --
  -- Deleting only where there is nothing for GoTrue to enforce against -- an
  -- idle session has no column saying so -- plus tidying rows already past
  -- their ceiling. auth.refresh_tokens.session_id is ON DELETE CASCADE, so the
  -- refresh tokens go with the row and the next refresh attempt gets a 400.
  -- assets/js/supabase.js turns that into a local sign-out and a plain-English
  -- toast, which is why this is safe to switch on without a code change.
  --
  -- `refreshed_at` is `timestamp WITHOUT time zone` holding UTC, while
  -- `created_at` is timestamptz. Comparing them without the explicit
  -- `at time zone 'utc'` silently reinterprets one in the server's zone and
  -- skews the window by hours.
  delete from auth.sessions
   where (not_after is not null and not_after < now())
      or coalesce(refreshed_at at time zone 'utc', created_at) < now() - idle;
  get diagnostics dropped = row_count;

  return format('stamped %s, deleted %s', stamped, dropped);
end;
$$;

-- Same posture as purge_deleted_formations(): this is for pg_cron and for a
-- maintainer at a psql prompt. Executable by anon, it would be a way for any
-- visitor to sign every other visitor out.
revoke execute on function public.expire_stale_sessions() from public, anon, authenticated;

-- ---------------------------------------------------------------- scheduling
--
-- Its own job, not folded into purge-deleted-formations: a failure in either
-- should be visible on its own line rather than hidden behind the other's
-- status. 04:31 UTC, a quarter-hour clear of the 04:17 purge.
select cron.unschedule(jobid) from cron.job where jobname = 'expire-stale-sessions';

select cron.schedule(
  'expire-stale-sessions',
  '31 4 * * *',
  $$select public.expire_stale_sessions()$$
);

-- Check on it with:
--
--   select jobname, schedule, active from cron.job;
--   select jobname, status, return_message, start_time
--     from cron.job_run_details
--    where jobname = 'expire-stale-sessions'
--    order by start_time desc limit 10;
--
-- And confirm the claim the README makes is actually true:
--
--   select count(*) filter (where not_after is null)     as never_expiring,
--          count(*) filter (where not_after is not null) as time_boxed
--     from auth.sessions;
--
-- `never_expiring` should be 0 the morning after this runs, and never more than
-- a day's worth of new sign-ins at any other time. If it is not, the README is
-- overclaiming and one of the two needs to change.
