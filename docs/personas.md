# Who uses this, and how

Four people. They are not invented: each is assembled from something the project
already knows — GoatCounter's device and referrer split, the funnel counts, and
the named requests in the changelog. Where a claim is inference rather than
measurement it says so, because a persona nobody can check is just a preference
with a name on it.

What they are for: settling arguments about defaults. When two designs are both
defensible, the question is which of these four it fails.

---

## The evidence they are built from

| Signal | Number | Source |
| --- | --- | --- |
| Mobile share | 75% by screen, 72% by OS | GoatCounter, 455 hits |
| Safari | 47% of browsers, essentially all iOS | same |
| Opened → put something on the field | 286 → 151 (53%) | same |
| Field → saved | 151 → 11 (7%) | same |
| Saved → shared as an artifact | 11 → 7 (4 downloads, 3 copies) | same |
| Share link copied | **0** | same |
| Referrers | 14% Reddit, 13% Google, 8% YouTube, rest direct | same |
| Feature requests, named | 9 across 7 people | README changelog |

The two numbers that shape everything below: **three quarters are on a phone**,
and **the share button is not how formations travel**. Nobody has ever copied a
link. Four people have downloaded a card. Meanwhile the README's own observation
is that formations get posted as an OS screenshot of the grid.

So the artifact is the screenshot, and the screenshot is taken on a phone.

---

## 1. The Poster

**Builds a formation, screenshots it, posts it to Discord or Reddit.** On a
phone, in one sitting, between runs.

Evidence: 14% of `used` referrals are Reddit and the tool has appeared in a
YouTube video (Artiar). 53% of arrivals place something. 0 have copied a link.

What they need:

- The field frame to fit one phone viewport and carry everything a reader needs,
  because the crop is the deliverable. This is already why the LF and HAVE lines
  are drawn inside the frame and the site URL is not.
- Anything they mean to say to be **visible in the picture**. This is the whole
  argument for flex slots: an empty square that means "your choice" said nothing
  in a screenshot until it said FLEX.
- Clean view, which exists for exactly this and hides everything but the field.

What breaks them: any state that lives only in a tooltip or a hover. They are on
a phone. There is no hover. A rule that can only be read by pointing at it does
not exist in their copy of the tool.

## 2. The Co-op Partner

**Two players agreeing a split before a run.** One builds, posts the board with
LF and HAVE filled, the other answers.

Evidence: co-op mode, per-player benches and the LF/HAVE pair all exist because
this conversation does. @mersite asked for tier switching and for moving a
Tatari between players — both are edits you make while negotiating, not while
drafting alone.

What they need:

- To say "I have these, looking for those" as **one sentence**, which is why
  both lines can be filled at once.
- Whose Tatari is whose to survive the screenshot. P1/P2 colour is doing that
  work, and it is the reason `--p1`/`--p2` have a high-contrast pair of their
  own.
- Flex slots are theirs too, and arguably more theirs than the Poster's: "these
  four are mine, those two are yours" is a co-op sentence, and until now it had
  to be typed in a caption that a cropped screenshot loses.

Open question, not yet answered: whether the four chips flagged `scope:
unknown` in `data/chips.json` reach a partner. It changes whether a co-op pair
should coordinate chip picks at all.

## 3. The Learner

**Does not know the type chart or which Tatari bring heals.** PRODUCT.md names
them explicitly as an intended user, not an edge case.

Evidence: the request history is mostly legibility, not power. u/Nikky-Nami
asked for horde level-up skills to be shown; @lem77 for the buff/debuff tracker
and a range toggle; ztkz and dyslexicshowerhead for high contrast and a light
theme. None of those make the tool faster for an expert. They make it readable.

What they need:

- The interface to **carry the knowledge**, not assume it. Effect badges, the
  summary that names its sources, undefined skill tags that say they are
  undefined.
- To be told why something is refused. "That square is taken" beats a tap that
  does nothing.
- Chips are currently their worst surface. Forty-nine rules, no in-game wiki,
  and until this week the rule itself was in a tooltip they could not reach.

What breaks them: anything that answers in jargon they have not met yet. "3 of
your 5 in your back 2 rows" is a sentence you have to decode; five sprites are
not.

## 4. The Optimiser

**Knows the roster, is tuning a specific run.** The smallest group, and the one
the tool is least at risk of failing.

Evidence: inferred, not measured. The strongest support is the request set that
is *not* about legibility — glenthern's Sandbox duplicates, minhmax0r and
@johnlmbui's boss pull, both of which are about modelling a specific situation
precisely.

What they need:

- Density, and no ceremony between a decision and the board.
- Sandbox and the boss pull, which are both "let me model the real thing".
- The level-up plan, which is the only part of the tool that is about a run
  rather than a lineup.

What breaks them: a mode they have to leave to do the next thing. Worth watching
on the new flex-marking toggle — it is a mode, and modes cost this persona most.

---

## What this changes

Three decisions this document is meant to settle in advance:

1. **When phone and desktop conflict, phone wins.** Not a preference — 75%.
2. **When "visible in the app" and "visible in a screenshot" conflict, the
   screenshot wins.** It is the artifact that actually circulates.
3. **When density and legibility conflict, ask which persona is served.** The
   Learner is a stated intended user and the Optimiser is inferred. That is not
   a tie.

## What is still unknown

Named here so it does not get quietly assumed:

- Nobody has been observed using the tool. All four of these are reconstructed
  from counts and requests.
- Whether the 47% on iOS Safari can copy an image at all. PRODUCT.md flags it as
  unverified and it would explain part of the 4.6% share conversion.
- Whether the Learner and the Poster are usually the same person on the same
  evening, or two different visits.
