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
DIRS = [ROOT / "data/images/tatari", ROOT / "data/images/glitter"]

CANVAS = 200          # output is CANVAS x CANVAS
CONTENT = 176         # longest side of the artwork inside it -> 12px padding
ALPHA_FLOOR = 8       # ignore near-invisible antialiasing when finding the bbox
MARKER = "coc-normalized"
MARKER_VALUE = "1"


def content_box(img):
    """Bounding box of visibly opaque pixels, or None if the image is empty."""
    alpha = img.getchannel("A")
    # point() to a 1-bit mask so faint antialiasing does not widen the box
    mask = alpha.point(lambda a: 255 if a >= ALPHA_FLOOR else 0)
    return mask.getbbox()


def normalize(path, force=False):
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
    scale = CONTENT / max(art.size)
    art = art.resize(
        (max(1, round(art.width * scale)), max(1, round(art.height * scale))),
        Image.LANCZOS,
    )

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(art, ((CANVAS - art.width) // 2, (CANVAS - art.height) // 2))

    meta = PngImagePlugin.PngInfo()
    meta.add_text(MARKER, MARKER_VALUE)
    canvas.save(path, "PNG", optimize=True, pnginfo=meta)
    return (scale, before, canvas.size)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="reprocess files already tagged as normalised")
    args = ap.parse_args()

    done = skipped = 0
    upscaled = []
    empty = []

    for directory in DIRS:
        if not directory.is_dir():
            print(f"  no such directory: {directory}")
            continue
        files = sorted(directory.glob("*.png"))
        for path in files:
            result = normalize(path, args.force)
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
        print(f"  {directory.relative_to(ROOT).as_posix()}: {len(files)} files")

    print(f"\nNormalised {done}, skipped {skipped} (already done)")
    print(f"  canvas {CANVAS}x{CANVAS}, artwork fits {CONTENT}px")
    if upscaled:
        print(f"  enlarged more than 1.15x ({len(upscaled)}): " +
              ", ".join(f"{n} {s}x" for n, s in sorted(upscaled, key=lambda x: -x[1])[:12]))
    if empty:
        print(f"  fully transparent, left alone: {', '.join(empty)}")


if __name__ == "__main__":
    main()
