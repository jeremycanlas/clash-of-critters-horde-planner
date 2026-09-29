-- Read the channels every 15 seconds, not every minute. Run after 023.
--
-- A post reached members' screens in up to two minutes: a minute for the sync,
-- thirty seconds for their page's refresh. Now 15 seconds each. A read takes
-- about a second and asks Discord for one page per channel, so this is about
-- eight requests a minute, far inside Discord's limits; the whole-round read
-- stays every ten minutes (018). pg_cron runs one of these at a time, so a slow
-- read delays the next rather than piling up.
--
-- pg_cron keeps a line in cron.job_run_details for every run and never drops
-- them: at this rate 5,760 a day. A daily job keeps this job's last three days.

select cron.unschedule(jobid) from cron.job where jobname = 'banquet-sync';
select cron.schedule('banquet-sync', '15 seconds', 'select public.banquet_sync()');

select cron.unschedule(jobid) from cron.job where jobname = 'banquet-sync-log-trim';
select cron.schedule('banquet-sync-log-trim', '43 3 * * *', $$
  delete from cron.job_run_details
   where jobid = (select jobid from cron.job where jobname = 'banquet-sync')
     and start_time < now() - interval '3 days'
$$);
