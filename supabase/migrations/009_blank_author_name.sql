-- A poster with no Discord display name stops being credited to nobody.
-- Run after 006. (007 and 008 are independent of this one and may be in any
-- order relative to it.)
--
-- ## What was wrong
--
-- derive_formation() picked the name to put on a formation with
--
--   coalesce(ident -> 'custom_claims' ->> 'global_name',
--            ident ->> 'full_name',
--            ident ->> 'name',
--            'Someone')
--
-- which reads as "the display name, or the username, or something". It is not.
-- coalesce steps over nulls, and `global_name` is not null when it is unset --
-- it is `""`. Discord returns no display name for an account that has never been
-- given one, and GoTrue writes that absence into identity_data as an empty
-- string rather than as JSON null. So `->> 'global_name'` yields `''`, coalesce
-- accepts it as a perfectly good value, and the chain stops at the first link.
--
-- The result is `formations.author_name = ''`, which the column allows: it is
-- `not null default ''`. Two of the three formations posted so far carry it.
--
-- Nothing errors. The card simply loses its byline, because card.js draws the
-- byline only when there is a name to draw -- `username.trim() ? ...` -- and an
-- empty string is a name in every check but that one. The poster's picture still
-- appears beside the list, so the gallery shows a face with nothing to call it.
--
-- ## The fix
--
-- Blank is absent. `nullif(btrim(...), '')` on each candidate makes coalesce
-- mean what the original was written to mean, and the fallback to the Discord
-- username -- which every account has -- is reached instead of skipped.
--
-- btrim as well as the empty check, so a name that is nothing but spaces is
-- treated the same way. It is the same rule the drafter applies to a formation's
-- own name.

create or replace function public.derive_formation()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  cells jsonb := coalesce(new.snapshot -> 'cells', 'null'::jsonb);
  board text;
  ident jsonb;
  avatar text;
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

  if exists (select 1 from unnest(new.slugs) as s
              where s !~ '^[a-z0-9][a-z0-9-]{0,39}$') then
    raise exception 'That formation names a Tatari this site cannot read'
      using errcode = '22000';
  end if;

  new.steps := coalesce(jsonb_array_length(new.snapshot -> 'plan'), 0);

  -- The board, and only the board. Renaming a formation or rewriting its note
  -- is not a new formation; moving one Tatari one tile is.
  --
  -- sha256() rather than pgcrypto's digest(): this function pins its own
  -- search_path (it must, being security definer), and Supabase installs
  -- pgcrypto into `extensions`, which is not on that path.
  select string_agg(coalesce((c ->> 'player') || '.' || (c ->> 'slug'), '-'), ',' order by i)
    into board
    from jsonb_array_elements(cells) with ordinality as t(c, i);

  new.fingerprint := encode(
    sha256(convert_to(new.mode || '|' || coalesce(board, ''), 'UTF8')), 'hex');

  -- Who posted it, from the provider rather than from the account. See 006.
  select i.identity_data
    into ident
    from auth.identities i
   where i.user_id = new.author_id
     and i.provider = 'discord'
   order by i.last_sign_in_at desc nulls last
   limit 1;

  -- nullif(btrim(...), '') on every candidate: an unset display name arrives as
  -- '' rather than as null, and a bare coalesce would stop on it. See above.
  new.author_name := coalesce(
    nullif(btrim(ident -> 'custom_claims' ->> 'global_name'), ''),
    nullif(btrim(ident ->> 'full_name'), ''),
    nullif(btrim(ident ->> 'name'), ''),
    'Someone');

  avatar := ident ->> 'avatar_url';
  -- Discord's CDN or nothing. A card with no face is a solved problem — the
  -- gallery already draws a monogram — and an arbitrary host is not.
  new.author_avatar := case
    when avatar ~ '^https://cdn\.discordapp\.com/[A-Za-z0-9/._-]*$' then avatar
    else null
  end;

  new.submitted_at := now();
  new.patch_id     := public.patch_at(now());
  new.score        := 0;
  new.hidden       := false;
  return new;
end;
$$;

-- Rows already posted with a blank name. Only those: a formation whose name was
-- derived correctly is left exactly as it is, so re-running this is not a way to
-- rewrite what anybody is already credited as.
update public.formations f
   set author_name = coalesce(
         nullif(btrim(i.identity_data -> 'custom_claims' ->> 'global_name'), ''),
         nullif(btrim(i.identity_data ->> 'full_name'), ''),
         nullif(btrim(i.identity_data ->> 'name'), ''),
         'Someone')
  from auth.identities i
 where i.user_id = f.author_id
   and i.provider = 'discord'
   and btrim(f.author_name) = '';

-- A poster who has since removed the Discord identity matches no row above and
-- would keep its blank name. There is nothing left to look them up by, so they
-- become the same 'Someone' a fresh insert would produce.
update public.formations
   set author_name = 'Someone'
 where btrim(author_name) = '';

notify pgrst, 'reload schema';
