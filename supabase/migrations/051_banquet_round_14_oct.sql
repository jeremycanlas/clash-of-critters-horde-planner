-- The gold rush set up as 15 Oct resets on 14 Oct (8am Manila). Its rows move
-- to 14 Oct as they are; the packed lists and leaderboards rebuild themselves.
-- The switch time stays, so the bot keeps reading the channel from 13 Oct.

update public.banquet_schedule set round = '2026-10-14' where round = '2026-10-15';
update public.banquet_access   set round = '2026-10-14' where round = '2026-10-15';
update public.banquet_claims   set round = '2026-10-14' where round = '2026-10-15';
update public.banquet_events   set round = '2026-10-14' where round = '2026-10-15';
update public.banquet_feed     set round = '2026-10-14' where round = '2026-10-15';
update public.banquet_marks    set round = '2026-10-14' where round = '2026-10-15';
update public.banquet_uids     set round = '2026-10-14' where round = '2026-10-15';
delete from public.banquet_snap          where round = '2026-10-15';
delete from public.banquet_leaders_cache where round = '2026-10-15';
