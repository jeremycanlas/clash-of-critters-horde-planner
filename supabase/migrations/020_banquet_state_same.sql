-- A refresh that finds nothing new costs a few bytes, not the whole list. Run
-- after 019.
--
-- Every open banquet page asks for the list every 30 seconds, and the list is
-- about 20 kB for a busy group, sent again whole even though nothing changed,
-- which is most of the time. That is Supabase egress, the free plan's limit.
--
-- The answer now carries a fingerprint of itself. A page that sends back the
-- fingerprint it holds (`known`) gets {same, synced_at, hash} when the list is
-- unchanged. The fingerprint is taken from the answer itself, so no change can
-- slip past it: at worst an equal list is sent again in full.
--
-- The old one-argument call still works: `known` defaults to null.

drop function if exists public.banquet_state_full(date);
alter function public.banquet_state(date) rename to banquet_state_full;
revoke all on function public.banquet_state_full(date) from public, anon, authenticated;

create or replace function public.banquet_state(r date default null, known text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  full_ jsonb := public.banquet_state_full(r);
  -- The minute-by-minute last read is left out, or the list would never be the same twice.
  hash  text := md5((full_ - 'synced_at')::text);
begin
  if known = hash then
    return jsonb_build_object('same', true, 'hash', hash, 'synced_at', full_ -> 'synced_at');
  end if;
  return full_ || jsonb_build_object('hash', hash);
end;
$$;

revoke all on function public.banquet_state(date, text) from public, anon;
grant execute on function public.banquet_state(date, text) to authenticated;
