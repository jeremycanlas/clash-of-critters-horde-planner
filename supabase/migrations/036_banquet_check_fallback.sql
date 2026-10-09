-- The role check survives Discord not answering. Run after 035.
--
-- The database's calls to Discord began failing about one in eight on 7 Oct
-- (name lookups and connections timing out), and every failed role check
-- shut the page with "Could not reach Discord". Now, when Discord does not
-- answer, someone it said yes to in the last 24 hours is let in, and asked
-- again within a minute. A "no" from Discord still shuts the page at once.

alter table public.banquet_members add column if not exists confirmed_at timestamptz;   -- the last time Discord said yes
update public.banquet_members set confirmed_at = checked_at where ok and confirmed_at is null;

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

  if res.status = 200 then
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
  values (me.discord_id, me.display, cardinality(grps) > 0, now(), grps, all_, case when cardinality(grps) > 0 then now() end)
  on conflict (discord_id) do update
    set display = excluded.display, ok = excluded.ok, checked_at = now(),
        groups = excluded.groups, sees_all = excluded.sees_all, confirmed_at = excluded.confirmed_at;

  return case when cardinality(grps) > 0 then 'ok' else 'no-role' end;
end;
$$;
