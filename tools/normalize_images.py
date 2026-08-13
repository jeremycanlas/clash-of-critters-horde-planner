#!/usr/bin/env python3
"""
Normalises Tatari sprites so every one carries the same visual weight.

The wiki serves thumbnails at a fixed *width*, so a tall sprite like Sealing
(200x281) renders far bigger than a wide one like Pearpair (200x160). Framing is
inconsistent too: Blitzmane's art runs right to all four edges while others sit
in generous padding.

For each sprite this trims the transparent border, scales the remaining artwork
so its longest side is CONTENT px, and centres it on a CANVAS x CANVAS
transparent square. Same box, same padding, same apparent size for everyone.

    python tools/normalize_images.py            # only unprocessed files
    python tools/normalize_images.py --force    # redo everything

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

# (directory, canvas, content) — content is the longest side of the artwork
# inside the canvas, so canvas - content is the padding it keeps.
PROFILES = [
    (ROOT / "data/images/tatari", 200, 176),
    (ROOT / "data/images/glitter", 200, 176),
    # Zobos share the field with Tatari, so they have to share their sizing —
    # the wiki serves them at assorted heights, and an enemy a third taller than
    # the Tatari standing next to it reads as a boss when it is not.
    (ROOT / "data/images/zobo", 200, 176),
    # Type and role icons are already self-contained badges: they arrive at
    # assorted sizes but want no padding of their own, only a common box.
    (ROOT / "data/images/icons", 64, 64),
]

ALPHA_FLOOR = 8       # ignore near-invisible antialiasing when finding the bbox
MARKER = "coc-normalized"
MARKER_VALUE = "1"

# Attack-range diagrams are in-game screenshots, not artwork: opaque photographs
# of a forest with a grid on it. Trimming and padding them makes no sense, but
# shipping 114 lossless PNGs of foliage does even less — they land at roughly
# 300 KB each as PNG and a tenth of that as JPEG, with no visible cost.
RANGE_DIR = ROOT / "data/images/range"
RANGE_QUALITY = 80


def content_box(img):
    """Bounding box of visibly opaque pixels, or None if the image is empty."""
    alpha = img.getchannel("A")
    # point() to a 1-bit mask so faint antialiasing does not widen the box
    mask = alpha.point(lambda a: 255 if a >= ALPHA_FLOOR else 0)
    return mask.getbbox()


def normalize(path, canvas_size, content, force=False):
    """
    @return one of 'skipped', 'empty', or a (scale, before, after) tuple
    """
    with Image.open(path) as src:
        if not force and src.info.get(MARKER) == MARKER_VALUE:
            return "skipped"
        img = src.convert("RGBA")
        before = img.size

    box = content_box(img)
    if box is None:
        return "empty"

    art = img.crop(box)
    scale = content / max(art.size)
    art = art.resize(
        (max(1, round(art.width * scale)), max(1, round(art.height * scale))),
        Image.LANCZOS,
    )

    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    canvas.paste(art, ((canvas_size - art.width) // 2, (canvas_size - art.height) // 2))

    meta = PngImagePlugin.PngInfo()
    meta.add_text(MARKER, MARKER_VALUE)
    canvas.save(path, "PNG", optimize=True, pnginfo=meta)
    return (scale, before, canvas.size)


def shrink_range_diagrams():
    """PNG screenshot in, JPEG out, original deleted. @return (files, KB before, KB after)"""
    if not RANGE_DIR.is_dir():
        return (0, 0, 0)

    before = after = count = 0
    for png in sorted(RANGE_DIR.glob("*.png")):
        jpg = png.with_suffix(".jpg")
        before += png.stat().st_size
        with Image.open(png) as src:
            src.convert("RGB").save(jpg, "JPEG", quality=RANGE_QUALITY, optimize=True)
        png.unlink()
        after += jpg.stat().st_size
        count += 1
    return (count, before // 1024, after // 1024)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="reprocess files already tagged as normalised")
    args = ap.parse_args()

    done = skipped = 0
    upscaled = []
    empty = []

    for directory, canvas_size, content in PROFILES:
        if not directory.is_dir():
            print(f"  no such directory: {directory}")
            continue
        files = sorted(directory.glob("*.png"))
        for path in files:
            result = normalize(path, canvas_size, content, args.force)
            if result == "skipped":
                skipped += 1
            elif result == "empty":
                empty.append(path.name)
            else:
                scale, _, _ = result
                done += 1
                # Sprites that had to be enlarged are the only quality risk.
                if scale > 1.15:
                    upscaled.append((path.name, round(scale, 2)))
        print(f"  {directory.relative_to(ROOT).as_posix()}: {len(files)} files "
              f"-> {canvas_size}x{canvas_size}, artwork fits {content}px")

    count, kb_before, kb_after = shrink_range_diagrams()
    if count:
        print(f"  data/images/range: {count} diagrams re-encoded to JPEG, "
              f"{kb_before} KB -> {kb_after} KB")

    print(f"\nNormalised {done}, skipped {skipped} (already done)")
    if upscaled:
        print(f"  enlarged more than 1.15x ({len(upscaled)}): " +
              ", ".join(f"{n} {s}x" for n, s in sorted(upscaled, key=lambda x: -x[1])[:12]))
    if empty:
        print(f"  fully transparent, left alone: {', '.join(empty)}")


if __name__ == "__main__":
    main()
