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

1. Apply `supabase/migrations/031_banquet_statuses.sql` to the live database.
2. Apply it to the second server too:
   `sh tools/setup-server.sh tide supabase/migrations/031_banquet_statuses.sql`.
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
