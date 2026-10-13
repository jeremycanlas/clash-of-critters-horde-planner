-- The channel is read from when the site switched to the gold rush (046's
-- banquet_schedule), not from the reset day. Since 046 a round opens two days
-- before its reset, and the bot skipped every post in those two days.
-- Duneside keeps its fixed date; a round with no schedule row, the reset day.

create or replace function public.banquet_reads_from(r date)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select case when r = date '2026-10-07' then timestamptz '2026-10-06 00:00+08'
    else coalesce((select s.switch_at from public.banquet_schedule s where s.round = r),
                  r::timestamp at time zone 'UTC') end;
$$;
revoke all on function public.banquet_reads_from(date) from public, anon, authenticated;
