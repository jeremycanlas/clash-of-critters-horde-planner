-- Proves the MVP banquet rules, then undoes everything it did.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/banquet_check.sql
--
-- Loads 013 to 015 inside the transaction too, so it can run before the migration is
-- applied. Discord is not asked: the test members are written straight into
-- banquet_members, which is what a yes from Discord leaves behind. A clean run
-- prints "banquet: ok"; it ends in ROLLBACK, so nothing survives.

begin;
\i supabase/migrations/013_banquet.sql
\i supabase/migrations/014_banquet_not_yet.sql
\i supabase/migrations/015_banquet_extras.sql

-- Real entries would skew the counts. Gone for this transaction only.
delete from public.banquet_claims; delete from public.banquet_full; delete from public.banquet_mvps; delete from public.banquet_extras;

insert into auth.users (id, aud, role, email)
values ('00000000-0000-4000-8000-00000000bb01', 'authenticated', 'authenticated', 'banquet-a@example.invalid'),
       ('00000000-0000-4000-8000-00000000bb02', 'authenticated', 'authenticated', 'banquet-b@example.invalid'),
       ('00000000-0000-4000-8000-00000000bb03', 'authenticated', 'authenticated', 'banquet-x@example.invalid');

insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), p, u::uuid, jsonb_build_object('name', n, 'full_name', n, 'sub', p), 'discord', now(), now(), now()
  from (values ('990000000000000101', '00000000-0000-4000-8000-00000000bb01', 'zz_a'),
               ('990000000000000102', '00000000-0000-4000-8000-00000000bb02', 'zz_b'),
               ('990000000000000103', '00000000-0000-4000-8000-00000000bb03', 'zz_x')) v(p, u, n);

-- A and B hold the role; X was checked and does not.
insert into public.banquet_members (discord_id, display, ok)
values ('990000000000000101', 'zz_a', true), ('990000000000000102', 'zz_b', true), ('990000000000000103', 'zz_x', false);

-- An old round, to prove history is browsable without sharing.
insert into public.banquet_mvps (round, discord_id, color, uid, by_name)
values ('2026-01-01', '990000000000000101', 1, 10000777, 'zz_a');

-- Rounds: every six days from 2026-09-30 08:00 Manila.
do $$
begin
  assert public.banquet_round('2026-09-30 07:59+08') = '2026-09-24', 'a minute before the end is the previous round';
  assert public.banquet_round('2026-09-30 08:00+08') = '2026-09-30', 'the end starts the round';
  assert public.banquet_round('2026-10-06 07:59+08') = '2026-09-30', 'lasts six days';
  assert public.banquet_round('2026-10-06 08:00+08') = '2026-10-06', 'then the next';
end $$;

set local role authenticated;

-- ---------------------------------------------------------------- X, no role
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000bb03","role":"authenticated"}', true);
do $$
begin
  begin perform public.banquet_state(); raise exception 'X read the state';
  exception when raise_exception then if sqlerrm = 'X read the state' then raise; end if; end;
  begin perform public.banquet_save_mvps(array[1,2,3,4]::bigint[]); raise exception 'X saved';
  exception when raise_exception then if sqlerrm = 'X saved' then raise; end if; end;
  begin perform count(*) from public.banquet_mvps; raise exception 'X read the table';
  exception when insufficient_privilege then null; end;
end $$;

-- ---------------------------------------------------------------- A shares
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000bb01","role":"authenticated"}', true);
do $$
declare s jsonb;
begin
  -- Tables are closed even to members.
  begin perform count(*) from public.banquet_claims; raise exception 'A read a table';
  exception when insufficient_privilege then null; end;

  begin perform public.banquet_save_mvps(array[10000005, 10000005, null, null]::bigint[]); raise exception 'dupe saved';
  exception when raise_exception then if sqlerrm = 'dupe saved' then raise; end if; end;

  perform public.banquet_save_mvps(array[10000101, 10000102, 10000103, null]::bigint[]);
  s := public.banquet_state();
  assert not (s ->> 'shared')::boolean, 'three is not sharing';
  assert jsonb_array_length(s -> 'banquets') = 0, 'nothing shown before sharing';
  assert (s ->> 'total')::int = 3, 'but the count is';

  begin perform public.banquet_claim(10000101, true); raise exception 'claimed before sharing';
  exception when raise_exception then if sqlerrm = 'claimed before sharing' then raise; end if; end;

  -- Past rounds are open to any member.
  s := public.banquet_state('2026-01-01');
  assert jsonb_array_length(s -> 'banquets') = 1, 'history is browsable';

  perform public.banquet_save_mvps(array[10000101, 10000102, 10000103, 10000104]::bigint[]);
  assert (public.banquet_state() ->> 'shared')::boolean, 'four is sharing';
end $$;

-- ---------------------------------------------------------------- B shares, claims
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000bb02","role":"authenticated"}', true);
do $$
declare s jsonb; b jsonb;
begin
  assert jsonb_array_length(public.banquet_state() -> 'banquets') = 0, 'B sees nothing yet';
  -- 10000104 is also A's: same camp, one banquet.
  perform public.banquet_save_mvps(array[10000201, 10000202, 10000203, 10000104]::bigint[]);
  s := public.banquet_state();
  assert jsonb_array_length(s -> 'banquets') = 7, 'seven distinct banquets';

  perform public.banquet_claim(10000101, true);
  perform public.banquet_claim(10000101, true);   -- twice is still once
  perform public.banquet_mark(10000102, 'full');
  perform public.banquet_mark(10000103, 'not-yet');
  perform public.banquet_mark(10000201, 'not-yet');
  perform public.banquet_mark(10000201, 'full');   -- one or the other
  begin perform public.banquet_claim(10000999, true); raise exception 'claimed a stranger';
  exception when raise_exception then if sqlerrm = 'claimed a stranger' then raise; end if; end;

  s := public.banquet_state();
  select x into b from jsonb_array_elements(s -> 'banquets') x where x ->> 'uid' = '10000101';
  assert (b ->> 'claims')::int = 1 and (b ->> 'claimed')::boolean, 'B claimed 10000101 once';
  select x into b from jsonb_array_elements(s -> 'banquets') x where x ->> 'uid' = '10000102';
  assert b ->> 'full' = 'zz_b', 'B marked 10000102 full';
  select x into b from jsonb_array_elements(s -> 'banquets') x where x ->> 'uid' = '10000103';
  assert b -> 'not_yet' ->> 'by' = 'zz_b' and b ->> 'full' is null, 'B marked 10000103 not yet';
  select x into b from jsonb_array_elements(s -> 'banquets') x where x ->> 'uid' = '10000201';
  assert b ->> 'full' = 'zz_b' and b -> 'not_yet' = 'null'::jsonb, 'Full replaced not yet on 10000201';
  begin perform public.banquet_mark(10000101, 'bogus'); raise exception 'bogus state';
  exception when raise_exception then if sqlerrm = 'bogus state' then raise; end if; end;
  select x into b from jsonb_array_elements(s -> 'banquets') x where x ->> 'uid' = '10000104';
  assert jsonb_array_length(b -> 'entered_by') = 2, 'both entered 10000104';
end $$;

-- ---------------------------------------------------------------- A sees B's work, undoes Full
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000bb01","role":"authenticated"}', true);
do $$
declare b jsonb;
begin
  select x into b from jsonb_array_elements(public.banquet_state() -> 'banquets') x where x ->> 'uid' = '10000101';
  assert (b ->> 'claims')::int = 1 and not (b ->> 'claimed')::boolean, 'B''s claim is not A''s';
  perform public.banquet_mark(10000102, null);
  select x into b from jsonb_array_elements(public.banquet_state() -> 'banquets') x where x ->> 'uid' = '10000102';
  assert b ->> 'full' is null, 'anyone can undo Full';
end $$;

-- ---------------------------------------------------------------- 8 digits, extras, clean-up
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000bb01","role":"authenticated"}', true);
do $$
declare s jsonb; b jsonb;
begin
  begin perform public.banquet_save_mvps(array[1000010, 10000102, 10000103, 10000104]::bigint[]); raise exception 'seven digits saved';
  exception when raise_exception then if sqlerrm = 'seven digits saved' then raise; end if; end;
  begin perform public.banquet_extra(123456789, true); raise exception 'nine digits added';
  exception when raise_exception then if sqlerrm = 'nine digits added' then raise; end if; end;

  -- An extra is a banquet like any other.
  perform public.banquet_extra(10000301, true);
  perform public.banquet_claim(10000301, true);
  perform public.banquet_mark(10000301, 'not-yet');
  select x into b from jsonb_array_elements(public.banquet_state() -> 'banquets') x where x ->> 'uid' = '10000301';
  assert (b ->> 'extra')::boolean and (b ->> 'mine_extra')::boolean and (b ->> 'claimed')::boolean, 'extra listed and claimable';
  assert b -> 'colors' = '[]'::jsonb, 'an extra has no colour';

  -- Removing it takes its claim and mark with it.
  perform public.banquet_extra(10000301, false);
  assert not exists (select 1 from jsonb_array_elements(public.banquet_state() -> 'banquets') x where x ->> 'uid' = '10000301'), 'extra removed';
  perform public.banquet_extra(10000301, true);
  select x into b from jsonb_array_elements(public.banquet_state() -> 'banquets') x where x ->> 'uid' = '10000301';
  assert (b ->> 'claims')::int = 0 and b -> 'not_yet' = 'null'::jsonb, 're-added starts clean';

  -- Editing a slot: 10000101 (B claimed it) is A's alone, so its claim goes;
  -- 10000104 is B's too, so B's marks on it stay.
  perform public.banquet_mark(10000104, 'full');
  perform public.banquet_save_mvps(array[10000111, 10000102, 10000103, 10000114]::bigint[]);
  s := public.banquet_state();
  assert not exists (select 1 from jsonb_array_elements(s -> 'banquets') x where x ->> 'uid' = '10000101'), '101 gone';
  select x into b from jsonb_array_elements(s -> 'banquets') x where x ->> 'uid' = '10000104';
  assert b ->> 'full' is not null, 'still listed by B, so still full';
  perform public.banquet_save_mvps(array[10000101, 10000102, 10000103, 10000114]::bigint[]);
  select x into b from jsonb_array_elements(public.banquet_state() -> 'banquets') x where x ->> 'uid' = '10000101';
  assert (b ->> 'claims')::int = 0, 'back again, but the old claim is not';
end $$;

-- ---------------------------------------------------------------- a stale yes expires
reset role;
update public.banquet_members set checked_at = now() - interval '31 minutes' where discord_id = '990000000000000101';
set local role authenticated;
do $$
begin
  begin perform public.banquet_state(); raise exception 'stale read';
  exception when raise_exception then if sqlerrm = 'stale read' then raise; end if; end;
end $$;

\echo banquet: ok
rollback;
