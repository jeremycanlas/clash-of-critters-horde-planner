-- Corrective patch for 001_community.sql. Run any time after 001; idempotent.
--
-- Postgres grants EXECUTE on every newly created function to PUBLIC, and the
-- `anon` and `authenticated` roles inherit from PUBLIC. That makes any
-- SECURITY DEFINER function in `public` a callable endpoint by default -- and
-- revoking "from anon, authenticated" does nothing about it, because those
-- roles never held an individual grant to take away.
--
-- 001's two definer functions both return `trigger`, and PostgREST does not
-- expose trigger-returning functions, so nothing here was actually reachable
-- over the API. This closes the default grant regardless: a privilege nobody
-- decided to hand out should not be sitting there because the database handed
-- it out on our behalf.

revoke execute on function public.derive_formation() from public;
revoke execute on function public.limit_submissions() from public;

-- patch_at() is deliberately left callable. It is not SECURITY DEFINER, it only
-- reads `patches`, and `patches` is world-readable by policy -- so it can tell
-- nobody anything they could not already select.

notify pgrst, 'reload schema';
