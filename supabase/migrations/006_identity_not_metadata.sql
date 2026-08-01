-- The name and the picture on a formation stop being things the poster can set.
-- Run after 005.
--
-- ## What was wrong
--
-- derive_formation() read the poster's display name and avatar from
-- `auth.users.raw_user_meta_data`. That column is not Discord's copy of who you
-- are -- it is the account's own metadata bag, and any signed-in user can
-- rewrite the whole of it with one authenticated call:
--
--   PUT /auth/v1/user   {"data": {"avatar_url": "...", "full_name": "..."}}
--
-- Verified against this project: the call returns 200. So a poster could set
--
--   * `avatar_url` to any URL at all. Every visitor's browser then fetches it
--     to draw the gallery -- and the card canvas fetches it again -- handing
--     the poster's chosen host the IP address and user agent of everyone who
--     scrolls past. A tracking pixel with somebody else's name on it.
--   * `full_name` / `custom_claims.global_name` to anyone else's display name,
--     because nothing anywhere checks that the name on a formation is the name
--     Discord issued.
--
-- Neither is cross-site scripting: both values are escaped in the DOM and drawn
-- as text on the canvas. It is a provenance bug. The fields claim to say who
-- posted this, and they were saying whatever the poster typed.
--
-- ## The fix
--
-- `auth.identities.identity_data` carries the same keys, written by GoTrue from
-- what the provider returned at sign-in. `updateUser` does not touch it. So the
-- trigger reads there instead, filtered to the discord identity, and the values
-- become the provider's rather than the account's.
--
-- The avatar is additionally constrained to Discord's own CDN. identity_data is
-- not user-writable today, and a URL that is fetched by every reader of the
-- gallery is worth two locks rather than one.

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

  -- Who posted it, from the provider rather than from the account. See above.
  select i.identity_data
    into ident
    from auth.identities i
   where i.user_id = new.author_id
     and i.provider = 'discord'
   order by i.last_sign_in_at desc nulls last
   limit 1;

  new.author_name := coalesce(ident -> 'custom_claims' ->> 'global_name',
                              ident ->> 'full_name',
                              ident ->> 'name',
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

-- Existing rows were written from the metadata bag. Re-derive them from the
-- provider so nothing already posted keeps a name or a picture its poster chose
-- for itself. Rows whose author has since deleted the identity keep 'Someone'.
update public.formations f
   set author_name = coalesce(i.identity_data -> 'custom_claims' ->> 'global_name',
                              i.identity_data ->> 'full_name',
                              i.identity_data ->> 'name',
                              'Someone'),
       author_avatar = case
         when i.identity_data ->> 'avatar_url' ~ '^https://cdn\.discordapp\.com/[A-Za-z0-9/._-]*$'
           then i.identity_data ->> 'avatar_url'
         else null
       end
  from auth.identities i
 where i.user_id = f.author_id
   and i.provider = 'discord';

notify pgrst, 'reload schema';
