-- Names are each server's nickname. Run after 042.
--
-- The role check already asks Discord for the member in that server; its answer
-- carries their nickname there. That is now the name the site shows, per
-- server (each schema checks its own). When it changes, everything of theirs,
-- in every round, takes the new name: at most once per check (every 10 minutes
-- at most), so a nickname changed every few seconds still costs a handful of
-- small updates an hour.
--
-- A mark kept only the name of who set it; it now keeps their account too, so
-- a rename finds their marks by account and never someone else's of the same name.

alter table public.banquet_marks add column if not exists discord_id text;

-- Marks set before this: the account of the last mark or claim on that card by that name.
update public.banquet_marks m
   set discord_id = (select e.discord_id from public.banquet_events e
                      where e.round = m.round and e.grp = m.grp and e.uid = m.uid and e.by_name = m.by_name
                        and e.kind in ('open', 'full', 'not-yet', 'claim')
                      order by e.at desc limit 1)
 where m.discord_id is null;

create index if not exists banquet_uids_who on public.banquet_uids (discord_id);
create index if not exists banquet_claims_who on public.banquet_claims (discord_id);
create index if not exists banquet_marks_who on public.banquet_marks (discord_id);
create index if not exists banquet_events_who on public.banquet_events (discord_id);
create index if not exists banquet_likes_who on public.banquet_likes (discord_id);

-- Everything of one person's, under a new name. Only rows that differ are touched.
create or replace function public.banquet_rename(who text, name_ text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.banquet_uids   set by_name = name_ where discord_id = who and by_name is distinct from name_;
  update public.banquet_claims set by_name = name_ where discord_id = who and by_name is distinct from name_;
  update public.banquet_marks  set by_name = name_ where discord_id = who and by_name is distinct from name_;
  update public.banquet_events set by_name = name_ where discord_id = who and by_name is distinct from name_;
  update public.banquet_likes  set by_name = name_ where discord_id = who and by_name is distinct from name_;
  update public.banquet_access set display = name_ where discord_id = who and display is distinct from name_;
$$;
revoke all on function public.banquet_rename(text, text) from public, anon, authenticated;

create or replace function public.banquet_claim(target bigint, claimed boolean, g smallint default null)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  you record;
  r date := public.banquet_round();
  gg smallint;
  n int;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  gg := public.banquet_group_for(you.sees_all, you.groups, g);
  if not public.banquet_shared(you.sees_all, you.discord_id, r, gg) then raise exception 'Add four UIDs first.'; end if;
  if claimed then
    if not exists (select 1 from public.banquet_uids where round = r and grp = gg and uid = target) then
      raise exception 'That banquet is not in this round.';
    end if;
    insert into public.banquet_claims (round, grp, uid, discord_id, by_name)
    values (r, gg, target, you.discord_id, you.display)
    on conflict do nothing;
    get diagnostics n = row_count;
    -- Claimed means the gift was there: open, unless someone has seen it full.
    insert into public.banquet_marks (round, grp, uid, state, by_name, discord_id)
    values (r, gg, target, 'open', you.display, you.discord_id)
    on conflict (round, grp, uid) do update set state = 'open', by_name = excluded.by_name, discord_id = excluded.discord_id, marked_at = now()
      where banquet_marks.state = 'not-yet';
  else
    delete from public.banquet_claims where round = r and grp = gg and uid = target and discord_id = you.discord_id;
    get diagnostics n = row_count;
  end if;
  if n > 0 then
    insert into public.banquet_events (round, grp, uid, kind, discord_id, by_name)
    values (r, gg, target, case when claimed then 'claim' else 'unclaim' end, you.discord_id, you.display);
  end if;
end;
$$;

create or replace function public.banquet_mark(target bigint, state text, g smallint default null)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  you record;
  r date := public.banquet_round();
  gg smallint;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  gg := public.banquet_group_for(you.sees_all, you.groups, g);
  if not public.banquet_shared(you.sees_all, you.discord_id, r, gg) then raise exception 'Add four UIDs first.'; end if;
  if state is null then
    delete from public.banquet_marks m where m.round = r and m.grp = gg and m.uid = target;
    if found then
      insert into public.banquet_events (round, grp, uid, kind, discord_id, by_name)
      values (r, gg, target, 'clear', you.discord_id, you.display);
    end if;
    return;
  end if;
  if state not in ('full', 'not-yet', 'open') then raise exception 'Unknown state.'; end if;
  if not exists (select 1 from public.banquet_uids where round = r and grp = gg and uid = target) then
    raise exception 'That banquet is not in this round.';
  end if;
  insert into public.banquet_marks (round, grp, uid, state, by_name, discord_id)
  values (r, gg, target, banquet_mark.state, you.display, you.discord_id)
  on conflict (round, grp, uid) do update set state = excluded.state, by_name = excluded.by_name, discord_id = excluded.discord_id, marked_at = now();
  insert into public.banquet_events (round, grp, uid, kind, discord_id, by_name)
  values (r, gg, target, banquet_mark.state, you.discord_id, you.display);
end;
$$;

create or replace function public.banquet_apply(r date, g smallint, msgs jsonb, since timestamptz default null)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  with n as (
    select distinct on (u, m -> 'author' ->> 'id') u as uid, m -> 'author' ->> 'id' as discord_id,
           -- Their server nickname once the site has seen them (banquet_check), else their Discord name.
           coalesce((select mm.display from public.banquet_members mm where mm.discord_id = m -> 'author' ->> 'id'),
                    nullif(m -> 'author' ->> 'global_name', ''), m -> 'author' ->> 'username') as by_name,
           m ->> 'id' as message_id, (m ->> 'timestamp')::timestamptz as added_at
      from jsonb_array_elements(msgs) m, public.banquet_parse(m ->> 'content') u
     where coalesce((m -> 'author' ->> 'bot')::boolean, false) = false
       and (since is null or (m ->> 'timestamp')::timestamptz >= since)
     order by u, m -> 'author' ->> 'id', (m ->> 'timestamp')::timestamptz),
  gone as (
    delete from public.banquet_uids b
     where b.round = r and b.grp = g and b.source = 'discord' and (since is null or b.added_at >= since)
       and not exists (select 1 from n where n.uid = b.uid and n.discord_id = b.discord_id))
  insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source, message_id, added_at)
  select r, g, n.uid, n.discord_id, n.by_name, 'discord', n.message_id, n.added_at from n
  on conflict do nothing;
  select public.banquet_sweep(r, g);
$$;

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

  return case when cardinality(grps) > 0 then 'ok' else 'no-role' end;
end;
$$;
