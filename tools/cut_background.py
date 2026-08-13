#!/usr/bin/env python3
"""
Cuts the background out of sprites the wiki serves as flat pictures.

Most Tatari art on the wiki arrives as a PNG with a real alpha channel, and
normalize_images.py can trim it straight away. A minority does not: the artwork
has been exported over a background — a purple radial gradient behind Cavyzap,
a cream texture behind Kaiseroo, bokeh circles behind Gigagnash, and for a few
of the glitter sprites an entire outdoor scene with sky and hills. Dropped into
the roster next to 200-odd cut-out sprites, those read as mistakes.

    python tools/cut_background.py                # only files that need it
    python tools/cut_background.py --only cavyzap hippiehog
    python tools/cut_background.py --dry-run      # list what it would touch
    python tools/cut_background.py --force        # redo files already cut

Run this BEFORE normalize_images.py. Normalising trims the transparent border,
which requires there to be one; run in the other order and the background is
baked into a 200x200 canvas with nothing to trim.

## Why a model rather than a flood fill

The obvious approach — pick the corner colour, flood outwards while the colour
stays within a tolerance — is a hundred lines lighter and works on none of
these. Every background here is a gradient, a texture, or a photograph of a
field, so there is no single corner colour to match: the tolerance that reaches
the far corner also eats the sprite. Worse, these are cartoon characters with
saturated flat fills, so a tolerance wide enough to cross a gradient reliably
matches some part of the character too, and the failure is a hole through the
middle of a Tatari rather than a visibly wrong edge.

rembg is a salient-object segmentation model (U^2-Net family). It is a tools/
dependency, never shipped to a browser, in the same way Pillow already is.
The first run downloads model weights (~180 MB) to ~/.u2net and is slow; every
run after that is local and takes about a second per image.

## What it will not fix

Segmentation finds the subject and removes everything else. That is the wrong
job for two kinds of file this repo has seen, and both are worth catching by
eye rather than shipping:

  - in-game screenshots, where damage numbers and HUD are burned into the art
    and overlap the character (Technocan, Blastniff);
  - full cards, where a name banner and a frame are part of the picture
    (Hippiehog).

Those need a better source image from the wiki, not a better mask. --check
reports them so they do not quietly pass.

Processed files are tagged in PNG metadata, so re-running is a no-op and the
scraper's own "skip what already exists" behaviour keeps working.
"""

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, PngImagePlugin
except ImportError:
    sys.exit("Pillow is required:  python -m pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent

DIRS = [
    ROOT / "data/images/tatari",
    ROOT / "data/images/glitter",
]

MARKER = "coc-bg-cut"
MARKER_VALUE = "1"
NORMALIZED = "coc-normalized"

# A pixel this faint is antialiasing, not artwork — the same floor
# normalize_images.py uses when it looks for the content box.
ALPHA_FLOOR = 8

# How a file is judged to still carry a background. Either test alone gives
# false positives: art that genuinely fills its canvas edge to edge trips the
# corner test, and a sprite cropped tight to its subject trips the coverage
# test. Both at once is what a background looks like.
CLEAR_FRACTION = 0.02   # less than 2% transparent pixels
OPAQUE_CORNERS = 3      # at least 3 of 4 corners solid

# ...and the second kind, which the corner test alone silently passes.
#
# A sprite that has already been through normalize_images.py sits centred on a
# 200x200 transparent canvas, so its canvas corners are clear and a third of the
# file really is transparent — it looks cut out by every measure above, while
# the artwork inside is still a solid rectangle of gradient with a character
# drawn on it. Thirteen of the roster were in exactly that state.
#
# What actually distinguishes them is the border of the *content* box rather
# than the border of the canvas: on a cut-out sprite the outline is the
# character, so most of that perimeter is transparent, and on a background it is
# the edge of the rectangle and all of it is solid.
RECT_BORDER = 0.90      # 90%+ of the content box's perimeter opaque
RECT_MIN_SIDE = 8       # ignore anything too small to have a meaningful border

# The default model. isnet-general-use holds edges better than u2net on flat
# cartoon fills, which is all of this roster; u2net is kept reachable through
# --model for the odd sprite it does better on.
MODEL = "isnet-general-use"

# Alpha matting cleans up the band of half-transparent pixels the model leaves
# at the boundary. Without it, a sprite lifted off a saturated background keeps
# a rim of that background's colour, which on the dark field reads as a glow.
MATTING = dict(
    alpha_matting=True,
    alpha_matting_foreground_threshold=240,
    alpha_matting_background_threshold=10,
    alpha_matting_erode_size=5,
)


def fills_canvas(img):
    """Artwork exported over a background that reaches every edge of the file."""
    w, h = img.size
    clear = sum(img.getchannel("A").histogram()[:ALPHA_FLOOR + 1])
    if clear / (w * h) >= CLEAR_FRACTION:
        return False
    px = img.load()
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    return sum(1 for c in corners if c[3] > 200) >= OPAQUE_CORNERS


def solid_rectangle(img):
    """A background already trimmed and centred, so only its own edge gives it away."""
    box = img.getchannel("A").point(lambda v: 255 if v >= ALPHA_FLOOR else 0).getbbox()
    if not box:
        return False
    left, top, right, bottom = box
    if right - left < RECT_MIN_SIDE or bottom - top < RECT_MIN_SIDE:
        return False

    px = img.load()
    perimeter = []
    for x in range(left, right):
        perimeter += [px[x, top], px[x, bottom - 1]]
    for y in range(top, bottom):
        perimeter += [px[left, y], px[right - 1, y]]
    opaque = sum(1 for c in perimeter if c[3] > 200)
    return opaque / len(perimeter) >= RECT_BORDER


def has_background(img):
    """True when this looks like artwork exported over a background."""
    return fills_canvas(img) or solid_rectangle(img)


# ---------------------------------------------------------------- flood fill

# The escape hatch for the sprites segmentation gets wrong, and it is wrong in
# a consistent way: a subject drawn in pale, translucent colours over a
# saturated background reads to the model as background itself. Luminastra's
# glitter art is white gauzy wings and a dark crest on violet, and all four
# models tried on it threw the wings away and kept the middle third.
#
# What saves it is the thing the module docstring says a flood fill cannot
# rely on — except the objection there was about matching one *global* colour
# across a gradient. Comparing each pixel to the neighbour it spread from
# instead costs nothing and removes the objection: a gradient changes by a
# point or two per pixel and the fill walks straight across it, while the black
# outline these sprites are drawn with is a jump of a hundred or more and stops
# it dead. The character's own colours are never consulted, so a pale wing is
# as safe as a dark one.
#
# It is not the default because it needs that unbroken outline. Where the
# artwork bleeds into its background — the in-game screenshots — the fill
# escapes through the gap and takes the sprite with it, which is why this is
# opt-in per file rather than a fallback the tool reaches for on its own.
FLOOD_TOLERANCE = 12    # per-channel step allowed between adjacent pixels
FLOOD_SPECKLE = 24      # opaque islands smaller than this are fill leftovers


def flood_cut(img, tolerance=FLOOD_TOLERANCE):
    """Clear everything reachable from the border without crossing an edge."""
    from collections import deque

    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()

    background = bytearray(w * h)
    queue = deque()

    def seed(x, y):
        if not background[y * w + x]:
            background[y * w + x] = 1
            queue.append((x, y))

    for x in range(w):
        seed(x, 0)
        seed(x, h - 1)
    for y in range(h):
        seed(0, y)
        seed(w - 1, y)

    while queue:
        x, y = queue.popleft()
        here = px[x, y]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if not (0 <= nx < w and 0 <= ny < h) or background[ny * w + nx]:
                continue
            there = px[nx, ny]
            if max(abs(there[i] - here[i]) for i in range(3)) <= tolerance:
                background[ny * w + nx] = 1
                queue.append((nx, ny))

    # Pockets of background enclosed by the artwork are never reached from the
    # border, and small ones read as dirt around the edges. Sweep any opaque
    # island too small to be part of the character.
    kept = [i for i in range(w * h) if not background[i]]
    seen = set()
    for start in kept:
        if start in seen:
            continue
        island, stack = [], [start]
        seen.add(start)
        while stack:
            i = stack.pop()
            island.append(i)
            x, y = i % w, i // w
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                j = ny * w + nx
                if 0 <= nx < w and 0 <= ny < h and not background[j] and j not in seen:
                    seen.add(j)
                    stack.append(j)
        if len(island) < FLOOD_SPECKLE:
            for i in island:
                background[i] = 1

    out = img.convert("RGBA")
    o = out.load()
    for y in range(h):
        for x in range(w):
            if background[y * w + x]:
                o[x, y] = (0, 0, 0, 0)
    return out


def cut(path, session, force=False, flood=False):
    """
    @return 'skipped', 'clean', 'empty', or (before_size, kept_fraction)
        `kept_fraction` is how much of the canvas survived as opaque artwork —
        a number near 0 means the model found nothing and the file is worth
        looking at rather than trusting.
    """
    with Image.open(path) as src:
        tagged = src.info.get(MARKER) == MARKER_VALUE
        img = src.convert("RGBA")
    before = img.size

    if tagged and not force:
        return "skipped"
    if not force and not has_background(img):
        return "clean"

    if flood:
        out = flood_cut(img)
    else:
        from rembg import remove
        out = remove(img, session=session, **MATTING).convert("RGBA")

    alpha = out.getchannel("A")
    kept = sum(alpha.histogram()[128:]) / (out.width * out.height)
    if kept < 0.005:
        # Everything went. Saving this would replace a usable-but-ugly sprite
        # with an empty square, which is strictly worse than leaving it alone.
        return "empty"

    meta = PngImagePlugin.PngInfo()
    meta.add_text(MARKER, MARKER_VALUE)
    out.save(path, "PNG", optimize=True, pnginfo=meta)
    return (before, kept)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="+", metavar="SLUG",
                    help="limit to these sprites. A bare stem (cavyzap) matches that "
                         "name in every directory; qualify it (glitter/cavyzap) to mean "
                         "one of them — the normal and glitter art of a Tatari share a "
                         "name and rarely need the same treatment.")
    ap.add_argument("--force", action="store_true",
                    help="reprocess files already tagged as cut")
    ap.add_argument("--dry-run", action="store_true",
                    help="list what would be cut and change nothing")
    ap.add_argument("--model", default=MODEL, help=f"rembg model (default {MODEL})")
    ap.add_argument("--flood", action="store_true",
                    help="flood fill from the border instead of segmenting — for pale "
                         "subjects the model mistakes for background. Needs the artwork "
                         "to have an unbroken outline; use with --only.")
    args = ap.parse_args()

    targets = []
    for directory in DIRS:
        if not directory.is_dir():
            print(f"  no such directory: {directory}")
            continue
        for path in sorted(directory.glob("*.png")):
            if args.only and not {path.stem, f"{directory.name}/{path.stem}"} & set(args.only):
                continue
            with Image.open(path) as src:
                tagged = src.info.get(MARKER) == MARKER_VALUE
                normalized = src.info.get(NORMALIZED)
                img = src.convert("RGBA")
            if not args.force and tagged:
                continue
            if not args.force and not has_background(img):
                continue
            targets.append((path, normalized))

    if not targets:
        print("Nothing to cut — every sprite already has a transparent background.")
        return

    print(f"{len(targets)} sprite(s) to cut:")
    for path, normalized in targets:
        late = "  (already normalised — cut before normalising next time)" if normalized else ""
        print(f"  {path.relative_to(ROOT).as_posix()}{late}")

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return

    session = None
    if not args.flood:
        try:
            from rembg import new_session
        except ImportError:
            sys.exit("rembg is required:  python -m pip install \"rembg[cpu]\"")
        print(f"\nLoading {args.model} (first run downloads weights to ~/.u2net)…")
        session = new_session(args.model)
    else:
        print("\nFlood filling from the border — no model involved.")

    done = []
    empty = []
    thin = []
    for path, _ in targets:
        result = cut(path, session, force=True, flood=args.flood)
        if result == "empty":
            empty.append(path.name)
            continue
        before, kept = result
        done.append(path.name)
        # Very little artwork left is the signature of a card or a screenshot,
        # where the model keeps one element and drops the rest.
        if kept < 0.12:
            thin.append((path.name, round(kept * 100, 1)))
        print(f"  cut {path.name}  {before[0]}x{before[1]}  {kept * 100:.0f}% artwork")

    print(f"\nCut {len(done)}")
    if empty:
        print(f"  found no subject, left alone: {', '.join(empty)}")
    if thin:
        print("  very little artwork left, check these by eye: "
              + ", ".join(f"{n} {p}%" for n, p in thin))
    print("\nNext: python tools/normalize_images.py")


if __name__ == "__main__":
    main()
