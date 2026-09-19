-- Proves the tracker's row-level security, then undoes everything it did.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tracker_rls_check.sql
--
-- Two throwaway Discord accounts are created inside one transaction: one on
-- the member list, one not. Each check raises an exception if access is wrong,
-- so a clean run prints "tracker RLS: ok" and a broken policy stops the script.
-- It ends in ROLLBACK, so nothing it creates survives.

begin;

insert into auth.users (id, aud, role, email)
values ('00000000-0000-4000-8000-00000000aa01', 'authenticated', 'authenticated', 'tracker-member@example.invalid'),
       ('00000000-0000-4000-8000-00000000aa02', 'authenticated', 'authenticated', 'tracker-stranger@example.invalid');

insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values (gen_random_uuid(), '990000000000000001', '00000000-0000-4000-8000-00000000aa01',
        '{"name":"zz_tracker_member","full_name":"zz_tracker_member","sub":"990000000000000001"}', 'discord', now(), now(), now()),
       (gen_random_uuid(), '990000000000000002', '00000000-0000-4000-8000-00000000aa02',
        '{"name":"zz_tracker_stranger","full_name":"zz_tracker_stranger","sub":"990000000000000002"}', 'discord', now(), now(), now());

insert into public.tracker_members (username) values ('zz_tracker_member');
insert into public.tracker_players (uid, name, clock) values (999999001, 'zz_row', 200);

-- ---------------------------------------------------------------- the stranger
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000aa02","role":"authenticated"}', true);

do $$
begin
  if public.tracker_claim() then raise exception 'FAIL: a stranger was let in'; end if;
  if exists (select 1 from public.tracker_players) then raise exception 'FAIL: a stranger can read players'; end if;
  begin
    insert into public.tracker_players (uid, name) values (999999002, 'zz_stranger_row');
    raise exception 'FAIL: a stranger can insert';
  exception when insufficient_privilege then null;
  end;
  update public.tracker_players set clock = 1;
  delete from public.tracker_players;
  begin
    perform 1 from public.tracker_members;
    raise exception 'FAIL: a stranger can read the member list';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.tracker_history) then raise exception 'FAIL: a stranger can read the history'; end if;
end $$;

-- ---------------------------------------------------------------- anon
reset role;
set local role anon;
do $$
begin
  begin
    perform 1 from public.tracker_players;
    raise exception 'FAIL: anon can read players';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------- the member
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000aa01","role":"authenticated"}', true);

do $$
declare n int;
begin
  if not public.tracker_claim() then raise exception 'FAIL: the member was refused'; end if;
  select clock into n from public.tracker_players where uid = 999999001;
  if n is distinct from 200 then raise exception 'FAIL: the stranger changed a row, or the member cannot read it (clock=%)', n; end if;
  update public.tracker_players set clock = 210, updated_by = 'forged' where uid = 999999001;
  if (select updated_by from public.tracker_players where uid = 999999001) <> 'zz_tracker_member' then
    raise exception 'FAIL: updated_by was not stamped by the database';
  end if;
  insert into public.tracker_players (uid, name) values (999999003, 'zz_member_row');

  -- The edit above is in the history, with the old value, under the member's name.
  if not exists (select 1 from public.tracker_history
                  where uid = 999999001 and action = 'update'
                    and (before ->> 'clock')::int = 200 and (after ->> 'clock')::int = 210
                    and changed_by = 'zz_tracker_member') then
    raise exception 'FAIL: the edit was not recorded in the history';
  end if;
  delete from public.tracker_players where uid = 999999003;
  if not exists (select 1 from public.tracker_history where uid = 999999003 and action = 'delete' and before ->> 'name' = 'zz_member_row') then
    raise exception 'FAIL: a delete was not recorded in the history';
  end if;
  -- And a member cannot cover their tracks.
  begin
    delete from public.tracker_history;
    raise exception 'FAIL: a member can delete history';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tracker_history set changed_by = 'someone else';
    raise exception 'FAIL: a member can rewrite history';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- A username taken over later does not inherit access: the ID is locked now.
do $$
begin
  if (select discord_id from public.tracker_members where username = 'zz_tracker_member') <> '990000000000000001' then
    raise exception 'FAIL: the member''s Discord ID was not locked in';
  end if;
  raise notice 'tracker RLS: ok';
end $$;

rollback;
