# Horde Drafter — Clash of Critters

A static, no-build tool for planning a Horde Invasion formation: drag Tatari onto
your half of the field — 6 tiles across, 5 deep — cap out at 15, and keep a ranked
level-up order to read mid-run.

Everything is plain HTML, CSS and ES modules, so the repo root is publishable to
GitHub Pages as-is — no bundler, no dependencies at runtime.

## Run it locally

Browsers block `fetch` on `file://`, so serve the folder rather than opening
`index.html` directly:

```bash
npx --yes http-server . -p 8123 -c-1
```

Then open <http://localhost:8123>.

## Publish to GitHub Pages

Push the repo, then in **Settings → Pages** set *Source* to **Deploy from a
branch**, branch `main`, folder `/ (root)`. Nothing else is needed — `.nojekyll`
is already committed so Pages serves the files verbatim.

## What it does

**Roster** — all 218 Tatari, filterable by type, role and tier, with a search box
that matches names, whole evolution lines, skill text, wiki etymologies, and
community nicknames or the real animal a Tatari is based on ("capybara",
"pufferfish", "arctic fox"). Click a card to deploy it, click again to pull it
back, or drag it where you want it. The `i` button opens skill, matchup and
evolution details.

**Two layers, because Horde has two.** Your **bench** is the 15 Tatari you bring
into a run. The **field** is where they actually stand — and you don't get all 15
down, because the game offers you random choices. So the bench is what you commit
to, and the field is what you're hoping for.

Clicking a roster card brings a Tatari (bench only). Dragging it onto the field
brings *and* places it in one go. Benched-but-unplaced Tatari sit in a strip under
the grid; click one to place it, or drag it where you want.

**Field** — 6 columns × 5 rows. Zobos spawn beyond the top edge and never stand on
these tiles, so row 1 is the contact line. Drag between cells to rearrange
(dropping onto an occupied cell swaps them), double-click or press <kbd>Delete</kbd>
to take one off the field — it stays on the bench. Dragging works with mouse and
touch, auto-scrolls when you near a viewport edge, and the grid is fully
keyboard-operable (arrows to move, <kbd>Enter</kbd> to pick up and drop).

**Solo or co-op** — the switch in the header sets the caps:

| | Players | Bench each | Field each |
| --- | --- | --- | --- |
| Solo | 1 | 15 | 15 |
| Co-op | 2 | 15 | 10 |

In co-op both players share one field and every token is badged and ringed with its
owner's colour — P1 blue, P2 pink. The tabs above the grid pick who you're drafting
for and show both players' counts. Switching modes never silently loses work:
dropping to solo reports what P2 was carrying, and tightening the field cap unplaces
the excess onto the bench rather than deleting it.

**One per evolution line, per player.** Bringing Frostnip locks Frostpaw, Frostique
and Frostluna out of *that player's* bench — the roster marks them *"Frostnip in
use"*. The other player is unaffected: two teammates can absolutely run the same
Tatari, and the roster flags when they are with a small owner badge.

**Level-up priority** — Horde offers three cards each round, and some of them
level something already deployed. The plan is an ordered list of *steps*, each one
"take this Tatari to level N". A Tatari appears once per level it should hit on its
way to 7, so this is a legitimate plan:

| Step | Tatari | Level |
| --- | --- | --- |
| 1 | Sealing | 3 |
| 2 | Cheerling | 3 |
| 3 | Frugagon | 3 |
| 4 | Sealing | 5 |

Pick the Tatari from a strip of its own sprites — you recognise the art faster than
a name in a dropdown — then a level, then **Add step**. Or hit **+** on any Tatari on
the field. Repeated **Add step** walks the same one up a level at a time; jump ahead
manually and the next offer continues from there rather than back-filling the gap.

Each row's level is editable in place, rows drag to reorder
(<kbd>Ctrl</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> by keyboard), and the same Tatari can't be
planned at the same level twice. In co-op the plan covers both players and every step
is badged with its owner. Grid tokens show the level each one is planned to *reach*,
with the full step sequence in the tooltip.

Three levels of clearing, so nothing is all-or-nothing: **Clear steps** in this panel,
**Clear field** in the formation panel (benches kept), and **Clear all** in the header.

**Sharing and export** — **Share link** puts the mode, both benches, the layout and
the plan in one readable URL and copies it. `1.sealing@7` is player 1's Sealing in
cell 7; `@-` means benched but not placed:

```
#v4=coop/1.stoodbeak@0,1.sealing@7,1.chefugu@-,2.stoodbeak@3;1.sealing.3,2.sealing.3
```

**Export** writes JSON with the rules in force, each player's bench (cell, row,
column, whether it's on the field, target level), and the ordered `levelPlan`.
**Import** reads it back, and still accepts v1–v3 files as a solo formation. Work in
progress is kept in `localStorage`, so a reload picks up where you left off.

**Your own Tatari** — *+ Add your own* registers a critter the wiki has not
documented yet. Give several entries the same *evolution line* name and they
become mutually exclusive like a real line. Custom Tatari are stored in your
browser, and any that appear on a bench are bundled into the formation's export, so
the plan still opens on someone else's machine.

### Not modelled

`battleRow` (front/back preference) is in the data and shown on the detail sheet, but
nothing warns you about it — the wiki only records it for 87 of 218 Tatari using
pre-rework role names, and it isn't a rule players follow.

## Data

| File | Contents |
| --- | --- |
| `data/tatari.json` | 218 Tatari: type, role, tier, evolution line, rarity, skill, flavour text, wiki etymology, sprite paths |
| `data/meta.json` | type/role lists, the type-effectiveness chart, counts, grid dimensions and level cap |
| `data/aliases.json` | community nicknames and real-animal search terms, per evolution line |
| `data/images/tatari/` | 215 normal sprites, 200×200 |
| `data/images/glitter/` | 195 Glitter-form sprites, 200×200 |

### Refreshing from the wiki

```bash
node tools/scrape-wiki.mjs && python tools/normalize_images.py
```

The scraper re-reads <https://clashofcritters.wiki.gg/wiki/Tatari> plus the five
element pages, rewrites both JSON files, and downloads any sprite it does not
already have (`--no-images` skips that pass).

The normalizer then fixes framing. The wiki serves thumbnails at a fixed *width*,
not a fixed box, so raw downloads range from 200×160 to 200×281 — Sealing rendered
40% taller than Pearpair, while Blitzmane's art ran flush to all four edges with no
padding at all. For each sprite the normalizer trims the transparent border, scales
the artwork so its longest side is 176 px, and centres it on a 200×200 transparent
square. Same box, same padding, same apparent size for everyone; the CSS can then
just let sprites fill their container.

Processed files are tagged in PNG metadata, so re-running is a no-op (`--force`
overrides). It needs Pillow: `python -m pip install Pillow`.

A dozen sprites have to be enlarged slightly because the wiki's original is small —
Budboo's source is only 148 px — so those are marginally softer. The script lists
them.

Two things worth knowing about the scrape:

- **Evolution lines are inferred.** The wiki table has no family column, but it
  lists Tatari family by family and every member of a line shares its type and
  role — so a contiguous run of the same `(type, role)` is exactly one family.
  That yields 62 families of 2, 3 or 4 members with nothing left over, and the
  script warns if a future edit breaks the pattern. Rarity follows from it: a
  2-stage line is Common (blue), 3–4 stages is Rare (purple).
- **Front/back row is partial.** Only the five element pages record it, and they
  cover 87 of 218 Tatari using the pre-rework role names. It is treated as a hint
  in the summary, never a placement rule.

Three unreleased Tatari — Kaiseroo, Saberheart and Chomperwraith — have no sprite
on the wiki yet and render as their name.

### Aliases are guesswork

`data/aliases.json` is the one file that is not scraped. The wiki does not
publish which animal each Tatari is based on, so those entries were inferred from
names and sprites and some of them are certainly wrong. Fix them in the file, or
add your own in the app — local additions are merged on top and searched the same
way.

## Layout

```
index.html
assets/css/app.css
assets/js/
  app.js        boot, toolbar, drag auto-scroll
  data.js       roster loading, custom Tatari, search index
  store.js      benches, field, caps, per-player line exclusion, share URLs, import/export
  dnd.js        pointer-based drag controller (mouse + touch)
  grid.js       the 6x5 field, bench strip, player tabs
  roster.js     picker, filters, search
  priority.js   the level-up step plan
  detail.js     per-Tatari sheet
  custom.js     "add your own" editor
  icons.js      inline SVG type and role icons
data/
tools/
  scrape-wiki.mjs      pull data + sprites from the wiki
  normalize_images.py  trim and re-frame sprites to a common box
```

Type and role icons are hand-drawn SVG rather than wiki rips, so they stay sharp
at any size and follow the page's light/dark theme.

## Credits

Data and sprites come from the [Clash of Critters Wiki](https://clashofcritters.wiki.gg/wiki/Tatari).
Fan-made and unofficial; not affiliated with the developers of Clash of Critters.
