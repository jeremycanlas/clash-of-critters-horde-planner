-- Proves the MVP banquet rules, then undoes everything it did.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/banquet_check.sql
--
-- Loads 013 to 017 inside the transaction too, so it can run before a
-- migration is applied. Discord is not asked: members are written straight
-- into banquet_members, which is what Discord's yes leaves behind, and channel
-- posts go through banquet_apply(), which is what banquet_sync() hands them
-- to. A clean run prints "banquet: ok"; it ends in ROLLBACK.

begin;
\i supabase/migrations/013_banquet.sql
\i supabase/migrations/014_banquet_not_yet.sql
\i supabase/migrations/015_banquet_extras.sql
\i supabase/migrations/016_banquet_groups.sql
\i supabase/migrations/017_banquet_synced_at.sql

-- Real entries would skew the counts. Gone for this transaction only.
delete from public.banquet_claims; delete from public.banquet_marks; delete from public.banquet_uids;
delete from public.banquet_groups; delete from public.banquet_members;
insert into public.banquet_groups (grp, role_id, channel_id, synced_at) values
  (1, 'r1', 'c1', now() - interval '2 minutes'), (2, 'r2', 'c2', now() - interval '9 minutes');

-- A and B are Group 1, C is Group 2, V sees both, X was refused.
insert into auth.users (id, aud, role, email)
select ('00000000-0000-4000-8000-0000000000d' || n)::uuid, 'authenticated', 'authenticated', 'bq' || n || '@example.invalid'
  from generate_series(1, 5) n;
insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), '99000000000000030' || n, ('00000000-0000-4000-8000-0000000000d' || n)::uuid,
       jsonb_build_object('name', nm, 'full_name', nm), 'discord', now(), now(), now()
  from (values (1, 'zz_a'), (2, 'zz_b'), (3, 'zz_c'), (4, 'zz_v'), (5, 'zz_x')) v(n, nm);
insert into public.banquet_members (discord_id, display, ok, groups, sees_all) values
  ('990000000000000301', 'zz_a', true, '{1}', false),
  ('990000000000000302', 'zz_b', true, '{1}', false),
  ('990000000000000303', 'zz_c', true, '{2}', false),
  ('990000000000000304', 'zz_v', true, '{1,2}', true),
  ('990000000000000305', 'zz_x', false, '{}', false);

create function pg_temp.as_(n int) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000000d' || n, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.msg(id text, author text, content text, bot boolean default false) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'content', content, 'timestamp', now(),
         'author', jsonb_build_object('id', author, 'username', 'u' || right(author, 3), 'bot', bot));
$$;
create function pg_temp.card(s jsonb, uid text) returns jsonb language sql as $$
  select x from jsonb_array_elements(s -> 'banquets') x where x ->> 'uid' = uid;
$$;

-- ---------------------------------------------------------------- pure parts
do $$
begin
  assert array(select public.banquet_parse('`12345678` / ‘87654321’ 123456789 1234567 x11112222y 12345678') order by 1)
         = '{11112222,12345678,87654321}'::bigint[], 'eight digits, any quoting, no longer or shorter';
  assert public.banquet_round('2026-09-30 07:59+08') = '2026-09-24', 'a minute before the end is the previous round';
  assert public.banquet_round('2026-09-30 08:00+08') = '2026-09-30', 'the end starts the round';
  assert public.banquet_round('2026-10-06 07:59+08') = '2026-09-30', 'lasts six days';
end $$;

-- ---------------------------------------------------------------- the channels
-- A posts two UIDs, then one more; B posts four at once; a bot posts one; C
-- posts four in the other channel. 55555555 is in both channels.
select public.banquet_apply(public.banquet_round(), 1::smallint, jsonb_build_array(
  pg_temp.msg('m1', '990000000000000301', E'`10000001`\n`10000002`'),
  pg_temp.msg('m2', '990000000000000301', '‘10000003’'),
  pg_temp.msg('m3', '990000000000000302', E'`20000001`\n`20000002`\n`20000003`\n`55555555`'),
  pg_temp.msg('m4', '990000000000000399', '`99999999`', true),
  pg_temp.msg('m5', '990000000000000301', '`10000001` again')));
select public.banquet_apply(public.banquet_round(), 2::smallint, jsonb_build_array(
  pg_temp.msg('w1', '990000000000000303', E'30000001 30000002 30000003 55555555')));

set local role authenticated;

-- ---------------------------------------------------------------- X, refused
select pg_temp.as_(5);
do $$
begin
  begin perform public.banquet_state(); raise exception 'X read the state';
  exception when raise_exception then if sqlerrm = 'X read the state' then raise; end if; end;
  begin perform count(*) from public.banquet_uids; raise exception 'X read the table';
  exception when insufficient_privilege then null; end;
end $$;

-- ---------------------------------------------------------------- A, three posted
select pg_temp.as_(1);
do $$
declare s jsonb;
begin
  begin perform count(*) from public.banquet_claims; raise exception 'A read a table';
  exception when insufficient_privilege then null; end;

  s := public.banquet_state();
  assert jsonb_array_length(s -> 'mine') = 3, 'A''s posts, in two goes, filled in: 3';
  assert not (s ->> 'shared')::boolean and jsonb_array_length(s -> 'banquets') = 0, 'three is not enough';
  assert (s ->> 'total')::int = 7, 'Group 1 only, bots ignored';

  begin perform public.banquet_claim(20000001, true); raise exception 'claimed early';
  exception when raise_exception then if sqlerrm = 'claimed early' then raise; end if; end;

  -- The fourth on the site. Sent for Group 2, it still lands in Group 1.
  perform public.banquet_add(10000004, 2::smallint);
  s := public.banquet_state();
  assert (s ->> 'shared')::boolean and jsonb_array_length(s -> 'banquets') = 8, 'four unlocks Group 1''s eight';
  assert s::text not like '%grp%' and s::text not like '%groups%', 'nothing says there are groups';
  assert s::text not like '%3000000%' and s::text not like '%zz_c%' and s::text not like '%u303%', 'nothing of Group 2';
  assert (s ->> 'synced_at')::timestamptz = now() - interval '2 minutes', 'A gets Group 1''s last read only';

  begin perform public.banquet_add(1234567); raise exception 'seven digits added';
  exception when raise_exception then if sqlerrm = 'seven digits added' then raise; end if; end;

  perform public.banquet_claim(55555555, true);
  perform public.banquet_mark(20000002, 'full');
  -- A posted one cannot be removed on the site.
  perform public.banquet_remove(10000001);
  assert pg_temp.card(public.banquet_state(), '10000001') is not null, 'posted stays';
end $$;

-- ---------------------------------------------------------------- C, the other group
select pg_temp.as_(3);
do $$
declare s jsonb;
begin
  s := public.banquet_state();
  assert (s ->> 'shared')::boolean and jsonb_array_length(s -> 'banquets') = 4, 'C sees Group 2''s four';
  assert (pg_temp.card(s, '55555555') ->> 'claims')::int = 0, 'A''s claim on the shared UID is Group 1''s';
  assert s::text not like '%grp%' and s::text not like '%1000000%' and s::text not like '%zz_a%', 'nothing of Group 1';
  perform public.banquet_mark(55555555, 'not-yet');
end $$;

-- ---------------------------------------------------------------- V, both
select pg_temp.as_(4);
do $$
declare s jsonb;
begin
  s := public.banquet_state();
  assert s -> 'groups' = '[1, 2]'::jsonb, 'V is told there are two';
  assert (s ->> 'synced_at')::timestamptz = now() - interval '9 minutes', 'V gets the staler of the two';
  assert jsonb_array_length(s -> 'banquets') = 12, 'eight and four, 55555555 once per group';
  assert (select count(*) from jsonb_array_elements(s -> 'banquets') x where x ->> 'uid' = '55555555') = 2, 'one card per group';
  assert (select bool_and(x ? 'grp') from jsonb_array_elements(s -> 'banquets') x), 'every card says its group';
  assert (select x -> 'not_yet' ->> 'by' from jsonb_array_elements(s -> 'banquets') x where x ->> 'uid' = '55555555' and x ->> 'grp' = '2') = 'zz_c',
         'C''s mark is on Group 2''s card';
  assert (select (x ->> 'claims')::int from jsonb_array_elements(s -> 'banquets') x where x ->> 'uid' = '55555555' and x ->> 'grp' = '1') = 1,
         'A''s claim is on Group 1''s card';

  begin perform public.banquet_add(40000001); raise exception 'no group picked';
  exception when raise_exception then if sqlerrm = 'no group picked' then raise; end if; end;
  perform public.banquet_add(40000001, 2::smallint);
  perform public.banquet_claim(20000001, true, 1::smallint);
end $$;

select pg_temp.as_(1);
do $$ begin
  assert pg_temp.card(public.banquet_state(), '40000001') is null, 'V''s Group 2 add is not in Group 1';
  assert (pg_temp.card(public.banquet_state(), '20000001') ->> 'claims')::int = 1, 'V''s Group 1 claim is';
end $$;

-- ---------------------------------------------------------------- an edit in Discord
-- B edits 55555555 out of their post. A's claim on it goes with it, in Group 1
-- only: C's mark in Group 2 stays.
reset role;
select public.banquet_apply(public.banquet_round(), 1::smallint, jsonb_build_array(
  pg_temp.msg('m1', '990000000000000301', E'`10000001`\n`10000002`'),
  pg_temp.msg('m2', '990000000000000301', '‘10000003’'),
  pg_temp.msg('m3', '990000000000000302', E'`20000001`\n`20000002`\n`20000003`\n`20000004`')));
set local role authenticated;
select pg_temp.as_(1);
do $$ begin
  assert pg_temp.card(public.banquet_state(), '55555555') is null, 'edited out of Group 1';
  assert jsonb_array_length(public.banquet_state() -> 'mine') = 4, 'A''s site add survived the sync';
end $$;
select pg_temp.as_(3);
do $$ begin
  assert pg_temp.card(public.banquet_state(), '55555555') -> 'not_yet' ->> 'by' = 'zz_c', 'Group 2 untouched';
end $$;

-- ---------------------------------------------------------------- a stale yes expires
reset role;
update public.banquet_members set checked_at = now() - interval '31 minutes' where discord_id = '990000000000000301';
set local role authenticated;
select pg_temp.as_(1);
do $$
begin
  begin perform public.banquet_state(); raise exception 'stale read';
  exception when raise_exception then if sqlerrm = 'stale read' then raise; end if; end;
end $$;

\echo banquet: ok
rollback;
