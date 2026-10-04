# python tools/horde-export.py  ->  writes the site's data/horde-numbers.json from horde.json
#
# The reader scrolls long Horde panels, and a row read twice across a scroll comes back the second
# time without its box heading. Clean-up, per level:
#   - rows before any box heading are the skill's own: kept as they are;
#   - a row with no heading AFTER a heading has been seen is a re-read: dropped when an earlier row has
#     the same value and a label that equals or starts the earlier one ("Paralysis Damage" of
#     "Paralysis Damage Factor"); kept (in the last box) otherwise;
#   - a box split by a scroll (two "Bane" groups) is joined, exact repeats removed;
#   - the output lists the skill's own rows, then each box once, in first-seen order.
# Labels, box headings and names also get the OCR's dropped spaces and l-for-I put back (tidy).
import json
import re
from pathlib import Path

SRC = Path('E:/caches/coc-arena/horde.json')   # the reader's raw output, outside the repo
DST = Path(__file__).resolve().parent.parent / 'data' / 'horde-numbers.json'

# OCR misreads seen in the reader's output, fixed by hand from the screenshots.
GARBLED = {
    'IVidxmum Cooldown': 'Maximum Cooldown',
    'mifiitaDcua Paralysis Damage Factor': 'Paralysis Damage Factor',
    'dAflitan vamageintervai': 'Damage Interval',
}

# Rows too garbled to fix from what was read: dropped, to be read again off the game.
# Blowfin's Warship Roll repeats its 450% damage in this row; the panel needs a fresh look.
UNREADABLE = {('Vamage Factor', '45U%T')}


def value(v):
    """The game's up arrow beside a number that rose, which the OCR reads as 个."""
    return v.replace('个', '↑')


def tidy(text):
    """Spaces the OCR dropped ("BoostFactor", "ATKBoost", "Fumes:ATK&DEF") and l read for I."""
    t = GARBLED.get(text, text)
    t = re.sub(r'([a-z])([A-Z])', r'\1 \2', t)             # BoostFactor -> Boost Factor
    t = re.sub(r'([A-Z]{2,})([A-Z][a-z])', r'\1 \2', t)     # ATKBoost -> ATK Boost
    t = re.sub(r'\s*:\s*', ': ', t).replace('&', ' & ')
    t = re.sub(r'\blce\b', 'Ice', t)
    t = re.sub(r'\bIl\b', 'II', t)
    return re.sub(r'\s+', ' ', t).strip()


def same(a, b):
    la, lb = a[0].lower(), b[0].lower()
    return a[1] == b[1] and (la == lb or la.startswith(lb) or lb.startswith(la))


def clean(rows):
    own, boxes, order, last = [], {}, [], None
    for r in rows:
        if (r[0], r[1]) in UNREADABLE:
            continue
        label, value_, box = tidy(r[0]), value(r[1]), (tidy(r[2]) if len(r) > 2 else None)
        if box:
            if box not in boxes:
                boxes[box] = []; order.append(box)
            if not any(same((label, value_), x) for x in boxes[box]):
                boxes[box].append((label, value_))
            last = box
        elif last is None:
            if not any(same((label, value_), x) for x in own):
                own.append((label, value_))
        else:
            everything = own + [x for b in order for x in boxes[b]]
            if not any(same((label, value_), x) for x in everything):
                boxes[last].append((label, value_))
    out = [[l, v] for l, v in own]
    for b in order:
        out += [[l, v, b] for l, v in boxes[b]]
    return out


src = json.loads(SRC.read_text(encoding='utf-8'))
out, dropped = {}, 0
for fam, v in src.items():
    if fam.startswith('_'):
        continue
    out[fam] = {}
    for k in ('level3', 'level5', 'level7'):
        rows = clean(v[k]['rows'])
        dropped += len(v[k]['rows']) - len(rows)
        out[fam][k] = {'name': tidy(v[k]['name']), 'rows': rows}
DST.write_text(json.dumps(out, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
print(f'{len(out)} lines written, {dropped} re-read rows dropped')
