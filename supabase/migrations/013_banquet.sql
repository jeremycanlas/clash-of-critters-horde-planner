-- MVP banquets: after every gold rush each colour has an MVP, and the first 50
-- players to visit that MVP's camp claim pinballs from its banquet. Members of
-- one Discord server share their MVPs' UIDs here and track who has claimed
-- what. Run after 012.
--
-- ## Who can use it
--
-- Anybody signed in with Discord who holds one role in one Discord server. The
-- database asks Discord itself, through a bot, on the member's behalf: the page
-- proves nothing. Setting it up, as the maintainer, over psql:
--
--   update public.banquet_settings set guild_id = '<server id>', role_id = '<role id>';
--   select vault.create_secret('<bot token>', 'banquet_bot_token');
--
-- The bot needs no permissions and no intents, only to be in the server:
-- fetching one member by ID is allowed to any bot that can see the server.
-- Swapping the test server for the real one is the same update again.
--
-- ## Share to see
--
-- The current round's UIDs are only shown to a member who has entered all four
-- of their own. Past rounds are over, so any member can browse them.
--
-- ## No table is readable directly
--
-- Every read goes through banquet_state() and every write through the three
-- functions below it, so the share-to-see rule lives in one place rather than
-- in a policy on each table.

create extension if not exists http with schema extensions;

-- ---------------------------------------------------------------- settings

create table if not exists public.banquet_settings (
  id       boolean primary key default true check (id),
  guild_id text,
  role_id  text
);
insert into public.banquet_settings (id) values (true) on conflict do nothing;

alter table public.banquet_settings enable row level security;
revoke all on public.banquet_settings from anon, authenticated;

-- ---------------------------------------------------------------- members

-- Discord's last answer per person. Nobody reads this but the functions here.
create table if not exists public.banquet_members (
  discord_id text primary key,
  display    text not null,
  ok         boolean not null,
  checked_at timestamptz not null default now()
);

alter table public.banquet_members enable row level security;
revoke all on public.banquet_members from anon, authenticated;

-- The caller's Discord ID when Discord said yes in the last half hour, else
-- null. The page re-checks every ten minutes, so a removed role locks the page
-- within minutes and the API within half an hour.
create or replace function public.banquet_me()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select m.discord_id
    from public.banquet_members m
    join public.tracker_caller() c on c.discord_id = m.discord_id
   where m.ok and m.checked_at > now() - interval '30 minutes';
$$;

-- Called by the page on arrival and every ten minutes after. Answers one of:
--   ok, no-role, signed-out, not-set-up, discord-down
create or replace function public.banquet_check()
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, extensions
as $$
declare
  me   record;
  held record;
  s    record;
  tok  text;
  res  extensions.http_response;
  body jsonb;
  yes  boolean;
begin
  select * into me from public.tracker_caller();
  if me.discord_id is null then return 'signed-out'; end if;

  -- Ten minutes of Discord's answer is plenty, and keeps a busy evening well
  -- inside Discord's rate limit.
  select * into held from public.banquet_members where discord_id = me.discord_id;
  if held.checked_at > now() - interval '10 minutes' then
    return case when held.ok then 'ok' else 'no-role' end;
  end if;

  select * into s from public.banquet_settings;
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'banquet_bot_token';
  if s.guild_id is null or s.role_id is null or tok is null then return 'not-set-up'; end if;

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
    yes := coalesce(body -> 'roles' ? s.role_id, false);
  elsif res.status = 404 and body ->> 'code' = '10007' then
    yes := false;                 -- Unknown Member: not in the server
  elsif res.status in (401, 403, 404) then
    return 'not-set-up';          -- bad token, bot not in the server, bad server ID
  else
    return 'discord-down';        -- 429 or 5xx
  end if;

  insert into public.banquet_members (discord_id, display, ok, checked_at)
  values (me.discord_id, me.display, yes, now())
  on conflict (discord_id) do update set display = excluded.display, ok = excluded.ok, checked_at = now();

  return case when yes then 'ok' else 'no-role' end;
end;
$$;

-- ---------------------------------------------------------------- rounds

-- A gold rush ends every six days at 8am Manila time, the first on 2026-09-30.
-- A round is named by the Manila date its gold rush ended, and everything
-- entered belongs to the one that ended most recently.
create or replace function public.banquet_round(at timestamptz default now())
returns date
language sql
stable
as $$
  select ((timestamptz '2026-09-30 08:00+08'
           + floor(extract(epoch from at - timestamptz '2026-09-30 08:00+08') / 518400) * interval '6 days')
          at time zone 'Asia/Manila')::date;
$$;

-- ---------------------------------------------------------------- data

create table if not exists public.banquet_mvps (
  round      date not null,
  discord_id text not null,
  color      smallint not null check (color between 1 and 4),
  uid        bigint not null check (uid > 0 and uid < 1000000000000000),
  by_name    text not null,
  updated_at timestamptz not null default now(),
  primary key (round, discord_id, color)
);
create index if not exists banquet_mvps_uid on public.banquet_mvps (round, uid);

create table if not exists public.banquet_claims (
  round      date not null,
  uid        bigint not null,
  discord_id text not null,
  by_name    text not null,
  claimed_at timestamptz not null default now(),
  primary key (round, uid, discord_id)
);

create table if not exists public.banquet_full (
  round     date not null,
  uid       bigint not null,
  by_name   text not null,
  marked_at timestamptz not null default now(),
  primary key (round, uid)
);

alter table public.banquet_mvps   enable row level security;
alter table public.banquet_claims enable row level security;
alter table public.banquet_full   enable row level security;
revoke all on public.banquet_mvps, public.banquet_claims, public.banquet_full from anon, authenticated;

create or replace function public.banquet_shared(me text, r date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select count(*) = 4 from public.banquet_mvps where round = r and discord_id = me;
$$;

-- ---------------------------------------------------------------- reads

-- Everything the page shows for one round (the current one when r is null).
create or replace function public.banquet_state(r date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  me   text := public.banquet_me();
  now_ date := public.banquet_round();
  shared boolean;
begin
  if me is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  r := coalesce(r, now_);
  shared := public.banquet_shared(me, r);

  return jsonb_build_object(
    'round', r,
    'current', now_,
    'rounds', (select coalesce(jsonb_agg(x order by x desc), '[]')
                 from (select distinct round as x from public.banquet_mvps
                       union select now_) t),
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('color', color, 'uid', uid::text) order by color), '[]')
               from public.banquet_mvps where round = r and discord_id = me),
    'shared', shared,
    'total', (select count(distinct uid) from public.banquet_mvps where round = r),
    'banquets', case when r < now_ or shared then (
      select coalesce(jsonb_agg(b), '[]')
        from (
          select jsonb_build_object(
                   -- As text: a UID can pass 2^53, where a JSON number stops being exact.
                   'uid', m.uid::text,
                   'colors', (select jsonb_agg(distinct color) from public.banquet_mvps x where x.round = r and x.uid = m.uid),
                   'entered_by', (select jsonb_agg(distinct by_name) from public.banquet_mvps x where x.round = r and x.uid = m.uid),
                   'claims', (select count(*) from public.banquet_claims c where c.round = r and c.uid = m.uid),
                   'claimed_by', (select coalesce(jsonb_agg(by_name order by claimed_at), '[]') from public.banquet_claims c where c.round = r and c.uid = m.uid),
                   'claimed', exists (select 1 from public.banquet_claims c where c.round = r and c.uid = m.uid and c.discord_id = me),
                   'full', (select f.by_name from public.banquet_full f where f.round = r and f.uid = m.uid)
                 ) as b
            from (select distinct uid from public.banquet_mvps where round = r) m
        ) t)
      else '[]'::jsonb end
  );
end;
$$;

-- ---------------------------------------------------------------- writes
-- All three only ever touch the current round: history is not editable.

-- Replaces the caller's MVPs for this round. Four slots in colour order; a
-- null is a colour not known yet.
create or replace function public.banquet_save_mvps(uids bigint[])
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  me  text := public.banquet_me();
  r   date := public.banquet_round();
  who text := (select display from public.tracker_caller());
begin
  if me is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if cardinality(uids) <> 4 then raise exception 'Four MVPs, one per colour.'; end if;
  if exists (select 1 from unnest(uids) u where u is not null and (u <= 0 or u >= 1000000000000000)) then
    raise exception 'A UID is a whole number, up to 15 digits.';
  end if;
  if (select count(u) <> count(distinct u) from unnest(uids) u) then
    raise exception 'The same UID is in two colours.';
  end if;

  delete from public.banquet_mvps where round = r and discord_id = me;
  insert into public.banquet_mvps (round, discord_id, color, uid, by_name)
  select r, me, i, uids[i], who from generate_series(1, 4) i where uids[i] is not null;
end;
$$;

create or replace function public.banquet_claim(target bigint, claimed boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  me text := public.banquet_me();
  r  date := public.banquet_round();
begin
  if me is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if not public.banquet_shared(me, r) then raise exception 'Enter your four MVPs first.'; end if;
  if claimed then
    if not exists (select 1 from public.banquet_mvps where round = r and uid = target) then
      raise exception 'That banquet is not in this round.';
    end if;
    insert into public.banquet_claims (round, uid, discord_id, by_name)
    values (r, target, me, (select display from public.tracker_caller()))
    on conflict do nothing;
  else
    delete from public.banquet_claims where round = r and uid = target and discord_id = me;
  end if;
end;
$$;

-- Anyone can mark a banquet full, and anyone can take it back: whoever got
-- there and found nothing left knows best.
create or replace function public.banquet_mark_full(target bigint, is_full boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  me text := public.banquet_me();
  r  date := public.banquet_round();
begin
  if me is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if not public.banquet_shared(me, r) then raise exception 'Enter your four MVPs first.'; end if;
  if is_full then
    if not exists (select 1 from public.banquet_mvps where round = r and uid = target) then
      raise exception 'That banquet is not in this round.';
    end if;
    insert into public.banquet_full (round, uid, by_name)
    values (r, target, (select display from public.tracker_caller()))
    on conflict do nothing;
  else
    delete from public.banquet_full where round = r and uid = target;
  end if;
end;
$$;

-- ---------------------------------------------------------------- grants

revoke all on function public.banquet_me() from public, anon, authenticated;
revoke all on function public.banquet_shared(text, date) from public, anon, authenticated;
revoke all on function public.banquet_round(timestamptz) from public, anon;
revoke all on function public.banquet_check() from public, anon;
revoke all on function public.banquet_state(date) from public, anon;
revoke all on function public.banquet_save_mvps(bigint[]) from public, anon;
revoke all on function public.banquet_claim(bigint, boolean) from public, anon;
revoke all on function public.banquet_mark_full(bigint, boolean) from public, anon;
grant execute on function public.banquet_round(timestamptz) to authenticated;
grant execute on function public.banquet_check() to authenticated;
grant execute on function public.banquet_state(date) to authenticated;
grant execute on function public.banquet_save_mvps(bigint[]) to authenticated;
grant execute on function public.banquet_claim(bigint, boolean) to authenticated;
grant execute on function public.banquet_mark_full(bigint, boolean) to authenticated;
