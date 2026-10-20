-- Likes posted in the UID channel count as likes noted on the site. Run after 054.
--
-- From 20 Oct the Send UIDs channel was asked to post each UID with its
-- building's likes ("17935440 100 likes"). The reader took the UIDs and threw
-- the counts away, so the site still said "no likes noted" for all of them.
--
-- A count is read from a line holding exactly one UID and "N like" or "N likes"
-- (a space or none). A line with two UIDs and one count is left alone: there is
-- no telling whose count it is. It is noted at the time of the post (or of its
-- last edit), so a count posted before a reset is that gold rush's "before",
-- as a count noted on the site then would be. Each poster's newest count per
-- UID; the reader goes over the same posts again, so a count already noted is
-- not noted twice.
--
-- The second server: the same file through setup-server.sh's moved() rewrite.

create or replace function public.banquet_likes_read(g smallint, msgs jsonb)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.banquet_likes (grp, uid, likes, discord_id, by_name, at)
  select g, x.uid, x.likes, x.discord_id, x.by_name, x.at
    from (
      select distinct on (p.uids[1], m -> 'author' ->> 'id')
             p.uids[1] as uid, l[1]::int as likes, m -> 'author' ->> 'id' as discord_id,
             coalesce((select mm.display from public.banquet_members mm where mm.discord_id = m -> 'author' ->> 'id'),
                      nullif(m -> 'author' ->> 'global_name', ''), m -> 'author' ->> 'username') as by_name,
             coalesce(m ->> 'edited_timestamp', m ->> 'timestamp')::timestamptz as at
        from jsonb_array_elements(msgs) m,
             regexp_split_to_table(coalesce(m ->> 'content', ''), '\n') line,
             regexp_match(line, '(?<![0-9])([0-9]{1,6}) ?likes?(?![a-z])', 'i') l,
             lateral (select array_agg(u) as uids from public.banquet_parse(line) u) p
       where coalesce((m -> 'author' ->> 'bot')::boolean, false) = false
         and l is not null and cardinality(p.uids) = 1 and l[1]::int <= 100000
       order by p.uids[1], m -> 'author' ->> 'id', 5 desc) x
   where exists (select 1 from public.banquet_uids b where b.grp = g and b.uid = x.uid)
     and not exists (select 1 from public.banquet_likes k
                      where k.grp = g and k.uid = x.uid and k.discord_id = x.discord_id and k.at = x.at);
$$;
revoke all on function public.banquet_likes_read(smallint, jsonb) from public, anon, authenticated;

-- The reader calls it after the UIDs are in. Edits the reader as it stands,
-- as 054 does banquet_check, so nothing else in it can drift.
do $$
declare d text := pg_get_functiondef('public.banquet_sync()'::regprocedure);
begin
  if d like '%banquet_likes_read%' then return; end if;
  if d not like '%perform public.banquet_apply(r, g.grp, msgs, since);%' then
    raise exception 'banquet_sync: no banquet_apply call to read likes after';
  end if;
  execute replace(d, 'perform public.banquet_apply(r, g.grp, msgs, since);',
    'perform public.banquet_apply(r, g.grp, msgs, since);
    perform public.banquet_likes_read(g.grp, msgs);');
end;
$$;
