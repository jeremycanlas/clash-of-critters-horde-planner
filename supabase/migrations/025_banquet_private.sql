-- Private lists: a group with no Discord channel and no role, whose members are
-- named one by one. Run after 024.
--
-- For a handful of people to keep their own banquets, with everything the
-- group lists have: adding UIDs on the site, claims, full, not open. Only its
-- members see it. It is never part of "sees both": an Owner, Budboo Enjoyer or
-- Channel Admin who is not a member gets nothing of it, not in the list, not in
-- Possible copies. The sync skips it (no channel), so its UIDs come from the
-- site alone, and there is no four-to-see: its members are there by name.
--
-- Members, as the maintainer:
--   insert into public.banquet_group_members (grp, discord_id) values (3, '<discord id>');

alter table public.banquet_groups drop constraint if exists banquet_groups_grp_check;
alter table public.banquet_groups add constraint banquet_groups_grp_check check (grp between 1 and 9);
alter table public.banquet_groups alter column role_id drop not null;
alter table public.banquet_groups add column if not exists private boolean not null default false;
alter table public.banquet_groups add column if not exists name text;

create table if not exists public.banquet_group_members (
  grp        smallint not null references public.banquet_groups (grp) on delete cascade,
  discord_id text not null,
  primary key (grp, discord_id)
);
alter table public.banquet_group_members enable row level security;
revoke all on public.banquet_group_members from anon, authenticated;

-- A private list opens without four UIDs of your own.
create or replace function public.banquet_shared(sees_all boolean, who text, r date, g smallint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select sees_all
      or exists (select 1 from public.banquet_groups x where x.grp = g and x.private)
      or (select count(distinct uid) >= 4 from public.banquet_uids
           where round = r and grp = g and discord_id = who);
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
    grps := array(select g.grp from public.banquet_groups g where not g.private and g.role_id = any (roles) order by g.grp);
    all_ := roles && s.viewer_roles or cardinality(grps) > 1;
    -- Seeing both is both channel groups; a private list is never part of it.
    if all_ then grps := array(select g.grp from public.banquet_groups g where not g.private order by g.grp); end if;
    -- Private lists are by name, whatever the roles.
    grps := grps || array(select m.grp from public.banquet_group_members m where m.discord_id = me.discord_id order by m.grp);
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


create or replace function public.banquet_state_full(r date default null)
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
                 'posted', (select min(u.added_at) from public.banquet_uids u where u.round = r and u.grp = k.grp and u.uid = k.uid),
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
  ) || jsonb_build_object('synced_at', (select min(g.synced_at) from public.banquet_groups g where g.grp = any (you.groups)))
    || case when you.sees_all then jsonb_build_object(
         'groups', to_jsonb(you.groups),
         -- What to call each, and which are private: never folded into Both groups.
         'names', (select jsonb_object_agg(g.grp, coalesce(g.name, 'Group ' || g.grp)) from public.banquet_groups g where g.grp = any (you.groups)),
         'private', (select coalesce(jsonb_agg(g.grp order by g.grp), '[]') from public.banquet_groups g where g.grp = any (you.groups) and g.private))
       else '{}' end;
end;
$$;

revoke all on function public.banquet_state_full(date) from public, anon, authenticated;

create or replace function public.banquet_copies(r date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  you record;
  gs  smallint[];
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if not you.sees_all then raise exception 'Not for this account.'; end if;
  -- Only the channel groups the caller sees: a private list is nobody else's business.
  gs := array(select g.grp from public.banquet_groups g where g.grp = any (you.groups) and not g.private);
  r := coalesce(r, public.banquet_round());

  return jsonb_build_object(
    -- Everyone with at least one UID someone else posted first, worst first.
    'people', (
      select coalesce(jsonb_agg(p order by (p ->> 'all_copied')::boolean desc, (p ->> 'copied')::int desc, p ->> 'name'), '[]')
        from (
          select jsonb_build_object(
                   'name', min(u.by_name), 'grp', u.grp, 'uids', count(*),
                   'copied', count(f.uid), 'all_copied', count(f.uid) = count(*),
                   'items', jsonb_agg(jsonb_build_object(
                              'uid', u.uid::text, 'at', u.added_at, 'source', u.source,
                              'first_by', f.by_name, 'first_grp', f.grp, 'first_at', f.added_at)
                            order by u.added_at)) as p
            from public.banquet_uids u
            left join lateral (
              select o.uid, o.by_name, o.grp, o.added_at from public.banquet_uids o
               where o.round = r and o.grp = any (gs) and o.uid = u.uid and o.discord_id <> u.discord_id and o.added_at < u.added_at
               order by o.added_at limit 1) f on true
           where u.round = r and u.grp = any (gs)
           group by u.grp, u.discord_id
          having count(f.uid) > 0
        ) t),
    'both_groups', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'uid', uid::text,
               'groups', (select jsonb_object_agg(g, names) from (
                            select x.grp::text g, jsonb_agg(distinct x.by_name) names from public.banquet_uids x
                             where x.round = r and x.grp = any (gs) and x.uid = t.uid group by x.grp) y))
             order by uid), '[]')
        from (select uid from public.banquet_uids where round = r and grp = any (gs) group by uid having count(distinct grp) > 1) t)
  );
end;
$$;

