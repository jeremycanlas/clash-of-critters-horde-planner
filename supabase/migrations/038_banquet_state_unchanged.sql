-- An unchanged list is not rebuilt. Run after 037.
--
-- Every open page asks for the list every 15 s, sending the fingerprint of
-- what it holds. banquet_state built the whole list each time only to compare
-- fingerprints, so on 7 Oct a few dozen open pages kept the database's
-- processor full and the site stopped answering, even after a restart.
--
-- Now a counter goes up on every change to the banquet data (a trigger on each
-- table), and the fingerprint is that counter plus who is asking, what they
-- may see and the minute. Asked again with the same fingerprint, the answer is
-- "same" without building anything. The minute in it means a page is rebuilt
-- at least once a minute, so nothing a change could slip past stays stale long.

create sequence if not exists public.banquet_version;
revoke all on sequence public.banquet_version from public, anon, authenticated;

create or replace function public.banquet_bump()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform nextval('public.banquet_version');
  return null;
end;
$$;
revoke all on function public.banquet_bump() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['banquet_uids', 'banquet_claims', 'banquet_marks', 'banquet_events', 'banquet_likes', 'banquet_group_members'] loop
    execute format('drop trigger if exists bump on public.%I', t);
    execute format('create trigger bump after insert or update or delete on public.%I for each row execute function public.banquet_bump()', t);
  end loop;
end $$;

-- As 033, with the fingerprint taken before the list is built.
create or replace function public.banquet_state(r date default null, known text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  you   record;
  now_  date := public.banquet_round();
  rr    date;
  hash  text;
  full_ jsonb;
  v     bigint;
begin
  select * into you from public.banquet_you();
  if you.discord_id is null then raise exception 'Your access needs checking again. Reload the page.'; end if;
  rr := coalesce(r, now_);
  hash := md5(concat_ws('|',
    (select last_value from public.banquet_version), rr, now_, you.discord_id, you.groups::text, you.sees_all,
    public.banquet_covered(rr, you.groups[1]), now() >= public.banquet_opens(rr),
    floor(extract(epoch from now()) / 60)));

  v := public.banquet_visit(you.discord_id, you.display, you.groups, rr);
  update public.banquet_access
     set last_at = now(), reads = reads + 1, groups = you.groups, display = you.display
   where id = v;

  if known = hash then
    return jsonb_build_object('same', true, 'hash', hash,
      'synced_at', (select min(g.synced_at) from public.banquet_groups g where g.grp = any (you.groups)));
  end if;

  full_ := public.banquet_state_full(r);
  if not you.sees_all and public.banquet_covered(rr, you.groups[1]) then
    full_ := full_ || jsonb_build_object('covered', true);
  end if;
  return full_ || jsonb_build_object('hash', hash);
end;
$$;
