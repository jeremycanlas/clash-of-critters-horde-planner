-- Every change to a tracker player is kept, so a bad edit can be put back.
--
-- The members are the only people who can edit at all (010). This guards
-- against what is left: a mistake, or a member's Discord account in the wrong
-- hands. The history is written by a trigger and nobody can edit or delete it,
-- members included, so whatever happens to the players the record of what they
-- were survives. Putting a version back is an ordinary edit through the page,
-- which is itself recorded.

create table if not exists public.tracker_history (
  id          bigint generated always as identity primary key,
  uid         bigint not null,
  action      text not null check (action in ('insert', 'update', 'delete')),
  before      jsonb,          -- null on insert
  after       jsonb,          -- null on delete
  changed_by  text not null,
  changed_at  timestamptz not null default now()
);
create index if not exists tracker_history_uid on public.tracker_history (uid, changed_at desc);

alter table public.tracker_history enable row level security;

drop policy if exists tracker_history_read on public.tracker_history;
create policy tracker_history_read on public.tracker_history
  for select to authenticated
  using (public.is_tracker_member());

-- Read-only for members, invisible to everyone else. No insert, update or delete
-- grant for anybody: only the trigger below writes here.
revoke all on public.tracker_history from anon, authenticated;
grant select on public.tracker_history to authenticated;

create or replace function public.tracker_log()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- An update that changes nothing is not worth a line.
  if tg_op = 'UPDATE' and (to_jsonb(old) - 'updated_at' - 'updated_by') = (to_jsonb(new) - 'updated_at' - 'updated_by') then
    return null;
  end if;
  insert into public.tracker_history (uid, action, before, after, changed_by)
  values (
    coalesce(new.uid, old.uid),
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end,
    coalesce((select display from public.tracker_caller()),
             case when tg_op = 'DELETE' then null else nullif(new.updated_by, '') end,
             'Maintainer (database)')
  );
  return null;
end;
$$;

revoke all on function public.tracker_log() from public, anon, authenticated;

drop trigger if exists tracker_players_log on public.tracker_players;
create trigger tracker_players_log
  after insert or update or delete on public.tracker_players
  for each row execute function public.tracker_log();

-- The maintainer's own loads over psql may say who the numbers came from
-- ("Recorded by Claude"); a signed-in caller still cannot choose.
create or replace function public.tracker_stamp()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  who text := (select display from public.tracker_caller());
begin
  new.updated_at := now();
  new.updated_by := coalesce(who, nullif(new.updated_by, ''), 'Spreadsheet import');
  return new;
end;
$$;
