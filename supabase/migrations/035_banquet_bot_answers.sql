-- The bot answers each post in a channel it reads. Run after 034.
--
-- Turned on per server by naming two emojis the bot can use, in
-- banquet_settings (ack_up, ack_down: "name:id"); unset, nothing is answered.
-- Only posts in the channels the reader already reads, from the same point.
--
--   every UID recorded             ack_up
--   a number that is nearly a UID  ack_down, and a reply naming it: 6-7 or
--   (6-7 or 9-10 digits)           9-10 digits, outside mentions, emoji codes
--                                  and links
--   neither (chat)                 nothing
--
-- An edit is answered again: the reaction swaps, and the reply is edited to
-- say it is fixed (or back to the warning). What was answered is kept in
-- banquet_acks, so nothing is sent twice. Also: 12345678, the format example
-- in announcements, is never a UID.

-- ---------------------------------------------------------------- 12345678

create or replace function public.banquet_parse(content text)
returns setof bigint
language sql
immutable
as $$
  select distinct m[1]::bigint from regexp_matches(coalesce(content, ''), '(?<![0-9])([0-9]{8})(?![0-9])', 'g') m
   where m[1] <> '12345678';
$$;

create or replace function public.banquet_add(target bigint, g smallint default null)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  you record;
  r date := public.banquet_round();
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  if target not between 10000000 and 99999999 then raise exception 'A UID is 8 digits.'; end if;
  if target = 12345678 then raise exception '12345678 is the example UID, not a real one.'; end if;
  insert into public.banquet_uids (round, grp, uid, discord_id, by_name, source)
  values (r, public.banquet_group_for(you.sees_all, you.groups, g), target, you.discord_id, you.display, 'site')
  on conflict do nothing;
end;
$$;

-- ---------------------------------------------------------------- reading a post

alter table public.banquet_settings add column if not exists ack_up text;
alter table public.banquet_settings add column if not exists ack_down text;

-- What a post holds: how many UIDs, and the numbers that look like a mistyped
-- one. Mentions, channel links, emoji codes and web links are left out first:
-- their long numbers are IDs, not typos.
create or replace function public.banquet_ack_read(content text)
returns jsonb
language sql
immutable
as $$
  with plain as (
    select regexp_replace(coalesce(content, ''), '<a?:[A-Za-z0-9_]+:[0-9]+>|<[@#][!&]?[0-9]+>|https?://[^[:space:]]+', ' ', 'g') as t
  )
  select jsonb_build_object(
    'uids', (select count(*) from public.banquet_parse(content)),
    'bad', (select coalesce(jsonb_agg(m[1] order by m[1]), '[]')
              from (select distinct m from plain, regexp_matches(plain.t, '(?<![0-9])([0-9]{6,7}|[0-9]{9,10})(?![0-9])', 'g') m) x));
$$;

-- What was last said about each post: its state, what it was said about, the reply.
create table if not exists public.banquet_acks (
  message_id text primary key,
  grp        smallint not null,
  posted_at  timestamptz not null,
  state      text not null check (state in ('ok', 'issue', 'none')),
  said       text not null,       -- the post's reading it answered, so an unchanged post is skipped
  reply_id   text,
  at         timestamptz not null default now()
);
alter table public.banquet_acks enable row level security;
revoke all on public.banquet_acks from anon, authenticated;

-- One call to Discord as the bot. Anything but a 2xx (or a 404 on taking a
-- reaction away) raises, so the post is tried again on the next read.
create or replace function public.banquet_discord(tok text, method text, path text, body jsonb default null)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions
as $$
declare res extensions.http_response;
begin
  res := extensions.http((
    method, 'https://discord.com/api/v10' || path,
    array[extensions.http_header('Authorization', 'Bot ' || tok),
          extensions.http_header('User-Agent', 'DiscordBot (https://github.com/, 1)')],
    'application/json',
    coalesce(body::text, ''))::extensions.http_request);   -- a PUT needs a body, even an empty one
  if res.status = 404 and method = 'DELETE' then return null; end if;
  if res.status not between 200 and 299 then raise exception 'Discord answered % to % %', res.status, method, path; end if;
  return case when res.content ~ '^\s*\{' then res.content::jsonb end;
end;
$$;

create or replace function public.banquet_ack_text(r jsonb)
returns text
language sql
immutable
as $$
  select case when jsonb_array_length(r -> 'bad') > 0 then
    '⚠️ Not recorded: ' || (select string_agg('`' || b || '` has ' || length(b) || ' digits', ', ')
                             from jsonb_array_elements_text(r -> 'bad') b)
    || '. A UID is 8 digits. Edit your message to fix it and I''ll pick it up.'
  when (r ->> 'uids')::int > 0 then
    '✅ Fixed, all ' || (r ->> 'uids') || ' UID' || case when (r ->> 'uids')::int = 1 then '' else 's' end || ' recorded.'
  else '✅ Fixed: no UIDs left in this message.' end;
$$;

-- Answers the posts in `msgs` from one channel; with `whole`, the channel's
-- posts since `start` are all there, so a post that is gone takes its reply with it.
create or replace function public.banquet_ack(g smallint, channel text, tok text, msgs jsonb, whole boolean, start timestamptz)
returns int
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  s     record;
  m     jsonb;
  a     record;
  rd    jsonb;
  want  text;
  said  text;
  reply text;
  base  text := '/channels/' || channel || '/messages/';
  n     int := 0;
  got   jsonb;
begin
  select ack_up, ack_down into s from public.banquet_settings;
  if s.ack_up is null or s.ack_down is null then return 0; end if;

  for m in select x from jsonb_array_elements(msgs) x
            where not coalesce((x -> 'author' ->> 'bot')::boolean, false) order by (x ->> 'id')::bigint loop
    begin
      rd := public.banquet_ack_read(m ->> 'content');
      want := case when jsonb_array_length(rd -> 'bad') > 0 then 'issue'
                   when (rd ->> 'uids')::int > 0 then 'ok' else 'none' end;
      said := rd::text;
      select * into a from public.banquet_acks where message_id = m ->> 'id';
      if a.message_id is null and want = 'none' then continue; end if;   -- chat
      if a.message_id is not null and a.said = said then continue; end if; -- answered already

      -- The reaction: the one wanted on, the other off.
      if want = 'ok' then
        perform public.banquet_discord(tok, 'PUT', base || (m ->> 'id') || '/reactions/' || replace(s.ack_up, ':', '%3A') || '/@me');
      elsif want = 'issue' then
        perform public.banquet_discord(tok, 'PUT', base || (m ->> 'id') || '/reactions/' || replace(s.ack_down, ':', '%3A') || '/@me');
      end if;
      if coalesce(a.state, 'none') = 'ok' and want <> 'ok' then
        perform public.banquet_discord(tok, 'DELETE', base || (m ->> 'id') || '/reactions/' || replace(s.ack_up, ':', '%3A') || '/@me');
      elsif coalesce(a.state, 'none') = 'issue' and want <> 'issue' then
        perform public.banquet_discord(tok, 'DELETE', base || (m ->> 'id') || '/reactions/' || replace(s.ack_down, ':', '%3A') || '/@me');
      end if;

      -- The reply: written on a problem, edited after.
      reply := a.reply_id;
      if reply is not null and (want = 'issue' or a.state = 'issue') then
        perform public.banquet_discord(tok, 'PATCH', base || reply, jsonb_build_object('content', public.banquet_ack_text(rd)));
      elsif reply is null and want = 'issue' then
        got := public.banquet_discord(tok, 'POST', '/channels/' || channel || '/messages', jsonb_build_object(
          'content', public.banquet_ack_text(rd),
          'message_reference', jsonb_build_object('message_id', m ->> 'id', 'fail_if_not_exists', false),
          'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb, 'replied_user', false)));
        reply := got ->> 'id';
      end if;

      insert into public.banquet_acks (message_id, grp, posted_at, state, said, reply_id)
      values (m ->> 'id', g, (m ->> 'timestamp')::timestamptz, want, said, reply)
      on conflict (message_id) do update set state = excluded.state, said = excluded.said, reply_id = excluded.reply_id, at = now();
      n := n + 1;
    exception when others then
      -- ponytail: a failed post is tried again on the next read; nothing records why but the sync's own error.
      raise warning 'banquet_ack %: %', m ->> 'id', sqlerrm;
    end;
  end loop;

  -- A deleted post: its reply goes too.
  if whole then
    for a in select * from public.banquet_acks k
              where k.grp = g and k.posted_at >= start
                and not exists (select 1 from jsonb_array_elements(msgs) x where x ->> 'id' = k.message_id) loop
      begin
        if a.reply_id is not null then perform public.banquet_discord(tok, 'DELETE', base || a.reply_id); end if;
        delete from public.banquet_acks where message_id = a.message_id;
      exception when others then raise warning 'banquet_ack gone %: %', a.message_id, sqlerrm;
      end;
    end loop;
  end if;
  return n;
end;
$$;

revoke all on function public.banquet_ack_read(text) from public, anon, authenticated;
revoke all on function public.banquet_discord(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.banquet_ack_text(jsonb) from public, anon, authenticated;
revoke all on function public.banquet_ack(smallint, text, text, jsonb, boolean, timestamptz) from public, anon, authenticated;

-- As 034, and each post read is answered.
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
    perform public.banquet_ack(g.grp, g.channel_id, tok, msgs, since is null, start);
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
