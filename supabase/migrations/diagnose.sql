-- Not a migration. A read-only check that says which of the parts posting needs
-- are actually in the database right now. Safe to run any time; changes nothing.
--
-- Expected answers once 001, 001a and 001b have all been run:
--
--   hashing_with     sha256      <- 'digest' means 001b has not been run
--   derive_trigger   1
--   limit_trigger    1
--   patch_at_fn      1
--   cards_view       1
--   hidden_granted   1           <- 0 means 001a has not been run
--   sha256_works     ok

select
  (select substring(prosrc from 'digest|sha256')
     from pg_proc where proname = 'derive_formation')            as hashing_with,
  (select count(*) from pg_trigger
    where tgname = 'formations_derive')                          as derive_trigger,
  (select count(*) from pg_trigger
    where tgname = 'formations_limit')                           as limit_trigger,
  (select count(*) from pg_proc where proname = 'patch_at')      as patch_at_fn,
  (select count(*) from pg_views
    where schemaname = 'public' and viewname = 'formation_cards') as cards_view,
  (select count(*) from information_schema.column_privileges
    where table_name = 'formations' and column_name = 'hidden'
      and grantee = 'anon' and privilege_type = 'SELECT')        as hidden_granted,
  (select case when encode(sha256(convert_to('x', 'UTF8')), 'hex') <> ''
               then 'ok' else 'no' end)                          as sha256_works,
  version()                                                      as postgres;
