# Horde Drafter - Clash of Critters

Plan your Horde Invasion formation before a run: drag and drop Tatari into the bench and onto the field, then plan the priority of levels for your team. Finally, share the whole thing as a picture or as a link for others to use as a template.

![The drafter with a formation laid out, the bench underneath and the level-up plan below it](docs/screenshot.jpg)

## Use it

**Online:** <https://jeremycanlas.github.io/clash-of-critters-horde-planner/>

**On your own machine:** the app is plain HTML, CSS and JavaScript with no build
step, but browsers block data loading on `file://`, so serve the folder rather
than double-clicking `index.html`:

```bash
git clone https://github.com/jeremycanlas/clash-of-critters-horde-planner.git
cd clash-of-critters-horde-planner
npx --yes http-server . -p 8123 -c-1
```

Then open <http://localhost:8123>. Any static server works — `python -m http.server`
if you'd rather not use Node.

Co-op has two lines for talking to a teammate: **LF** ("looking for", amber) and
**HAVE** ("I am bringing these", green). Either, neither or both can be filled —
"I have these, looking for those" is one sentence, so making it a choice between
the two was the wrong shape.

They share one editor rather than taking two rows of controls: a small pair of
buttons picks which line you are adding to, and each carries a count so the one
you are not looking at still shows it has something on it. Both are drawn on the
field, HAVE above LF.

Name Tatari on them and they appear as sprites — the art reads faster than the
name, and reads the same in any language — with a free text box beside it for
anything that is not one particular Tatari ("a healer"). The picker runs the
roster's own search, so aliases work the same way there: "monkey" finds Punchimp
and Rockfu, "panda" finds the Pandaroot line. It is a listbox rather than a
native `<datalist>` for one reason — a datalist cannot draw the sprite.

The line is drawn inside the field frame, not just in the share sheet, because
formations get posted as a screenshot of the grid far more often than through
the download button, and the ask has to survive being cropped.

## Privacy

Your formation never leaves your browser. It lives in `localStorage`, so a reload
picks up where you left off, and it is never sent anywhere — not the layout, not
the level-up plan, not the name you sign a shared card with.

The published site does count how many people visit and how often the Share and
Save buttons get used, through [GoatCounter](https://www.goatcounter.com). It sets
no cookies, records no personal data, and only ever receives a fixed label such as
`card-downloaded` — never anything about what you were planning. It is switched off
everywhere except the published site, so a clone or a fork counts nothing.

## Where the data comes from

All the stats, sprites, type and role icons come from the
[Clash of Critters Wiki](https://clashofcritters.wiki.gg/wiki/Tatari) and is
included in this repo, so the app needs no network access to run.

| File | Contents |
| --- | --- |
| `data/tatari.json` | 218 Tatari: type, role, tier, evolution line, rarity, skill, flavour text, etymology |
| `data/meta.json` | type and role lists, the type-effectiveness chart, what each skill type does, counts, grid size, level cap |
| `data/aliases.json` | community nicknames and the real animal each line is based on, for search |
| `data/ranges.json` | attack ranges as tile offsets, measured off the diagrams and checked by eye |
| `data/images/tatari/` | 215 sprites, 200×200 |
| `data/images/glitter/` | 195 Glitter-form sprites, 200×200 |
| `data/images/icons/` | the 5 type and 6 role icons, 64×64 |
| `data/images/range/` | 114 attack-range diagrams from the wiki, 480px wide |

Three unreleased Tatari, Kaiseroo, Saberheart and Chomperwraith have no art on
the wiki yet and show as their name. The aliases file is the one thing not scraped:
which animal a Tatari is based on isn't published anywhere, so those were inferred
and some are probably wrong. Corrections welcome.

The summary under the field also tallies what your formation brings besides
damage — heals, buffs and debuffs — and tapping a tally names exactly who brings
it — with their sprites, since that is how you recognise a Tatari you picked by
its art — in a panel of its own below the row. Each effect carries an **i**
button explaining what it does, in the wiki's own words: every tag has a
`Category:Skill Type: X` page whose opening line defines the effect, and the
scraper collects those into `meta.json`. 19 of the 32 tags are described that
way; the rest either have no category page yet (Shield, Stun) or still read
"known to TBA" (Bind, Blind), and those say so rather than being guessed at.
The same text is the tooltip on the skill-type chips in a Tatari's detail sheet.

The panel sits below the row. That panel is a fixed size and always
present: opening the names inside the row re-wrapped it and shoved every other
effect sideways, so reading a second one meant hunting for where it had gone.

The roster can also be filtered by what a Tatari brings — heals, buffs, debuffs.
These *intersect*: picking Heals and Buffs asks for one Tatari that does both,
which is the question worth asking of a 15-slot bench. (The type and role chips
still read as "any", since nothing is both Fire and Water.) Each
card carries a small marker per group: **solid** means it has the effect from
the start, **hollow with a level** means it only arrives once you have levelled
that far, and **solid with a level** means it has one now and gains another
later. "Brings a heal" and "could bring a heal at 5" are different picks.

Two sources feed those markers and the field tallies, and the difference shows:

- The **base skill** is tagged by the wiki itself, covering 203 of 218 Tatari.
  You get these for free.
- The **Horde level-up skills** at 3, 5 and 7 are only free text upstream, with
  no tags, so the same vocabulary is matched against the wording. These are
  marked with the level they arrive at — `L5` when that is the *only* way to get
  the effect, drawn as a dashed outline because the formation does not have it
  yet, and `+L5` when a level-up adds to something you already have. The source
  list names the Tatari, the level and the skill, so "Shellshy at 5 · Bubble
  Shield" tells you what levelling actually buys.

Matching wording is inference, not data, so it is deliberately cautious: a
leading `When ...,` clause names what sets a skill off rather than what it does,
and is not counted — Clucky's "When Weakened allies are nearby, provides
continuous healing" is a heal, not a Weaken.

Two things are only partly documented upstream, and the app says so rather than
pretending otherwise:

- **Horde level-up skills** cover 55 of the 62 evolution lines (190 of 218
  Tatari). The mode's page lists them per line, since every form in a line learns
  the same three; the base skill differs per form and comes from the roster.
- **Attack range** exists for 114 of 218 Tatari, and only as in-game screenshots
  with the reachable tiles lit up — photographs at assorted zooms with game UI on
  top. Those are shown as pictures on the detail sheet.

  The range *overlay* needs tiles rather than pictures, so `data/ranges.json`
  records them as offsets, keyed by the individual form — range is per-form, and
  evolving can change the shape and not just the reach. 72 of 218 are recorded.

  It sits behind the **Ranges (WIP)** toggle on the formation panel, off by
  default, because two thirds of the roster is still blank and a coverage map
  missing most of your Tatari misleads more than it helps. With it on, dragging
  or hovering a Tatari lights the tiles it would cover, and the field shades by
  how many of your Tatari reach each tile. Anything unrecorded shows no range
  rather than a guess, because a wrong tile is worse than a missing one in a
  tool people position by.

  `tools/read-range-diagrams.py` measures the tiles off a screenshot, which is
  most of the work; it cannot reliably tell which tile the Tatari is standing
  on, so its `sheets` output is meant to be checked by eye before anything is
  written to the data. `docs/ranges-todo.md` lists what is still missing and
  why. Contributions are welcome.

### Refreshing it

```bash
node tools/scrape-wiki.mjs && python tools/normalize_images.py
```

The scraper re-reads the wiki and rewrites both JSON files, downloading any sprite
it doesn't already have (`--no-images` skips that, `--icons-only` fetches just the
type and role icons). The normalizer then trims and re-frames every image so they
all sit in the same box at the same apparent size; it needs Pillow
(`python -m pip install Pillow`) and re-running it is a no-op.

## Project layout

```
index.html
assets/css/app.css
assets/js/
  app.js        boot and toolbar
  data.js       roster loading and the search index
  store.js      benches, field, caps, plan, share links, save/open
  dnd.js        pointer-based drag controller (mouse and touch)
  grid.js       the field, bench strip and player tabs
  roster.js     the picker, filters and search
  priority.js   the level-up plan
  share.js      the share sheet
  card.js       the formation drawn onto a canvas
  detail.js     the per-Tatari sheet
  custom.js     registers custom Tatari found in an imported file
  icons.js      type and role icon markup
  analytics.js  anonymous visit counts, published site only
data/           the scraped roster, images and aliases
tools/          the wiki scraper, the image normalizer, and the range-diagram reader
```

## Deploying your own copy

Fork or clone the repo, then in **Settings → Pages** set *Source* to **Deploy from
a branch**, branch `main`, folder `/ (root)`. That's all — there's no build step,
and `.nojekyll` is already committed so Pages serves the files as they are.

## Changelog

### 1.1.0

#### Changes:
- Polished mobile UI
- Added Horde Level-Up skills (suggested by u/Nikky-Nami) and Attack Range (if available) on Tatari Information
- Added Toggle for Tatari range indicators (WIP) (suggested by @lem77)
  - Added a read-range-diagram tool for measuring Tatari ranges from images
- Added Buff/Debuff/Heal tracker on the formation panel (suggested by @lem77)
  - Includes if a Buff/Debuff/Heal comes from a specific horde level-up or not
- Added a Buff/Debuff/Heal filter for the Roster
- Added an optional Looking For (LF) on the coop formation panel if you're looking for specific Tatari(s) for a coop partner
- Also added an optional Have (H) on the coop formation panel

#### Bug Fixes:
- Fixed the issue where fielded Tataris will disappear on the screen on mobile view. (Reported by u/R2DKK)

### 1.0.0
- Initial release

## Credits

Data and art from the [Clash of Critters Wiki](https://clashofcritters.wiki.gg).
Fan-made and unofficial; not affiliated with the developers of Clash of Critters.
