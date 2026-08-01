-- Corrective patch for 001_community.sql.
--
-- 001 as first written granted `anon` and `authenticated` read on every column
-- of `formations` that the gallery displays, but not on `hidden`. The
-- formation_cards view is declared `security_invoker = on`, so its own
-- `where not hidden` is evaluated as the caller — and a caller with no read
-- privilege on `hidden` cannot evaluate it. Every read of the view failed with
--
--   42501  permission denied for table formations
--
-- which reads like a row-level-security problem and is not one. The policies
-- were right the whole time; the column grant was short by one.
--
-- Publishing `hidden` leaks nothing. Row-level security means the only rows
-- either role can reach already have hidden = false, so to them the column is
-- a constant. Keeping the view's own filter as well as the policy is deliberate:
-- if row-level security were ever switched off by accident, the view still
-- refuses to serve a taken-down formation.
--
-- 001_community.sql has been corrected too, so a fresh project does not need
-- this file. Safe to run more than once.

grant select (id, name, note, snapshot, mode, slugs, placed, steps, author_name,
              app_version, submitted_at, patch_id, score, hidden)
  on public.formations to anon, authenticated;

notify pgrst, 'reload schema';
