-- A Duneside-sized banquet list for load simulations (tools/banquet-sim/run.sh,
-- loadtest.mjs). :users members (200 unless set: psql -v users=1200): 40% in
-- Group 1, 30% in Group 2, the rest in MVPgoats (4), and 3 viewers who see every group. Group 3 is a small private list. About 4,100 UIDs as on
-- 7 Oct (966 / 1,241 / 1,432 / 30), some claimed, marked and with likes noted.
-- Users are sim1..sim200; their sign-in ids are 00000000-0000-4000-8000-<n>.

\if :{?users} \else \set users 200 \endif
select setseed(0.42);
insert into public.banquet_settings (id) values (true) on conflict do nothing;
insert into public.banquet_groups (grp, role_id, channel_id, name, private, synced_at) values
  (1, 'r1', null, null, false, now()), (2, 'r2', null, null, false, now()),
  (3, null, null, 'Private', true, now()), (4, 'r4', null, 'MVPgoats', false, now())
on conflict (grp) do nothing;

insert into auth.users (id, aud, role)
select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'authenticated', 'authenticated' from generate_series(1, :users) n;
insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at)
select 'sim' || n, ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       jsonb_build_object('name', 'sim' || n, 'full_name', 'sim' || n), 'discord', now()
  from generate_series(1, :users) n;

-- Checked "a day from now", so the 30-minute window in banquet_you() holds for the run.
insert into public.banquet_members (discord_id, display, ok, checked_at, groups, sees_all)
select 'sim' || n, 'sim' || n, true, now() + interval '1 day',
       case when n <= 3 then '{1,2,3,4}'::smallint[] when n <= 3 + :users * 4 / 10 then '{1}' when n <= 3 + :users * 7 / 10 then '{2}' else '{4}' end,
       n <= 3
  from generate_series(1, :users) n;
insert into public.banquet_group_members (grp, discord_id) values (3, 'sim1'), (3, 'sim2');

-- UIDs: each group's posters share its list, a few posted twice.
insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source, added_at)
select public.banquet_round(), g.grp, 10000000 + g.grp * 10000000 + i,
       'sim' || (g.first + (i % g.people)), 'sim' || (g.first + (i % g.people)), 'site',
       now() - (random() * interval '20 hours')
  from (values (1, 966, 4, :users * 4 / 10), (2, 1241, 4 + :users * 4 / 10, :users * 3 / 10),
               (4, 1432, 4 + :users * 7 / 10, :users - 3 - :users * 7 / 10), (3, 30, 1, 2)) g(grp, n, first, people),
       generate_series(1, g.n) i
on conflict do nothing;

-- And four each of their group's UIDs for every member, so each has the four
-- that open the list (most did on 7 Oct); several posting one UID is real too.
insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source, added_at)
select public.banquet_round(), m.groups[1], 10000000 + m.groups[1] * 10000000 + 1 + ((x.who * 7 + k) % g.n), m.discord_id, m.discord_id, 'site',
       now() - (random() * interval '20 hours')
  from public.banquet_members m
  cross join generate_series(0, 3) k
  join (values (1, 966), (2, 1241), (4, 1432)) g(grp, n) on g.grp = m.groups[1]
  cross join lateral (select substr(m.discord_id, 4)::int as who) x
 where not m.sees_all
on conflict do nothing;

insert into public.banquet_claims (round, grp, uid, discord_id, by_name)
select u.round, u.grp, u.uid, 'sim' || (4 + (random() * (:users - 4))::int), 'x'
  from public.banquet_uids u where random() < 0.08
on conflict do nothing;
insert into public.banquet_marks (round, grp, uid, state, by_name)
select u.round, u.grp, u.uid, (array['open', 'full', 'not-yet'])[1 + (random() * 2)::int], 'x'
  from (select distinct round, grp, uid from public.banquet_uids) u where random() < 0.06
on conflict do nothing;
insert into public.banquet_likes (grp, uid, likes, discord_id, by_name, at)
select u.grp, u.uid, (random() * 3)::int * 50, 'sim4', 'x', now() - interval '1 hour'
  from (select distinct grp, uid from public.banquet_uids) u where random() < 0.2;
analyze;
