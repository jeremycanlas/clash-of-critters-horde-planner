-- LOAD TESTS ONLY. Never apply this to a real server.
--
-- On a throwaway Supabase project, a request says which fake member it is in an
-- x-sim-user header, sent with the public key, instead of a Discord sign-in:
-- a thousand fake sign-ins are not to be had. Everything after "who is asking"
-- (banquet_you, the rules, the lists) runs exactly as on the live server.
create or replace function public.tracker_caller()
returns table (discord_id text, usernames text[], display text)
language sql
stable
security definer
set search_path = public
as $$
  select h, array[h], h
    from (select nullif(current_setting('request.headers', true)::json ->> 'x-sim-user', '') as h) x
   where h is not null;
$$;
do $$
declare f text;
begin
  foreach f in array array['public.banquet_state(date, text)', 'public.banquet_check()', 'public.banquet_claim(bigint, boolean, smallint)',
                           'public.banquet_mark(bigint, text, smallint)', 'public.banquet_changes(timestamptz, date)'] loop
    if to_regprocedure(f) is not null then execute format('grant execute on function %s to anon', f); end if;
  end loop;
end $$;
