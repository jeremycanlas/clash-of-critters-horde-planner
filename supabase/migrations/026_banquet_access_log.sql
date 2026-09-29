-- An access log aimed at one question: is anybody using the banquet list to
-- take UIDs they give nothing back for, or to carry them elsewhere? Run after 025.
--
-- What the site can see, and so what this records:
--
--   visits   one row per visit, not per refresh: who, the round, whose UIDs
--            were sent, when it started and last refreshed, how many
--            refreshes. A visit ends after ten quiet minutes.
--   copies   every UID copied from the page (a tap on it), once per visit.
--
-- and, per person over the last days, set against what they put in:
--
--   copied   distinct UIDs they copied
--   claimed  banquets they marked claimed
--   shared   UIDs of their own, posted or added
--
-- with flags for what stands out:
--
--   copied-not-claimed  8 or more copied, and claimed fewer than half of them
--   took-not-shared     4 or more copied, and nothing of their own shared
--   script              refreshing faster than the page ever does (8+ a minute)
--
-- What it cannot see: a screenshot, or UIDs read off the screen and typed
-- out. Nothing about the device, no address, nothing from Discord.
--
-- Read by whoever sees both groups, the same people as Possible copies. A
-- private list is only ever counted for its own members. Kept 30 days.

create table if not exists public.banquet_access (
  id         bigint generated always as identity primary key,
  discord_id text not null,
  display    text not null,
  round      date not null,
  groups     smallint[] not null,
  started_at timestamptz not null default now(),
  last_at    timestamptz not null default now(),
  reads      int not null default 1,
  copied     text[] not null default '{}'     -- "grp:uid", in the order copied
);
create index if not exists banquet_access_recent on public.banquet_access (discord_id, last_at desc);
create index if not exists banquet_access_last on public.banquet_access (last_at desc);
alter table public.banquet_access enable row level security;
revoke all on public.banquet_access from anon, authenticated;

-- The caller's current visit, started if there is none.
create or replace function public.banquet_visit(who text, display_ text, groups_ smallint[], rr date)
returns bigint
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v bigint;
begin
  select x.id into v from public.banquet_access x
   where x.discord_id = who and x.round = rr and x.last_at > now() - interval '10 minutes'
   order by x.last_at desc limit 1;
  if v is null then
    insert into public.banquet_access (discord_id, display, round, groups, reads)
    values (who, display_, rr, groups_, 0) returning id into v;
  end if;
  return v;
end;
$$;

-- The list, as before (020), now also noting the visit. Volatile: it writes.
create or replace function public.banquet_state(r date default null, known text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  full_ jsonb := public.banquet_state_full(r);   -- refuses anyone not let in, before anything is noted
  -- The minute-by-minute last read is left out, or the list would never be the same twice.
  hash  text := md5((full_ - 'synced_at')::text);
  you   record;
  v     bigint;
begin
  select * into you from public.banquet_you();
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

-- The page tells this when a UID is copied from it. Only from a group the
-- caller is in; once per visit.
create or replace function public.banquet_note_copy(target bigint, g smallint default null)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  you record;
  gg  smallint;
  k   text;
  v   bigint;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then return; end if;
  gg := coalesce(g, you.groups[1]);
  if not (gg = any (you.groups)) then return; end if;
  k := gg || ':' || target;
  v := public.banquet_visit(you.discord_id, you.display, you.groups, public.banquet_round());
  update public.banquet_access
     set copied = case when k = any (copied) then copied else copied || k end
   where id = v;
end;
$$;

-- Per person, the last `days`: what they took against what they gave, with
-- flags, worst first, and their visits.
create or replace function public.banquet_access_log(days int default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  you   record;
  since timestamptz;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if not you.sees_all then raise exception 'Not for this account.'; end if;
  since := now() - make_interval(days => least(greatest(days, 1), 30));

  return (
    with v as (
      -- Each visit, cut down to the groups the reader is in.
      select a.*, array(select g from unnest(a.groups) g where g = any (you.groups) order by g) as seen_groups,
             array(select c from unnest(a.copied) c where split_part(c, ':', 1)::smallint = any (you.groups)) as seen_copied,
             greatest(extract(epoch from a.last_at - a.started_at) / 60, 1) as minutes
        from public.banquet_access a
       where a.last_at > since
    ), p as (
      select v.discord_id, max(v.display) as name,
             count(*) as visits, sum(v.reads) as reads, round(sum(v.minutes)) as minutes,
             round(max(v.reads / v.minutes)::numeric, 1) as per_min,
             (select count(distinct c) from v x, unnest(x.seen_copied) c where x.discord_id = v.discord_id) as copied,
             (select array_agg(distinct g order by g) from v x, unnest(x.seen_groups) g where x.discord_id = v.discord_id) as groups,
             count(*) filter (where v.round < public.banquet_round()) as past_visits,
             max(v.last_at) as last
        from v where cardinality(v.seen_groups) > 0
       group by v.discord_id
    ), q as (
      select p.*,
             (select count(*) from public.banquet_claims c
               where c.discord_id = p.discord_id and c.claimed_at > since and c.grp = any (you.groups)) as claimed,
             (select count(*) from public.banquet_uids u
               where u.discord_id = p.discord_id and u.added_at > since and u.grp = any (you.groups)) as shared
        from p
    )
    select coalesce(jsonb_agg(x order by jsonb_array_length(x -> 'flags') desc, (x ->> 'copied')::int desc, x ->> 'last' desc), '[]')
      from (
        select jsonb_build_object(
                 'name', q.name, 'groups', to_jsonb(q.groups), 'visits', q.visits, 'minutes', q.minutes, 'reads', q.reads,
                 'per_min', q.per_min, 'copied', q.copied, 'claimed', q.claimed, 'shared', q.shared,
                 'past_visits', q.past_visits, 'last', q.last,
                 'flags', to_jsonb(array_remove(array[
                    case when q.copied >= 8 and q.claimed * 2 < q.copied then 'copied-not-claimed' end,
                    case when q.copied >= 4 and q.shared = 0 then 'took-not-shared' end,
                    case when q.per_min >= 8 then 'script' end], null)),
                 'recent', (select coalesce(jsonb_agg(jsonb_build_object(
                                'start', v.started_at, 'last', v.last_at, 'reads', v.reads, 'round', v.round,
                                'groups', to_jsonb(v.seen_groups), 'copied', cardinality(v.seen_copied)) order by v.last_at desc), '[]')
                              from (select * from v where v.discord_id = q.discord_id and cardinality(v.seen_groups) > 0
                                     order by v.last_at desc limit 10) v)
               ) as x
          from q
      ) t
  );
end;
$$;

revoke all on function public.banquet_visit(text, text, smallint[], date) from public, anon, authenticated;
revoke all on function public.banquet_note_copy(bigint, smallint) from public, anon;
grant execute on function public.banquet_note_copy(bigint, smallint) to authenticated;
revoke all on function public.banquet_access_log(int) from public, anon;
grant execute on function public.banquet_access_log(int) to authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'banquet-access-trim';
select cron.schedule('banquet-access-trim', '51 3 * * *',
  $$delete from public.banquet_access where last_at < now() - interval '30 days'$$);
