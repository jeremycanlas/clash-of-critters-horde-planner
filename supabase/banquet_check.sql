-- Proves the MVP banquet rules, then undoes everything it did.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/banquet_check.sql
--
-- Loads 013 to 028 inside the transaction too, so it can run before a
-- migration is applied. Discord is not asked: members are written straight
-- into banquet_members, which is what Discord's yes leaves behind, and channel
-- posts go through banquet_apply(), which is what banquet_sync() hands them
-- to. A clean run prints "banquet: ok"; it ends in ROLLBACK.

begin;
-- The live sync runs every minute and touches these tables. Taking them first,
-- in one order, makes it wait the second or two this takes instead of
-- deadlocking with the migrations below.
do $$
declare t text;
begin
  foreach t in array array['banquet_settings', 'banquet_groups', 'banquet_members', 'banquet_uids', 'banquet_claims', 'banquet_marks', 'banquet_events', 'banquet_likes'] loop
    if to_regclass('public.' || t) is not null then execute format('lock table public.%I in access exclusive mode', t); end if;
  end loop;
end $$;
\i supabase/migrations/013_banquet.sql
\i supabase/migrations/014_banquet_not_yet.sql
\i supabase/migrations/015_banquet_extras.sql
\i supabase/migrations/016_banquet_groups.sql
\i supabase/migrations/017_banquet_synced_at.sql
\i supabase/migrations/018_banquet_sync_window.sql
\i supabase/migrations/019_banquet_add_limit.sql
\i supabase/migrations/020_banquet_state_same.sql
\i supabase/migrations/021_banquet_copies.sql
\i supabase/migrations/022_banquet_posted.sql
\i supabase/migrations/023_banquet_no_role_minute.sql
\i supabase/migrations/025_banquet_private.sql
\i supabase/migrations/026_banquet_access_log.sql
\i supabase/migrations/027_banquet_edit.sql
\i supabase/migrations/028_banquet_add_no_limit.sql
\i supabase/migrations/029_banquet_viewer_ids.sql
\i supabase/migrations/031_banquet_statuses.sql
\i supabase/migrations/032_banquet_likes.sql
\i supabase/migrations/033_banquet_site_only.sql
\i supabase/migrations/034_banquet_channel_again.sql
\i supabase/migrations/035_banquet_bot_answers.sql

-- Real entries would skew the counts. Gone for this transaction only.
delete from public.banquet_claims; delete from public.banquet_marks; delete from public.banquet_uids; delete from public.banquet_access; delete from public.banquet_events;
delete from public.banquet_likes;
delete from public.banquet_group_members; delete from public.banquet_groups; delete from public.banquet_members;
insert into public.banquet_groups (grp, role_id, channel_id, synced_at) values
  (1, 'r1', 'c1', now() - interval '2 minutes'), (2, 'r2', 'c2', now() - interval '9 minutes');
insert into public.banquet_groups (grp, private, name, synced_at) values (3, true, 'Private', now());
insert into public.banquet_group_members (grp, discord_id) values (3, '990000000000000304');

-- A and B are Group 1, C is Group 2, V sees both and is in the private list,
-- W sees both and is not, X was refused.
insert into auth.users (id, aud, role, email)
select ('00000000-0000-4000-8000-0000000000d' || n)::uuid, 'authenticated', 'authenticated', 'bq' || n || '@example.invalid'
  from generate_series(1, 6) n;
insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), '99000000000000030' || n, ('00000000-0000-4000-8000-0000000000d' || n)::uuid,
       jsonb_build_object('name', nm, 'full_name', nm), 'discord', now(), now(), now()
  from (values (1, 'zz_a'), (2, 'zz_b'), (3, 'zz_c'), (4, 'zz_v'), (5, 'zz_x'), (6, 'zz_w')) v(n, nm);
insert into public.banquet_members (discord_id, display, ok, groups, sees_all) values
  ('990000000000000301', 'zz_a', true, '{1}', false),
  ('990000000000000302', 'zz_b', true, '{1}', false),
  ('990000000000000303', 'zz_c', true, '{2}', false),
  ('990000000000000304', 'zz_v', true, '{1,2,3}', true),
  ('990000000000000306', 'zz_w', true, '{1,2}', true),
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
  assert array(select public.banquet_parse('`13579246` / ‘87654321’ 135792469 1234567 x11112222y 13579246') order by 1)
         = '{11112222,13579246,87654321}'::bigint[], 'eight digits, any quoting, no longer or shorter';
  assert public.banquet_round('2026-09-30 07:59+08') = '2026-09-24', 'a minute before the end is the previous round';
  assert public.banquet_round('2026-09-30 08:00+08') = '2026-09-30', 'the end starts the round';
  assert public.banquet_round('2026-10-04 23:59+00') = '2026-09-30', 'lasts until Duneside';
  assert public.banquet_round('2026-10-05 00:00+00') = '2026-10-07', 'Duneside is named by its reset, and its UIDs come before it';
  assert public.banquet_round('2026-10-20 00:00+00') = '2026-10-07', 'and it stays current until the next is set up';
  -- 035: the example UID is never one, and what the bot makes of a post.
  assert array(select public.banquet_parse('12345678 | 23456789 |')) = '{23456789}'::bigint[], '12345678 is the example, not a UID';
  assert public.banquet_ack_read(E'1st
14289205 | 10795976 | 22734148
2nd
16777530/17349955') = '{"uids": 5, "bad": []}', 'a clean post: five, nothing wrong';
  assert public.banquet_ack_read('5th 257614831 / 28200817 / 1234567') = '{"uids": 1, "bad": ["1234567", "257614831"]}', 'nine and seven digits are flagged';
  assert public.banquet_ack_read('<@606863557094539286> drop them here, format: 12345678 | 12345678') = '{"uids": 0, "bad": []}', 'the announcement: nothing';
  assert public.banquet_ack_read('see https://discord.com/channels/151888059987866/155412215474697 <:vUp:1535202996252581909> <#1554122154746978> ok') = '{"uids": 0, "bad": []}', 'links, emoji and channels are not typos';
  assert public.banquet_ack_read('the mvp keeps changing every hour') = '{"uids": 0, "bad": []}', 'chat: nothing';
  assert public.banquet_ack_text('{"uids": 1, "bad": ["257614831"]}') = '⚠️ Not recorded: `257614831` has 9 digits. A UID is 8 digits. Edit your message to fix it and I''ll pick it up.', 'the warning';
  assert public.banquet_ack_text('{"uids": 24, "bad": []}') = '✅ Fixed, all 24 UIDs recorded.', 'and once fixed';
  assert public.banquet_ack(1::smallint, 'c', 't', '[{"id": "1", "content": "257614831", "author": {"id": "2"}, "timestamp": "2026-10-06T00:00:00Z"}]', true, now()) = 0
         or exists (select 1 from public.banquet_settings where ack_up is not null), 'with no emojis set, nothing is answered and Discord is not asked';
  assert public.banquet_reads_from('2026-10-07') = '2026-10-06 00:00+08' and public.banquet_reads_from('2026-09-30') = '2026-09-30 00:00+00', 'a channel is read from Duneside''s switch, older rounds from their reset';
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
  assert (select bool_and(x ? 'posted' and (x ->> 'posted')::timestamptz is not null) from jsonb_array_elements(s -> 'banquets') x), 'every banquet says when it was first posted';
  assert s::text not like '%3000000%' and s::text not like '%zz_c%' and s::text not like '%u303%', 'nothing of Group 2';
  assert (s ->> 'synced_at')::timestamptz = now() - interval '2 minutes', 'A gets Group 1''s last read only';

  -- No cap: thirty more on the site go in, and come out again.
  perform public.banquet_add(70000000 + i) from generate_series(1, 30) i;
  assert (select count(*) from jsonb_array_elements(public.banquet_state() -> 'mine')) = 34, 'thirty-one added on the site, no limit';
  perform public.banquet_remove(70000000 + i) from generate_series(1, 30) i;
  s := public.banquet_state();
  assert jsonb_array_length(s -> 'banquets') = 8, 'and removing them leaves the eight';

  begin perform public.banquet_add(12345678); raise exception 'the example added';
  exception when raise_exception then if sqlerrm = 'the example added' then raise; end if; end;
  begin perform public.banquet_add(1234567); raise exception 'seven digits added';
  exception when raise_exception then if sqlerrm = 'seven digits added' then raise; end if; end;

  perform public.banquet_claim(55555555, true);
  perform public.banquet_mark(20000002, 'full');
  -- A posted one cannot be removed on the site.
  perform public.banquet_remove(10000001);
  assert pg_temp.card(public.banquet_state(), '10000001') is not null, 'posted stays';
end $$;

-- ---------------------------------------------------------------- the same list, in a few bytes
do $$
declare s jsonb; h text;
begin
  s := public.banquet_state();
  h := s ->> 'hash';
  assert public.banquet_state(null, h) - 'synced_at' = jsonb_build_object('same', true, 'hash', h), 'unchanged: only same and the hash';
  assert public.banquet_state(null, 'stale') ? 'banquets', 'a wrong fingerprint gets the list';
  perform public.banquet_claim(20000003, true);
  assert not (public.banquet_state(null, h) ? 'same'), 'a claim changes it';
  perform public.banquet_claim(20000003, false);
  -- The log keeps the claim and the take-back, so the list is not the one before.
  h := public.banquet_state() ->> 'hash';
  assert public.banquet_state(null, h) ? 'same', 'and once read, it is the same again';
end $$;

-- ---------------------------------------------------------------- four statuses, and the log
do $$
declare s jsonb; c jsonb; e jsonb;
begin
  -- 10000002: nobody has looked, so no mark at all: Needs a look.
  c := pg_temp.card(public.banquet_state(), '10000002');
  assert c -> 'open' = 'null' and c -> 'not_yet' = 'null' and c -> 'full' = 'null', 'unmarked: needs a look';

  -- Seen with no icon, then claimed: a claim is a gift seen, so it is open.
  perform public.banquet_mark(10000002, 'not-yet');
  assert pg_temp.card(public.banquet_state(), '10000002') -> 'not_yet' ->> 'by' = 'zz_a', 'not logged in';
  perform public.banquet_claim(10000002, true);
  c := pg_temp.card(public.banquet_state(), '10000002');
  assert c -> 'not_yet' = 'null' and c -> 'open' ->> 'by' = 'zz_a', 'claimed: claimable, not waiting';

  -- A claim never reopens a full one.
  perform public.banquet_claim(20000002, true);
  c := pg_temp.card(public.banquet_state(), '20000002');
  assert c ->> 'full' = 'zz_a' and c ->> 'full_at' is not null and c -> 'open' = 'null', 'full stays full';

  -- Open set by hand, then cleared.
  perform public.banquet_mark(10000003, 'open');
  assert pg_temp.card(public.banquet_state(), '10000003') -> 'open' ->> 'by' = 'zz_a', 'gift seen';
  perform public.banquet_mark(10000003, null);
  assert pg_temp.card(public.banquet_state(), '10000003') -> 'open' = 'null', 'and cleared';

  -- Every press, and every post, newest first.
  s := public.banquet_state();
  e := s -> 'events';
  assert e -> 0 ->> 'kind' = 'clear' and e -> 0 ->> 'uid' = '10000003' and e -> 0 ->> 'by' = 'zz_a', 'the clear is newest';
  assert (select count(*) from jsonb_array_elements(e) x where x ->> 'kind' = 'claim' and x ->> 'uid' = '10000002') = 1, 'the claim is there';
  assert (select count(*) from jsonb_array_elements(e) x where x ->> 'kind' = 'unclaim' and x ->> 'uid' = '20000003') = 1, 'so is a take-back';
  assert (select count(*) from jsonb_array_elements(e) x where x ->> 'kind' = 'post' and x ->> 'uid' = '20000001' and x ->> 'by' = 'u302') = 1, 'posts from Discord, by who posted';
  assert (select count(*) from jsonb_array_elements(e) x where x ->> 'kind' = 'claim' and x ->> 'uid' = '20000002') = 1, 'a claim on a full one still counts';
  assert s::text not like '%grp%', 'still nothing says there are groups';

  begin perform public.banquet_mark(10000003, 'gone'); raise exception 'odd state';
  exception when raise_exception then if sqlerrm = 'odd state' then raise; end if; end;
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
  assert s -> 'groups' = '[1, 2, 3]'::jsonb, 'V is told there are two, and the private list V is in';
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

-- ---------------------------------------------------------------- a half-hour read
-- Only posts from the window are replaced. B's 20000004 was posted "now" in the
-- edit above, inside the window, and is edited out; A's older posts are outside
-- it and untouched even though this read does not include them.
reset role;
update public.banquet_uids set added_at = now() - interval '2 hours' where grp = 1 and discord_id = '990000000000000301';
select public.banquet_apply(public.banquet_round(), 1::smallint, jsonb_build_array(
  pg_temp.msg('m3', '990000000000000302', E'`20000001`
`20000002`
`20000003`')), now() - interval '30 minutes');
set local role authenticated;
select pg_temp.as_(1);
do $$ begin
  assert pg_temp.card(public.banquet_state(), '20000004') is null, 'edited out inside the window';
  assert pg_temp.card(public.banquet_state(), '10000002') is not null, 'older posts outside the window stay';
  assert jsonb_array_length(public.banquet_state() -> 'mine') = 4, 'A still has four';
end $$;

-- ---------------------------------------------------------------- possible copies
-- A newcomer posts three of B's UIDs and one of A's, all after them.
reset role;
insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source, added_at)
select public.banquet_round(), 1, u, '990000000000000399', 'zz_copier', 'discord', now() + interval '1 minute'
  from unnest('{20000001,20000002,20000003,10000001}'::bigint[]) u;
set local role authenticated;
select pg_temp.as_(1);
do $$ begin
  begin perform public.banquet_copies(); raise exception 'a member saw copies';
  exception when raise_exception then if sqlerrm = 'a member saw copies' then raise; end if; end;
end $$;
select pg_temp.as_(4);
do $$
declare c jsonb; p jsonb;
begin
  c := public.banquet_copies();
  p := c -> 'people' -> 0;
  assert p ->> 'name' = 'zz_copier' and (p ->> 'all_copied')::boolean and (p ->> 'copied')::int = 4, 'the copier is first, all four copied';
  assert (select array_agg(distinct x ->> 'first_by' order by x ->> 'first_by') from jsonb_array_elements(p -> 'items') x) = '{u301,u302}',
         'and whose they were, as posted in Discord';
  assert not exists (select 1 from jsonb_array_elements(c -> 'people') x where x ->> 'name' = 'u302'), 'the one who posted first is not flagged';
  assert (select count(*) from jsonb_array_elements(c -> 'both_groups') x where x ->> 'uid' = '55555555') = 0,
         '55555555 left Group 1 in the edit above, so it is in one group now';
end $$;

-- ---------------------------------------------------------------- editing your own
select pg_temp.as_(1);
do $$
declare b jsonb;
begin
  perform public.banquet_add(10000777);
  perform public.banquet_claim(10000777, true);
  perform public.banquet_edit(10000777, 10000778);
  assert pg_temp.card(public.banquet_state(), '10000777') is null, 'the old UID is gone';
  b := pg_temp.card(public.banquet_state(), '10000778');
  assert b is not null and (b ->> 'claims')::int = 0, 'the new one is there, and the old claim did not follow it';
  begin perform public.banquet_edit(10000001, 10000009); raise exception 'edited a Discord post';
  exception when raise_exception then if sqlerrm = 'edited a Discord post' then raise; end if; end;
  begin perform public.banquet_edit(10000778, 1234567); raise exception 'seven digits';
  exception when raise_exception then if sqlerrm = 'seven digits' then raise; end if; end;
  perform public.banquet_remove(10000778);
end $$;
select pg_temp.as_(2);
do $$ begin
  begin perform public.banquet_edit(10000004, 10000005); raise exception 'B edited A''s';
  exception when raise_exception then if sqlerrm = 'B edited A''s' then raise; end if; end;
end $$;

-- ---------------------------------------------------------------- the private list
reset role;
set local role authenticated;
select pg_temp.as_(4);
do $$
declare s jsonb;
begin
  s := public.banquet_state();
  assert s -> 'private' = '[3]'::jsonb and s -> 'names' ->> '3' = 'Private', 'V is told the private list is private';
  perform public.banquet_add(33300001, 3::smallint);
  perform public.banquet_claim(33300001, true, 3::smallint);
  s := public.banquet_state();
  assert (select count(*) from jsonb_array_elements(s -> 'banquets') x where x ->> 'grp' = '3') = 1, 'V has a private banquet, claimed';
end $$;
select pg_temp.as_(6);
do $$
declare s jsonb; c jsonb;
begin
  s := public.banquet_state();
  assert s::text not like '%33300001%' and s -> 'groups' = '[1, 2]'::jsonb, 'W sees both groups, and nothing private';
  c := public.banquet_copies();
  assert c::text not like '%33300001%', 'nor in Possible copies';
  begin perform public.banquet_add(33300002, 3::smallint); raise exception 'W added to private';
  exception when raise_exception then if sqlerrm = 'W added to private' then raise; end if; end;
end $$;
-- One transaction is one now(): V's private add is put a minute earlier, so A's is after it.
reset role;
update public.banquet_uids set added_at = now() - interval '1 minute' where uid = 33300001 and grp = 3;
set local role authenticated;
select pg_temp.as_(1);
do $$ declare b jsonb; begin
  -- A adds the private list's UID, after V, sending group 3: it lands in Group 1 as A's own.
  perform public.banquet_add(33300001, 3::smallint);
  b := pg_temp.card(public.banquet_state(), '33300001');
  assert b -> 'entered_by' = '["zz_a"]'::jsonb and (b ->> 'claims')::int = 0, 'A sees only their own, not V''s private one';
end $$;
select pg_temp.as_(6);
do $$ begin
  assert public.banquet_copies()::text not like '%zz_v%', 'W''s Possible copies do not say V had it first, privately';
end $$;
select pg_temp.as_(4);
do $$ begin
  assert (select count(*) from jsonb_array_elements(public.banquet_state() -> 'banquets') x where x ->> 'grp' = '3') = 1,
         'and nothing A sends reaches the private list';
end $$;

-- ---------------------------------------------------------------- likes
-- 10000001 showed 100 likes before the reset and 150 since: MVP twice before,
-- and this round's banquet full. Only its group can write them down.
reset role;
insert into public.banquet_likes (grp, uid, likes, discord_id, by_name, at) values
  (1, 10000001, 50, '990000000000000302', 'zz_b', public.banquet_opens(public.banquet_round()) - interval '7 days'),
  (1, 10000001, 100, '990000000000000302', 'zz_b', least(public.banquet_opens(public.banquet_round()), now()) - interval '1 hour');
set local role authenticated;
select pg_temp.as_(1);
select public.banquet_likes_set(10000001, 150);
do $$
declare c jsonb;
begin
  c := pg_temp.card(public.banquet_state(), '10000001');
  if now() >= public.banquet_round()::timestamp at time zone 'UTC' then
    assert (c -> 'likes_before' ->> 'n')::int = 100 and c -> 'likes_before' ->> 'by' = 'zz_b', 'the last count before the reset, not the one before it';
    assert (c -> 'likes_now' ->> 'n')::int = 150 and c -> 'likes_now' ->> 'by' = 'zz_a', 'and the last since';
  else -- before this round's reset, a count noted now is its "before"
    assert (c -> 'likes_before' ->> 'n')::int = 150 and c -> 'likes_before' ->> 'by' = 'zz_a', 'before the reset, the newest count is "before"';
    assert c -> 'likes_now' = 'null'::jsonb, 'and nothing is "now" yet';
  end if;
  assert pg_temp.card(public.banquet_state(), '10000002') -> 'likes_before' = 'null'::jsonb, 'none written down: null';
  begin perform public.banquet_likes_set(10000001, -1); raise exception 'negative likes';
  exception when raise_exception then if sqlerrm = 'negative likes' then raise; end if; end;
end $$;
select pg_temp.as_(3);
do $$ begin
  begin perform public.banquet_likes_set(10000001, 999); raise exception 'C wrote Group 1''s likes';
  exception when raise_exception then if sqlerrm = 'C wrote Group 1''s likes' then raise; end if; end;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.banquet_likes) = 3, 'nothing written by the refused calls';
  assert public.banquet_opens('2026-09-30') = '2026-09-30 08:00+08', 'a round opens at its reset';
end $$;

-- ---------------------------------------------------------------- the access log
-- By now A, C, V and W have each opened the list, many times over: one visit each.
-- W copies ten of Group 1's UIDs, claims none and shares none; V copies one
-- from the private list; A copies one not in any list it was sent.
set local role authenticated;
select pg_temp.as_(6);
select public.banquet_note_copy(u, 1::smallint) from unnest('{10000001,10000002,10000003,10000101,10000102,10000103,20000001,20000002,20000003,10000114}'::bigint[]) u;
select public.banquet_note_copy(10000001, 1::smallint);   -- twice is once
select pg_temp.as_(4);
select public.banquet_note_copy(33300001, 3::smallint);
select pg_temp.as_(1);
select public.banquet_note_copy(30000001, 2::smallint);   -- Group 2's, which A was never sent: ignored
do $$ begin
  begin perform public.banquet_access_log(); raise exception 'a member read the log';
  exception when raise_exception then if sqlerrm = 'a member read the log' then raise; end if; end;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.banquet_access where discord_id = '990000000000000301') = 1, 'many refreshes, one visit';
  assert (select reads from public.banquet_access where discord_id = '990000000000000301') > 5, 'counted';
  assert (select cardinality(copied) from public.banquet_access where discord_id = '990000000000000301') = 0, 'a UID A was never sent is not counted';
end $$;
set local role authenticated;
select pg_temp.as_(4);
do $$
declare l jsonb; w jsonb;
begin
  l := public.banquet_access_log();
  w := (select x from jsonb_array_elements(l) x where x ->> 'name' = 'zz_w');
  assert l -> 0 ->> 'name' = 'zz_w', 'the one who took most comes first';
  assert (w ->> 'copied')::int = 10 and (w ->> 'claimed')::int = 0 and (w ->> 'shared')::int = 0, 'W: copied 10, claimed 0, shared 0';
  assert w -> 'flags' @> '["copied-not-claimed", "took-not-shared"]'::jsonb, 'and flagged for both';
  assert (select (x ->> 'copied')::int from jsonb_array_elements(l) x where x ->> 'name' = 'zz_v') = 1, 'V, a member, sees V''s private copy';
end $$;
select pg_temp.as_(6);
do $$
declare l jsonb;
begin
  l := public.banquet_access_log();
  assert (select (x ->> 'copied')::int from jsonb_array_elements(l) x where x ->> 'name' = 'zz_v') = 0, 'W does not: it was from the private list';
  assert not exists (select 1 from jsonb_array_elements(l) x, jsonb_array_elements(x -> 'groups') g where g::int = 3), 'nor any private group';
end $$;

-- ---------------------------------------------------------------- a covered list
-- Group 1 covered until the reset: A, with four of their own, sees only them.
-- V, who sees every group, sees all; Group 2 is not covered.
reset role;
update public.banquet_groups set covered = true where grp = 1;
set local role authenticated;
select pg_temp.as_(1);
do $$
declare s jsonb;
begin
  if now() < public.banquet_round()::timestamp at time zone 'UTC' then
    s := public.banquet_state();
    assert (s ->> 'covered')::boolean, 'A is told the list is covered';
    assert not (s ->> 'shared')::boolean and jsonb_array_length(s -> 'banquets') = 0 and jsonb_array_length(s -> 'events') = 0, 'and sees none of it';
    assert jsonb_array_length(s -> 'mine') >= 4, 'but sees their own';
    perform public.banquet_add(10000099);
    assert (select count(*) from jsonb_array_elements(public.banquet_state() -> 'mine') x where x ->> 'uid' = '10000099') = 1, 'and can add more';
    begin perform public.banquet_claim(10000001, true); raise exception 'claimed while covered';
    exception when raise_exception then if sqlerrm = 'claimed while covered' then raise; end if; end;
  end if;
end $$;
select pg_temp.as_(4);
do $$ begin
  assert not (public.banquet_state() ? 'covered') and jsonb_array_length(public.banquet_state() -> 'banquets') > 0, 'V sees every group, covered or not';
end $$;
select pg_temp.as_(3);
do $$ begin
  assert not (public.banquet_state() ? 'covered'), 'Group 2 is not covered';
end $$;
-- A UID from the last round can be added again: each round has its own.
reset role;
insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source)
values ('2026-09-30', 1, 10000077, '990000000000000301', 'zz_a', 'site');
update public.banquet_groups set covered = false where grp = 1;
set local role authenticated;
select pg_temp.as_(1);
select public.banquet_add(10000077);
do $$ begin
  assert (select count(*) from jsonb_array_elements(public.banquet_state() -> 'mine') x where x ->> 'uid' = '10000077') = 1, 'last round''s UID added again';
end $$;

-- ---------------------------------------------------------------- how long an answer is remembered
-- With no server set, anything not answered from memory comes back
-- not-set-up, so this never asks Discord.
reset role;
update public.banquet_settings set guild_id = null;
update public.banquet_members set checked_at = now() - interval '30 seconds' where discord_id = '990000000000000305';
set local role authenticated;
select pg_temp.as_(5);
do $$ begin assert public.banquet_check() = 'no-role', 'a no from 30 seconds ago is remembered'; end $$;
reset role;
update public.banquet_members set checked_at = now() - interval '2 minutes' where discord_id = '990000000000000305';
update public.banquet_members set checked_at = now() - interval '5 minutes' where discord_id = '990000000000000301';
set local role authenticated;
do $$ begin assert public.banquet_check() = 'not-set-up', 'a no from 2 minutes ago is asked again'; end $$;
select pg_temp.as_(1);
do $$ begin assert public.banquet_check() = 'ok', 'a yes from 5 minutes ago is remembered'; end $$;

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

-- ---------------------------------------------------------------- what a user can reach at all
-- The twelve calls the page makes, nothing else: not the sync (it would let
-- anyone hammer Discord as the bot), not the unfiltered list, not a table, not
-- the vault the bot token is in. Anonymous visitors reach none of it.
reset role;
do $$
declare got text[];
begin
  got := array(select p.proname::text from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.proname like 'banquet%'
                  and has_function_privilege('authenticated', p.oid, 'execute') order by 1);
  assert got = '{banquet_access_log,banquet_add,banquet_check,banquet_claim,banquet_copies,banquet_edit,banquet_likes_set,banquet_mark,banquet_note_copy,banquet_remove,banquet_round,banquet_state}',
         'signed-in users can call exactly the page''s functions, got ' || got::text;
  assert not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'banquet%'
                      and has_function_privilege('anon', p.oid, 'execute')), 'anonymous visitors can call nothing';
  assert not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'banquet%' and c.relkind = 'r'
                      and (has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('anon', c.oid, 'select')
                           or not c.relrowsecurity)), 'every table closed, with row security on';
  assert not has_table_privilege('authenticated', 'vault.decrypted_secrets', 'select'), 'the bot token stays in the vault';
end $$;

\echo banquet: ok
rollback;
