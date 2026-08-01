-- Corrective patch for 001_community.sql. Run after 001 and 001a.
--
-- Posting failed with an HTTP 404 that had nothing to do with a missing route.
--
-- derive_formation() is `security definer`, so it pins its own search_path —
-- that is the correct and necessary hardening for a definer function, because
-- without it a caller could shadow the tables it reads. But the pinned path was
-- `public, auth`, and the fingerprint was built with digest() from pgcrypto.
-- Supabase pre-installs pgcrypto into the `extensions` schema, not `public`, so
-- `create extension if not exists pgcrypto` in 001 was a no-op and digest() was
-- never on the path this function runs with. Postgres raised
--
--   42883  function digest(text, unknown) does not exist
--
-- and PostgREST reports an undefined function as 404, which reads as "no such
-- endpoint" and is nothing of the sort. The insert never ran.
--
-- The fix drops the dependency rather than widening the search_path: sha256()
-- has been in core Postgres since 11 and needs no extension, so there is no
-- schema to resolve and nothing to pin wrongly. gen_random_uuid() is likewise
-- core since 13, so 001's pgcrypto line is now vestigial and harmless.
--
-- The board string being hashed is unchanged, so fingerprints computed before
-- and after this patch are NOT comparable — but nothing was ever successfully
-- inserted, so there is nothing to migrate.

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

notify pgrst, 'reload schema';
