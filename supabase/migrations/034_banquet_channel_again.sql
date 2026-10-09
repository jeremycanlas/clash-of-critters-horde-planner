-- A server can read its Discord channel again. Run after 033.
--
-- 033 stopped every channel being read. One server (YCT) wants its channel read
-- once more, alongside the site; whether a server's channel is read is its own
-- scheduled job, started by hand for that server only:
--   select cron.schedule('tide-banquet-sync', '15 seconds', 'select tide.banquet_sync()');
--
-- The reader took a round's posts from its reset onward. Duneside's UIDs come
-- before its reset (033), so a round now has a separate point to read from:
-- for Duneside, the start of 6 Oct in Manila, when it was switched on.

-- ponytail: one fixed date for Duneside, as banquet_round() has; the next gold rush sets its own.
create or replace function public.banquet_reads_from(r date)
returns timestamptz
language sql
immutable
as $$
  select case when r = date '2026-10-07' then timestamptz '2026-10-06 00:00+08'
    else r::timestamp at time zone 'UTC' end;
$$;
revoke all on function public.banquet_reads_from(date) from public, anon, authenticated;

-- As 018, reading from banquet_reads_from(r) rather than the reset.
create or replace function public.banquet_sync()
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  r     date := public.banquet_round();
  start timestamptz := public.banquet_reads_from(r);
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
