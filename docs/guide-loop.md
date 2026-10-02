# Guide loop: getting the site ready for the Discord contest guide

Branch `skill-data-guide`, in its own worktree so the banquet work on main is
untouched. Nothing here is pushed or merged.

## The list (from the 2026-10-02 stats review)

1. Skill numbers for every Tatari, plus Horde Invasion numbers, on the Skill data page
2. One-tap share on phones (only 6% of builders open Share)
3. Gold Rush in Community: done on main (`1b9cdf9`)
4. Starter templates for Horde co-op: waiting on the user's share links
5. First-visit walkthrough on phones; a co-op section for the guide

## Where the numbers can come from

| Source | Base skill numbers | Horde Invasion numbers | Verdict |
|---|---|---|---|
| wiki.gg / fandom | no | names and text only | already scraped: text for 65 of 66 lines |
| Guide sites (mobi.gg, games.gg, clashcritters.com, ldshop) | no | no | nothing to take |
| In-game panel, by screenshot + OCR helper (`E:\caches\coc-arena\helper.py`) | yes | likely, if the Horde screen shows them | works; 7 done; slow because a person presses every key |
| In-game panel, driven by adb (BlueStacks' own `HD-Adb.exe`) | yes | yes | the way to all 242: tap, screenshot, OCR, scroll, next. Needs BlueStacks open on the roster |

The adb route reuses the helper's `read()` OCR and rally-watcher's adb discovery.
It needs one calibration session with BlueStacks open, to learn where the
roster, the skill panel and the scroll area sit on screen.

Dolphie is the only line with no Horde Invasion skills anywhere; it needs the game.

## Log

- **2026-10-03**: Skill data page lists all 66 lines. Unrecorded Tatari get a quiet card with
  the wiki's skill text; each line's Lv 3/5/7 Horde Invasion skills sit under its row;
  search reaches them; "With numbers only" toggle; type filter swipes on phones.
