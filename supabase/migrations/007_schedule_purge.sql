-- The thirty days become self-enforcing. Run after 006.
--
-- 005 wrote purge_deleted_formations() and deliberately did not schedule it,
-- because scheduling meant installing an extension and that is a change to the
-- project rather than to this schema. This is that change, made on purpose and
-- written down where the rest of the schema lives.
--
-- Until this ran, the README's promise -- gone from the gallery immediately,
-- gone from the database within a month -- depended on somebody remembering to
-- run a function. A privacy promise that depends on a person remembering is a
-- privacy promise with a bug in it.

create extension if not exists pg_cron;

-- 04:17 UTC daily. Not on the hour: every scheduled job in the world runs at
-- :00, and this one has no reason to join the queue. The minute is arbitrary
-- and that is the point.
--
-- Unscheduled first so re-running this file replaces the job rather than
-- collecting a second copy of it. cron.schedule() on an existing name updates
-- in place, but only if the name matches exactly, and a typo would otherwise
-- leave two jobs racing over the same rows.
select cron.unschedule(jobid) from cron.job where jobname = 'purge-deleted-formations';

select cron.schedule(
  'purge-deleted-formations',
  '17 4 * * *',
  $$select public.purge_deleted_formations()$$
);

-- The job runs as the database owner, which is what lets it call a function
-- that anon and authenticated are both revoked from. Check on it with:
--
--   select jobname, schedule, active from cron.job;
--   select jobname, status, return_message, start_time
--     from cron.job_run_details order by start_time desc limit 10;
