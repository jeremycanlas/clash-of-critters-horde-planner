-- Possible copies: members who may be passing off someone else's UIDs as
-- their own MVPs. For Owner and Budboo Enjoyer only. Run after 020.
--
-- The same UID from two people is not wrong on its own: players on one game
-- server share their four MVPs. What stands out is
--
--   someone whose UIDs were all posted earlier by other people: they opened
--   the list without adding a banquet anyone lacked; and
--   a UID in both groups' lists, which suggests one group's list reaching the
--   other.
--
-- This only reports. Nobody is locked out by it; that is a person's call.

create or replace function public.banquet_copies(r date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  you record;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if not you.sees_all then raise exception 'Not for this account.'; end if;
  r := coalesce(r, public.banquet_round());

  return jsonb_build_object(
    -- Everyone with at least one UID someone else posted first, worst first.
    'people', (
      select coalesce(jsonb_agg(p order by (p ->> 'all_copied')::boolean desc, (p ->> 'copied')::int desc, p ->> 'name'), '[]')
        from (
          select jsonb_build_object(
                   'name', min(u.by_name), 'grp', u.grp, 'uids', count(*),
                   'copied', count(f.uid), 'all_copied', count(f.uid) = count(*),
                   'items', jsonb_agg(jsonb_build_object(
                              'uid', u.uid::text, 'at', u.added_at, 'source', u.source,
                              'first_by', f.by_name, 'first_grp', f.grp, 'first_at', f.added_at)
                            order by u.added_at)) as p
            from public.banquet_uids u
            left join lateral (
              select o.uid, o.by_name, o.grp, o.added_at from public.banquet_uids o
               where o.round = r and o.uid = u.uid and o.discord_id <> u.discord_id and o.added_at < u.added_at
               order by o.added_at limit 1) f on true
           where u.round = r
           group by u.grp, u.discord_id
          having count(f.uid) > 0
        ) t),
    'both_groups', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'uid', uid::text,
               'groups', (select jsonb_object_agg(g, names) from (
                            select x.grp::text g, jsonb_agg(distinct x.by_name) names from public.banquet_uids x
                             where x.round = r and x.uid = t.uid group by x.grp) y))
             order by uid), '[]')
        from (select uid from public.banquet_uids where round = r group by uid having count(distinct grp) > 1) t)
  );
end;
$$;

revoke all on function public.banquet_copies(date) from public, anon;
grant execute on function public.banquet_copies(date) to authenticated;
