/**
 * The share card: the whole formation drawn as one image.
 *
 * A link is only useful to someone who will open it. A picture is what actually
 * gets posted, so sharing draws the title, the field, both benches and the
 * level-up plan onto a canvas the user can download or paste anywhere.
 *
 * Sprites are same-origin, so the canvas stays untainted and can be exported.
 */

import { state, pieceBySlug } from './data.js';
import * as store from './store.js';
import { artOf } from './ui.js';
import { effectsOf, GROUP_LABELS } from './effects.js';

/** Logical width. The bitmap is SCALE times this, so text stays crisp. */
const W = 1080;
const SCALE = 2;
const PAD = 40;

const CELL = 86;         // field tile
const CELL_GAP = 8;
const GRID_W = 6 * CELL + 5 * CELL_GAP;
const RIGHT_W = W - PAD * 2 - GRID_W - 32;

const BENCH_TILE = 62;
const BENCH_CELL_W = 76;
const BENCH_CELL_H = BENCH_TILE + 20;

/*
 * The two kinds of note on a card, named because the height calculation and the
 * drawing both need them and must not drift apart.
 *
 * Both were set at a size that read as marginalia — and the poster's note is the
 * one line saying why the formation is shaped the way it is, which is the thing
 * a stranger most needs and the last thing they could make out. Sized to be read
 * rather than noticed.
 */
const NOTE = 19;
const NOTE_LINE = 24;
/** Breathing room inside the note's panel, and the accent bar down its left. */
const NOTE_PAD = 13;
const NOTE_BAR = 4;
const PLAN_NOTE = 15;
const PLAN_NOTE_LINE = 20;

/** Step sprites, and how many fit before the rest become a "+N". */
const PLAN_SPRITE = 26;
const PLAN_SPRITES = 5;

/** What a step whose Tatari are brought but not deployed is labelled. */
const BENCH_TAG = 'Bench';

const FONT = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';
const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;

/** The page's own palette, so the card matches the app the user is looking at. */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: read('--bg', '#12141a'),
    surface: read('--surface', '#1a1d26'),
    surface2: read('--surface-2', '#22262f'),
    surface3: read('--surface-3', '#2b303b'),
    line: read('--line', '#2e3340'),
    text: read('--text', '#e7eaf1'),
    dim: read('--text-dim', '#a3aab9'),
    mute: read('--text-mute', '#6f7788'),
    accent: read('--accent', '#ffc93c'),
    ok: read('--ok', '#55c98a'),
    danger: read('--danger', '#f0654f'),
    ownerInk: read('--owner-ink', '#0e1118'),
    accentInk: read('--accent-ink', '#2a2005'),
    p1: read('--p1', '#4d9dff'),
    p2: read('--p2', '#ff5fa8'),
    /*
     * Whether the reader turned High contrast on, read from the same place as
     * everything else here.
     *
     * The five element colours below already arrive swapped when it is on —
     * prefs.js writes the flag to <html> and the stylesheet points --water and
     * friends at their high-contrast values, so this read picks up the new ones
     * with no work. What the flag is needed for is the part CSS cannot do for a
     * canvas: drawing the element letter.
     */
    contrast: document.documentElement.dataset.contrast === 'more',
    type: {
      Water: read('--water', '#37a7e6'),
      Fire: read('--fire', '#e8453c'),
      Grass: read('--grass', '#57c14a'),
      Lightning: read('--lightning', '#f2be16'),
      Rock: read('--rock', '#a2762f'),
    },
  };
}

// ---------------------------------------------------------------- helpers

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fill(ctx, colour, x, y, w, h, r = 0) {
  ctx.fillStyle = colour;
  if (r) { roundRect(ctx, x, y, w, h, r); ctx.fill(); }
  else ctx.fillRect(x, y, w, h);
}

/** `colour` at `alpha` over the card background, so no globalAlpha juggling. */
function tint(ctx, colour, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  return () => ctx.restore();
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function sectionLabel(ctx, colours, text, x, y) {
  ctx.font = font(15, 700);
  ctx.fillStyle = colours.mute;
  ctx.letterSpacing = '1.4px';
  ctx.fillText(text.toUpperCase(), x, y);
  ctx.letterSpacing = '0px';
  return y + 18;
}

/** Every Tatari a card draws: the field, both benches, the co-op lines. */
export function cardSlugs(view = store) {
  return [
    ...view.formation.cells.filter(Boolean).map((o) => o.slug),
    ...view.players().flatMap((p) => view.benchOf(p)),
    // Asked-for Tatari are on nobody's bench by definition, so they need
    // fetching too or the LF band draws empty chips.
    ...view.filledLines().flatMap((l) => l.wants),
  ];
}

/**
 * Decoded sprites, keyed by slug and source. A source rather than a slug alone
 * because the glitter toggle swaps the art under it.
 *
 * @type {Map<string, Promise<HTMLImageElement|null>>}
 */
const warmed = new Map();

const spriteKey = (slug, src) => `${slug}\n${src}`;

/**
 * Starts decoding the sprites a card would need, long before anyone asks for
 * one.
 *
 * Pressing Share should not be the moment the download begins, and reading the
 * page's own image elements is not enough either — one that has not decoded yet
 * is skipped, which is most of them on a formation restored at load.
 *
 * Warming on every change means the picture is ready before anyone asks for it,
 * and holding the promises rather than the results means a Share pressed
 * immediately waits on the requests already in flight instead of starting its
 * own.
 */
export function warmSprites(slugs = cardSlugs()) {
  for (const slug of new Set(slugs)) {
    const src = artOf(pieceBySlug(slug) ?? {});
    if (!src) continue;
    const key = spriteKey(slug, src);
    if (warmed.has(key)) continue;

    const img = new Image();
    img.fetchPriority = 'high';
    img.src = src;

    /*
     * load/error, not decode(). decode() never settles for these images in
     * Chrome — measured on eleven sprites that were all sitting there complete
     * with a naturalWidth of 200, every one of them still pending after ten
     * seconds. Every sprite therefore missed its deadline and the card drew
     * empty tiles. A complete image is drawable; that is the whole test.
     */
    warmed.set(key, new Promise((resolve) => {
      if (img.complete) { resolve(img.naturalWidth ? img : null); return; }
      img.addEventListener('load', () => resolve(img), { once: true });
      img.addEventListener('error', () => resolve(null), { once: true });
    }));
  }
}

/**
 * The sprites the card needs, skipping the ones with no art.
 *
 * These are nearly always already decoded by the time this runs; the timeout is
 * only there so a card still appears when one sprite is genuinely unreachable.
 * A card missing one sprite beats a card that never arrives.
 */
async function loadSprites(slugs) {
  const sprites = new Map();
  warmSprites(slugs);

  await Promise.all([...new Set(slugs)].map(async (slug) => {
    const src = artOf(pieceBySlug(slug) ?? {});
    if (!src) return;

    const img = await Promise.race([
      warmed.get(spriteKey(slug, src)),
      new Promise((resolve) => { setTimeout(() => resolve(null), 8000); }),
    ]);
    if (img?.naturalWidth) sprites.set(slug, img);
  }));
  return sprites;
}

/**
 * The poster's Discord picture, for the byline. Null for anything that does not
 * arrive, which the header then simply draws without.
 *
 * `crossOrigin` matters more than it looks. Drawing an image from another origin
 * onto a canvas without CORS *taints* it, and a tainted canvas cannot be read
 * back: `toBlob` throws SecurityError. One unreachable avatar would therefore
 * take the entire picture down rather than costing it a 26px circle. With
 * `anonymous`, a host that will not permit the read fails the *load* instead,
 * which lands on the null path and draws a card with no face on it.
 *
 * The timeout is not belt-and-braces. `cdn.discordapp.com` is a standing target
 * for content blockers, and a blocked request there hangs with no load and no
 * error — the same thing the gallery's HTML avatar had to be built around. The
 * card is not waiting on it.
 *
 * no-referrer for the same reason the gallery uses it: the URL carries the
 * poster's Discord ID, and Discord does not need to be told which page asked.
 */
async function loadAvatar(src) {
  if (!src) return null;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.referrerPolicy = 'no-referrer';
  img.src = src;

  return Promise.race([
    new Promise((resolve) => {
      const ok = () => resolve(img.naturalWidth ? img : null);
      if (img.complete) { ok(); return; }
      img.addEventListener('load', ok, { once: true });
      img.addEventListener('error', () => resolve(null), { once: true });
    }),
    new Promise((resolve) => { setTimeout(() => resolve(null), 4000); }),
  ]);
}

// ---------------------------------------------------------------- content

function planLines(view, player) {
  const steps = view.isCoop()
    ? view.planFor(player)
    : view.formation.plan.map((step, index) => ({ step, index }));

  return steps.map(({ step }, i) => ({
    rank: `${i + 1}`,
    members: step.members,
    who: step.members.map((m) => state.bySlug.get(m.slug)?.name ?? m.slug).join(', '),
    level: step.level === null ? 'Any' : `Lv ${step.level}`,
    note: step.note,
    /*
     * Brought, but not standing anywhere — the same test the plan list makes.
     *
     * A plan keeps its steps when a Tatari comes off the field, so a card drawn
     * from one has to say which of them are live. On screen that is a colour and
     * a dashed border; in a posted PNG it cannot be colour alone, because the
     * picture gets thumbnailed and recompressed in a chat before anyone reads
     * it. Hence a word as well as the fade.
     */
    benched: step.members.every((m) => !view.isPlaced(m.slug, m.player)),
  }));
}

// ---------------------------------------------------------------- drawing

/**
 * One tile of the board.
 *
 * Lifted out of drawField's double loop so the rows past the contact line can be
 * drawn by exactly the same code as the field: a pulled Tatari out there has to
 * look like the Tatari it is, badge and owner colour and all, and a Zobo has to
 * look like nothing you brought.
 */
function drawCell(ctx, colours, sprites, view, cx, cy, cell, coop) {
  const occ = view.formation.cells[cell];

    if (!occ) {
      fill(ctx, colours.bg, cx, cy, CELL, CELL, 8);
      ctx.strokeStyle = colours.line;
      ctx.lineWidth = 1;
      roundRect(ctx, cx + 0.5, cy + 0.5, CELL - 1, CELL - 1, 8);
      ctx.stroke();
      return;
    }
    // Tatari or Zobo: the field takes both and the card has to draw both.
    const tatari = pieceBySlug(occ.slug);
    const isZobo = occ.kind === 'zobo';
    const typeColour = colours.type[tatari?.type] ?? colours.line;

    const done = tint(ctx, typeColour, 0.18);
    roundRect(ctx, cx, cy, CELL, CELL, 8);
    ctx.fill();
    done();

    ctx.strokeStyle = isZobo ? colours.line
      : coop ? (occ.player === 1 ? colours.p1 : colours.p2) : typeColour;
    ctx.lineWidth = 2;
    roundRect(ctx, cx + 1, cy + 1, CELL - 2, CELL - 2, 7);
    ctx.stroke();

    const sprite = sprites.get(occ.slug);
    if (sprite) ctx.drawImage(sprite, cx + 4, cy + 4, CELL - 8, CELL - 8);
    else {
      ctx.font = font(11, 600);
      ctx.fillStyle = colours.dim;
      ctx.textAlign = 'center';
      ctx.fillText(fitText(ctx, tatari?.name ?? occ.slug, CELL - 8), cx + CELL / 2, cy + CELL / 2);
      ctx.textAlign = 'left';
    }

    /*
     * The tier, top-left, matching the token in the app. It is the one fact
     * about a Tatari the sprite does not carry, and a stranger reading a posted
     * board should not have to hunt it in the roster. A chip rather than bare
     * text so it survives the recompression a PNG takes on the way through a
     * chat — the same reason the level badge and the element letter have one.
     */
    if (!isZobo && tatari?.tier) {
      const label = `T${tatari.tier}`;
      ctx.font = font(11, 700);
      const w = ctx.measureText(label).width + 10;
      const bx = cx + 4;
      const by = cy + 4;
      fill(ctx, colours.surface, bx, by, w, 15, 4);
      ctx.strokeStyle = colours.line;
      ctx.lineWidth = 1;
      roundRect(ctx, bx + 0.5, by + 0.5, w - 1, 14, 4);
      ctx.stroke();
      ctx.fillStyle = colours.dim;
      ctx.fillText(label, bx + 5, by + 11);
    }

    /*
     * The element letter, matching the token in the app — top-centre, neutral
     * ink, on top of the sprite.
     *
     * A posted card is the one place this matters most and the one place the
     * reader cannot fix it themselves. In the app somebody who cannot separate
     * Fire from Rock can turn this on; in a PNG in a chat they get whatever the
     * person who posted it had switched on. That is an argument for drawing it,
     * not against: a card exported with the letters stays readable to everyone
     * downstream, and the tint underneath still says the same thing in colour.
     */
    if (colours.contrast && tatari?.type) {
      const letter = tatari.type[0];
      ctx.font = font(12, 800);
      const w = Math.max(16, ctx.measureText(letter).width + 10);
      const bx = cx + (CELL - w) / 2;
      const by = cy + 4;
      fill(ctx, colours.surface, bx, by, w, 16, 4);
      ctx.strokeStyle = colours.line;
      ctx.lineWidth = 1;
      roundRect(ctx, bx + 0.5, by + 0.5, w - 1, 15, 4);
      ctx.stroke();
      ctx.fillStyle = colours.text;
      ctx.textAlign = 'center';
      ctx.fillText(letter, cx + CELL / 2, by + 12);
      ctx.textAlign = 'left';
    }

    /*
     * The planned level and where it falls in the order — the two numbers
     * worth reading off a formation at a glance. The step number rides on the
     * level badge exactly as it does on the token in the app, because a
     * posted picture is where most people read a plan and "which one first"
     * is the question a plan answers.
     */
    // Nobody levels a Zobo, and nobody owns one.
    const target = isZobo ? null : view.topLevel(occ.slug, occ.player);
    const seat = isZobo ? null : view.planPositionOf(occ.slug, occ.player);
    if (target !== null || seat !== null) {
      const label = target !== null ? `L${target}` : '';
      ctx.font = font(12, 800);
      const labelW = label ? ctx.measureText(label).width : 0;
      const discW = seat !== null ? 14 : 0;
      const gap = label && discW ? 4 : 0;
      const w = labelW + discW + gap + 10;
      const bx = cx + CELL - w - 4;
      const by = cy + CELL - 20;

      fill(ctx, colours.accent, bx, by, w, 16, 4);

      let tx = bx + 5;
      if (seat !== null) {
        const done = tint(ctx, colours.accentInk, 0.82);
        roundRect(ctx, tx, by + 2, discW, 12, 6);
        ctx.fill();
        done();
        ctx.fillStyle = colours.accent;
        ctx.font = font(9.5, 800);
        ctx.textAlign = 'center';
        ctx.fillText(String(seat), tx + discW / 2, by + 11.5);
        ctx.textAlign = 'left';
        tx += discW + gap;
      }
      if (label) {
        ctx.fillStyle = colours.accentInk;
        ctx.font = font(12, 800);
        ctx.fillText(label, tx, by + 12);
      }
    }
    // Bottom-left, matching the app's own token — and out of the top-left corner
    // the tier now occupies.
    if (coop && !isZobo) {
      const by = cy + CELL - 20;
      ctx.font = font(11, 800);
      fill(ctx, occ.player === 1 ? colours.p1 : colours.p2, cx + 4, by, 22, 15, 4);
      ctx.fillStyle = colours.ownerInk;
      ctx.fillText(`P${occ.player}`, cx + 7, by + 11);
    }
}

function drawField(ctx, colours, sprites, view, x, y) {
  const coop = view.isCoop();
  let top = sectionLabel(ctx, colours, 'Field', x, y + 12);

  /*
   * The ground past the contact line, drawn above the strip because that is
   * where it is: the Zobo rows when that toggle is on, and the rows a boss pull
   * opened otherwise. Nothing at all in an ordinary formation, so the card is
   * unchanged for everyone who has not turned either on.
   *
   * Drawn before the line rather than after, so the picture reads top-to-bottom
   * the way the board does — enemies and anything dragged out, then the line,
   * then your field.
   */
  const beyond = view.beyondRows ? view.beyondRows() : 0;
  for (let r = beyond; r >= 1; r--) {
    for (let col = 0; col < view.COLS; col++) {
      const cx = x + col * (CELL + CELL_GAP);
      const cy = top + (beyond - r) * (CELL + CELL_GAP);
      drawCell(ctx, colours, sprites, view, cx, cy, view.cellAtRow(-r, col), coop, true);
    }
  }
  if (beyond) top += beyond * (CELL + CELL_GAP) + CELL_GAP;

  // The line Zobos come from, matching the app's own cue.
  fill(ctx, colours.surface2, x, top, GRID_W, 22, 6);
  ctx.font = font(11, 700);
  ctx.fillStyle = colours.mute;
  ctx.letterSpacing = '1.2px';
  ctx.textAlign = 'center';
  ctx.fillText('ZOBOS SPAWN BEYOND THIS LINE', x + GRID_W / 2, top + 15);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';
  top += 30;

  for (let row = 0; row < view.ROWS; row++) {
    for (let col = 0; col < view.COLS; col++) {
      drawCell(ctx, colours, sprites, view,
        x + col * (CELL + CELL_GAP), top + row * (CELL + CELL_GAP),
        row * view.COLS + col, coop);
    }
  }

  const bottom = top + view.ROWS * CELL + (view.ROWS - 1) * CELL_GAP;
  ctx.font = font(11, 700);
  ctx.fillStyle = colours.mute;
  ctx.letterSpacing = '1.2px';
  ctx.textAlign = 'right';
  ctx.fillText('YOUR BASE', x + GRID_W, bottom + 16);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';

  // Both co-op lines, banded under the field so they survive a crop to just
  // the grid — the same reason they are drawn inside the frame in the app.
  const lines = coop ? view.filledLines() : [];
  if (!lines.length) return bottom + 24;

  const H = 40;
  let band = bottom + 26;
  for (const line of lines) {
    const ink = line.side === 'have' ? colours.ok : colours.accent;
    const label = view.LF_LABELS[line.side];
    const named = line.wants.map((slug) => state.bySlug.get(slug)).filter(Boolean);
    const note = line.note.trim();

    const done = tint(ctx, ink, 0.14);
    roundRect(ctx, x, band, GRID_W, H, 8);
    ctx.fill();
    done();

    // Measured first so the whole run can be centred in the band.
    const SP = 30;
    const GAP = 8;
    ctx.font = font(15, 800);
    const labelW = ctx.measureText(label).width;
    ctx.font = font(13, 700);
    const chipWs = named.map((t) => SP + 4 + ctx.measureText(t.name).width + 10);
    const noteW = note ? ctx.measureText(note).width + GAP : 0;
    const runW = Math.min(
      labelW + GAP + chipWs.reduce((n, w) => n + w + GAP, 0) + noteW,
      GRID_W - 20
    );

    let at = x + (GRID_W - runW) / 2;
    const mid = band + H / 2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font(15, 800);
    ctx.fillStyle = ink;
    ctx.fillText(label, at, mid);
    at += labelW + GAP;

    ctx.font = font(13, 700);
    named.forEach((t, i) => {
      const w = chipWs[i];
      const chip = tint(ctx, colours.bg, 0.5);
      roundRect(ctx, at, mid - 15, w, 30, 15);
      ctx.fill();
      chip();

      const sprite = sprites.get(t.slug);
      if (sprite) ctx.drawImage(sprite, at + 2, mid - 14, SP - 4, 28);
      ctx.fillStyle = ink;
      ctx.fillText(t.name, at + SP, mid + 1);
      at += w + GAP;
    });

    if (note) {
      ctx.fillStyle = colours.text;
      ctx.fillText(fitText(ctx, note, x + GRID_W - 10 - at), at, mid + 1);
    }
    ctx.textBaseline = 'alphabetic';
    band += H + 8;
  }
  return band;
}

/** The sprites on one step, and the width they take. */
function drawStepSprites(ctx, colours, sprites, members, x, y, benched = false) {
  const shown = members.slice(0, PLAN_SPRITES);
  let at = x;

  for (const m of shown) {
    const tatari = state.bySlug.get(m.slug);
    const done = tint(ctx, colours.type[tatari?.type] ?? colours.line, benched ? 0.08 : 0.2);
    roundRect(ctx, at, y, PLAN_SPRITE, PLAN_SPRITE, 5);
    ctx.fill();
    done();

    const sprite = sprites.get(m.slug);
    if (sprite) {
      const alpha = ctx.globalAlpha;
      if (benched) ctx.globalAlpha = alpha * 0.45;
      ctx.drawImage(sprite, at + 1, y + 1, PLAN_SPRITE - 2, PLAN_SPRITE - 2);
      ctx.globalAlpha = alpha;
    }
    at += PLAN_SPRITE + 3;
  }

  const rest = members.length - shown.length;
  if (rest > 0) {
    ctx.font = font(11, 700);
    ctx.fillStyle = colours.mute;
    ctx.fillText(`+${rest}`, at, y + PLAN_SPRITE - 8);
    at += ctx.measureText(`+${rest}`).width + 3;
  }
  return at - x;
}

function drawPlan(ctx, colours, sprites, view, x, y, width) {
  let top = sectionLabel(ctx, colours, 'Level-up priority', x, y + 12);

  for (const player of view.players()) {
    const lines = planLines(view, player);
    if (view.isCoop()) {
      ctx.font = font(12, 800);
      fill(ctx, player === 1 ? colours.p1 : colours.p2, x, top - 2, 26, 16, 4);
      ctx.fillStyle = colours.ownerInk;
      ctx.fillText(`P${player}`, x + 5, top + 10);
      top += 24;
    }
    if (!lines.length) {
      ctx.font = font(16);
      ctx.fillStyle = colours.mute;
      ctx.fillText('No level-ups planned.', x, top + 10);
      top += 30;
      continue;
    }

    for (const line of lines) {
      ctx.font = font(15, 700);
      ctx.fillStyle = colours.mute;
      ctx.fillText(line.rank, x, top + 17);

      // The chips sit at the right edge and are measured leftwards, so whatever
      // is left over is what the names get.
      let rightAt = x + width;

      ctx.font = font(13, 800);
      const chipW = ctx.measureText(line.level).width + 14;
      fill(ctx, colours.surface3, rightAt - chipW, top + 3, chipW, 19, 5);
      ctx.fillStyle = colours.accent;
      ctx.fillText(line.level, rightAt - chipW + 7, top + 17);
      rightAt -= chipW;

      if (line.benched) {
        ctx.font = font(11, 800);
        const tagW = ctx.measureText(BENCH_TAG).width + 12;
        rightAt -= 6;
        fill(ctx, colours.surface2, rightAt - tagW, top + 4, tagW, 17, 5);
        ctx.fillStyle = colours.mute;
        ctx.fillText(BENCH_TAG, rightAt - tagW + 6, top + 16);
        rightAt -= tagW;
      }

      const spritesW = drawStepSprites(
        ctx, colours, sprites, line.members, x + 20, top, line.benched);

      ctx.font = font(19, 600);
      ctx.fillStyle = line.benched ? colours.mute : colours.text;
      const namesAt = x + 20 + spritesW + 6;
      ctx.fillText(fitText(ctx, line.who, rightAt - 10 - namesAt), namesAt, top + 18);
      top += PLAN_SPRITE + 6;

      if (line.note) {
        ctx.font = `italic ${font(PLAN_NOTE)}`;
        ctx.fillStyle = colours.dim;
        for (const noteLine of wrapText(ctx, line.note, width - 26)) {
          ctx.fillText(noteLine, x + 22, top + 10);
          top += PLAN_NOTE_LINE;
        }
      }
      top += 6;
    }
    top += 8;
  }
  return top;
}

function drawBench(ctx, colours, sprites, view, x, y, width) {
  let top = sectionLabel(ctx, colours, 'Bench', x, y + 12);
  const perRow = Math.floor(width / BENCH_CELL_W);

  for (const player of view.players()) {
    const bench = view.benchOf(player);
    if (view.isCoop()) {
      ctx.font = font(12, 800);
      fill(ctx, player === 1 ? colours.p1 : colours.p2, x, top - 2, 26, 16, 4);
      ctx.fillStyle = colours.ownerInk;
      ctx.fillText(`P${player}`, x + 5, top + 10);

      ctx.font = font(12.5);
      ctx.fillStyle = colours.mute;
      ctx.fillText(`${bench.length} brought · ${view.placedCount(player)} on the field`,
        x + 34, top + 10);
      top += 24;
    }
    if (!bench.length) {
      ctx.font = font(14);
      ctx.fillStyle = colours.mute;
      ctx.fillText('Nobody brought yet.', x, top + 12);
      top += 32;
      continue;
    }

    bench.forEach((slug, i) => {
      const tatari = state.bySlug.get(slug);
      const cx = x + (i % perRow) * BENCH_CELL_W;
      const cy = top + Math.floor(i / perRow) * BENCH_CELL_H;
      const typeColour = colours.type[tatari?.type] ?? colours.line;
      const onField = view.cellOf(slug, player) !== null;

      const done = tint(ctx, typeColour, onField ? 0.2 : 0.1);
      roundRect(ctx, cx, cy, BENCH_TILE, BENCH_TILE, 8);
      ctx.fill();
      done();

      const sprite = sprites.get(slug);
      if (sprite) {
        ctx.save();
        ctx.globalAlpha = onField ? 1 : 0.5;
        ctx.drawImage(sprite, cx + 3, cy + 3, BENCH_TILE - 6, BENCH_TILE - 6);
        ctx.restore();
      }

      ctx.font = font(12, 600);
      ctx.fillStyle = onField ? colours.dim : colours.mute;
      ctx.textAlign = 'center';
      ctx.fillText(fitText(ctx, tatari?.name ?? slug, BENCH_CELL_W - 6),
        cx + BENCH_TILE / 2, cy + BENCH_TILE + 13);
      ctx.textAlign = 'left';
    });

    top += Math.ceil(bench.length / perRow) * BENCH_CELL_H + 10;
  }
  return top;
}

// ---------------------------------------------------------------- card

/**
 * Draws the card and returns the canvas.
 * @param {{username?: string}} options
 */
/**
 * What the formation brings besides damage, laid out the way the panel under
 * the field lays it out.
 *
 * It belongs in the picture because "has this team got a heal" is the first
 * thing anyone reading a posted formation asks, and working it out from sprites
 * is exactly the counting the tool exists to do for you.
 *
 * Returns the y it finished at, so the same call measures and draws.
 */
function drawEffects(ctx, colours, x, y, width, list) {
  const found = effectsOf(list);
  const groups = ['heal', 'buff', 'debuff'].filter((g) => found[g].length);
  if (!groups.length) return y;

  const colourOf = { heal: colours.ok, buff: colours.accent, debuff: colours.danger };
  const LABEL_W = 82;
  const H = 22;
  const GAP = 6;

  for (const group of groups) {
    const colour = colourOf[group];
    const top = y;
    let cx = x + LABEL_W;

    for (const e of found[group]) {
      // A level-only effect is something the formation could have, not
      // something it has, and the dashed outline says so here as on the page.
      const only = e.fromLevel && !e.fromBase;
      const text = `${e.type} ${e.count}${
        e.fromLevel ? `  ${only ? '' : '+'}L${e.minLevel}` : ''}`;

      ctx.font = font(12, 600);
      const chipW = ctx.measureText(text).width + 18;
      if (cx > x + LABEL_W && cx + chipW > x + width) {
        cx = x + LABEL_W;
        y += H + GAP;
      }

      if (!only) {
        ctx.save();
        ctx.globalAlpha = 0.14;
        fill(ctx, colour, cx, y, chipW, H, H / 2);
        ctx.restore();
      }
      ctx.save();
      if (only) ctx.setLineDash([4, 3]);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      roundRect(ctx, cx + 0.5, y + 0.5, chipW - 1, H - 1, H / 2);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = colour;
      ctx.font = font(12, 600);
      ctx.fillText(text, cx + 9, y + 15);
      cx += chipW + GAP;
    }

    // Drawn after the chips so the label sits on the first row of a group that
    // wrapped onto several.
    ctx.font = font(11, 700);
    ctx.fillStyle = colours.mute;
    ctx.letterSpacing = '1.2px';
    ctx.fillText(GROUP_LABELS[group].toUpperCase(), x, top + 15);
    ctx.letterSpacing = '0px';

    y += H + 10;
  }
  return y;
}

/**
 * The picture people actually post.
 *
 * `view` is what to draw: the live formation by default, or any snapshot
 * wrapped by `viewOf()` — which is how the community gallery gets its cards.
 * There is deliberately only one of these functions, so a change to how a
 * shared PNG looks is the same change to how every posted formation looks, with
 * nobody having to remember the second place.
 *
 * `scale` trades sharpness for pixels. The default 2 is right for something
 * being downloaded and zoomed into; a list of twenty on a phone asks for 1.
 *
 * `avatar` is a URL for the picture beside the byline — the poster's Discord
 * one, on the community gallery. It is optional in every sense: absent, blocked
 * or slow all draw the same card without it, never a broken or empty circle.
 *
 * `note` is the poster's one line about what the formation is for. It belongs
 * on the picture rather than only beside it: the card is the part that travels
 * — downloaded, pasted into Discord, screenshotted — and a build arriving
 * somewhere with no word about what it is for is a build nobody can use.
 *
 * @param {{username?: string, avatar?: string, note?: string, full?: boolean,
 *          view?: object, scale?: number}} opts
 */
export async function drawCard({
  username = '', avatar = '', note = '', full = false, stacked = false,
  view = store, scale = SCALE,
} = {}) {
  const colours = palette();
  const coop = view.isCoop();

  /*
   * Grid-only is the narrow card: the field and nothing beside it, which is
   * what gets posted. The full card keeps the wide canvas, because the plan
   * sits in a column to the right of the field and the benches run the whole
   * way across it.
   */
  /*
   * Three shapes, and the third exists for one reason: legibility on a phone.
   *
   * A card is a fixed-width picture scaled to fit whatever column shows it. The
   * wide card is 1080 across, and a phone gives it about 380 — a scale of 0.35,
   * at which 14px type renders at five physical pixels and the level-up plan is
   * a grey smear. Making the type bigger cannot fix that on its own: to reach a
   * readable 12px you would need 34px in card space, which is title-sized.
   *
   * So the narrow card is narrow in *card* units too. Same content, one column
   * — field, then plan, then bench — at 636 across, which the same phone shows
   * at 0.6. Everything on it is immediately 1.7x larger for free, before a
   * single font size changes.
   */
  const oneColumn = !full || stacked;
  const w = oneColumn ? PAD * 2 + GRID_W : W;
  const contentW = w - PAD * 2;
  // The plan sits beside the field on a wide card and under it on a narrow one,
  // so what it has to wrap inside differs.
  const planW = stacked ? contentW : RIGHT_W;

  // Together, not one after the other: the avatar is a different host with its
  // own latency, and it has no business adding itself to the sprite wait.
  const [sprites, face] = await Promise.all([
    loadSprites(cardSlugs(view)),
    loadAvatar(username.trim() ? avatar : ''),
  ]);

  // Measure first: the plan and the benches decide how tall the card is.
  const probe = document.createElement('canvas').getContext('2d');
  const planHeight = () => {
    let h = 30;
    for (const player of view.players()) {
      if (coop) h += 24;
      const lines = planLines(view, player);
      if (!lines.length) { h += 30; continue; }
      for (const line of lines) {
        h += PLAN_SPRITE + 12;
        if (line.note) {
          probe.font = `italic ${font(PLAN_NOTE)}`;
          h += wrapText(probe, line.note, planW - 26).length * PLAN_NOTE_LINE;
        }
      }
      h += 8;
    }
    return h;
  };
  const benchHeight = () => {
    const perRow = Math.floor(contentW / BENCH_CELL_W);
    let h = 30;
    for (const player of view.players()) {
      if (coop) h += 24;
      const n = view.benchOf(player).length;
      h += n ? Math.ceil(n / perRow) * BENCH_CELL_H + 10 : 32;
    }
    return h;
  };

  /*
   * The note wraps, so the header is only a fixed height when there isn't one.
   * Measured with the same font the drawing uses, on the probe, because getting
   * this wrong crops the note or leaves a gap above the field.
   */
  probe.font = font(NOTE, 500);
  const noteInset = NOTE_BAR + 14;
  const noteLines = note.trim()
    ? wrapText(probe, note.trim(), contentW - noteInset - 14)
    : [];
  const noteBoxH = noteLines.length ? noteLines.length * NOTE_LINE + NOTE_PAD * 2 : 0;
  const headerH = 96 + (noteBoxH ? noteBoxH + 14 : 0);
  // The LF band only exists in co-op, and only once something is being asked
  // for; drawField returns past it, so the measure has to agree.
  const lfH = coop ? view.filledLines().length * 48 : 0;
  /*
   * The rows past the contact line are part of the field's height. Left out,
   * the canvas stayed sized for six rows and the board simply ran off the
   * bottom of the picture — the one failure mode a share card cannot have.
   */
  const beyondH = (view.beyondRows ? view.beyondRows() : 0) * (CELL + CELL_GAP);
  const fieldH = 42 + beyondH + view.ROWS * CELL + (view.ROWS - 1) * CELL_GAP + 24 + lfH;

  // On both cards, so measured for both. drawEffects returns its own bottom,
  // which lets the probe run the measurement rather than duplicating the wrap.
  const fielded = view.allPlaced()
    .map(({ slug }) => state.bySlug.get(slug)).filter(Boolean);
  const effectsH = fielded.length
    ? drawEffects(probe, colours, 0, 0, contentW, fielded) + 12
    : 0;

  // Side by side takes the taller of the two; stacked takes both, plus the rule
  // between them.
  let bodyH = fieldH;
  if (full) bodyH = stacked ? fieldH + 20 + planHeight() : Math.max(fieldH, planHeight());
  // The trailing 12 is breathing room under the last row, not a reserved band:
  // nothing is drawn below the content, so anything more reads as a crop gone
  // wrong rather than as margin.
  const height = PAD + headerH + bodyH
    + (full ? 20 + benchHeight() : 0)
    + effectsH + 12 + PAD;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';

  fill(ctx, colours.bg, 0, 0, w, height);
  fill(ctx, colours.surface, PAD - 16, PAD - 16, w - (PAD - 16) * 2, height - (PAD - 16) * 2, 18);
  ctx.strokeStyle = colours.line;
  ctx.lineWidth = 1;
  roundRect(ctx, PAD - 16.5, PAD - 16.5, w - (PAD - 16) * 2 + 1, height - (PAD - 16) * 2 + 1, 18);
  ctx.stroke();

  // Header
  let y = PAD + 22;
  const byline = username.trim() ? `by ${username.trim()}` : '';
  ctx.font = font(15, 600);
  const bylineW = byline ? ctx.measureText(byline).width : 0;
  // Reserved before the title is fitted, so a long formation name is cut to
  // clear the face rather than run under it.
  const FACE = 26;
  const faceW = face ? FACE + 9 : 0;

  ctx.font = font(34, 700);
  ctx.fillStyle = colours.text;
  ctx.fillText(
    fitText(ctx, view.formation.name || 'Untitled formation',
      w - PAD * 2 - bylineW - faceW - 24),
    PAD, y
  );
  if (byline) {
    ctx.font = font(15, 600);
    ctx.fillStyle = colours.accent;
    ctx.textAlign = 'right';
    ctx.fillText(byline, w - PAD, y - 2);
    ctx.textAlign = 'left';

    if (face) {
      /*
       * Left of the name, and circular, because that is what a Discord avatar
       * is everywhere else the reader has seen one — square would read as a
       * sprite, which is the one thing this card is full of.
       *
       * Centred on the byline's own text rather than its baseline: 15px type
       * sits about 5px above the baseline at its middle, so this lines the
       * circle up with the words instead of hanging it below them.
       */
      const cx = w - PAD - bylineW - 9 - FACE / 2;
      const cy = y - 2 - 5;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, FACE / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(face, cx - FACE / 2, cy - FACE / 2, FACE, FACE);
      ctx.restore();

      // A hairline, so a dark avatar has an edge against a dark card.
      ctx.strokeStyle = colours.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, FACE / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  y += 26;
  ctx.font = font(14.5);
  ctx.fillStyle = colours.dim;
  ctx.fillText(fitText(ctx, [
    'Horde Invasion',
    view.mode().label,
    `${view.COLS} × ${view.ROWS} field`,
    // Tatari only: a Zobo is not deployed by anybody and counts against no cap.
    `${view.allPlaced().filter((p) => p.player > 0).length} of ${
      view.fieldCap() * view.playerCount()} deployed`,
  ].join('  ·  '), w - PAD * 2), PAD, y);

  y += 18;

  /*
   * Italic and dim, directly under the facts it qualifies. Not in quotes: it is
   * the poster's own card, so there is nobody for it to be attributed away
   * from, and quote marks around a sentence that is already set apart just read
   * as punctuation somebody forgot to close.
   */
  /*
   * A panel, not a caption.
   *
   * This was dim italic set directly under the dim facts line, which is exactly
   * the recipe for something the eye files as more subtitle and skips — and it
   * is the one line on the card written by a person, saying why the formation
   * is shaped the way it is. Italic and grey were both telling the reader it
   * was an aside.
   *
   * So it gets its own surface, full text colour, upright at medium weight, and
   * an accent bar down the left. The bar is doing the real work: it is the only
   * accent-coloured thing in the header apart from the byline, so the block
   * reads as quoted speech before a single word of it is read.
   */
  if (noteBoxH) {
    const boxY = y + 6;
    fill(ctx, colours.surface2, PAD, boxY, contentW, noteBoxH, 10);
    fill(ctx, colours.accent, PAD, boxY, NOTE_BAR, noteBoxH, 2);

    ctx.font = font(NOTE, 500);
    ctx.fillStyle = colours.text;
    // 0.78em is about the cap height of this face, so the first line sits on
    // the padding rather than hanging off it.
    let ty = boxY + NOTE_PAD + NOTE * 0.78;
    for (const line of noteLines) {
      ctx.fillText(line, PAD + noteInset, ty);
      ty += NOTE_LINE;
    }
    y = boxY + noteBoxH + 8;
  }

  fill(ctx, colours.line, PAD, y, w - PAD * 2, 1);
  y += 8;

  // Body
  const fieldBottom = drawField(ctx, colours, sprites, view, PAD, y);

  if (!full) {
    y = fieldBottom + 12;
  } else if (stacked) {
    // Under the field, with a rule of its own, so the plan reads as the next
    // thing rather than as a caption on the board.
    fill(ctx, colours.line, PAD, fieldBottom + 8, contentW, 1);
    y = drawPlan(ctx, colours, sprites, view, PAD, fieldBottom + 12, planW) + 12;
  } else {
    y = Math.max(drawPlan(ctx, colours, sprites, view, PAD + GRID_W + 32, y, planW), fieldBottom) + 12;
  }

  if (full) {
    fill(ctx, colours.line, PAD, y, contentW, 1);
    y = drawBench(ctx, colours, sprites, view, PAD, y + 8, contentW);
  }

  if (fielded.length) {
    fill(ctx, colours.line, PAD, y, contentW, 1);
    y = drawEffects(ctx, colours, PAD, y + 11, contentW, fielded);
  }

  return canvas;
}

/** PNG rather than JPEG: the card is mostly flat colour, text and sprite edges. */
export function canvasBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
