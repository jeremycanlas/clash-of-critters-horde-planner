-- MVP banquets, rebuilt around two groups and their Discord channels. Run after 015.
--
-- ## Groups
--
-- The "MVP UIDs" server has a Group 1 and a Group 2 role, and a channel each
-- where members post the UIDs of their MVPs. Everything a member sees, claims
-- and marks belongs to their group, and nothing a group member is sent says a
-- second group exists: no group number, no count, no name from the other side.
-- Holders of a viewer role (Owner, Budboo Enjoyer), or of both group roles, see
-- both, with the group on every banquet.
--
-- ## The channels are the source
--
-- banquet_sync() runs every minute. It reads every post in each group's
-- channel since the current gold rush started and replaces that group's
-- Discord-sourced UIDs with what it found, so a post, an edit and a deletion
-- all show within a minute. A read that fails changes nothing. Members can also
-- add UIDs on the site; those are theirs to remove.
--
-- ## Share to see
--
-- A group member sees the current round once they have four UIDs in it, posted
-- or added, in any number of goes. Viewers always see everything.
--
-- ## Settings, as the maintainer, over psql
--
--   update public.banquet_settings set guild_id = '<server>', viewer_roles = '{<role>,<role>}';
--   insert into public.banquet_groups (grp, role_id, channel_id) values (1, '<role>', '<channel>'), ...
--
-- This replaces 013-015's colour slots and extras; their test rows go with them.

-- ---------------------------------------------------------------- out with the old

drop function if exists public.banquet_save_mvps(bigint[]);
drop function if exists public.banquet_extra(bigint, boolean);
drop function if exists public.banquet_claim(bigint, boolean);
drop function if exists public.banquet_mark(bigint, text);
drop function if exists public.banquet_state(date);
drop function if exists public.banquet_shared(text, date);
drop function if exists public.banquet_sweep(date);
drop function if exists public.banquet_listed(date);
drop table if exists public.banquet_mvps, public.banquet_extras, public.banquet_claims, public.banquet_full;

-- ---------------------------------------------------------------- settings

alter table public.banquet_settings drop column if exists role_id;
alter table public.banquet_settings add column if not exists viewer_roles text[] not null default '{}';

create table if not exists public.banquet_groups (
  grp        smallint primary key check (grp in (1, 2)),
  role_id    text not null,
  channel_id text,
  synced_at  timestamptz,   -- last read that worked
  sync_error text           -- last read that did not, cleared by the next good one
);
alter table public.banquet_groups enable row level security;
revoke all on public.banquet_groups from anon, authenticated;

alter table public.banquet_members add column if not exists groups smallint[] not null default '{}';
alter table public.banquet_members add column if not exists sees_all boolean not null default false;
-- Fresh answers only: groups are new, so every cached yes is out of date.
delete from public.banquet_members;

-- ---------------------------------------------------------------- data

create table public.banquet_uids (
  round      date not null,
  grp        smallint not null,
  uid        bigint not null check (uid between 10000000 and 99999999),
  discord_id text not null,
  by_name    text not null,
  source     text not null check (source in ('discord', 'site')),
  message_id text,
  added_at   timestamptz not null default now(),
  primary key (round, grp, uid, discord_id)
);

create table public.banquet_claims (
  round      date not null,
  grp        smallint not null,
  uid        bigint not null,
  discord_id text not null,
  by_name    text not null,
  claimed_at timestamptz not null default now(),
  primary key (round, grp, uid, discord_id)
);

create table public.banquet_marks (
  round     date not null,
  grp       smallint not null,
  uid       bigint not null,
  state     text not null check (state in ('full', 'not-yet')),
  by_name   text not null,
  marked_at timestamptz not null default now(),
  primary key (round, grp, uid)
);

alter table public.banquet_uids   enable row level security;
alter table public.banquet_claims enable row level security;
alter table public.banquet_marks  enable row level security;
revoke all on public.banquet_uids, public.banquet_claims, public.banquet_marks from anon, authenticated;

-- ---------------------------------------------------------------- who is asking

-- Asks Discord for the caller's roles. Answers ok, no-role, signed-out,
-- not-set-up or discord-down, as before; the groups it finds are kept for
-- banquet_you().
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
  if held.checked_at > now() - interval '10 minutes' then
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

-- The caller, when Discord said yes in the last half hour.
create or replace function public.banquet_you()
returns table (discord_id text, display text, groups smallint[], sees_all boolean)
language sql
stable
security definer
set search_path = public, auth
as $$
  select m.discord_id, m.display, m.groups, m.sees_all
    from public.banquet_members m
    join public.tracker_caller() c on c.discord_id = m.discord_id
   where m.ok and m.checked_at > now() - interval '30 minutes';
$$;

drop function if exists public.banquet_me();

-- Which group a write is for. A group member's own, whatever they sent; a
-- viewer's choice, which they must make.
create or replace function public.banquet_group_for(sees_all boolean, groups smallint[], g smallint)
returns smallint
language plpgsql
immutable
as $$
begin
  if not sees_all then return groups[1]; end if;
  if g is null or not (g = any (groups)) then raise exception 'Pick a group.'; end if;
  return g;
end;
$$;

create or replace function public.banquet_shared(sees_all boolean, who text, r date, g smallint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select sees_all
      or (select count(distinct uid) >= 4 from public.banquet_uids
           where round = r and grp = g and discord_id = who);
$$;

-- Claims and marks on UIDs nobody in the group lists any more.
create or replace function public.banquet_sweep(r date, g smallint)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.banquet_claims c where c.round = r and c.grp = g
     and not exists (select 1 from public.banquet_uids u where u.round = r and u.grp = g and u.uid = c.uid);
  delete from public.banquet_marks m where m.round = r and m.grp = g
     and not exists (select 1 from public.banquet_uids u where u.round = r and u.grp = g and u.uid = m.uid);
$$;

-- ---------------------------------------------------------------- the channels

-- Every 8-digit number in a post, however it is quoted.
create or replace function public.banquet_parse(content text)
returns setof bigint
language sql
immutable
as $$
  select distinct m[1]::bigint from regexp_matches(coalesce(content, ''), '(?<![0-9])([0-9]{8})(?![0-9])', 'g') m;
$$;

-- Replaces one group's Discord UIDs for a round with those in `msgs`, a list
-- of Discord message objects. Separate from the fetch so it can be checked
-- without Discord.
create or replace function public.banquet_apply(r date, g smallint, msgs jsonb)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.banquet_uids where round = r and grp = g and source = 'discord';
  insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source, message_id, added_at)
  select distinct on (u, m -> 'author' ->> 'id') r, g, u, m -> 'author' ->> 'id',
         coalesce(nullif(m -> 'author' ->> 'global_name', ''), m -> 'author' ->> 'username'),
         'discord', m ->> 'id', (m ->> 'timestamp')::timestamptz
    from jsonb_array_elements(msgs) m, public.banquet_parse(m ->> 'content') u
   where coalesce((m -> 'author' ->> 'bot')::boolean, false) = false
   order by u, m -> 'author' ->> 'id', (m ->> 'timestamp')::timestamptz
  on conflict do nothing;
  select public.banquet_sweep(r, g);
$$;

-- Each group's channel, every post since the current gold rush began. Paged a
-- hundred at a time from the start, the order Discord gives with `after`.
create or replace function public.banquet_sync()
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  r     date := public.banquet_round();
  tok   text;
  g     record;
  after bigint;
  page  jsonb;
  msgs  jsonb;
  res   extensions.http_response;
  n     int;
  said  text := '';
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'banquet_bot_token';
  if tok is null then return 'no token'; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '8000');

  for g in select * from public.banquet_groups where channel_id is not null order by grp loop
    -- A Discord ID is a timestamp: milliseconds since 2015, shifted 22 bits.
    after := ((extract(epoch from r::timestamp at time zone 'UTC') * 1000)::bigint - 1420070400000) << 22;
    msgs := '[]';
    begin
      for n in 1..50 loop
        res := extensions.http((
          'GET',
          format('https://discord.com/api/v10/channels/%s/messages?limit=100&after=%s', g.channel_id, after),
          array[extensions.http_header('Authorization', 'Bot ' || tok),
                extensions.http_header('User-Agent', 'DiscordBot (https://github.com/, 1)')],
          null, null)::extensions.http_request);
        if res.status <> 200 then raise exception 'Discord answered %', res.status; end if;
        page := res.content::jsonb;
        msgs := msgs || page;
        exit when jsonb_array_length(page) < 100;
        after := (select max((x ->> 'id')::bigint) from jsonb_array_elements(page) x);
        if n = 50 then raise exception 'more than 5000 posts; stopped'; end if;
      end loop;
    exception when others then
      update public.banquet_groups set sync_error = sqlerrm where grp = g.grp;
      said := said || format('group %s: %s. ', g.grp, sqlerrm);
      continue;
    end;

    perform public.banquet_apply(r, g.grp, msgs);
    update public.banquet_groups set synced_at = now(), sync_error = null where grp = g.grp;
    said := said || format('group %s: %s posts. ', g.grp, jsonb_array_length(msgs));
  end loop;
  return btrim(said);
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'banquet-sync';
select cron.schedule('banquet-sync', '* * * * *', 'select public.banquet_sync()');

-- ---------------------------------------------------------------- reads

create or replace function public.banquet_state(r date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  you  record;
  now_ date := public.banquet_round();
  shared boolean;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  r := coalesce(r, now_);
  shared := public.banquet_shared(you.sees_all, you.discord_id, r, you.groups[1]);

  -- Built so a one-group member's answer has no group in it anywhere.
  return jsonb_build_object(
    'round', r,
    'current', now_,
    'rounds', (select coalesce(jsonb_agg(x order by x desc), '[]')
                 from (select distinct round as x from public.banquet_uids where grp = any (you.groups)
                       union select now_) t),
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('uid', uid::text, 'source', source)
                                       || case when you.sees_all then jsonb_build_object('grp', grp) else '{}' end
                                       order by added_at), '[]')
               from public.banquet_uids where round = r and grp = any (you.groups) and discord_id = you.discord_id),
    'shared', shared,
    'total', (select count(*) from (select distinct grp, uid from public.banquet_uids where round = r and grp = any (you.groups)) t),
    'banquets', case when r < now_ or shared then (
      select coalesce(jsonb_agg(b), '[]') from (
        select jsonb_build_object(
                 'uid', k.uid::text,
                 'entered_by', (select jsonb_agg(distinct u.by_name) from public.banquet_uids u where u.round = r and u.grp = k.grp and u.uid = k.uid),
                 'mine_site', exists (select 1 from public.banquet_uids u where u.round = r and u.grp = k.grp and u.uid = k.uid
                                        and u.discord_id = you.discord_id and u.source = 'site'),
                 'claims', (select count(*) from public.banquet_claims c where c.round = r and c.grp = k.grp and c.uid = k.uid),
                 'claimed_by', (select coalesce(jsonb_agg(c.by_name order by c.claimed_at), '[]') from public.banquet_claims c where c.round = r and c.grp = k.grp and c.uid = k.uid),
                 'claimed', exists (select 1 from public.banquet_claims c where c.round = r and c.grp = k.grp and c.uid = k.uid and c.discord_id = you.discord_id),
                 'full', (select m.by_name from public.banquet_marks m where m.round = r and m.grp = k.grp and m.uid = k.uid and m.state = 'full'),
                 'not_yet', (select jsonb_build_object('by', m.by_name, 'at', m.marked_at) from public.banquet_marks m
                              where m.round = r and m.grp = k.grp and m.uid = k.uid and m.state = 'not-yet')
               ) || case when you.sees_all then jsonb_build_object('grp', k.grp) else '{}' end as b
          from (select distinct grp, uid from public.banquet_uids where round = r and grp = any (you.groups)) k
      ) t)
    else '[]'::jsonb end
  ) || case when you.sees_all then jsonb_build_object('groups', to_jsonb(you.groups)) else '{}' end;
end;
$$;

-- ---------------------------------------------------------------- writes
-- Current round only: history is not editable.

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

-- Only UIDs you added on the site. A posted one is changed in Discord.
create or replace function public.banquet_remove(target bigint, g smallint default null)
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
  delete from public.banquet_uids
   where round = r and grp = gg and uid = target and discord_id = you.discord_id and source = 'site';
  perform public.banquet_sweep(r, gg);
end;
$$;

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
  else
    delete from public.banquet_claims where round = r and grp = gg and uid = target and discord_id = you.discord_id;
  end if;
end;
$$;

-- Full or not-yet, set by anyone in the group and cleared by anyone (null).
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
    return;
  end if;
  if state not in ('full', 'not-yet') then raise exception 'Unknown state.'; end if;
  if not exists (select 1 from public.banquet_uids where round = r and grp = gg and uid = target) then
    raise exception 'That banquet is not in this round.';
  end if;
  insert into public.banquet_marks (round, grp, uid, state, by_name)
  values (r, gg, target, banquet_mark.state, you.display)
  on conflict (round, grp, uid) do update set state = excluded.state, by_name = excluded.by_name, marked_at = now();
end;
$$;

-- ---------------------------------------------------------------- grants

revoke all on function public.banquet_you() from public, anon, authenticated;
revoke all on function public.banquet_group_for(boolean, smallint[], smallint) from public, anon, authenticated;
revoke all on function public.banquet_shared(boolean, text, date, smallint) from public, anon, authenticated;
revoke all on function public.banquet_sweep(date, smallint) from public, anon, authenticated;
revoke all on function public.banquet_parse(text) from public, anon, authenticated;
revoke all on function public.banquet_apply(date, smallint, jsonb) from public, anon, authenticated;
revoke all on function public.banquet_sync() from public, anon, authenticated;
revoke all on function public.banquet_check() from public, anon;
revoke all on function public.banquet_state(date) from public, anon;
revoke all on function public.banquet_add(bigint, smallint) from public, anon;
revoke all on function public.banquet_remove(bigint, smallint) from public, anon;
revoke all on function public.banquet_claim(bigint, boolean, smallint) from public, anon;
revoke all on function public.banquet_mark(bigint, text, smallint) from public, anon;
grant execute on function public.banquet_check() to authenticated;
grant execute on function public.banquet_state(date) to authenticated;
grant execute on function public.banquet_add(bigint, smallint) to authenticated;
grant execute on function public.banquet_remove(bigint, smallint) to authenticated;
grant execute on function public.banquet_claim(bigint, boolean, smallint) to authenticated;
grant execute on function public.banquet_mark(bigint, text, smallint) to authenticated;
