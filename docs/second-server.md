# A second server's banquets

The banquet page can serve more than one Discord server from the one Supabase
project. Each extra server gets a schema of its own: a full copy of the banquet
tables and functions under its own name, whose functions name nothing of the
first server's.

| Link | What it opens |
|---|---|
| `banquet.html` | The first server, exactly as before (schema `public`) |
| `banquet.html?s=tide` | The second server only (schema `tide`) |
| `banquet.html?s=duo` | Both in one list, for whoever each server lets in on its own terms |

The codes, names and schemas are in `SERVERS` at the top of
`assets/js/banquet.js`. One sign-in covers every link.

## Setting one up

Site address below: `https://jeremycanlas.github.io/clash-of-critters-horde-planner/`.

1. **The bot.** Invite the new server's bot. On its channel (`#send-uids`) it
   needs View Channel and Read Message History. In the Developer Portal → Bot,
   turn on Message Content Intent, or every post reads as empty.
2. **Roles.** Members need the member role. Viewers, who also see the access
   log and possible copies and can use the both-servers link, are named by
   Discord user ID in `.env`, and get in whether or not they are in the server.
3. **`.env`.** Add `BANQUET_TIDE_GUILD`, `BANQUET_TIDE_ROLE`,
   `BANQUET_TIDE_CHANNEL`, `BANQUET_TIDE_VIEWERS` (comma-separated user IDs) and
   `BANQUET_TIDE_BOT_TOKEN`. Discord IDs: Developer Mode on, then right-click →
   Copy ID. `.env` is gitignored; the token goes into Vault and is not shown again.
4. **Run** `sh tools/setup-server.sh tide`. It builds the schema from the banquet
   migrations, proves the rules in it with `supabase/banquet_check.sql`, saves
   the settings and reads the channel once.
5. **Dashboard, once:** Project Settings → Data API → Exposed schemas, add `tide`.
   Authentication → URL Configuration → Redirect URLs: add `…/banquet.html?s=tide`
   and `…/banquet.html?s=duo`, unless a wildcard there already covers them.

## Later banquet migrations

029 (viewers by user ID) is applied to `tide`; `public` gets it when the branch
is merged, and with no IDs set it behaves exactly as before.

A new `0NN_banquet_*.sql` is written for `public` as always, then applied to each
other server too: `sh tools/setup-server.sh tide supabase/migrations/0NN_banquet_x.sql`.

## What keeps them apart

- **Separate tables and functions.** The script rewrites every banquet table,
  function, scheduled job and the bot token's Vault name into the new schema,
  and the functions look there first. Before running anything it refuses a copy
  that still names any of the first server's objects. The one thing they share
  is `public.tracker_caller()`, which only says who you are on Discord.
- **The page asks one schema per request.** The first server's link never asks
  the second's schema, and the reverse; `tools/banquet-page-check.mjs` checks
  every request either link makes.
- **The both-servers view** merges the two lists in the browser of whoever
  opens it, only after each server has separately said yes, and sends every
  press to the schema its card came from. The only way a UID crosses is by a
  person carrying it.
- **What this does not guard against:** anyone with the database password sees
  both schemas, and a future hand-written function could name both. With every
  banquet migration going through the script's check, it would be refused there.

031 (four statuses and the activity log) is on the banquet rebuild branch and
applied to neither yet: apply it to `public`, then
`sh tools/setup-server.sh tide supabase/migrations/031_banquet_statuses.sql`,
before the page that needs it goes live.

033 (site only, Duneside, covered groups) stops reading Discord: the bot is
only asked about roles now, and `setup-server.sh` no longer reads the channel.
Which groups are covered until the reset is data, set by hand:
`update <schema>.banquet_groups set covered = true where grp in (…)`.

034 lets one server's channel be read again. YCT (`tide`) reads its channel
once more, from 6 Oct 00:00 Manila, and its list is not covered; the first
server stays site-only. A server's reading is its own scheduled job:
`select cron.schedule('tide-banquet-sync', '15 seconds', 'select tide.banquet_sync()')`
starts it and `cron.unschedule` with that name stops it.
