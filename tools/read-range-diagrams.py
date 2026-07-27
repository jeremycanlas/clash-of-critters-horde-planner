#!/usr/bin/env python3
"""
Read attack-range tiles off the in-game range screenshots in data/images/range/.

The wiki documents range only as screenshots, so the tile patterns in
data/ranges.json have to be measured off the picture. This does the measuring;
it does not do the deciding. Every run is meant to be checked against the
`sheets` output before anything lands in data/ranges.json.

Three steps, each picked so it does not depend on the background art, which
runs from desert tan through forest green to purple cave:

  1. the highlight is drawn in one consistent bright yellow, so a colour match
     finds it — but the cut is taken relative to this screenshot's own
     background, because a desert field is yellow too. Depending on what is
     underneath, the highlight comes out either solid or as a hollow outline,
     so holes are filled and the largest sensible blob is kept.
  2. the field is a regular checkerboard, so the cell pitch falls out of the
     autocorrelation of the image's edge profile.
  3. cells are classified by how yellow their interior is, against the unlit
     cells around the highlight.

WHAT THIS CANNOT DO
    It cannot reliably tell you which tile the Tatari is standing on. It
    assumes the near row of the highlight, which is wrong for the ranges that
    are centred on the Tatari (Charflutter, Cheerling, Ashlarva) or that reach
    the row behind it (Buzzbeak, Toucanzam), and it cannot see whether the tile
    under a large sprite is lit at all. Getting that wrong shifts every offset
    by a row, so the anchor is a judgement call for a human with the `sheets`
    output in front of them. Attempts to automate it topped out around 60%.

Usage
    python tools/read-range-diagrams.py validate
        Re-run the seven diagrams whose tiles were read by hand, and check the
        measurement still agrees. Run this after touching any threshold.

    python tools/read-range-diagrams.py detect [slug ...] > out.json
        Measure every diagram, or just the named ones.

    python tools/read-range-diagrams.py sheets OUTDIR [slug ...]
        Draw the measurement back onto each diagram, six to a sheet, with every
        cell labelled row,col. This is how you read off which cell the Tatari
        stands in, and how you catch a shape that came out wrong.

Needs numpy, pillow and scipy.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RANGE_DIR = os.path.join(ROOT, 'data', 'images', 'range')

# Read off the diagrams by eye and confirmed tile by tile. If a change to the
# thresholds below breaks any of these, the change is wrong.
T7 = [[-1, 0], [0, 0], [1, 0], [-1, -1], [0, -1], [1, -1], [0, -2]]
KNOWN = {
    'zapup':     [[0, 0], [0, -1], [0, -2], [0, -3]],
    'zapooch':   [[0, 0], [0, -1], [0, -2], [0, -3]],
    'zappur':    [[0, 0], [0, -1], [0, -2]],
    'electroar': T7,
    'blitzmane': T7,
    'cobbledon': T7,
    'rockzilla': T7,
}


def highlight_mask(a):
    """
    The highlight is a bright yellow, but so is a desert field, so the cut has
    to sit above whatever this particular screenshot's background already is.
    """
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    y = r + g - 2 * b
    base = float(np.median(y))
    top = float(np.percentile(y, 99.5))
    adaptive = base + 0.42 * max(top - base, 1.0)
    return (r > 185) & (g > 180) & (b < 155) & (y > max(200.0, adaptive))


def pick_region(m, H, W):
    """The highlight blob: biggest sensible component, holes filled."""
    lab, n = ndimage.label(m)
    if n == 0:
        return None, 'no highlight'
    best, best_area = None, 0
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        area = len(ys)
        if area < 0.002 * H * W:
            continue
        # cave walls and foliage run the full height down one edge
        if (ys.max() - ys.min()) > 0.9 * H and (xs.max() - xs.min()) < 0.12 * W:
            continue
        if xs.min() < 0.02 * W and xs.max() < 0.15 * W:
            continue
        if xs.max() > 0.98 * W and xs.min() > 0.85 * W:
            continue
        if area > best_area:
            best, best_area = i, area
    if best is None:
        return None, 'no component survived filtering'

    reg = lab == best
    # a highlight running off the bottom of the screenshot is not enclosed, so
    # close it against a floor before filling, then take the floor back off
    padded = ndimage.binary_fill_holes(np.vstack([reg, np.ones((1, W), bool)]))
    return padded[:H], None


def pitch_of(a, region):
    """Cell size, from the periodicity of the field's own grid and checkerboard."""
    g = a.mean(2)
    H, W = g.shape
    ys, _ = np.where(region)
    band = g[max(0, ys.min() - 40):min(H, ys.max() + 40), :]
    prof = np.abs(np.diff(band, axis=1)).sum(0)
    prof = prof - prof.mean()
    best, peak = None, -1e18
    for lag in range(38, 135):
        v = float((prof[:-lag] * prof[lag:]).mean())
        if v > peak:
            peak, best = v, lag
    # the true pitch can show up as a harmonic; prefer the smallest lag that
    # scores nearly as well as the best one
    for lag in range(38, best + 1):
        v = float((prof[:-lag] * prof[lag:]).mean())
        if v > peak * 0.82 and best % lag < 4:
            return lag
    return best


def geometry(path):
    """Lattice origin and cell pitch, shared by detect() and the sheets."""
    a = np.asarray(Image.open(path).convert('RGB')).astype(int)
    H, W, _ = a.shape
    m = highlight_mask(a)
    if m.sum() < 300:
        return a, None, 'no highlight found'
    region, err = pick_region(m, H, W)
    if err:
        return a, None, err
    ys, xs = np.where(region)
    return a, (region, ys.min(), ys.max(), xs.min(), xs.max(), pitch_of(a, region)), None


def detect(path):
    a, geo, err = geometry(path)
    if err:
        return {'error': err}
    region, y0, y1, x0, x1, p = geo
    H, W, _ = a.shape
    cut_off = y1 >= H - 3
    # some Tatari light the whole board; there is then no unlit tile to compare
    # against, so say so rather than inventing a shape
    full_field = region.mean() > 0.55

    ncol = max(1, int(round((x1 - x0 + 1) / p)))
    nrow = max(1, int(round((y1 - y0 + 1) / p)))
    fit_err = max(abs((x1 - x0 + 1) / p - ncol), abs((y1 - y0 + 1) / p - nrow))

    # Classify by colour rather than by the mask: over a purple or grey field
    # the highlight comes out as a bare outline, and the Tatari sprite standing
    # on that outline breaks it, so filled-area coverage is not dependable.
    # A lit tile's interior is tinted yellow whatever is underneath it.
    yellow = (a[..., 0] + a[..., 1] - 2 * a[..., 2]).astype(float)
    stats = {}
    for r in range(-1, nrow + 1):
        for c in range(-1, ncol + 1):
            iy0, iy1 = int(round(y0 + (r + .18) * p)), int(round(y0 + (r + .82) * p))
            ix0, ix1 = int(round(x0 + (c + .18) * p)), int(round(x0 + (c + .82) * p))
            iy0, ix0 = max(iy0, 0), max(ix0, 0)
            iy1, ix1 = min(iy1, H), min(ix1, W)
            # the bottom row is usually clipped by the screen edge, so keep
            # whatever part of it is visible instead of dropping the cell
            if (iy1 - iy0) < .22 * p or (ix1 - ix0) < .22 * p:
                continue
            # a high percentile: the sprite covers much of its own tile, but
            # the tile colour still shows around it
            stats[(r, c)] = float(np.percentile(yellow[iy0:iy1, ix0:ix1], 78))

    inside = {k: v for k, v in stats.items() if 0 <= k[0] < nrow and 0 <= k[1] < ncol}
    if not inside:
        return {'error': 'lattice missed the highlight'}

    vals = np.array(sorted(stats.values()))
    best, thr = -1, None
    for i in range(1, len(vals)):
        lo, hi = vals[:i], vals[i:]
        v = len(lo) * len(hi) * (lo.mean() - hi.mean()) ** 2
        if v > best:
            best, thr = v, (vals[i - 1] + vals[i]) / 2
    lo = [v for v in vals if v <= thr]
    hi = [v for v in vals if v > thr]
    sep = (min(hi) - max(lo)) if lo and hi else 0.0
    spread = (vals.max() - vals.min()) or 1.0

    lit = {k for k, v in inside.items() if v > thr}
    if not lit:
        return {'error': 'no lit cells'}

    # A big dark sprite can swallow its own tile's colour, leaving a notch in
    # what is otherwise a solid shape. Ranges do not have holes, and the notch
    # is the tile the Tatari stands on, at the bottom — so close the grid
    # against a floor and fill.
    grid = np.zeros((nrow, ncol), bool)
    for r, c in lit:
        grid[r, c] = True
    filled = ndimage.binary_fill_holes(np.vstack([grid, np.ones((1, ncol), bool)]))[:nrow]
    rescued = [tuple(t) for t in np.argwhere(filled & ~grid)]
    lit |= {(int(r), int(c)) for r, c in rescued}

    # NOTE: assumes the Tatari stands on the near row, centred. Often wrong —
    # see the module docstring. Check it against `sheets` before trusting it.
    br = max(r for r, _ in lit)
    bottom = sorted(c for r, c in lit if r == br)
    anchor = bottom[len(bottom) // 2]
    symmetric = bottom == sorted(2 * anchor - c for c in bottom)

    flags = []
    if not symmetric or len(bottom) % 2 == 0:
        flags.append('anchor-uncertain')
    if fit_err > 0.30:
        flags.append('grid-fit')
    if sep < spread * 0.12:
        flags.append('weak-contrast')
    if cut_off:
        flags.append('clipped')
    if p < 45 or p > 125:
        flags.append('odd-pitch')
    if full_field:
        flags.append('full-field')
    if rescued:
        flags.append('filled-notch')

    return {
        'tiles': sorted(([c - anchor, r - br] for r, c in lit), key=lambda t: (t[1], t[0])),
        'pitch': int(p), 'n': len(lit), 'fit': round(fit_err, 2), 'flags': flags,
    }


# ------------------------------------------------------------------ sheets

TILE_W, SHEET_COLS, LABEL_H = 420, 3, 30


def _panel(slug, res):
    path = os.path.join(RANGE_DIR, f'{slug}.jpg')
    im = Image.open(path).convert('RGB')
    W, H = im.size
    _, geo, err = geometry(path)
    d = ImageDraw.Draw(im)
    if not err and 'tiles' in res:
        _, y0, _, x0, _, p = geo
        rows = [t[1] for t in res['tiles']]
        cols = [t[0] for t in res['tiles']]
        nrow, ncol = max(rows) - min(rows) + 1, max(cols) - min(cols) + 1
        on = {(r - min(rows), c - min(cols)) for c, r in res['tiles']}
        # label the whole neighbourhood, so a Tatari standing outside its own
        # highlight can still be named by cell
        for rr in range(-1, nrow + 1):
            for cc in range(-1, ncol + 1):
                gy, gx = y0 + rr * p, x0 + cc * p
                hit = (rr, cc) in on
                d.rectangle([gx + 2, gy + 2, gx + p - 2, gy + p - 2],
                            outline=(255, 0, 0) if hit else (90, 90, 255),
                            width=5 if hit else 1)
                d.text((gx + 7, gy + 5), f'{rr},{cc}',
                       fill=(255, 60, 60) if hit else (150, 150, 255))
    crop = im.crop((0, int(H * 0.30), W, H))
    crop = crop.resize((TILE_W, int(crop.height * TILE_W / crop.width)), Image.LANCZOS)
    out = Image.new('RGB', (TILE_W, crop.height + LABEL_H), (14, 14, 18))
    out.paste(crop, (0, LABEL_H))
    ImageDraw.Draw(out).text(
        (6, 8), f"{slug}  n={len(res.get('tiles', []))} {','.join(res.get('flags', []))}",
        fill=(255, 255, 255))
    return out


def sheets(outdir, slugs, results):
    os.makedirs(outdir, exist_ok=True)
    made = []
    for i in range(0, len(slugs), 6):
        panels = [_panel(s, results[s]) for s in slugs[i:i + 6]]
        h = max(p.height for p in panels)
        rows = (len(panels) + SHEET_COLS - 1) // SHEET_COLS
        sheet = Image.new('RGB', (TILE_W * SHEET_COLS + 8 * (SHEET_COLS + 1),
                                  rows * (h + 8) + 8), (14, 14, 18))
        for j, p in enumerate(panels):
            sheet.paste(p, (8 + (j % SHEET_COLS) * (TILE_W + 8),
                            8 + (j // SHEET_COLS) * (h + 8)))
        path = os.path.join(outdir, f'sheet{i // 6:02d}.png')
        sheet.save(path)
        made.append(path)
    return made


# ------------------------------------------------------------------ cli

def all_slugs():
    return sorted(f[:-4] for f in os.listdir(RANGE_DIR) if f.endswith('.jpg'))


def main(argv):
    cmd = argv[1] if len(argv) > 1 else 'validate'

    if cmd == 'validate':
        bad = 0
        for slug, want in KNOWN.items():
            res = detect(os.path.join(RANGE_DIR, f'{slug}.jpg'))
            got = res.get('tiles')
            ok = (sorted(map(tuple, got)) if got else None) == sorted(map(tuple, want))
            bad += 0 if ok else 1
            print(f"{'OK  ' if ok else 'FAIL'} {slug:11} n={res.get('n')} "
                  f"{res.get('flags', res.get('error'))}")
            if not ok:
                print(f'       want {sorted(map(tuple, want))}')
                print(f'       got  {sorted(map(tuple, got)) if got else None}')
        print(f'\n{len(KNOWN) - bad} ok, {bad} failed')
        return 1 if bad else 0

    if cmd == 'detect':
        slugs = argv[2:] or all_slugs()
        print(json.dumps({s: detect(os.path.join(RANGE_DIR, f'{s}.jpg'))
                          for s in slugs}, indent=1))
        return 0

    if cmd == 'sheets':
        if len(argv) < 3:
            print('sheets needs an output directory', file=sys.stderr)
            return 2
        slugs = argv[3:] or all_slugs()
        results = {s: detect(os.path.join(RANGE_DIR, f'{s}.jpg')) for s in slugs}
        for path in sheets(argv[2], slugs, results):
            print(path)
        return 0

    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
