-- Hardening, from an adversarial pass against a signed-in account with DevTools.
--
-- The model: somebody who has legitimately signed in with Discord, and then
-- calls the REST API by hand instead of using the page. They can send any body
-- they like to any endpoint the `authenticated` role can reach.
--
-- Most of what they might try was already refused, and by construction rather
-- than by luck -- the column grants mean `score`, `hidden` and `author_id` are
-- not theirs to set, the delete policy scopes to their own rows, and the votes
-- table cannot be written on anyone else's behalf. What follows is the part
-- that was not covered.

-- ---------------------------------------------------------------- app_version
--
-- Unbounded. A crafted post stored 500,000 characters in it, and would have
-- stored more -- the only ceiling was the row size Postgres will TOAST.
--
-- It is a version string. Sixteen characters is four times what "1.3.0" needs
-- and leaves room for a suffix nobody has invented yet.

alter table public.formations
  add constraint formations_version_len
  check (app_version is null or char_length(app_version) <= 16);

-- ---------------------------------------------------------------- field caps
--
-- `placed between 1 and 20` was the only limit, and 20 is right for co-op --
-- two players at ten each. It is wrong for solo, where the game allows fifteen,
-- so a hand-made request could post a solo board with twenty Tatari on it.
--
-- Nothing is compromised by that, but the gallery would draw a board that
-- cannot exist. The drafter would not: opening one runs reconcile(), which
-- trims to the legal cap. A picture that disagrees with what opening it gives
-- you is the kind of quiet wrongness principle 1 exists to refuse.

alter table public.formations
  add constraint formations_cap_ok
  check (placed <= case when mode = 'coop' then 20 else 15 end);

-- ---------------------------------------------------------------- slug shape
--
-- A slug is derived from a Tatari's name: lowercase, digits, hyphens, nothing
-- else. The database has no roster to check membership against -- that lives in
-- data/tatari.json -- so it cannot reject a slug that merely does not exist. It
-- can reject one that could not possibly be a slug, which bounds what a crafted
-- post can put into the aggregate counts the meta view will read.
--
-- This goes in the trigger rather than a CHECK because validating an array
-- needs a subquery, and CHECK constraints may not contain one.
--
-- Raise rather than filter. Quietly dropping half of what somebody sent and
-- storing the rest would make the stored formation disagree with the one they
-- posted, which is a worse failure than refusing it.
--
-- The client already handles an unknown-but-well-formed slug honestly: it draws
-- a marked gap rather than skipping the tile, and says how many in words.

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

-- ---------------------------------------------------------------- plan size
--
-- Bounded already by the 16 KB snapshot ceiling, but only incidentally. Fifteen
-- Tatari taken through seven levels is 105 steps; 200 is generous and stops a
-- crafted snapshot spending its whole budget on plan entries.

alter table public.formations
  add constraint formations_steps_ok
  check (steps between 0 and 200);

notify pgrst, 'reload schema';
