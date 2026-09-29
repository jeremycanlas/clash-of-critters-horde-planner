-- The minute-by-minute sync reads the last half hour, not the whole round. Run
-- after 017.
--
-- 016 re-read every post since the gold rush began, every minute: one request
-- per hundred posts per channel, so about twenty a minute per channel by the
-- end of a busy round, and a hard stop at five thousand posts. Now:
--
--   every minute     posts from the last 30 minutes: new posts, and edits or
--                    deletions made to them. Usually one request per channel.
--   every 10 minutes the whole round, as before: edits and deletions to older
--                    posts. Also the first run of every round.
--
-- So an edit to a post more than half an hour old shows within ten minutes
-- rather than one. The cap is now twenty thousand posts.

alter table public.banquet_groups add column if not exists full_synced_at timestamptz;

-- `since` null replaces the group's whole round; otherwise only UIDs first
-- posted at or after it, from posts at or after it. A UID also posted earlier
-- keeps its earlier row, which only a whole-round read replaces.
drop function if exists public.banquet_apply(date, smallint, jsonb);
create or replace function public.banquet_apply(r date, g smallint, msgs jsonb, since timestamptz default null)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.banquet_uids
   where round = r and grp = g and source = 'discord' and (since is null or added_at >= since);
  insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source, message_id, added_at)
  select distinct on (u, m -> 'author' ->> 'id') r, g, u, m -> 'author' ->> 'id',
         coalesce(nullif(m -> 'author' ->> 'global_name', ''), m -> 'author' ->> 'username'),
         'discord', m ->> 'id', (m ->> 'timestamp')::timestamptz
    from jsonb_array_elements(msgs) m, public.banquet_parse(m ->> 'content') u
   where coalesce((m -> 'author' ->> 'bot')::boolean, false) = false
     and (since is null or (m ->> 'timestamp')::timestamptz >= since)
   order by u, m -> 'author' ->> 'id', (m ->> 'timestamp')::timestamptz
  on conflict do nothing;
  select public.banquet_sweep(r, g);
$$;
revoke all on function public.banquet_apply(date, smallint, jsonb, timestamptz) from public, anon, authenticated;

create or replace function public.banquet_sync()
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  r     date := public.banquet_round();
  start timestamptz := r::timestamp at time zone 'UTC';
  tok   text;
  g     record;
  since timestamptz;
  after bigint;
  page  jsonb;
  msgs  jsonb;
  res   extensions.http_response;
  n     int;
  said  text := '';
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'banquet_bot_token';
  if tok is null then return 'no token'; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '8000');

  for g in select * from public.banquet_groups where channel_id is not null order by grp loop
    -- The whole round every ten minutes, and on the first run of a round.
    since := case when g.full_synced_at is null or g.full_synced_at < start
                    or g.full_synced_at < now() - interval '10 minutes'
                  then null else greatest(start, now() - interval '30 minutes') end;
    -- A Discord ID is a timestamp: milliseconds since 2015, shifted 22 bits.
    after := ((extract(epoch from coalesce(since, start)) * 1000)::bigint - 1420070400000) << 22;
    msgs := '[]';
    begin
      for n in 1..200 loop
        res := extensions.http((
          'GET',
          format('https://discord.com/api/v10/channels/%s/messages?limit=100&after=%s', g.channel_id, after),
          array[extensions.http_header('Authorization', 'Bot ' || tok),
                extensions.http_header('User-Agent', 'DiscordBot (https://github.com/, 1)')],
          null, null)::extensions.http_request);
        if res.status <> 200 then raise exception 'Discord answered %', res.status; end if;
        page := res.content::jsonb;
        msgs := msgs || page;
        exit when jsonb_array_length(page) < 100;
        after := (select max((x ->> 'id')::bigint) from jsonb_array_elements(page) x);
        if n = 200 then raise exception 'more than 20000 posts; stopped'; end if;
      end loop;
    exception when others then
      update public.banquet_groups set sync_error = sqlerrm where grp = g.grp;
      said := said || format('group %s: %s. ', g.grp, sqlerrm);
      continue;
    end;

    perform public.banquet_apply(r, g.grp, msgs, since);
    update public.banquet_groups
       set synced_at = now(), sync_error = null,
           full_synced_at = case when since is null then now() else full_synced_at end
     where grp = g.grp;
    said := said || format('group %s: %s %s posts. ', g.grp, jsonb_array_length(msgs),
                           case when since is null then 'round' else 'recent' end);
  end loop;
  return btrim(said);
end;
$$;
