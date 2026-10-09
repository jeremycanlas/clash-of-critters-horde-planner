-- A member moved to another group mid gold rush takes their UIDs with them.
-- Run after 044.
--
-- The four-UID rule counts a member's own UIDs in their group. On 8 Oct a
-- dozen Group 2 members got the Group 1 role instead; their Duneside UIDs stayed
-- in Group 2, so Group 1's list asked them for four again. Now, at the role
-- check that finds the new group, their UIDs added on the site this gold rush
-- go to it. Claims and marks on them stay with the old group's cards. UIDs
-- read from a Discord channel stay where that channel put them.
--
-- During Duneside (the round of 7 Oct) they are copied, not moved: moving the
-- dozen of 8 Oct would have taken 304 cards out of Group 2's list mid gold
-- rush. From the next gold rush a change moves them. Someone whose role is
-- removed keeps their UIDs in the list: nothing here, or anywhere, deletes a
-- UID for its poster losing their role.

-- One member's site UIDs this round, from groups they are no longer in to
-- their group: copied during Duneside, moved after. One already there (added
-- again by hand) is not doubled.
create or replace function public.banquet_follow(who text, grps smallint[], r date default public.banquet_round())
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  target smallint;
  n      int;
begin
  select g into target from unnest(grps) g
   where not exists (select 1 from public.banquet_groups x where x.grp = g and x.private) limit 1;
  if target is null then return 0; end if;
  -- ponytail: Duneside by date; a setting if this ever needs to be chosen per round.
  if r <= '2026-10-07' then
    insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source, added_at)
    select u.round, target, u.uid, u.discord_id, u.by_name, u.source, u.added_at
      from public.banquet_uids u
     where u.round = r and u.discord_id = who and u.source = 'site' and not (u.grp = any (grps))
       and not exists (select 1 from public.banquet_groups x where x.grp = u.grp and x.private)
    on conflict do nothing;
    get diagnostics n = row_count;
    return n;
  end if;
  delete from public.banquet_uids u
   where u.round = r and u.discord_id = who and u.source = 'site' and not (u.grp = any (grps))
     and not exists (select 1 from public.banquet_groups x where x.grp = u.grp and x.private)
     and exists (select 1 from public.banquet_uids y where y.round = r and y.grp = target and y.uid = u.uid and y.discord_id = who);
  update public.banquet_uids u set grp = target
   where u.round = r and u.discord_id = who and u.source = 'site' and not (u.grp = any (grps))
     and not exists (select 1 from public.banquet_groups x where x.grp = u.grp and x.private);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.banquet_follow(text, smallint[], date) from public, anon, authenticated;

create or replace function public.banquet_check()
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, extensions
as $$
declare
  me    record;
  held  record;
  s     record;
  tok   text;
  res   extensions.http_response;
  body  jsonb;
  roles text[];
  grps  smallint[];
  all_  boolean;
  name_ text;
begin
  select * into me from public.tracker_caller();
  if me.discord_id is null then return 'signed-out'; end if;

  select * into held from public.banquet_members where discord_id = me.discord_id;
  if held.checked_at > now() - (case when held.ok then interval '10 minutes' else interval '1 minute' end) then
    return case when held.ok then 'ok' else 'no-role' end;
  end if;

  select * into s from public.banquet_settings;
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'banquet_bot_token';
  if s.guild_id is null or tok is null or not exists (select 1 from public.banquet_groups) then
    return 'not-set-up';
  end if;

  begin
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '5000');
    res := extensions.http((
      'GET',
      format('https://discord.com/api/v10/guilds/%s/members/%s', s.guild_id, me.discord_id),
      array[extensions.http_header('Authorization', 'Bot ' || tok),
            extensions.http_header('User-Agent', 'DiscordBot (https://github.com/, 1)')],
      null, null)::extensions.http_request);
  exception when others then
    -- Discord did not answer: someone it said yes to in the last day is let in.
    if held.ok and held.confirmed_at > now() - interval '24 hours' then
      -- Asked again within a minute; meanwhile the rest of the page works (banquet_you).
      update public.banquet_members set checked_at = now() - interval '9 minutes' where discord_id = me.discord_id;
      return 'ok';
    end if;
    return 'discord-down';
  end;

  begin body := res.content::jsonb; exception when others then body := null; end;

  name_ := me.display;
  if res.status = 200 then
    -- Their name in this server: the nickname set there, else their Discord display name.
    name_ := coalesce(nullif(btrim(body ->> 'nick'), ''), nullif(btrim(body -> 'user' ->> 'global_name'), ''), me.display);
    roles := array(select jsonb_array_elements_text(body -> 'roles'));
    grps := array(select g.grp from public.banquet_groups g where not g.private and g.role_id = any (roles) order by g.grp);
    all_ := roles && s.viewer_roles or me.discord_id = any (s.viewer_ids) or cardinality(grps) > 1;
    -- Seeing both is both channel groups; a private list is never part of it.
    if all_ then grps := array(select g.grp from public.banquet_groups g where not g.private order by g.grp); end if;
    -- Private lists are by name, whatever the roles.
    grps := grps || array(select m.grp from public.banquet_group_members m where m.discord_id = me.discord_id order by m.grp);
  elsif res.status = 404 and body ->> 'code' = '10007' then
    -- Not in the server: nothing, unless named as a viewer.
    all_ := me.discord_id = any (s.viewer_ids);
    grps := case when all_ then array(select g.grp from public.banquet_groups g where not g.private order by g.grp) else '{}' end;
  elsif res.status in (401, 403, 404) then
    return 'not-set-up';
  else
    -- Discord did not answer: someone it said yes to in the last day is let in.
    if held.ok and held.confirmed_at > now() - interval '24 hours' then
      -- Asked again within a minute; meanwhile the rest of the page works (banquet_you).
      update public.banquet_members set checked_at = now() - interval '9 minutes' where discord_id = me.discord_id;
      return 'ok';
    end if;
    return 'discord-down';
  end if;

  insert into public.banquet_members (discord_id, display, ok, checked_at, groups, sees_all, confirmed_at)
  values (me.discord_id, name_, cardinality(grps) > 0, now(), grps, all_, case when cardinality(grps) > 0 then now() end)
  on conflict (discord_id) do update
    set display = excluded.display, ok = excluded.ok, checked_at = now(),
        groups = excluded.groups, sees_all = excluded.sees_all, confirmed_at = excluded.confirmed_at;

  -- A new name shows on everything of theirs, every round. At most once per
  -- check, which is at most every 10 minutes, and a no-op when nothing differs.
  if held.display is distinct from name_ then perform public.banquet_rename(me.discord_id, name_); end if;
  -- Moved to another group: their own UIDs this gold rush go with them (045).
  if held.groups is distinct from grps and not all_ then perform public.banquet_follow(me.discord_id, grps); end if;

  return case when cardinality(grps) > 0 then 'ok' else 'no-role' end;
end;
$$;

-- Those moved already (8 Oct), now: copied, as it is still Duneside.
select public.banquet_follow(m.discord_id, m.groups)
  from public.banquet_members m
 where m.ok and not m.sees_all;
