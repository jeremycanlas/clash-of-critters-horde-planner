-- "Which of these are mine", asked of the database rather than of the browser.
--
-- The gallery has never been able to answer this properly. `author_id` is
-- deliberately not readable by clients (006), so no filter could be written on
-- it, and `Yours` fell back to the list of ids this browser recorded when it
-- posted -- which is "yours, from here": post on a phone, look on a laptop, and
-- the filter says you have posted nothing.
--
-- A function is the narrow way to fix that. It runs as its owner, so it can see
-- author_id; it returns nothing but the caller's own ids, so it leaks nothing
-- about anybody else; and the view and its grants are left exactly as they are.

create or replace function public.my_formation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
    from public.formations
   where author_id = auth.uid()
     and deleted_at is null
     and not hidden
   order by submitted_at desc
   limit 200;
$$;

-- Signed in only: signed out, auth.uid() is null and the answer is empty anyway,
-- but there is no reason for anon to be able to ask.
revoke all on function public.my_formation_ids() from public, anon;
grant execute on function public.my_formation_ids() to authenticated;

notify pgrst, 'reload schema';
