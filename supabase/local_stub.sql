-- Just enough of Supabase for the banquet migrations and checks to run on a
-- plain local Postgres, so tests and load simulations never touch the live
-- database (7 Oct: a full check run at peak locked live tables).
--
--   sh tools/local-db.sh            start it, load this and the migrations
--
-- Stand-ins, not copies: the sign-in tables have only the columns the banquet
-- code reads, Discord is never asked (extensions.http answers 503, so a role
-- check says discord-down unless an answer is held), and scheduled jobs are
-- recorded, never run.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists cron;
create schema if not exists vault;
grant usage on schema public, extensions to anon, authenticated;

-- ---------------------------------------------------------------- sign-in
create table if not exists auth.users (
  id uuid primary key, aud text, role text, email text,
  last_sign_in_at timestamptz, created_at timestamptz default now()
);
create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(), provider_id text not null, user_id uuid not null references auth.users (id),
  identity_data jsonb not null, provider text not null, last_sign_in_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- ---------------------------------------------------------------- web calls (never made)
do $$ begin
  if not exists (select 1 from pg_type where typname = 'http_header' and typnamespace = 'extensions'::regnamespace) then
    create type extensions.http_header as (field text, value text);
    create type extensions.http_request as (method text, uri text, headers extensions.http_header[], content_type text, content text);
    create type extensions.http_response as (status int, content_type text, headers extensions.http_header[], content text);
  end if;
end $$;
create or replace function extensions.http_header(field text, value text) returns extensions.http_header
  language sql immutable as $$ select row(field, value)::extensions.http_header $$;
create or replace function extensions.http_set_curlopt(curlopt text, value text) returns boolean
  language sql as $$ select true $$;
create or replace function extensions.http(req extensions.http_request) returns extensions.http_response
  language sql as $$ select row(503, 'text/plain', '{}'::extensions.http_header[], 'local stand-in: no network')::extensions.http_response $$;
create or replace function extensions.http_get(uri text) returns extensions.http_response
  language sql as $$ select extensions.http(row('GET', uri, '{}', null, null)::extensions.http_request) $$;

-- ---------------------------------------------------------------- scheduled jobs (recorded, not run)
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create table if not exists cron.job_run_details (runid bigserial primary key, jobid bigint, status text, return_message text, start_time timestamptz default now());
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid
$$;
create or replace function cron.unschedule(job_id bigint) returns boolean language sql as $$
  with d as (delete from cron.job where jobid = job_id returning 1) select exists (select 1 from d)
$$;
create or replace function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d)
$$;

-- ---------------------------------------------------------------- secrets
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text);
create or replace view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
create or replace function vault.create_secret(secret text, name text) returns uuid language sql as $$
  insert into vault.secrets (secret, name) values (secret, name) returning id
$$;
create or replace function vault.update_secret(id uuid, secret text) returns void language sql as $$
  update vault.secrets s set secret = update_secret.secret where s.id = update_secret.id
$$;

-- ---------------------------------------------------------------- who you are (010_tracker)
create or replace function public.tracker_caller()
returns table (discord_id text, usernames text[], display text)
language sql
stable
security definer
set search_path = public, auth
as $$
  select i.provider_id,
         array_remove(array[
           lower(regexp_replace(i.identity_data ->> 'name', '#0+$', '')),
           lower(regexp_replace(i.identity_data ->> 'full_name', '#0+$', '')),
           lower(i.identity_data ->> 'user_name'),
           lower(i.identity_data -> 'custom_claims' ->> 'preferred_username')
         ], null),
         coalesce(nullif(btrim(i.identity_data -> 'custom_claims' ->> 'global_name'), ''),
                  nullif(btrim(i.identity_data ->> 'full_name'), ''),
                  nullif(btrim(i.identity_data ->> 'name'), ''),
                  'Someone')
    from auth.identities i
   where i.user_id = auth.uid()
     and i.provider = 'discord'
   order by i.last_sign_in_at desc nulls last
   limit 1;
$$;
