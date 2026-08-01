-- Letting a poster fix the words, and only the words. Run after 003.
--
-- 001 left this table with no update policy at all, and said why:
--
--   No update policy either. A formation is immutable once posted: editing it
--   would silently change what other people already voted for. Delete and
--   repost.
--
-- That still holds for the board, and this does not weaken it. It never held
-- for the name and the note. Nobody upvotes a title, and delete-and-repost is a
-- brutal price for a typo: the row goes, and every vote on it goes with it.
--
-- So the rule is narrowed rather than dropped. `name` and `note` become
-- editable; `snapshot` -- and with it mode, slugs, placed, steps and the
-- fingerprint they are all derived from -- does not. What somebody upvoted
-- still cannot change under them.
--
-- Two separate things enforce that, and the column grant is the load-bearing
-- one. Row-level security decides which ROWS a statement may touch and has
-- nothing whatever to say about which COLUMNS. An update policy on its own
-- would let a poster rewrite their own snapshot, or their own score.

drop policy if exists formations_update_own on public.formations;

create policy formations_update_own on public.formations
  for update to authenticated
  using      (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));

-- `(select auth.uid())` rather than a bare call, matching every other policy
-- here: it is evaluated once as an initplan instead of once per row.

grant update (name, note) on public.formations to authenticated;

-- What is deliberately absent, and why:
--
--   * No update grant on author_id. Without it the WITH CHECK above cannot be
--     sidestepped by handing the row to somebody else on the way past.
--   * No update grant on score or hidden. Those move by voting and by
--     moderation, never by their owner asking.
--   * No update trigger. formations_derive and formations_limit are both
--     BEFORE INSERT, so an edit recomputes nothing and is not rate limited --
--     the limit is there to stop the table filling up, and an edit adds no row.
--   * No change to submitted_at. An edited formation keeps its place in
--     newest-first order, because it was posted when it was posted.
--
-- The CHECK constraints from 001 still apply to an update, unchanged:
-- formations_name_len (1..60) and formations_note_len (null or <= 240).
--
-- Delete needed nothing here. `formations_delete` has existed since 001 and
-- already scopes to `author_id = auth.uid()`; the gallery simply never offered
-- a button for it.
