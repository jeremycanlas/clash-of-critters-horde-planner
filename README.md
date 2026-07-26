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

Nothing is uploaded anywhere. Your formation lives in your browser, and a reload
picks up where you left off.

## Where the data comes from

All the stats, sprites, type and role icons come from the
[Clash of Critters Wiki](https://clashofcritters.wiki.gg/wiki/Tatari) and is
included in this repo, so the app needs no network access to run.

| File | Contents |
| --- | --- |
| `data/tatari.json` | 218 Tatari: type, role, tier, evolution line, rarity, skill, flavour text, etymology |
| `data/meta.json` | type and role lists, the type-effectiveness chart, counts, grid size, level cap |
| `data/aliases.json` | community nicknames and the real animal each line is based on, for search |
| `data/images/tatari/` | 215 sprites, 200×200 |
| `data/images/glitter/` | 195 Glitter-form sprites, 200×200 |
| `data/images/icons/` | the 5 type and 6 role icons, 64×64 |

Three unreleased Tatari, Kaiseroo, Saberheart and Chomperwraith have no art on
the wiki yet and show as their name. The aliases file is the one thing not scraped:
which animal a Tatari is based on isn't published anywhere, so those were inferred
and some are probably wrong. Corrections welcome.

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
data/           the scraped roster, images and aliases
tools/          the wiki scraper and the image normalizer
```

## Deploying your own copy

Fork or clone the repo, then in **Settings → Pages** set *Source* to **Deploy from
a branch**, branch `main`, folder `/ (root)`. That's all — there's no build step,
and `.nojekyll` is already committed so Pages serves the files as they are.

## Credits

Data and art from the [Clash of Critters Wiki](https://clashofcritters.wiki.gg).
Fan-made and unofficial; not affiliated with the developers of Clash of Critters.
