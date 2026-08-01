-- Deleting stops being instant and irreversible. Run after 004.
--
-- Until now Delete meant DELETE: the row went, and `votes.formation_id` is ON
-- DELETE CASCADE, so every upvote went with it. There is no version of "restore"
-- worth having that does not bring the score back, and a hard delete makes that
-- impossible rather than difficult.
--
-- So a delete marks `deleted_at` and the row stops being readable. The votes
-- stay attached, undoing is one update, and a purge erases it for good after
-- thirty days.
--
-- The thirty days are a promise in both directions, and the README says so:
-- gone from the gallery immediately, gone from the database within a month.
-- An indefinite archive would be a different product -- one that keeps what
-- somebody asked it to destroy, including whatever they deleted it *for*.

alter table public.formations
  add column if not exists deleted_at timestamptz;

-- ------------------------------------------------------------------ reading
--
-- The obvious version of this does not work, and the reason is worth writing
-- down because nothing about it is visible from the outside.
--
-- The obvious version is one policy: `using (not hidden and deleted_at is
-- null)`. It reads correctly, it hides deleted rows from everyone, and it makes
-- soft deletion *impossible*. On UPDATE, Postgres applies SELECT policies to
-- the NEW row as well as the old one -- so the moment the update sets
-- deleted_at, the resulting row fails the policy that was supposed to hide it,
-- and the statement is refused with
--
--   42501  new row violates row-level security policy for table "formations"
--
-- which reads like a missing grant and is nothing of the sort. The grant is
-- fine. The row is simply not allowed to become one you cannot see.
--
-- So: two permissive policies, which OR together. Everyone sees live rows; you
-- additionally see your own, deleted or not, which is what makes the update
-- legal -- and what would let a "recently deleted" list exist later without
-- another migration.
--
-- Hiding them from the gallery therefore moves to the view, below.

drop policy if exists formations_read on public.formations;
drop policy if exists formations_read_own on public.formations;

create policy formations_read on public.formations
  for select to anon, authenticated
  using (not hidden and deleted_at is null);

-- `not hidden` here as well as above: a formation hidden by moderation stays
-- hidden from its author too, which is the entire point of hiding it.
create policy formations_read_own on public.formations
  for select to authenticated
  using (author_id = (select auth.uid()) and not hidden);

-- --------------------------------------------------------------- the gallery
--
-- The view is what the gallery reads, and it is where deleted rows now stop.
--
-- Its WHERE runs as the caller because the view is security_invoker, so the
-- filter needs read privilege on the column it filters -- the same reason
-- `hidden` is in the grant list in 001. Publishing `deleted_at` leaks nothing:
-- row-level security means the only deleted rows anyone can reach through the
-- base table are their own.

drop view if exists public.formation_cards;

create view public.formation_cards
with (security_invoker = on) as
  select id, name, note, mode, slugs, placed, steps,
         author_name, author_avatar,
         submitted_at, patch_id, score, snapshot
    from public.formations
   where not hidden
     and deleted_at is null;

grant select (deleted_at) on public.formations to anon, authenticated;
grant select on public.formation_cards to anon, authenticated;

-- ------------------------------------------------------------------ writing

-- Soft-deleting, and undoing it, are both an update of this one column.
grant update (deleted_at) on public.formations to authenticated;

-- formations_delete from 001 is deliberately left in place. It is the poster's
-- own row, and someone who wants it gone now rather than in thirty days should
-- be able to say so -- this project's privacy section promises erasure, and
-- taking away the ability to actually erase would make that a worse promise,
-- not a better one. The gallery's button uses the soft path; the hard one stays
-- reachable.

-- ------------------------------------------------------------- the constraint
--
-- The trap. `formations_one_per_author unique (author_id, fingerprint)` stops
-- one person posting the same board twice -- and a soft-deleted row keeps its
-- fingerprint, so without this, deleting a formation and posting it again fails
-- with "You have already posted this one", naming a row the poster can no
-- longer see. A partial index scopes the rule to the rows that still exist.

alter table public.formations
  drop constraint if exists formations_one_per_author;

create unique index if not exists formations_one_per_author
  on public.formations (author_id, fingerprint)
  where deleted_at is null;

-- Deleted rows are read by exactly one thing, the purge, and it looks them up
-- by age. Partial, because the alternative is indexing a column that is null on
-- every row anyone actually reads.
create index if not exists formations_deleted_idx
  on public.formations (deleted_at)
  where deleted_at is not null;

-- ----------------------------------------------------------------- the purge
--
-- security definer so it can delete rows the caller has no business deleting,
-- and `set search_path = ''` so nothing it names can be shadowed. It takes no
-- arguments and reads no session state: there is no input to get wrong.

create or replace function public.purge_deleted_formations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  gone integer;
begin
  delete from public.formations
   where deleted_at is not null
     and deleted_at < now() - interval '30 days';
  get diagnostics gone = row_count;
  return gone;
end;
$$;

-- Nobody calls this from a browser. It is for pg_cron, or for a maintainer at
-- a psql prompt; leaving it executable by anon would publish a delete button.
revoke execute on function public.purge_deleted_formations() from public, anon, authenticated;

-- ------------------------------------------------------------- scheduling it
--
-- pg_cron is available on this project but NOT installed, and installing an
-- extension is a change to the infrastructure rather than to this schema, so
-- this migration does not do it silently. Until it is scheduled, the purge is
-- a thing somebody runs:
--
--   select public.purge_deleted_formations();
--
-- To have it run itself, enable pg_cron (Supabase dashboard -> Database ->
-- Extensions) and then:
--
--   select cron.schedule('purge-deleted-formations', '17 4 * * *',
--                        $$select public.purge_deleted_formations()$$);
--
-- Nothing breaks while it is unscheduled. A row that outlives its thirty days
-- is still invisible to every reader; it is only still occupying disk.

notify pgrst, 'reload schema';
