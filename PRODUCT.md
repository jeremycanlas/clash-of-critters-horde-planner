# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Players of Clash of Critters planning a Horde Invasion run. Confirmed: desktop
and mobile are both primary. Neither is the fallback, and a design that works
on one at the expense of the other has failed half the audience.

**Resolved by measurement: mobile is the primary target.** Desktop remains
supported and is roughly a quarter of the audience, but where the two conflict,
mobile wins.

GoatCounter, 455 hits (286 pageviews + 169 events):

- **75% mobile by screen size** (328 phones + 13 tablets vs 93 monitors + 21
  larger-than-HD); **72% by OS** (198 iOS + 129 Android vs 128 desktop).
- Safari is 47% of browsers, essentially all iOS. **iOS is the first platform to
  test on, not the last.**
- The split holds for real use, not just arrivals. Filtering `used` by device was
  not pulled directly, but the path totals bound it: desktop's 114 hits split
  between pageviews and events, giving ~74% mobile `used` at equal activation,
  and under 40% desktop pageviews even in the most desktop-favourable case.
- One earlier hypothesis is **disproved**: that phone traffic was inflated by
  people opening shared formation links. `link-copied` is 0 and card shares
  total 7. Arrivals are Reddit → tool (39% of `used` referrals are Reddit, the
  rest mostly direct), and those visitors build.

## Known Product Problem

**The share funnel is broken.** 286 opens → 151 `used` → 11 saved → 4
card-downloaded → 3 card-copied → **0 link-copied**. Activation is strong (53%
of visitors put something on the field); conversion to a shareable artifact is
4.6%. Since sharing is half the stated purpose, this is the largest known gap
between what the product is for and what it does.

Two documented contributors, neither yet fixed:

- The README already observed that formations get posted as an OS screenshot of
  the grid far more often than through the download button. If that is the real
  share mechanism, the field frame needs to fit one phone viewport and carry
  everything a reader needs, so the native screenshot *is* the artifact.
- Writing an image to the clipboard is unreliable on iOS, which is 44% of users,
  so "Copy image" may be failing for a large share of those who try it.
  Unverified; worth confirming on a real device before redesigning around it.

The tool is for the whole playerbase, not just the optimising core. Someone who
does not know the type chart or which Tatari bring heals is an intended user,
and the interface is expected to carry that knowledge rather than assume it.
Density and speed still matter, but they do not outrank being legible to
someone learning the game.

Secondary audience: the person receiving a shared formation, meaning a co-op
partner or a Discord/Reddit reader who did not build it and may not have the
tool open.

## Product Purpose

Plan a 15-Tatari Horde Invasion formation before committing to a run: choose
Tatari from the 230-strong roster, place them on the 6×6 field, and set the
order in which they get levelled. Then share the result as a picture or a link
so someone else can use it as a template.

Success is a player entering a run with a formation they have reasoned about
instead of improvised, and a shared card that another player can read at a
glance and act on.

## Positioning

The alternative is a spreadsheet, a screenshot of the in-game team screen, or
memory. Horde Drafter's difference is that it holds the game's actual data
(roster, types, roles, tiers, evolution lines, skills, level-up skills, attack
ranges) and reasons over the formation with it: what the formation brings
besides damage, which Tatari are locked out by an evolution line already in
use, which tiles are covered. A generic planner cannot do this without the
data; a screenshot cannot do it at all.

The second difference is the share artifact. The field frame is composed so a
cropped screenshot of the grid still carries the co-op ask, because that is how
formations actually travel.

## Operating Context

- Planning happens **between runs**, not during one. There is time to think,
  but the payoff is in the game, not in the tool.
- Formations travel through **Discord and Reddit**, usually as an image. Both
  named feature requests and the one reported bug in the changelog came from
  those channels (@lem77, u/Nikky-Nami, u/R2DKK).
- **Co-op** is a conversation between two players before a run. The LF
  ("looking for") and HAVE lines exist to make that ask postable, and both can
  be filled at once: "I have these, looking for those" is one sentence.
- Work is **resumable**: state lives in `localStorage`, so a reload continues
  where the player left off. Formations also save to and open from `.json`.
- The published site is served from **GitHub Pages** at
  `jeremycanlas.github.io/clash-of-critters-horde-planner`.

## Capabilities and Constraints

Confirmed functionality:

- 6×6 field, 15-Tatari bench, drag-and-drop by pointer and touch, solo and
  co-op modes with per-player tabs.
- Roster search over name, animal, community nickname and skill text; filters
  by type, role, tier, and by what a Tatari brings (heals/buffs/debuffs, which
  intersect rather than union); sorting; hiding Tatari blocked by an evolution
  line already in use.
- Level-up priority plan with per-step target level and notes.
- Per-Tatari detail sheet with stats, skill, level-up skills and attack-range
  diagram where recorded.
- Formation summary tallying types, roles, and the heals/buffs/debuffs the
  formation brings, with the sources named.
- Attack-range overlay behind a **Ranges (WIP)** toggle, off by default.
- Share as PNG (drawn to canvas), copy image, copy link; save/import `.json`;
  imported files may register custom Tatari.
- Glitter-art toggle for alternate sprites.
- Horde Invasion chips as a third roster list: all 49 with icon, rule, tier and
  type, filterable by either, in a list or a grid. The six that read placement
  and the fifteen that read your element split are scored against the board on
  the field and name the Tatari they would touch. You keep three, ranked, plus
  an unlimited list of alternatives; they ride the dock beside the bench and print on the
  full share card.
- **Flex slots**: any empty square can be marked as deliberately open. It draws
  as a dashed FLEX tile on the board and on the share card, which is what makes
  a posted formation readable as a template rather than as unfinished.

Technical constraints, **confirmed as not binding**:

The current implementation is plain HTML/CSS/JS with no build step, no runtime
dependencies, and every asset self-hosted so a clone runs without network
access. The user has confirmed these are current implementation facts, **not
rules future work must obey**. A build step, a framework, or web fonts are all
permitted if they earn their place.

As of Community, the project has one runtime service dependency: a Supabase
project reached over `fetch` against its PostgREST endpoint. There is still no
build step and no bundled library: the client is about 250 lines of `fetch` in
`assets/js/supabase.js`. `contribute.html` does not touch it; `community.html`
does, and says so plainly when it cannot reach it. `index.html` touches it only
when somebody presses Post.

Open decisions, not to be assumed:

- If a build step is introduced, the GitHub Pages deployment (deploy from
  branch `main`, folder `/ (root)`, `.nojekyll` committed) has to change with
  it. Undecided.
- Whether offline use is a property anyone actually relies on, or merely a
  side effect of how the app was built. Undecided.

Data constraints that are product truth, not implementation detail:

- The roster is **230 Tatari**. Every one has art; the six newest Zobos do not,
  and render without a sprite until the wiki has one.
- **Attack range** is recorded for 72 of 230 as tiles, and 115 of 230 exist as
  wiki screenshots. This is why the overlay ships off by default.
- **Horde level-up skills** cover 62 of 64 evolution lines (222 of 230 Tatari).
- **Base skill tags** cover 213 of 230; the level-up effects are inferred by
  matching wording, not tagged upstream.
- 20 of 32 skill-type tags have a published definition; the rest are shown as
  undefined rather than guessed.

## Brand Commitments

- Name: **Horde Drafter**. Subtitle: Clash of Critters.
- **Fan-made and unofficial**, not affiliated with the developers. Stated in the
  footer and README. Future work must not present the tool as official.
- Authored by **jacc6475** (Discord). The byline appears in the header with an
  avatar, deliberately placed so it is visible on load but never inside a
  screenshot of the grid; a fuller credit sits in the footer.
- Data and art are credited to the **Clash of Critters Wiki** with a link.
- Voice, as evidenced throughout the README and UI copy: plain, specific, and
  willing to state its own limits. It explains *why* a design decision was made
  and says "we don't know" where the data is incomplete rather than filling the
  gap. Hedging and marketing register would both be off-voice.

## Evidence on Hand

Real, in-repo, no fabrication needed:

- `data/tatari.json`: 230 Tatari with type, role, tier, evolution line, rarity,
  skill, flavour text, etymology.
- `data/meta.json`: types, roles, type-effectiveness chart, skill-type
  definitions, grid size, level cap.
- `data/aliases.json`: community nicknames and the real animal per line. The
  one file not scraped; inferred, and some entries are probably wrong.
- `data/ranges.json`: attack ranges as tile offsets, measured and eye-checked.
- `data/chips.json`: all 49 Horde Invasion chips. The one file with no upstream
  at all -- the wiki has no chip pages -- so every line was read off the in-game
  gallery by hand and the icons cut from screenshots of it by
  `tools/cut_chips.py`.
- `docs/personas.md`: four users assembled from the analytics and the named
  requests, with inference labelled as inference.
- `data/images/tatari/` (230 sprites), `glitter/` (207), `icons/` (11),
  `range/` (115 diagrams).
- `docs/screenshot.jpg`, `docs/media/`: the incumbent interface and share card.
- `assets/img/jacc6475.jpg`: the author's avatar.

Absences future work must not paper over: there are no testimonials, no usage
numbers beyond anonymous GoatCounter visit/button counts, no user quotes, no
press, and no partnership with the game's developers. None of these may be
invented.

## Product Principles

1. **Incomplete beats wrong.** Where data is missing, say so and show nothing
   rather than guess. Unrecorded ranges draw no tiles; undefined skill tags say
   they are undefined. In a tool people position by, a wrong tile is worse than
   a missing one.
2. **Name the source.** Inference is labelled as inference. The level-up
   effects derived from wording carry their level and their source Tatari, so a
   player can check the reasoning rather than trust it.
3. **The artifact must survive the crop.** Formations travel as screenshots
   into Discord and Reddit. Anything the recipient needs has to be inside the
   frame that gets captured.
4. **Art reads faster than names.** A player recognises a Tatari by its sprite,
   in any language. Wherever a Tatari is referenced, its art comes with it.
5. **Both hands and both screens.** Every interaction has a pointer path and a
   touch path, and the copy shown matches the input the player actually has.
6. **Nothing leaves the browser unless you post it.** Formations stay in
   `localStorage`; analytics are anonymous fixed labels only, published site
   only. The one exception is Community. Pressing *Post it publicly* sends that
   one formation, and doing so signs you in with Discord, which gives the
   database a display name, an account ID and an email address. Only the display
   name is used or shown. The email is requested by Supabase's Discord provider,
   which offers no way to opt out, so it is disclosed rather than denied.
   Both happen only on a press of a button that says what it does. Nothing is
   ever sent in the background, and a formation you do not post is never sent at
   all. Reading the gallery is the cheaper half: opening somebody's build is a
   plain `#v6=` link the drafter already knows how to read, so no network
   request is involved in that direction. This is a stated promise, not a
   default.

## Accessibility & Inclusion

No target standard has been set by the user, so none is recorded as a
requirement. The incumbent code does show deliberate practice worth preserving:
`role="grid"` on the field, labelled control groups, `sr-only` labels on
compact controls, a real `<label>` for the file input so the picker opens on the
browser's own activation, keyboard removal via <kbd>Delete</kbd>, and separate
pointer/touch instructions so neither audience is told to use hardware it does
not have.

Open decision: whether to commit to a named standard (e.g. WCAG 2.1 AA) as a
requirement for future work.
