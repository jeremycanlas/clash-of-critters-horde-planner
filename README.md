# Horde Drafter — Clash of Critters

A static, no-build tool for planning a Horde Invasion formation: drag Tatari onto a
5 × 6 field, cap out at 15, and keep a ranked level-up order to read mid-run.

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

**Field** — 5 columns × 6 rows with a hard 15-Tatari cap. Only one member of an
evolution line can be deployed at a time, so putting Frostnip down locks out
Frostpaw, Frostique and Frostluna; the roster marks them *"Frostnip in use"*.
Drag between cells to rearrange (dropping onto an occupied cell swaps them),
double-click or press <kbd>Delete</kbd> to remove. Dragging works with mouse and
touch, and the grid is fully keyboard-operable (arrows to move, <kbd>Enter</kbd>
to pick up and drop).

The front two rows are tinted, and where the wiki records a front/back-row
preference the summary flags anyone sitting on the wrong side of the field.

**Level-up priority** — Horde offers three cards each round, and some of them
level something already deployed. The ordered list is the plan for that: drag to
rearrange, or hit **Suggest order** for a front-line-first pass (Tank → Guardian
→ Healer → Support → DPS → Specialist, then by how far forward each one sits).
The rank shows on each grid token so you can read it at a glance.

**Sharing and export** — **Share link** puts the whole formation in the URL
(`#v1=frostnip@27,pyropup@12,…`, in priority order) and copies it. **Export**
writes a JSON file with each placement's cell, row, column and level priority.
**Import** reads it back. Work in progress is kept in `localStorage`, so a
reload picks up where you left off.

**Your own Tatari** — *+ Add your own* registers a critter the wiki has not
documented yet. Give several entries the same *evolution line* name and they
become mutually exclusive like a real line. Custom Tatari are stored in your
browser, and any that appear in a formation are bundled into its export, so the
plan still opens on someone else's machine.

## Data

| File | Contents |
| --- | --- |
| `data/tatari.json` | 218 Tatari: type, role, tier, evolution line, rarity, skill, flavour text, wiki etymology, sprite paths |
| `data/meta.json` | type/role lists, the type-effectiveness chart, counts, grid dimensions |
| `data/aliases.json` | community nicknames and real-animal search terms, per evolution line |
| `data/images/tatari/` | 215 normal sprites (200 px) |
| `data/images/glitter/` | 195 Glitter-form sprites |

### Refreshing from the wiki

```bash
node tools/scrape-wiki.mjs
```

Re-reads <https://clashofcritters.wiki.gg/wiki/Tatari> plus the five element
pages, rewrites both JSON files, and downloads any sprite it does not already
have. Add `--no-images` to skip the download pass.

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
  app.js        boot and toolbar wiring
  data.js       roster loading, custom Tatari, search index
  store.js      formation state, deploy cap, family exclusion, share URLs, import/export
  dnd.js        pointer-based drag controller (mouse + touch)
  grid.js       the 5x6 field
  roster.js     picker, filters, search
  priority.js   level-up order
  detail.js     per-Tatari sheet
  custom.js     "add your own" editor
  icons.js      inline SVG type and role icons
data/
tools/scrape-wiki.mjs
```

Type and role icons are hand-drawn SVG rather than wiki rips, so they stay sharp
at any size and follow the page's light/dark theme.

## Credits

Data and sprites come from the [Clash of Critters Wiki](https://clashofcritters.wiki.gg/wiki/Tatari).
Fan-made and unofficial; not affiliated with the developers of Clash of Critters.
