-- No cap on UIDs added on the site. Run after 027.
--
-- 019 capped them at 20 per person per gold rush, against one member burying
-- a group's list in made-up banquets. It was in the way of members who add
-- many real ones, so it goes; Possible copies and the access log are where a
-- flood would show. Posts in Discord never had a cap.

create or replace function public.banquet_add(target bigint, g smallint default null)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  you record;
  r date := public.banquet_round();
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if target not between 10000000 and 99999999 then raise exception 'A UID is 8 digits.'; end if;
  insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source)
  values (r, public.banquet_group_for(you.sees_all, you.groups, g), target, you.discord_id, you.display, 'site')
  on conflict do nothing;
end;
$$;
