-- A private player tracker: Support % per fruit for the players two people are
-- looking up by hand. Run after 009.
--
-- ## Who can see it
--
-- Nobody but the Discord accounts on public.tracker_members. The page that
-- shows it (tracker.html) is on the public site, so the page proves nothing;
-- every row is behind row-level security, checked by the database on every
-- read and write. A visitor who is not on the list gets an empty answer from
-- the API, not a hidden table.
--
-- ## How someone is recognised
--
-- By Discord, from auth.identities -- the provider's record, written by GoTrue
-- at sign-in and not writable by the user. Never from raw_user_meta_data,
-- which any signed-in user can rewrite with one call (see 006).
--
-- Members are added by Discord *username*, because that is what the owner
-- knows. A username can be given up and taken by somebody else, so the first
-- time a member signs in, tracker_claim() locks their Discord user ID into the
-- row; from then on only that ID matches, whatever the username becomes.

-- ---------------------------------------------------------------- the list

create table if not exists public.tracker_members (
  username   text primary key check (username = lower(username) and username <> ''),
  discord_id text unique,
  added_at   timestamptz not null default now()
);

alter table public.tracker_members enable row level security;
-- No policies and no grants: only the security-definer functions below read it.
revoke all on public.tracker_members from anon, authenticated;

-- Who is on it is not in this public repo: the members, like the player data,
-- are inserted by a private seed script kept outside git.

-- The caller's Discord identity, or nothing. Every candidate username field
-- GoTrue has been seen to write, lower-cased, with a legacy "#0" discriminator
-- stripped.
create or replace function public.tracker_caller()
returns table (discord_id text, usernames text[], display text)
language sql
stable
security definer
set search_path = public, auth
as $$
  select i.provider_id,
         array_remove(array[
           lower(regexp_replace(i.identity_data ->> 'name', '#0+$', '')),
           lower(regexp_replace(i.identity_data ->> 'full_name', '#0+$', '')),
           lower(i.identity_data ->> 'user_name'),
           lower(i.identity_data -> 'custom_claims' ->> 'preferred_username')
         ], null),
         coalesce(nullif(btrim(i.identity_data -> 'custom_claims' ->> 'global_name'), ''),
                  nullif(btrim(i.identity_data ->> 'full_name'), ''),
                  nullif(btrim(i.identity_data ->> 'name'), ''),
                  'Someone')
    from auth.identities i
   where i.user_id = auth.uid()
     and i.provider = 'discord'
   order by i.last_sign_in_at desc nulls last
   limit 1;
$$;

-- Used by the policies. Matches on the locked ID only: a member who has never
-- called tracker_claim() is not a member yet.
create or replace function public.is_tracker_member()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.tracker_members m
      join public.tracker_caller() c on m.discord_id = c.discord_id
  );
$$;

-- Called by the page on arrival. Locks the caller's Discord ID into their row
-- the first time their username matches, then answers whether they are in.
create or replace function public.tracker_claim()
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  me record;
begin
  select * into me from public.tracker_caller();
  if me.discord_id is null then return false; end if;

  update public.tracker_members m
     set discord_id = me.discord_id
   where m.discord_id is null
     and m.username = any (me.usernames)
     and not exists (select 1 from public.tracker_members x where x.discord_id = me.discord_id);

  return public.is_tracker_member();
end;
$$;

revoke all on function public.tracker_caller() from public, anon, authenticated;
revoke all on function public.is_tracker_member() from public, anon;
grant execute on function public.is_tracker_member() to authenticated;
revoke all on function public.tracker_claim() from public, anon;
grant execute on function public.tracker_claim() to authenticated;

-- ---------------------------------------------------------------- the data

create table if not exists public.tracker_players (
  uid         bigint primary key check (uid > 0),
  name        text not null default '' check (length(name) <= 60),
  aliases     text check (length(aliases) <= 200),
  -- Support % per fruit, as the game shows it. Null means not recorded yet.
  dragonfruit smallint check (dragonfruit between 0 and 999),
  bamboo      smallint check (bamboo between 0 and 999),
  carrot      smallint check (carrot between 0 and 999),
  phantom     smallint check (phantom between 0 and 999),
  clock       smallint check (clock between 0 and 999),
  berry       smallint check (berry between 0 and 999),
  -- When the numbers were read off the game. Null on rows imported from the
  -- spreadsheet, whose date is not known.
  checked_at  timestamptz,
  -- Written by the trigger, never by the client.
  updated_by  text,
  updated_at  timestamptz not null default now()
);

alter table public.tracker_players enable row level security;

drop policy if exists tracker_players_members on public.tracker_players;
create policy tracker_players_members on public.tracker_players
  for all to authenticated
  using (public.is_tracker_member())
  with check (public.is_tracker_member());

revoke all on public.tracker_players from anon;
grant select, insert, update, delete on public.tracker_players to authenticated;

-- Who and when come from the database: a client cannot claim somebody else
-- made its edit.
create or replace function public.tracker_stamp()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  new.updated_at := now();
  -- No signed-in caller means the maintainer's own import over psql.
  new.updated_by := coalesce((select display from public.tracker_caller()), 'Spreadsheet import');
  return new;
end;
$$;

drop trigger if exists tracker_players_stamp on public.tracker_players;
create trigger tracker_players_stamp
  before insert or update on public.tracker_players
  for each row execute function public.tracker_stamp();
