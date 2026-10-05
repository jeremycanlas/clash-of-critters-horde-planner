-- MVP banquets from the site only, and a covered list until the reset. Run after 032.
--
-- 1. Discord channels are no longer read: members add their UIDs on the site.
--    The bot stays, for role checks. UIDs already read from Discord stay where
--    they are, in their rounds.
--
-- 2. Duneside. A round is named by its reset, when its banquets open, and
--    rounds were six days apart. Duneside's reset is Wed 7 Oct, 00:00 UTC, not
--    the 6th, and its UIDs are added before it. So from 5 Oct the current round
--    is 2026-10-07, and it stays current until the next gold rush is set up
--    here. Everything entered before then stays in its own round (2026-09-30 is
--    now the previous gold rush).
--
-- 3. A covered group: until its round's reset, members see only the UIDs they
--    added themselves, however many. Viewers (who see every group) see all, as
--    always. Which groups are covered is data: banquet_groups.covered.

do $$
declare j bigint;
begin
  for j in select jobid from cron.job where jobname = 'banquet-sync' loop
    perform cron.unschedule(j);
  end loop;
end $$;

-- ponytail: one fixed round from 5 Oct; the next gold rush's date goes in here when it is known.
create or replace function public.banquet_round(at timestamptz default now())
returns date
language sql
stable
as $$
  select case when at >= timestamptz '2026-10-05 00:00+00' then date '2026-10-07'
    else ((timestamptz '2026-09-30 08:00+08'
           + floor(extract(epoch from at - timestamptz '2026-09-30 08:00+08') / 518400) * interval '6 days')
          at time zone 'Asia/Manila')::date end;
$$;

alter table public.banquet_groups add column if not exists covered boolean not null default false;

-- Whether round r's list is covered for group g: a covered group, before the reset.
create or replace function public.banquet_covered(r date, g smallint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.banquet_groups x where x.grp = g and x.covered)
     and now() < public.banquet_opens(r);
$$;

-- As 025, and a covered list stays shut however many UIDs you add.
create or replace function public.banquet_shared(sees_all boolean, who text, r date, g smallint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select sees_all
      or exists (select 1 from public.banquet_groups x where x.grp = g and x.private)
      or (not public.banquet_covered(r, g)
          and (select count(distinct uid) >= 4 from public.banquet_uids
                where round = r and grp = g and discord_id = who));
$$;

-- As 026, and a member is told when their list is covered, so the page can say
-- when it opens rather than "add more".
create or replace function public.banquet_state(r date default null, known text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  full_ jsonb := public.banquet_state_full(r);   -- refuses anyone not let in, before anything is noted
  hash  text;
  you   record;
  v     bigint;
begin
  select * into you from public.banquet_you();
  if not you.sees_all and public.banquet_covered((full_ ->> 'round')::date, you.groups[1]) then
    full_ := full_ || jsonb_build_object('covered', true);
  end if;
  -- The minute-by-minute last read is left out, or the list would never be the same twice.
  hash := md5((full_ - 'synced_at')::text);
  v := public.banquet_visit(you.discord_id, you.display, you.groups, coalesce(r, public.banquet_round()));
  update public.banquet_access
     set last_at = now(), reads = reads + 1, groups = you.groups, display = you.display
   where id = v;

  if known = hash then
    return jsonb_build_object('same', true, 'hash', hash, 'synced_at', full_ -> 'synced_at');
  end if;
  return full_ || jsonb_build_object('hash', hash);
end;
$$;

revoke all on function public.banquet_covered(date, smallint) from public, anon, authenticated;
