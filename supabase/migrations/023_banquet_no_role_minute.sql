-- A "no role" answer is remembered for one minute, not ten. Run after 022.
--
-- Someone signs in before a moderator gives them the role, gets "not for
-- you", is given the role, and reloads: for up to ten minutes they got the
-- same "not for you" from the remembered answer. A yes stays ten minutes,
-- which is what keeps a busy evening inside Discord's rate limit; a no is
-- rare and worth asking again soon.

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
    return 'discord-down';
  end;

  begin body := res.content::jsonb; exception when others then body := null; end;

  if res.status = 200 then
    roles := array(select jsonb_array_elements_text(body -> 'roles'));
    grps := array(select g.grp from public.banquet_groups g where g.role_id = any (roles) order by g.grp);
    all_ := roles && s.viewer_roles or cardinality(grps) > 1;
    if all_ then grps := array(select g.grp from public.banquet_groups g order by g.grp); end if;
  elsif res.status = 404 and body ->> 'code' = '10007' then
    grps := '{}'; all_ := false;      -- not in the server
  elsif res.status in (401, 403, 404) then
    return 'not-set-up';
  else
    return 'discord-down';
  end if;

  insert into public.banquet_members (discord_id, display, ok, checked_at, groups, sees_all)
  values (me.discord_id, me.display, cardinality(grps) > 0, now(), grps, all_)
  on conflict (discord_id) do update
    set display = excluded.display, ok = excluded.ok, checked_at = now(),
        groups = excluded.groups, sees_all = excluded.sees_all;

  return case when cardinality(grps) > 0 then 'ok' else 'no-role' end;
end;
$$;
