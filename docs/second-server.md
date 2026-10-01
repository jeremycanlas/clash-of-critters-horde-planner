# A second server's banquets

The banquet page can serve more than one Discord server. Each one is its own
Supabase project with its own bot, so no query, bug or role in one database can
reach another's UIDs.

| Link | What it opens |
|---|---|
| `banquet.html` | The first server, exactly as before |
| `banquet.html?s=tide` | The second server only |
| `banquet.html?s=duo` | Both servers in one list, for whoever each database lets in on its own terms |

The codes and display names are in `SERVERS` at the top of
`assets/js/banquet.js`.

## Setting one up

Site address below: `https://jeremycanlas.github.io/clash-of-critters-horde-planner/`.

1. **Discord sign-in on the new project.** Authentication → Sign In / Providers
   → Discord: turn it on and paste the Client ID and Secret. Reusing the first
   project's Discord application is fine. In the Discord Developer Portal, under
   that application's OAuth2 → Redirects, add the new project's callback:
   `https://<new project ref>.supabase.co/auth/v1/callback`.
2. **Where sign-in may return to, on the new project.** Authentication → URL
   Configuration: set Site URL to the site address, and add these two Redirect
   URLs: `…/banquet.html?s=tide` and `…/banquet.html?s=duo`.
3. **On the first project, one addition, for the both-servers view:** add
   `…/banquet.html?s=duo` to its Redirect URLs. Nothing else there changes.
4. **The bot.** Invite the new bot to the new server. On `#send-uids` it needs
   View Channel and Read Message History. In the Developer Portal → Bot, turn on
   Message Content Intent, or every post reads as empty.
5. **Roles.** Members need the member role. Anyone who should also see the
   access log and possible copies, and use the both-servers link, needs a role
   listed as a viewer role.
6. **`.env`.** Add `SUPABASE_DB_URL_TIDE` (Settings → Database → Connection
   string → Session pooler), plus `BANQUET_TIDE_GUILD`, `BANQUET_TIDE_ROLE`,
   `BANQUET_TIDE_CHANNEL`, `BANQUET_TIDE_VIEWERS` (comma-separated role IDs) and
   `BANQUET_TIDE_BOT_TOKEN`. `.env` is gitignored.
7. **Run** `sh tools/setup-server.sh TIDE`. It applies every migration the first
   time, proves the rules with `supabase/banquet_check.sql`, saves the settings,
   and reads the channel once.
8. **Connect the page.** Put the new project's URL and publishable key into the
   `tide` entry of `SERVERS` in `assets/js/banquet.js`. The publishable key is
   public by design; the secret key never goes in the repo.

Until step 8, `?s=tide` says "Not connected" and the first server's link is
unaffected.

## What keeps them apart

- Two databases. The first server's link builds no connection to the second
  and sends it nothing, and the reverse; `tools/banquet-page-check.mjs` checks
  every request either link makes.
- Two sign-ins. Each database keeps its own session in the browser under its
  own key, so a request only ever carries the sign-in of the database it goes to.
- The both-servers view merges the two lists in the browser of whoever opens
  it, and only after each database has separately said yes. Every claim, mark,
  add or copy goes to the server its card came from. The only way a UID crosses
  is by a person carrying it.
