-- When Discord was last read for the caller's groups, so the page can say how
-- fresh the list is, and warn when the minute-by-minute sync has stopped (a
-- revoked token, the bot removed). A group member gets only their own group's
-- time, which says nothing about any other. Run after 016.

create or replace function public.banquet_state(r date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  you  record;
  now_ date := public.banquet_round();
  shared boolean;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  r := coalesce(r, now_);
  shared := public.banquet_shared(you.sees_all, you.discord_id, r, you.groups[1]);

  -- Built so a one-group member's answer has no group in it anywhere.
  return jsonb_build_object(
    'round', r,
    'current', now_,
    'rounds', (select coalesce(jsonb_agg(x order by x desc), '[]')
                 from (select distinct round as x from public.banquet_uids where grp = any (you.groups)
                       union select now_) t),
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('uid', uid::text, 'source', source)
                                       || case when you.sees_all then jsonb_build_object('grp', grp) else '{}' end
                                       order by added_at), '[]')
               from public.banquet_uids where round = r and grp = any (you.groups) and discord_id = you.discord_id),
    'shared', shared,
    'total', (select count(*) from (select distinct grp, uid from public.banquet_uids where round = r and grp = any (you.groups)) t),
    'banquets', case when r < now_ or shared then (
      select coalesce(jsonb_agg(b), '[]') from (
        select jsonb_build_object(
                 'uid', k.uid::text,
                 'entered_by', (select jsonb_agg(distinct u.by_name) from public.banquet_uids u where u.round = r and u.grp = k.grp and u.uid = k.uid),
                 'mine_site', exists (select 1 from public.banquet_uids u where u.round = r and u.grp = k.grp and u.uid = k.uid
                                        and u.discord_id = you.discord_id and u.source = 'site'),
                 'claims', (select count(*) from public.banquet_claims c where c.round = r and c.grp = k.grp and c.uid = k.uid),
                 'claimed_by', (select coalesce(jsonb_agg(c.by_name order by c.claimed_at), '[]') from public.banquet_claims c where c.round = r and c.grp = k.grp and c.uid = k.uid),
                 'claimed', exists (select 1 from public.banquet_claims c where c.round = r and c.grp = k.grp and c.uid = k.uid and c.discord_id = you.discord_id),
                 'full', (select m.by_name from public.banquet_marks m where m.round = r and m.grp = k.grp and m.uid = k.uid and m.state = 'full'),
                 'not_yet', (select jsonb_build_object('by', m.by_name, 'at', m.marked_at) from public.banquet_marks m
                              where m.round = r and m.grp = k.grp and m.uid = k.uid and m.state = 'not-yet')
               ) || case when you.sees_all then jsonb_build_object('grp', k.grp) else '{}' end as b
          from (select distinct grp, uid from public.banquet_uids where round = r and grp = any (you.groups)) k
      ) t)
    else '[]'::jsonb end
  ) || jsonb_build_object('synced_at', (select min(g.synced_at) from public.banquet_groups g where g.grp = any (you.groups)))
    || case when you.sees_all then jsonb_build_object('groups', to_jsonb(you.groups)) else '{}' end;
end;
$$;
