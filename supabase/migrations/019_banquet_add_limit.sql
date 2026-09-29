-- At most 20 UIDs added on the site per person per gold rush. Run after 018.
--
-- Anyone in a group could add without limit, so one slip or one bad actor
-- could bury a group's list under hundreds of made-up banquets. Twenty is well
-- past four MVPs and a handful heard about. Posts in Discord do not count:
-- the channel has its own moderators.

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
  if (select count(*) from public.banquet_uids
       where round = r and discord_id = you.discord_id and source = 'site') >= 20 then
    raise exception 'That is 20 added this gold rush, the most there can be. Remove one first.';
  end if;
  insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source)
  values (r, public.banquet_group_for(you.sees_all, you.groups, g), target, you.discord_id, you.display, 'site')
  on conflict do nothing;
end;
$$;
