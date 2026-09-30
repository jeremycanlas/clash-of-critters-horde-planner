-- Edit a UID you added on the site, in one step. Run after 026.
--
-- It was Remove and add again: two presses, and a moment in between where the
-- banquet was gone for everyone. Only a UID you added on the site; one posted
-- in Discord changes in Discord, which stays the one place it lives. Claims
-- and marks on the old UID go with it (banquet_sweep), unless someone else
-- still lists it.

create or replace function public.banquet_edit(target bigint, replacement bigint, g smallint default null)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  you record;
  r   date := public.banquet_round();
  gg  smallint;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if replacement not between 10000000 and 99999999 then raise exception 'A UID is 8 digits.'; end if;
  gg := public.banquet_group_for(you.sees_all, you.groups, g);
  if not exists (select 1 from public.banquet_uids
                  where round = r and grp = gg and uid = target and discord_id = you.discord_id and source = 'site') then
    raise exception 'Only a UID you added on the site can be edited here. One posted in Discord is edited in Discord.';
  end if;
  if replacement = target then return; end if;

  delete from public.banquet_uids
   where round = r and grp = gg and uid = target and discord_id = you.discord_id and source = 'site';
  insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source)
  values (r, gg, replacement, you.discord_id, you.display, 'site')
  on conflict do nothing;   -- already yours: the edit just drops the old one
  perform public.banquet_sweep(r, gg);
end;
$$;

revoke all on function public.banquet_edit(bigint, bigint, smallint) from public, anon;
grant execute on function public.banquet_edit(bigint, bigint, smallint) to authenticated;
