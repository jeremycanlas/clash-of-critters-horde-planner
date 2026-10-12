-- Per-member numbers for viewers, by group: who adds, who claims, who checks.
-- Asked for on 12 Oct to spot who is not helping, reward those who are, and
-- look anyone up. Shown on the leaderboards page under the boards (042).
--
-- One row per member of the group: everyone whose last sign-in put them in it
-- (banquet_members.groups), zeros and all, plus anyone who did something in it
-- since and has left. Someone who never opened the page is not known to it.
--   uids:   UIDs they added (on the site or from Discord)
--   claims: banquets they claimed
--   checks: UIDs they marked open, full or not logged in (an undone mark is
--           gone from the log, 046), each UID once per round
-- Private lists are left out, as from the boards (044). Not cached: only
-- viewers ask, and only when they open the page.

create or replace function public.banquet_member_stats(r date default null, all_time boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  you record;
  rr  date;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if not you.sees_all then raise exception 'Only viewers see the member numbers.'; end if;
  rr := case when all_time then null else coalesce(r, public.banquet_round()) end;

  return (
    with g as (select x as grp from unnest(you.groups) x
                where not exists (select 1 from public.banquet_groups gg where gg.grp = x and gg.private)),
    uids as (select grp, discord_id, count(*) as n from public.banquet_uids
              where grp in (select grp from g) and (rr is null or round = rr) group by 1, 2),
    claims as (select grp, discord_id, count(*) as n from public.banquet_claims
                where grp in (select grp from g) and (rr is null or round = rr) group by 1, 2),
    checks as (select grp, discord_id, count(distinct (round, uid)) as n from public.banquet_events
                where grp in (select grp from g) and (rr is null or round = rr) and kind in ('open', 'full', 'not-yet')
                group by 1, 2),
    who as (select g.grp, m.discord_id from g join public.banquet_members m on m.ok and g.grp = any (m.groups)
            union select grp, discord_id from uids
            union select grp, discord_id from claims
            union select grp, discord_id from checks),
    rows_ as (select w.grp,
                     coalesce(m.display,
                       (select u.by_name from public.banquet_uids u where u.discord_id = w.discord_id limit 1),
                       (select e.by_name from public.banquet_events e where e.discord_id = w.discord_id limit 1),
                       'Someone') as name,
                     coalesce(m.ok and w.grp = any (m.groups), false) as member,
                     coalesce(u.n, 0) as uids, coalesce(c.n, 0) as claims, coalesce(k.n, 0) as checks
                from who w
                left join public.banquet_members m on m.discord_id = w.discord_id
                left join uids u on u.grp = w.grp and u.discord_id = w.discord_id
                left join claims c on c.grp = w.grp and c.discord_id = w.discord_id
                left join checks k on k.grp = w.grp and k.discord_id = w.discord_id)
    select jsonb_build_object('round', rr, 'groups', coalesce(jsonb_agg(jsonb_build_object(
             'grp', gg.grp,
             'name', coalesce(gg.name, 'Group ' || gg.grp),
             'members', (select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'member', x.member,
                                  'uids', x.uids, 'claims', x.claims, 'checks', x.checks)
                                  order by x.checks + x.claims + x.uids desc, lower(x.name)), '[]')
                           from rows_ x where x.grp = gg.grp))
             order by gg.grp), '[]'))
      from public.banquet_groups gg where gg.grp in (select grp from g)
  );
end;
$$;
revoke all on function public.banquet_member_stats(date, boolean) from public, anon;
grant execute on function public.banquet_member_stats(date, boolean) to authenticated;
