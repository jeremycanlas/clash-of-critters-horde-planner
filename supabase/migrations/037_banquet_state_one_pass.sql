-- The list, in one pass. Run after 036.
--
-- banquet_state_full looked up each banquet's posters, claims, marks and
-- likes one banquet at a time. Duneside's list on the first server is 3,641
-- banquets, five times any before, and one viewer's load took 11-18 s; with
-- every open page asking every 15 s, the API's connections filled and the
-- page said "busy" (7 Oct, 8 AM). Same answer, built from one pass per table.

create or replace function public.banquet_state_full(r date default null)
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
  opens_ timestamptz;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  r := coalesce(r, now_);
  opens_ := public.banquet_opens(r);
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
    -- One pass per table, joined, rather than a dozen lookups per banquet:
    -- a list of 3,641 took 11-18 s that way (7 Oct).
    'banquets', case when r < now_ or shared then (
      with k as (
        select u.grp, u.uid, min(u.added_at) as posted, jsonb_agg(distinct u.by_name) as entered_by,
               bool_or(u.discord_id = you.discord_id and u.source = 'site') as mine_site
          from public.banquet_uids u where u.round = r and u.grp = any (you.groups) group by u.grp, u.uid),
      c as (
        select c.grp, c.uid, count(*) as n, jsonb_agg(c.by_name order by c.claimed_at) as by_names,
               bool_or(c.discord_id = you.discord_id) as mine
          from public.banquet_claims c where c.round = r and c.grp = any (you.groups) group by c.grp, c.uid),
      m as (select m.grp, m.uid, m.state, m.by_name, m.marked_at from public.banquet_marks m where m.round = r and m.grp = any (you.groups)),
      lb as (select distinct on (l.grp, l.uid) l.grp, l.uid, l.likes, l.by_name, l.at from public.banquet_likes l
              where l.grp = any (you.groups) and l.at < opens_ order by l.grp, l.uid, l.at desc),
      ln as (select distinct on (l.grp, l.uid) l.grp, l.uid, l.likes, l.by_name, l.at from public.banquet_likes l
              where l.grp = any (you.groups) and l.at >= opens_ and l.at < opens_ + interval '6 days' order by l.grp, l.uid, l.at desc)
      select coalesce(jsonb_agg(jsonb_build_object(
               'uid', k.uid::text,
               'posted', k.posted,
               'entered_by', k.entered_by,
               'mine_site', k.mine_site,
               'claims', coalesce(c.n, 0),
               'claimed_by', coalesce(c.by_names, '[]'),
               'claimed', coalesce(c.mine, false),
               'full', case when m.state = 'full' then m.by_name end,
               'full_at', case when m.state = 'full' then m.marked_at end,
               'not_yet', case when m.state = 'not-yet' then jsonb_build_object('by', m.by_name, 'at', m.marked_at) end,
               'open', case when m.state = 'open' then jsonb_build_object('by', m.by_name, 'at', m.marked_at) end,
               'likes_before', case when lb.uid is not null then jsonb_build_object('n', lb.likes, 'by', lb.by_name, 'at', lb.at) end,
               'likes_now', case when ln.uid is not null then jsonb_build_object('n', ln.likes, 'by', ln.by_name, 'at', ln.at) end
             ) || case when you.sees_all then jsonb_build_object('grp', k.grp) else '{}' end), '[]')
        from k
        left join c on c.grp = k.grp and c.uid = k.uid
        left join m on m.grp = k.grp and m.uid = k.uid
        left join lb on lb.grp = k.grp and lb.uid = k.uid
        left join ln on ln.grp = k.grp and ln.uid = k.uid)
    else '[]'::jsonb end,
    -- ponytail: the newest 200 only; a page of older ones when a round needs it.
    'events', case when r < now_ or shared then (
      select coalesce(jsonb_agg(jsonb_build_object('uid', e.uid::text, 'kind', e.kind, 'by', e.by_name, 'at', e.at)
                                || case when you.sees_all then jsonb_build_object('grp', e.grp) else '{}' end
                                order by e.at desc), '[]')
        from (select grp, uid, kind, by_name, at from public.banquet_events where round = r and grp = any (you.groups)
              union all
              select grp, uid, 'post', by_name, added_at from public.banquet_uids where round = r and grp = any (you.groups)
              order by at desc limit 200) e)
    else '[]'::jsonb end
  ) || jsonb_build_object('synced_at', (select min(g.synced_at) from public.banquet_groups g where g.grp = any (you.groups)))
    || case when you.sees_all then jsonb_build_object(
         'groups', to_jsonb(you.groups),
         -- What to call each, and which are private: never folded into Both groups.
         'names', (select jsonb_object_agg(g.grp, coalesce(g.name, 'Group ' || g.grp)) from public.banquet_groups g where g.grp = any (you.groups)),
         'private', (select coalesce(jsonb_agg(g.grp order by g.grp), '[]') from public.banquet_groups g where g.grp = any (you.groups) and g.private))
       else '{}' end;
end;
$$;

revoke all on function public.banquet_state_full(date) from public, anon, authenticated;
