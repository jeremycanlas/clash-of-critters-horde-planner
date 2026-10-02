-- Gold Rush formations in Community. Run after 029.
--
-- The drafter's Gold Rush mode (1.9.6) plans the 5 x 5 board Gold Rush and
-- Arena use. A post's mode was solo or coop, derived from the snapshot; a Gold
-- Rush one now derives as 'goldrush', from the snapshot's goldRush flag, so
-- the gallery can list and filter it as itself rather than as a Horde build.
-- Its 15 deployed sit under the same cap as Solo.
--
-- derive_formation() below is the live function as it stood (it accepts 36 or
-- 78 cells, which the repo's 009 never caught up with), changed in the one line
-- that sets the mode.

alter table public.formations drop constraint if exists formations_mode_ok;
alter table public.formations add constraint formations_mode_ok check (mode in ('solo', 'coop', 'goldrush'));

CREATE OR REPLACE FUNCTION public.derive_formation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$

declare

  cells jsonb := coalesce(new.snapshot -> 'cells', 'null'::jsonb);

  board text;

  ident jsonb;

  avatar text;

begin

  -- 36 = the 6x6 field; 78 = the field plus the seven beyond-the-line rows.

  if jsonb_typeof(cells) <> 'array' or jsonb_array_length(cells) not in (36, 78) then

    raise exception 'That formation is not shaped like a 6x6 field' using errcode = '22000';

  end if;



  -- Gold Rush first: its formations are Solo underneath, with the flag on top.
  new.mode := case
    when new.snapshot ->> 'goldRush' = 'true' then 'goldrush'
    when new.snapshot ->> 'mode' = 'coop' then 'coop'
    else 'solo'
  end;



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

  -- '' rather than as null, and a bare coalesce would stop on it. See 009.

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

$function$;
