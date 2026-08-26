#!/usr/bin/env python3
"""
Cuts the 49 chip icons out of screenshots of the in-game Chip Gallery.

Every other image in this repo comes off the wiki, and scrape-wiki.mjs fetches
them by name. The chips are not on the wiki at all -- no chip pages, no infobox,
nothing in the file namespace -- so the only picture of a chip that exists
outside the game is a screenshot of the gallery. Four of those, taken at
different scroll offsets, cover all 49 tiles between them.

    python tools/cut_chips.py --shots E:/Coding/chip-shots
    python tools/cut_chips.py --shots ... --contact    # a sheet to eyeball
    python tools/cut_chips.py --shots ... --dry-run

## Finding the grid

Hardcoding "tiles start at x=17, every 147px" is true of the four files in one
folder on one day and of nothing else: each shot is scrolled differently, and a
window resized by a pixel moves every column. So each shot is measured.

Colour is the obvious way to measure it and it does not work. The tiles cover
about four fifths of the gallery, so the flat purple field is a *minority*
colour, and the modal colour of the area is whichever near-black the emulator
draws down the margins. Excluding dark pixels then makes it white, because the
tile art is bright. Every threshold that fixes one shot breaks another.

What is reliable is flatness. A column running down a gap between two tiles is
the same colour top to bottom; a column running through tiles is not. Standard
deviation down each column separates them with room to spare -- about 50 for a
gap against about 90 for a tile -- and it does not care what colour anything is.

Rows are then found by colour after all, because by then the colour is known:
the middle of a detected column gap is field by construction, so its median is
the field colour, and a row is a horizontal band that is mostly not it.

## Rejecting rather than guessing

A shot that does not measure exactly four columns is refused by name. Cropping
it anyway is what produces 49 plausible icons that each contain a slice of the
tile next door -- every one wrong, none of them obviously wrong.

## Why the label is cut off

A tile is 126x165 and the bottom of it is the chip's name on a dark bar. The
page prints the name itself, in its own type at its own size, so keeping the
baked-in one would show every name twice and the second would be a screenshot of
somebody else's font. The coloured background stays: the gallery uses it to say
which tier a chip is, and so does the page.
"""

import argparse
import json
import re
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  python -m pip install Pillow")

try:
    import numpy as np
except ImportError:
    sys.exit("numpy is required:  python -m pip install numpy")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data/images/chips"

# The gallery area of the emulator window: below the banner, above the black bar.
TOP, BOTTOM = 290, 1040

# A column of tiles varies far more than a column of flat field.
FLAT = 70

# A row is a band that is mostly not field. 0.85 rather than something tighter
# because the last row holds a single chip -- Mission Reset, alone -- so it is
# about four fifths field and a threshold tuned to full rows misses it entirely.
FIELD_ROW = 0.85

# Only rows fully on screen. Every shot is mid-scroll, so the first and last are
# usually sliced.
FULL_ROW = 150

# How much of a tile is artwork rather than its name bar.
#
# 0.73 and not 0.83. The name bar is not a plain rectangle -- it has a jagged
# top edge that overlaps the art -- so cropping to where the *text* starts
# leaves a black zigzag across the bottom of all 49 icons, which reads as a
# rendering fault rather than as part of the tile.
ART = 0.73

# Which chips are in which full row of which shot, top-left to bottom-right.
#
# Read off tools/cut_chips.py --contact rather than assumed: the shots overlap,
# so the first full row of each of the last three is the last full row of the one
# before it, and cropping those again would be harmless but silently redundant.
# They are left out, and the duplicate check below would catch it if they crept
# back in.
SHOTS = {
    "r1c2.png": [
        ["Photosynthesis III", "Bounty Hunter III", "Slot Machine 4", "Water Form III"],
        ["Fire Form III", "Grass Form III", "Rock Form III", "Lightning Form III"],
        ["Lawn Care", "Equalizer", "Center Spotlight", "Roll of Fate III"],
        ["On the Move", "Count to Five", "Photosynthesis II", "Bounty Hunter II"],
    ],
    "rows-5plus.png": [
        None,                                   # repeats the row above
        ["Slot Machine 3", "Water Form II", "Fire Form II", "Grass Form II"],
        ["Rock Form II", "Lightning Form II", "Glass Cannon", "Boss Killer"],
        ["The Exile", "Rear Guard", "Backend Support", "Patch Upgrade"],
    ],
    "rows-8plus.png": [
        None,                                   # repeats the row above
        ["Shuffle", "Underdog", "New Recruit", "Contract Employee"],
        ["Roll of Fate II", "Make Waves", "Weakest Link", "Photosynthesis I"],
        ["Bounty Hunter I", "Slot Machine 2", "AFK", "Water Form I"],
    ],
    "bottom.png": [
        None,                                   # repeats the row above
        ["Fire Form I", "Grass Form I", "Rock Form I", "Lightning Form I"],
        ["Barricade", "First-Aid Kit", "Parting Gift", "Roll of Fate I"],
        ["Mission Reset", None, None, None],
    ],
}


def slug(name):
    """Must match the line in chips.js that builds the src, or the icon 404s and
    the page shows a gap without saying why."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def bands(values, inside, minimum=20):
    """Contiguous runs where `inside` holds, ignoring anything too short."""
    out, start = [], None
    for i, v in enumerate(values):
        if inside(v) and start is None:
            start = i
        elif not inside(v) and start is not None:
            if i - start > minimum:
                out.append((start, i))
            start = None
    if start is not None and len(values) - start > minimum:
        out.append((start, len(values)))
    return out


def grid(img):
    """(columns, full rows) for one screenshot, both measured from the pixels."""
    body = np.asarray(img.convert("RGB")).astype(float)[TOP:BOTTOM]

    cols = bands(body.std(axis=(0, 2)), lambda v: v > FLAT)
    if len(cols) != 4:
        return cols, []

    # Dead centre of the first column gap is field by construction.
    gap = (cols[0][1] + cols[1][0]) // 2
    field = np.median(body[:, gap - 3:gap + 3].reshape(-1, 3), axis=0)

    is_field = np.abs(body - field).sum(axis=2) < 60
    rows = [(s + TOP, e + TOP)
            for s, e in bands(is_field.mean(axis=1), lambda v: v < FIELD_ROW)]
    return cols, [r for r in rows if r[1] - r[0] >= FULL_ROW]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--shots", required=True, help="folder holding the gallery screenshots")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--contact", action="store_true", help="write a sheet of every icon")
    args = ap.parse_args()

    shots = Path(args.shots)
    if not shots.is_dir():
        sys.exit(f"no such folder: {shots}")
    if not args.dry_run:
        OUT.mkdir(parents=True, exist_ok=True)

    written, seen = [], set()
    for filename, layout in SHOTS.items():
        path = shots / filename
        if not path.exists():
            sys.exit(f"missing screenshot: {path}")

        img = Image.open(path)
        cols, rows = grid(img)
        if len(cols) != 4:
            sys.exit(f"{filename}: measured {len(cols)} columns, expected 4 "
                     "-- taken at a different window size?")
        if len(rows) < len(layout):
            sys.exit(f"{filename}: measured {len(rows)} full rows, "
                     f"the layout names {len(layout)}")

        for r, names in enumerate(layout):
            if names is None:
                continue
            y0, y1 = rows[r]
            height = int((y1 - y0) * ART)
            for c, name in enumerate(names):
                if name is None:
                    continue
                if name in seen:
                    sys.exit(f"{name} would be cropped twice, the second time from {filename}")
                seen.add(name)
                x0, x1 = cols[c]
                dest = OUT / f"{slug(name)}.png"
                tile = img.crop((x0, y0, x1, y0 + height))
                written.append((name, dest, tile.size))
                if not args.dry_run:
                    tile.save(dest)

    for name, dest, size in written:
        verb = "would cut" if args.dry_run else "cut"
        print(f"{verb} {name:22} {size[0]}x{size[1]}  {dest.relative_to(ROOT)}")

    # Checked against the data file, not against a count of 49. A chip renamed in
    # one place and not the other is then caught here rather than as a hole on
    # the page that nobody notices until somebody scrolls that far.
    book = json.loads((ROOT / "data/chips.json").read_text(encoding="utf-8"))
    expected = {c["name"] for c in book["chips"]}
    if seen != expected:
        sys.exit(f"\ndoes not match data/chips.json"
                 f"\n  no icon: {sorted(expected - seen)}"
                 f"\n  not a chip: {sorted(seen - expected)}")
    print(f"\n{len(written)} icons, and every chip in data/chips.json has one")

    if args.contact and not args.dry_run:
        per_row = 7
        w, h = Image.open(written[0][1]).size
        rows_n = (len(written) + per_row - 1) // per_row
        sheet = Image.new("RGB", (per_row * w, rows_n * h), (18, 18, 24))
        for i, (_, dest, _) in enumerate(written):
            sheet.paste(Image.open(dest), ((i % per_row) * w, (i // per_row) * h))
        out = shots / "contact-sheet.png"
        sheet.save(out)
        print(f"contact sheet: {out}")


if __name__ == "__main__":
    main()
