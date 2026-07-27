# Attack ranges still to record

`data/ranges.json` currently holds 72 of the 218 Tatari. This is what is missing
and why, so nobody re-treads it. A Tatari absent from `ranges.json` shows no range
in the app at all, which is deliberate — a wrong tile is worse than a missing one.

## 1. No range screenshot exists (104)

Nothing in `data/images/range/`, so there is nothing to read. These need somebody to
open the Tatari in game and screenshot the range diagram.

- `Armorjaw` | `Beetleknight` | `Blowfin` | `Boltallion`
- `Borelord` | `Budboo` | `Cactobloom` | `Cheerstella`
- `Chefugu` | `Chomperwraith` | `Chronerva` | `Chrysolaria`
- `Clangnaga` | `Cosmoram` | `Cragolin` | `Cratzar`
- `Cribking` | `Crystalsnail` | `Dagondeep` | `Dazopus`
- `Drilleroo` | `Droppit` | `Dumbopus` | `Ecstamira`
- `Fishopus` | `Flameow` | `Frostluna` | `Frugantuan`
- `Gemmapo` | `Gibber` | `Glideflip` | `Glimmerwing`
- `Glowfly` | `Haplysia` | `Heliabloom` | `Hierotyrus`
- `Hootlet` | `Humbleetle` | `Hychroma` | `Hyphoria`
- `Hypnostrix` | `Ignitoad` | `Joeyo` | `Kaiseroo`
- `Kangachamp` | `Kitjitsu` | `Lickflicker` | `Lilypo`
- `Lollama` | `Lulupo` | `Luminastra` | `Magmusk`
- `Magnedart` | `Maskfry` | `Meteorax` | `Momopo`
- `Nekoflare` | `Newflamander` | `Nimbuzzy` | `Orchitoria`
- `Ospisces` | `Pandagrand` | `Pandaroo` | `Pandarrior`
- `Phantifox` | `Phosflare` | `Poakie` | `Ptooielama`
- `Puffbelly` | `Pyrodaemon` | `Pyromaki` | `Pyroviathan`
- `Ripplewing` | `Rockwu` | `Rubblet` | `Saberheart`
- `Sealord` | `Searhog` | `Silversear` | `Sizzribb`
- `Slobberlama` | `Snapshade` | `Solaflora` | `Somnrayna`
- `Sonarbat` | `Souphog` | `Stormlion` | `Sulfunk`
- `Surgehoof` | `Synthhog` | `Terracrawler` | `Terraton`
- `Thornwisp` | `Tikowl` | `Trippet` | `Umbraveil`
- `Voltazar` | `Voltreaver` | `Waddledo` | `Waveflutter`
- `Weaverfang` | `Yawnelly` | `Zaplet` | `Zenscarab`

### Lines with no diagram for any form (12)

Worth grabbing first — right now these lines have no range data at any tier.

- `Blowfin` | `Budboo` | `Drilleroo` | `Dumbopus`
- `Flameow` | `Glowfly` | `Hootlet` | `Lollama`
- `Maskfry` | `Momopo` | `Poakie` | `Zaplet`

## 2. The diagram lights the whole board (8)

Every tile of the field is highlighted. That may genuinely mean board-wide reach —
several are Support forms — but it could equally be a different UI state that got
screenshotted. Needs confirming in game before writing 30-odd tiles into the data.

- `Buddi` | `Cindermunk` | `Embertail` | `Fluffle`
- `Fumekit` | `Galewether` | `Pyropup` | `Sunfleur`

## 3. Cannot tell if the Tatari's own tile is lit (34)

The shape itself is clear, but the sprite stands over the near edge of it and hides
whether the tile underneath is part of the range. Getting this wrong shifts every
offset by a row, so they are left out rather than guessed. Most are a straight lane
or a small block; the question is only where the near end stops.

- `Azurion` | `Bastogard` | `Blueflick` | `Cactoczar`
- `Clawzor` | `Cribbler` | `Dewgrub` | `Donscarab`
- `Dreadclaw` | `Flarevix` | `Frostique` | `Frugagon`
- `Funglet` | `Gemsnail` | `Goonbug` | `Grillhog`
- `Hothog` | `Jewelsnail` | `Ninjaguana` | `Puncharoo`
- `Rockfu` | `Seaswirl` | `Serrabloom` | `Shardsnail`
- `Skinkoon` | `Souverelle` | `Stalkerix` | `Stoodbeak`
- `Swaystroll` | `Taiglow` | `Tideon` | `Watchroo`
- `Zapantler` | `Zapuni`

## Reading one off a diagram

The Tatari stands at the bottom, lit tiles are what it reaches. Write the offsets as
`[column, row]` from its own tile, negative rows towards the Zobos. Key it under
`bySlug` by that form's own slug — range is per-form, not per-line.
