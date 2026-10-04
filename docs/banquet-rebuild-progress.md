# MVP banquet page rebuild: progress

Branch `claude/gracious-grothendieck-0310bb`, not pushed, not merged.
Design: screens 9–10, 2 and 5 of the banquet redesign canvas.

| Part | State |
|---|---|
| 1. Four statuses with count tiles | Done |
| 2. Your UIDs with statuses and "Copy a reminder" | Done |
| 3. Claim run | Done |
| 4. Activity log | Done |

## Decisions made while you were away

- A "Not logged in" UID comes back into the claim run after **1 hour**.
- A claim counts as "gift seen", so claiming moves a banquet to Claimable
  (unless it is marked Full). Taking the claim back leaves it Claimable.
- The tiles start with none pressed, so all four statuses show under their
  own headings. Tapping a tile shows only that status; tapping it again shows
  all four.
- The "Most room / Newest" order switch is gone, as in the design. Each status
  has its own order: Claimable has the fewest claims first, Needs a look has
  the newest first, and Not logged in has the longest unchecked first.
- On a phone, "Not logged in" on a card's button is shortened to "Not in" so
  three buttons fit side by side.
- Full cards keep a small "Not full" button, so a wrong tap can be undone.

## Before this goes live

1. Apply `supabase/migrations/031_banquet_statuses.sql`, then
   `032_banquet_likes.sql`, to the live database.
2. Apply both to the second server too:
   `sh tools/setup-server.sh tide supabase/migrations/031_banquet_statuses.sql supabase/migrations/032_banquet_likes.sql`.
3. Then merge and push the page. An old page against the new database is
   fine. The new page against the old database shows everything as
   "Needs a look" or "Not logged in" until 031 is in.

## Checks

- `supabase/banquet_check.sql`: ok. It runs in a transaction that is rolled
  back, so nothing is kept.
- `tools/banquet-page-check.mjs`: ok.

## Part 2 notes

- The reminder copies: "Your MVP banquet has not opened yet (UID …). It opens
  once the MVP logs in after the gold rush reset, so please log in once today.
  Thank you!" Change the wording in `reminder()` in `assets/js/banquet.js`.
- Statuses next to your own UIDs show only once the list is open to you (four
  UIDs posted), because that is when the page gets everyone's marks.

## Part 3 notes

- The run goes in this order: Claimable ones you have not claimed (most room
  first), then Needs a look (newest first), then Not logged in ones last
  checked an hour ago or more.
- It skips any banquet that became full, or that you claimed from its card,
  while the run was going.
- On a phone the run fills the whole screen. On a PC it is a box in the
  middle. Escape or "List" closes it.
- Each UID is copied the moment it shows. If the browser blocks the copy, it
  says "Tap the UID to copy it".

## Part 4 notes

- The log shows every claim, take-back, mark and post this gold rush, newest
  first, up to 50 lines. The database sends the newest 200.
- On a phone it is a fold at the bottom, open to start with. On a screen
  1100px or wider it is a column on the right that stays in view while you
  scroll.
- Lines from the last hour say "5 min"; older ones say the day and time.
- People who see both groups get a group tag on each line, and Both groups
  leaves the private list out of the log too.

## The commit hook, while this was built

- `tools/check.sh` uses port 8199. A leftover server was already on it, so
  the suites failed at random (this is likely the "one commit in three" on
  the status board). Every commit here ran with `COC_TEST_PORT=8299`, and all
  suites passed.
- The screen sweep loads GitHub's issue list on the contribute page. After
  many runs in one hour, GitHub's limit of 60 requests an hour without a
  login runs out and the sweep fails with 403s. It clears within the hour.
- The worktree had no `data/tracker.local.json` (it is git-ignored), so the
  tracker page 404'd in the sweep. It was copied over from the main checkout.

## Round 2: after the walkthrough

- **The merge of main.** The hook had stopped it on apptest and mobiletest.
  Both passed on a free port and again in the hook, with nothing changed:
  the known flakiness, not the merge. Nothing was holding port 8199.
- **1. The line at the top.** Not a page bug. `#bq-status` is only the
  "Checking your role with Discord…" line and empties once the list is in.
  The line a member reads at the top (round, "Ends 00:00 UTC", "Discord read
  just now") was showing all along; the walkthrough pointed at the wrong
  element. The check now asserts a member sees both lines.
- **2. Your UIDs** opens on arrival while one of yours is not logged in, and
  again whenever one newly turns not logged in, so the "Copy a reminder" line
  is in view. Otherwise it folds as before.
- **3. View as buttons** are redrawn whenever the groups, a name, or which
  are private change, so a new Discord role shows without a reload. The
  chosen view stays pressed; if its group goes, the page goes back to All
  groups. The group picker beside Add UID had the same once-only build and
  is redrawn the same way.
- **4. The claim run** already followed the view (it uses the same in-view
  rule as the cards). The check now proves it: All groups counts Group 1 plus
  Group 2 and never the private list, and a run As Group 2 offers only
  Group 2's UIDs.
- **6. The run's tally** is now four icons (gift, portrait, moon, skip) with
  a count each, one line on a 320px phone. The words are kept for screen
  readers and as a tooltip.
- **Activity log.** Each kind has its status icon and colour, and plainer
  verbs ("saw the gift on", "marked X full", "found X not logged in", "took
  back their claim on"). The newest line about a banquet you can claim has
  Copy UID and I claimed it. They use the same code as the card's buttons,
  Undo included. Once it is claimed or full, that line says so instead.

## Round 3: likes, so a portrait is not mistaken for full

The problem: after the reset an MVP's building keeps last time's portrait
until its MVP logs in, and a portrait reads as "full". People marked banquets
full that had not opened yet.

- **Likes on a building.** Every card has a small heart ("Likes"). Tap it,
  type what the building shows, Save (or Enter). Anyone in the group can, at
  any time, and it says who and when. Each full banquet is 50 likes, so 100
  means MVP twice before; the card says "MVP 2× before".
- **Before the reset.** The last count noted before a round's reset is that
  round's "Before reset" number. A member's UIDs come back every gold rush,
  so noting likes on this round's cards (as you already check before reset)
  sets up the next round. Counts noted since the reset show as "Now".
- **Full asks first.** On a building that had 50 or more before the reset,
  Full does not mark straight away. It asks: "150 or more · Full" or
  "Still 100 · Not logged in". The claim run's Portrait answer asks the same.
  A building with no likes noted (or under 50) works as before.
- **Noting a count that settles it** offers the mark in the toast: 150 or more
  offers "Mark full", the same 100 offers "Mark not logged in".
- Kept per group and UID (`banquet_likes`), not per round. Not in the
  activity log yet.
- Checks: `supabase/banquet_check.sql` (before/now picked right, other groups
  cannot write, nothing written by refused calls) and
  `tools/banquet-page-check.mjs` (the question on the card and in the run,
  the box survives a refresh, 320px fits). Screenshots: `E:\cachesq-likes\`.

Decided without you (say if any is wrong):
- 50 likes per banquet, as you said (100 = MVP twice).
- The question only shows for a building with 50+ likes before the reset.
- No auto-marking from a typed count: it offers the mark, you tap it.
