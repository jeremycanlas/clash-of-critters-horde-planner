-- When Discord does not answer the access check, a member it said yes to in
-- the last 7 days is let in, not only the last 24 hours. Run after 045.
--
-- At the 14 Oct reset people could not get in from 8:00 to about 8:30. The
-- check asks Discord for each visitor every 10 minutes, and at a reset everyone
-- asks at once; most members come once a week, so a 24-hour fallback left
-- them out whenever Discord was slow or refused. Someone who has left the
-- server still loses access at the first check Discord does answer.
--
-- Edits the function as it stands rather than restating it, so nothing else
-- in it can drift. The second server: sh tools/setup-server.sh tide <this file>

do $$
declare d text := pg_get_functiondef('public.banquet_check()'::regprocedure);
begin
  if d not like '%interval ''24 hours''%' then raise exception 'banquet_check: no 24-hour fallback to change'; end if;
  execute replace(d, 'interval ''24 hours''', 'interval ''7 days''');
end;
$$;
