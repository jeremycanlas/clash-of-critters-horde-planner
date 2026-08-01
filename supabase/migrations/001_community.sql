-- Community formations: the tables a player's posted build lives in.
--
-- Run this in the Supabase SQL editor, then run the last line of this file --
-- PostgREST caches the schema and a brand new table is invisible to the API
-- until it reloads.
--
-- Phase 1 uses only the read half of this: an unauthenticated GET against the
-- formation_cards view. Everything to do with posting is defined here anyway,
-- because migrating a live table that is already behind row-level security is
-- the risky part, and doing it once is worth carrying a few unused columns.

-- gen_random_uuid() and sha256() are both core Postgres now, so nothing here
-- needs an extension. Left as a no-op guard for very old servers.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- patches
--
-- The game publishes no patch identifier anywhere this tool can read, so a
-- "patch" here is an editorial judgement about when the game changed, made by a
-- person, carrying a source link so the judgement can be checked rather than
-- trusted. data/patches.json in the repo is the authoring copy; this table is
-- what queries join against.

create table public.patches (
  id         bigint generated always as identity primary key,
  label      text        not null unique,
  starts_at  timestamptz not null,
  ends_at    timestamptz,                 -- null = the current, open-ended one
  note       text,
  source_url text,
  created_at timestamptz not null default now(),
  constraint patches_label_len check (char_length(label) between 1 and 24),
  constraint patches_window    check (ends_at is null or ends_at > starts_at)
);

-- No two patches cover the same instant, and only one can be open-ended --
-- a second open-ended window would necessarily overlap the first. This is what
-- lets patch_at() say `limit 1` honestly rather than picking arbitrarily.
alter table public.patches
  add constraint patches_no_overlap
  exclude using gist (tstzrange(starts_at, ends_at, '[)') with &&);

create or replace function public.patch_at(at timestamptz)
returns bigint
language sql
stable
as $$
  select p.id
    from public.patches p
   where tstzrange(p.starts_at, p.ends_at, '[)') @> at
   limit 1;
$$;

-- ---------------------------------------------------------------- formations

create table public.formations (
  id            uuid        primary key default gen_random_uuid(),
  author_id     uuid        not null default auth.uid()
                            references auth.users(id) on delete cascade,
  author_name   text        not null default '',
  author_avatar text,
  name          text        not null,
  note          text,
  snapshot      jsonb       not null,     -- a store.snapshot(), verbatim
  app_version   text,

  -- Everything below is derived by derive_formation(). The client sends four
  -- columns and cannot write any of these; see the grants at the bottom.
  mode          text        not null default 'solo',
  slugs         text[]      not null default '{}',
  placed        smallint    not null default 0,
  steps         smallint    not null default 0,
  fingerprint   text        not null default '',
  submitted_at  timestamptz not null default now(),
  patch_id      bigint      references public.patches(id) on delete set null,
  score         integer     not null default 0,
  hidden        boolean     not null default false,

  constraint formations_name_len  check (char_length(name) between 1 and 60),
  constraint formations_note_len  check (note is null or char_length(note) <= 240),
  constraint formations_mode_ok   check (mode in ('solo','coop')),
  constraint formations_placed_ok check (placed between 1 and 20),
  constraint formations_slugs_ok  check (cardinality(slugs) between 1 and 30),
  -- length(snapshot::text) rather than pg_column_size(): a CHECK needs an
  -- IMMUTABLE expression, and jsonb_out is one. 16 KB is about four times the
  -- largest legal snapshot (36 cells, 15 plan steps, 140-character notes).
  constraint formations_size      check (length(snapshot::text) <= 16384),
  -- One person cannot post the same board twice. Two different people posting
  -- the same board is allowed: those are two endorsements with two notes.
  constraint formations_one_per_author unique (author_id, fingerprint)
);

-- ---------------------------------------------------------------- derivation
--
-- The client sends name, note, snapshot and app_version. Everything else about
-- a formation is read off the snapshot here, on the server.
--
-- This is not tidiness. If a client could declare its own `slugs`, it could
-- claim a formation containing fifteen Tatari it does not contain, and the
-- community usage counts -- the whole point of the meta view in 003 -- would be
-- forgeable by anyone with curl.
--
-- security definer so it can read auth.users for the Discord display name,
-- which `authenticated` cannot see.

create or replace function public.derive_formation()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  cells jsonb := coalesce(new.snapshot -> 'cells', 'null'::jsonb);
  board text;
begin
  if jsonb_typeof(cells) <> 'array' or jsonb_array_length(cells) <> 36 then
    raise exception 'That formation is not shaped like a 6x6 field' using errcode = '22000';
  end if;

  new.mode := case when new.snapshot ->> 'mode' = 'coop' then 'coop' else 'solo' end;

  select coalesce(array_agg(distinct c ->> 'slug'), '{}'),
         count(*)
    into new.slugs, new.placed
    from jsonb_array_elements(cells) as c
   where jsonb_typeof(c) = 'object' and c ->> 'slug' is not null;

  new.steps := coalesce(jsonb_array_length(new.snapshot -> 'plan'), 0);

  -- The board, and only the board. Renaming a formation or rewriting its note
  -- is not a new formation; moving one Tatari one tile is.
  --
  -- sha256() rather than pgcrypto's digest(): this function pins its own
  -- search_path (it must, being security definer), and Supabase installs
  -- pgcrypto into `extensions`, which is not on that path. sha256() is core
  -- Postgres, so there is no schema to resolve and nothing to get wrong.
  select string_agg(coalesce((c ->> 'player') || '.' || (c ->> 'slug'), '-'), ',' order by i)
    into board
    from jsonb_array_elements(cells) with ordinality as t(c, i);

  new.fingerprint := encode(
    sha256(convert_to(new.mode || '|' || coalesce(board, ''), 'UTF8')), 'hex');

  select coalesce(u.raw_user_meta_data -> 'custom_claims' ->> 'global_name',
                  u.raw_user_meta_data ->> 'full_name',
                  u.raw_user_meta_data ->> 'name',
                  'Someone'),
         u.raw_user_meta_data ->> 'avatar_url'
    into new.author_name, new.author_avatar
    from auth.users u
   where u.id = new.author_id;

  new.submitted_at := now();
  new.patch_id     := public.patch_at(now());
  new.score        := 0;
  new.hidden       := false;
  return new;
end;
$$;

create trigger formations_derive
before insert on public.formations
for each row execute function public.derive_formation();

-- ---------------------------------------------------------------- rate limit
--
-- security definer, because a security invoker trigger runs as `authenticated`
-- and the select policy below hides `hidden` rows -- which would let someone
-- whose spam had just been taken down reset their own hourly count by getting
-- taken down.

create or replace function public.limit_submissions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.formations
       where author_id = new.author_id
         and submitted_at > now() - interval '1 hour') >= 5 then
    raise exception 'Five posts an hour is the limit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger formations_limit
before insert on public.formations
for each row execute function public.limit_submissions();

-- ---------------------------------------------------------------- indexes

create index formations_rank_idx on public.formations (patch_id, score desc, submitted_at desc)
  where not hidden;
create index formations_new_idx on public.formations (submitted_at desc)
  where not hidden;
create index formations_slugs_idx on public.formations using gin (slugs);
create index formations_author_idx on public.formations (author_id);

-- ---------------------------------------------------------------- row security

alter table public.patches    enable row level security;
alter table public.formations enable row level security;

-- There is deliberately no insert/update/delete policy on patches at all, so
-- only service_role -- which bypasses RLS -- can write them. That is
-- tools/patches.mjs, and nothing else.
create policy patches_read on public.patches
  for select to anon, authenticated
  using (true);

create policy formations_read on public.formations
  for select to anon, authenticated
  using (not hidden);

create policy formations_insert on public.formations
  for insert to authenticated
  with check (author_id = (select auth.uid()));

create policy formations_delete on public.formations
  for delete to authenticated
  using (author_id = (select auth.uid()));

-- No update policy either. A formation is immutable once posted: editing it
-- would silently change what other people already voted for. Delete and repost.

-- ---------------------------------------------------------------- grants
--
-- Supabase grants `all` on new tables in `public` to anon and authenticated by
-- default, and row-level security does not restrict *which columns* an insert
-- may set. Without these, a client could post a row with score = 999.

revoke all on public.formations from anon, authenticated;

-- `hidden` is in this list for a reason that is easy to miss: formation_cards
-- below is a security_invoker view, so its own `where not hidden` runs as the
-- caller and needs read privilege on the column it filters. Without it every
-- read of the view fails with "permission denied for table formations", which
-- looks like a policy problem and is not one.
--
-- Publishing it leaks nothing: row-level security means the only rows anyone
-- can reach already have hidden = false, so the column reads as a constant.
grant select (id, name, note, snapshot, mode, slugs, placed, steps, author_name,
              app_version, submitted_at, patch_id, score, hidden)
  on public.formations to anon, authenticated;

-- author_id is absent from both lists on purpose. It defaults to auth.uid(), so
-- a client never needs to send it and structurally cannot forge it -- and not
-- publishing it means two formations cannot be tied to one person by a reader.
grant insert (name, note, snapshot, app_version)
  on public.formations to authenticated;

grant delete on public.formations to authenticated;
grant select on public.patches to anon, authenticated;

-- ---------------------------------------------------------------- list view
--
-- A list of twenty cards needs the cells to draw the map and nothing else.
-- Opening one fetches the full snapshot by id. That roughly halves the payload
-- of the one request every visitor makes, which matters at 75% mobile.
--
-- security_invoker = on is load-bearing: without it a view runs as its owner and
-- bypasses the formations policies entirely, publishing hidden rows to everyone.

create or replace view public.formation_cards
with (security_invoker = on) as
  select id, name, note, mode, slugs, placed, steps, author_name,
         submitted_at, patch_id, score,
         snapshot -> 'cells' as cells
    from public.formations
   where not hidden;

grant select on public.formation_cards to anon, authenticated;

-- ---------------------------------------------------------------- finally
notify pgrst, 'reload schema';
