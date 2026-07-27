/**
 * The share card: the whole formation drawn as one image.
 *
 * A link is only useful to someone who will open it. A picture is what actually
 * gets posted, so sharing draws the title, the field, both benches and the
 * level-up plan onto a canvas the user can download or paste anywhere.
 *
 * Sprites are same-origin, so the canvas stays untainted and can be exported.
 */

import { state } from './data.js';
import * as store from './store.js';
import { artOf, APP_VERSION, APP_AUTHOR, SITE_URL } from './ui.js';

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

/** Step sprites, and how many fit before the rest become a "+N". */
const PLAN_SPRITE = 26;
const PLAN_SPRITES = 5;

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
    accentInk: read('--accent-ink', '#2a2005'),
    p1: read('--p1', '#4d9dff'),
    p2: read('--p2', '#ff5fa8'),
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
  ctx.font = font(13, 700);
  ctx.fillStyle = colours.mute;
  ctx.letterSpacing = '1.4px';
  ctx.fillText(text.toUpperCase(), x, y);
  ctx.letterSpacing = '0px';
  return y + 18;
}

/**
 * The sprites the card needs, skipping the ones with no art.
 *
 * Every Tatari on the card is also on the page, so the drawn <img> elements are
 * reused wherever possible. That matters: a fresh Image().decode() queues behind
 * the roster's several hundred sprites, and waiting on that pipeline can take
 * many seconds. Anything genuinely new waits, but not forever - a card missing
 * one sprite beats a card that never appears.
 */
async function loadSprites(slugs) {
  const sprites = new Map();
  // naturalWidth, not complete: an image can be decoded and perfectly drawable
  // while its load event is still pending, and those are exactly the sprites
  // already on screen.
  const onPage = new Map();
  for (const img of document.images) {
    if (img.naturalWidth) onPage.set(img.currentSrc || img.src, img);
  }

  await Promise.all([...new Set(slugs)].map(async (slug) => {
    const src = artOf(state.bySlug.get(slug) ?? {});
    if (!src) return;

    const drawn = onPage.get(new URL(src, location.href).href);
    if (drawn) { sprites.set(slug, drawn); return; }

    const img = new Image();
    img.fetchPriority = 'high';
    img.src = src;
    await Promise.race([
      img.decode().catch(() => {}),
      new Promise((resolve) => { setTimeout(resolve, 2500); }),
    ]);
    if (img.complete && img.naturalWidth) sprites.set(slug, img);
  }));
  return sprites;
}

// ---------------------------------------------------------------- content

function planLines(player) {
  const steps = store.isCoop()
    ? store.planFor(player)
    : store.formation.plan.map((step, index) => ({ step, index }));

  return steps.map(({ step }, i) => ({
    rank: `${i + 1}`,
    members: step.members,
    who: step.members.map((m) => state.bySlug.get(m.slug)?.name ?? m.slug).join(', '),
    level: step.level === null ? 'Any' : `Lv ${step.level}`,
    note: step.note,
  }));
}

// ---------------------------------------------------------------- drawing

function drawField(ctx, colours, sprites, x, y) {
  const coop = store.isCoop();
  let top = sectionLabel(ctx, colours, 'Field', x, y + 12);

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

  for (let row = 0; row < store.ROWS; row++) {
    for (let col = 0; col < store.COLS; col++) {
      const cx = x + col * (CELL + CELL_GAP);
      const cy = top + row * (CELL + CELL_GAP);
      const occ = store.formation.cells[row * store.COLS + col];

      if (!occ) {
        fill(ctx, colours.bg, cx, cy, CELL, CELL, 8);
        ctx.strokeStyle = colours.line;
        ctx.lineWidth = 1;
        roundRect(ctx, cx + 0.5, cy + 0.5, CELL - 1, CELL - 1, 8);
        ctx.stroke();
        continue;
      }
      const tatari = state.bySlug.get(occ.slug);
      const typeColour = colours.type[tatari?.type] ?? colours.line;

      const done = tint(ctx, typeColour, 0.18);
      roundRect(ctx, cx, cy, CELL, CELL, 8);
      ctx.fill();
      done();

      ctx.strokeStyle = coop ? (occ.player === 1 ? colours.p1 : colours.p2) : typeColour;
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

      // Planned target, the one number worth reading off a formation at a glance.
      const target = store.topLevel(occ.slug, occ.player);
      if (target !== null) {
        ctx.font = font(12, 800);
        const label = `L${target}`;
        const w = ctx.measureText(label).width + 10;
        fill(ctx, colours.accent, cx + CELL - w - 4, cy + CELL - 20, w, 16, 4);
        ctx.fillStyle = colours.accentInk;
        ctx.fillText(label, cx + CELL - w + 1, cy + CELL - 8);
      }
      if (coop) {
        ctx.font = font(11, 800);
        fill(ctx, occ.player === 1 ? colours.p1 : colours.p2, cx + 4, cy + 4, 22, 15, 4);
        ctx.fillStyle = '#0e1118';
        ctx.fillText(`P${occ.player}`, cx + 7, cy + 15);
      }
    }
  }

  const bottom = top + store.ROWS * CELL + (store.ROWS - 1) * CELL_GAP;
  ctx.font = font(11, 700);
  ctx.fillStyle = colours.mute;
  ctx.letterSpacing = '1.2px';
  ctx.textAlign = 'right';
  ctx.fillText('YOUR BASE', x + GRID_W, bottom + 16);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';

  // Both co-op lines, banded under the field so they survive a crop to just
  // the grid — the same reason they are drawn inside the frame in the app.
  const lines = coop ? store.filledLines() : [];
  if (!lines.length) return bottom + 24;

  const H = 40;
  let band = bottom + 26;
  for (const line of lines) {
    const ink = line.side === 'have' ? colours.ok : colours.accent;
    const label = store.LF_LABELS[line.side];
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
function drawStepSprites(ctx, colours, sprites, members, x, y) {
  const shown = members.slice(0, PLAN_SPRITES);
  let at = x;

  for (const m of shown) {
    const tatari = state.bySlug.get(m.slug);
    const done = tint(ctx, colours.type[tatari?.type] ?? colours.line, 0.2);
    roundRect(ctx, at, y, PLAN_SPRITE, PLAN_SPRITE, 5);
    ctx.fill();
    done();

    const sprite = sprites.get(m.slug);
    if (sprite) ctx.drawImage(sprite, at + 1, y + 1, PLAN_SPRITE - 2, PLAN_SPRITE - 2);
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

function drawPlan(ctx, colours, sprites, x, y, width) {
  let top = sectionLabel(ctx, colours, 'Level-up priority', x, y + 12);

  for (const player of store.players()) {
    const lines = planLines(player);
    if (store.isCoop()) {
      ctx.font = font(12, 800);
      fill(ctx, player === 1 ? colours.p1 : colours.p2, x, top - 2, 26, 16, 4);
      ctx.fillStyle = '#0e1118';
      ctx.fillText(`P${player}`, x + 5, top + 10);
      top += 24;
    }
    if (!lines.length) {
      ctx.font = font(14);
      ctx.fillStyle = colours.mute;
      ctx.fillText('No level-ups planned.', x, top + 10);
      top += 30;
      continue;
    }

    for (const line of lines) {
      ctx.font = font(13, 700);
      ctx.fillStyle = colours.mute;
      ctx.fillText(line.rank, x, top + 17);

      ctx.font = font(12, 800);
      const chipW = ctx.measureText(line.level).width + 14;
      fill(ctx, colours.surface3, x + width - chipW, top + 3, chipW, 19, 5);
      ctx.fillStyle = colours.accent;
      ctx.fillText(line.level, x + width - chipW + 7, top + 17);

      const spritesW = drawStepSprites(ctx, colours, sprites, line.members, x + 20, top);

      ctx.font = font(14, 600);
      ctx.fillStyle = colours.text;
      const namesAt = x + 20 + spritesW + 6;
      ctx.fillText(fitText(ctx, line.who, x + width - chipW - 10 - namesAt),
        namesAt, top + 18);
      top += PLAN_SPRITE + 6;

      if (line.note) {
        ctx.font = `italic ${font(12.5)}`;
        ctx.fillStyle = colours.dim;
        for (const noteLine of wrapText(ctx, line.note, width - 26)) {
          ctx.fillText(noteLine, x + 22, top + 10);
          top += 17;
        }
      }
      top += 6;
    }
    top += 8;
  }
  return top;
}

function drawBench(ctx, colours, sprites, x, y, width) {
  let top = sectionLabel(ctx, colours, 'Bench', x, y + 12);
  const perRow = Math.floor(width / BENCH_CELL_W);

  for (const player of store.players()) {
    const bench = store.benchOf(player);
    if (store.isCoop()) {
      ctx.font = font(12, 800);
      fill(ctx, player === 1 ? colours.p1 : colours.p2, x, top - 2, 26, 16, 4);
      ctx.fillStyle = '#0e1118';
      ctx.fillText(`P${player}`, x + 5, top + 10);

      ctx.font = font(12.5);
      ctx.fillStyle = colours.mute;
      ctx.fillText(`${bench.length} brought · ${store.placedCount(player)} on the field`,
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
      const onField = store.cellOf(slug, player) !== null;

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

      ctx.font = font(10.5, 600);
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
export async function drawCard({ username = '' } = {}) {
  const colours = palette();
  const coop = store.isCoop();

  const slugs = [
    ...store.formation.cells.filter(Boolean).map((o) => o.slug),
    ...store.players().flatMap((p) => store.benchOf(p)),
    // Asked-for Tatari are on nobody's bench by definition, so they need
    // fetching too or the LF band draws empty chips.
    ...store.filledLines().flatMap((l) => l.wants),
  ];
  const sprites = await loadSprites(slugs);

  // Measure first: the plan and the benches decide how tall the card is.
  const probe = document.createElement('canvas').getContext('2d');
  const planHeight = () => {
    let h = 30;
    for (const player of store.players()) {
      if (coop) h += 24;
      const lines = planLines(player);
      if (!lines.length) { h += 30; continue; }
      for (const line of lines) {
        h += PLAN_SPRITE + 12;
        if (line.note) {
          probe.font = `italic ${font(12.5)}`;
          h += wrapText(probe, line.note, RIGHT_W - 26).length * 17;
        }
      }
      h += 8;
    }
    return h;
  };
  const benchHeight = () => {
    const perRow = Math.floor((W - PAD * 2) / BENCH_CELL_W);
    let h = 30;
    for (const player of store.players()) {
      if (coop) h += 24;
      const n = store.benchOf(player).length;
      h += n ? Math.ceil(n / perRow) * BENCH_CELL_H + 10 : 32;
    }
    return h;
  };

  const headerH = 96;
  // The LF band only exists in co-op, and only once something is being asked
  // for; drawField returns past it, so the measure has to agree.
  const lfH = coop ? store.filledLines().length * 48 : 0;
  const fieldH = 42 + store.ROWS * CELL + (store.ROWS - 1) * CELL_GAP + 24 + lfH;
  const bodyH = Math.max(fieldH, planHeight());
  const height = PAD + headerH + bodyH + 20 + benchHeight() + 40 + PAD;

  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = Math.round(height) * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'alphabetic';

  fill(ctx, colours.bg, 0, 0, W, height);
  fill(ctx, colours.surface, PAD - 16, PAD - 16, W - (PAD - 16) * 2, height - (PAD - 16) * 2, 18);
  ctx.strokeStyle = colours.line;
  ctx.lineWidth = 1;
  roundRect(ctx, PAD - 16.5, PAD - 16.5, W - (PAD - 16) * 2 + 1, height - (PAD - 16) * 2 + 1, 18);
  ctx.stroke();

  // Header
  let y = PAD + 22;
  const byline = username.trim() ? `by ${username.trim()}` : '';
  ctx.font = font(15, 600);
  const bylineW = byline ? ctx.measureText(byline).width : 0;

  ctx.font = font(34, 700);
  ctx.fillStyle = colours.text;
  ctx.fillText(
    fitText(ctx, store.formation.name || 'Untitled formation', W - PAD * 2 - bylineW - 24),
    PAD, y
  );
  if (byline) {
    ctx.font = font(15, 600);
    ctx.fillStyle = colours.accent;
    ctx.textAlign = 'right';
    ctx.fillText(byline, W - PAD, y - 2);
    ctx.textAlign = 'left';
  }

  y += 26;
  ctx.font = font(14.5);
  ctx.fillStyle = colours.dim;
  ctx.fillText([
    'Horde Invasion',
    store.mode().label,
    `${store.COLS} × ${store.ROWS} field`,
    `${store.allPlaced().length} of ${store.fieldCap() * store.playerCount()} deployed`,
  ].join('  ·  '), PAD, y);

  y += 18;
  fill(ctx, colours.line, PAD, y, W - PAD * 2, 1);
  y += 8;

  // Body
  const planBottom = drawPlan(ctx, colours, sprites, PAD + GRID_W + 32, y, RIGHT_W);
  const fieldBottom = drawField(ctx, colours, sprites, PAD, y);
  y = Math.max(planBottom, fieldBottom) + 12;

  fill(ctx, colours.line, PAD, y, W - PAD * 2, 1);
  y = drawBench(ctx, colours, sprites, PAD, y + 8, W - PAD * 2);

  // Footer
  ctx.font = font(12.5);
  ctx.fillStyle = colours.mute;
  ctx.fillText(`Horde Drafter v${APP_VERSION} · by ${APP_AUTHOR} on Discord · ${SITE_URL}`,
    PAD, height - PAD - 4);

  return canvas;
}

/** PNG rather than JPEG: the card is mostly flat colour, text and sprite edges. */
export function canvasBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
