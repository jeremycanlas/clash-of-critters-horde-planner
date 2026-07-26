#!/usr/bin/env node
/**
 * Scrapes Tatari data + sprites from https://clashofcritters.wiki.gg
 *
 *   node tools/scrape-wiki.mjs            # data + images
 *   node tools/scrape-wiki.mjs --no-images
 *
 * Writes:
 *   data/tatari.json          full roster
 *   data/meta.json            types, roles, type chart, counts
 *   data/images/tatari/*.png  normal sprites
 *   data/images/glitter/*.png glitter sprites
 *
 * Cloudflare blocks plain HTML page views but leaves api.php and /images/ open,
 * so everything here goes through the MediaWiki API.
 */

import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const WIKI = 'https://clashofcritters.wiki.gg';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ROOT = path.resolve(import.meta.dirname, '..');
const THUMB_WIDTH = 200;

const ELEMENTS = ['Water', 'Fire', 'Grass', 'Lightning', 'Rock'];
const ROLE_CANON = {
  dps: 'DPS', guardian: 'Guardian', healer: 'Healer',
  tank: 'Tank', support: 'Support', specialist: 'Specialist',
  same: 'Same', none: 'None', '': null,
};

// ---------------------------------------------------------------- http

async function api(params) {
  const url = new URL('/api.php', WIKI);
  for (const [k, v] of Object.entries({ format: 'json', formatversion: '2', ...params })) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function wikitext(title) {
  const j = await api({
    action: 'query', titles: title,
    prop: 'revisions', rvprop: 'content', rvslots: 'main',
  });
  const page = j.query.pages[0];
  if (page.missing) throw new Error(`page not found: ${title}`);
  return page.revisions[0].slots.main.content;
}

// ---------------------------------------------------------------- wikitext helpers

const squash = (s) => s.replace(/\s+/g, ' ').trim();
const role = (s) => {
  const k = squash(s).toLowerCase();
  return ROLE_CANON[k] !== undefined ? ROLE_CANON[k] : squash(s);
};
const element = (s) => {
  const v = squash(s).toLowerCase();
  return v ? v[0].toUpperCase() + v.slice(1) : null;
};

/** Strip wiki markup down to readable text. */
function plain(s) {
  return squash(
    s
      .replace(/\[\[File:[^\]]*\]\]/gi, '')
      .replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/'''?/g, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
  );
}

/** `[[File:Some Name.png|100px]]` -> `Some Name.png` */
function fileName(cell) {
  const m = cell.match(/\[\[File:([^\]|]+)/i);
  return m ? squash(m[1].replace(/_/g, ' ')) : null;
}

/**
 * Splits one wikitable row into its cells. A cell begins on a line starting
 * with `|`; following lines that do not are continuations of that cell.
 */
function splitCells(rowText) {
  const cells = [];
  for (const line of rowText.split('\n')) {
    if (/^\s*\|/.test(line) && !/^\s*\|-/.test(line)) {
      cells.push(line.replace(/^\s*\|/, ''));
    } else if (cells.length) {
      cells[cells.length - 1] += '\n' + line;
    }
  }
  return cells;
}

/** Extracts the rows of the first wikitable that follows `marker`. */
function tableRows(text, marker) {
  const at = text.indexOf(marker);
  if (at === -1) throw new Error(`marker not found: ${marker}`);
  const start = text.lastIndexOf('{|', at);
  const end = text.indexOf('\n|}', start);
  const body = text.slice(start, end === -1 ? undefined : end);
  return body.split(/\n\|-+[^\n]*\n/).slice(1).filter((r) => r.trim());
}

// ---------------------------------------------------------------- roster

function parseRoster(text) {
  const rows = tableRows(text, '! Normal Form');
  const list = [];

  for (const row of rows) {
    const c = splitCells(row);
    if (c.length < 8) {
      console.warn(`  skipped a row with ${c.length} cells`);
      continue;
    }
    const nameCell = c[2];
    const linked = nameCell.match(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
    const name = linked ? squash(linked[1]) : plain(nameCell.split(/<br\s*\/?>|\n/)[0]);
    if (!name) continue;

    const ety = nameCell.match(/''([^']+)''/);
    const glitter = fileName(c[1]);

    list.push({
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      etymology: ety ? squash(ety[1]) : null,
      type: element(c[3]),
      role: role(c[4]),
      previousRole: role(c[5]),
      skill: plain(c[6]),
      description: plain(c[7]),
      wikiUrl: linked ? `${WIKI}/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}` : null,
      sourceFile: fileName(c[0]),
      glitterSourceFile: /^\s*N\/A/i.test(c[1]) ? null : glitter,
    });
  }
  return list;
}

/**
 * Evolution families. Rows on the wiki are listed family by family and every
 * member of a family shares its type and role, so contiguous runs of the same
 * (type, role) are exactly one family. Verified: 62 runs of length 2, 3 or 4.
 */
function groupFamilies(list) {
  const runs = [];
  let run = [list[0]];
  for (let i = 1; i < list.length; i++) {
    const head = run[0];
    if (list[i].type === head.type && list[i].role === head.role) run.push(list[i]);
    else { runs.push(run); run = [list[i]]; }
  }
  runs.push(run);

  const bad = runs.filter((r) => r.length < 2 || r.length > 4);
  if (bad.length) {
    console.warn('  unexpected family sizes:', bad.map((r) => `${r[0].name}(${r.length})`).join(', '));
  }

  runs.forEach((members, familyId) => {
    const line = members.map((m) => m.name);
    members.forEach((m, i) => {
      m.familyId = familyId;
      m.family = members[0].name;
      m.tier = i + 1;                                   // 1..4
      m.stages = members.length;
      m.rarity = members.length <= 2 ? 'Common' : 'Rare';
      m.evolutionLine = line;
    });
  });
  return runs.length;
}

// ---------------------------------------------------------------- element pages

/** Front/back row placement + the type effectiveness chart. */
async function parseElementPages() {
  const battleRow = {};
  const typeChart = {};

  for (const el of ELEMENTS) {
    const text = await wikitext(el);
    typeChart[el] = {
      weakTo: (text.match(/weak to \[\[(\w+)\]\]/i) || [])[1] || null,
      strongAgainst: (text.match(/super effective against \[\[(\w+)\]\]/i) || [])[1] || null,
    };

    for (const row of tableRows(text, '! Name')) {
      const c = splitCells(row);
      if (c.length < 4) continue;
      const m = c[1].match(/\[\[([^\]|]+)/);
      if (!m) continue;
      const r = squash(c[3]);
      if (/frontrow/i.test(r)) battleRow[squash(m[1])] = 'front';
      else if (/backrow/i.test(r)) battleRow[squash(m[1])] = 'back';
    }
    console.log(`  ${el}: weak to ${typeChart[el].weakTo}, strong vs ${typeChart[el].strongAgainst}`);
  }
  return { battleRow, typeChart };
}

// ---------------------------------------------------------------- images

/** Resolves File: titles to thumbnail URLs, 50 at a time. */
async function resolveThumbs(files) {
  const urls = new Map();
  const titles = [...new Set(files)];

  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const j = await api({
      action: 'query',
      titles: batch.map((f) => `File:${f}`).join('|'),
      prop: 'imageinfo',
      iiprop: 'url',
      iiurlwidth: String(THUMB_WIDTH),
    });
    for (const page of j.query.pages) {
      const info = page.imageinfo?.[0];
      if (!info) { console.warn(`  no image info: ${page.title}`); continue; }
      urls.set(page.title.replace(/^File:/, '').replace(/_/g, ' '), info.thumburl || info.url);
    }
    process.stdout.write(`\r  resolved ${Math.min(i + 50, titles.length)}/${titles.length}`);
  }
  console.log();
  return urls;
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function fetchSprites(list, thumbs) {
  const dirs = {
    tatari: path.join(ROOT, 'data/images/tatari'),
    glitter: path.join(ROOT, 'data/images/glitter'),
  };
  await Promise.all(Object.values(dirs).map((d) => mkdir(d, { recursive: true })));

  const jobs = [];
  for (const t of list) {
    if (t.sourceFile) jobs.push([t.sourceFile, path.join(dirs.tatari, `${t.slug}.png`), t, 'image']);
    if (t.glitterSourceFile) jobs.push([t.glitterSourceFile, path.join(dirs.glitter, `${t.slug}.png`), t, 'glitterImage']);
  }

  let done = 0, failed = 0, skipped = 0;
  const CONCURRENCY = 8;

  const worker = async () => {
    while (jobs.length) {
      const [file, dest, tatari, field] = jobs.shift();
      const url = thumbs.get(file);
      const rel = path.relative(ROOT, dest).replace(/\\/g, '/');
      if (!url) { failed++; continue; }
      try {
        const existing = await stat(dest).catch(() => null);
        if (existing && existing.size > 0) skipped++;
        else await download(url, dest);
        tatari[field] = rel;
        done++;
      } catch (err) {
        failed++;
        console.warn(`\n  ${file}: ${err.message}`);
      }
      process.stdout.write(`\r  sprites ${done} ok (${skipped} cached), ${failed} failed`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log();
}

// ---------------------------------------------------------------- main

async function main() {
  const withImages = !process.argv.includes('--no-images');

  console.log('Fetching Tatari list...');
  const list = parseRoster(await wikitext('Tatari'));
  console.log(`  ${list.length} Tatari`);

  const families = groupFamilies(list);
  console.log(`  ${families} evolution families`);

  console.log('Fetching element pages...');
  const { battleRow, typeChart } = await parseElementPages();
  let rowHits = 0;
  for (const t of list) {
    t.battleRow = battleRow[t.name] || null;
    if (t.battleRow) rowHits++;
  }
  console.log(`  front/back row known for ${rowHits}/${list.length}`);

  if (withImages) {
    console.log('Resolving sprite URLs...');
    const files = list.flatMap((t) => [t.sourceFile, t.glitterSourceFile].filter(Boolean));
    const thumbs = await resolveThumbs(files);
    console.log('Downloading sprites...');
    await fetchSprites(list, thumbs);
  } else {
    // keep the paths so the app still works against an existing image folder
    for (const t of list) {
      if (t.sourceFile) t.image = `data/images/tatari/${t.slug}.png`;
      if (t.glitterSourceFile) t.glitterImage = `data/images/glitter/${t.slug}.png`;
    }
  }

  const types = ELEMENTS.slice().sort();
  const roles = [...new Set(list.map((t) => t.role))].sort();

  const ordered = list.map((t) => ({
    name: t.name, slug: t.slug, type: t.type, role: t.role, tier: t.tier,
    family: t.family, familyId: t.familyId, stages: t.stages, rarity: t.rarity,
    evolutionLine: t.evolutionLine, battleRow: t.battleRow, previousRole: t.previousRole,
    etymology: t.etymology, skill: t.skill, description: t.description,
    image: t.image ?? null, glitterImage: t.glitterImage ?? null, wikiUrl: t.wikiUrl,
  }));

  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  await writeFile(path.join(ROOT, 'data/tatari.json'), JSON.stringify(ordered, null, 1) + '\n');

  const meta = {
    source: `${WIKI}/wiki/Tatari`,
    scrapedAt: new Date().toISOString().slice(0, 10),
    counts: {
      tatari: ordered.length,
      families,
      byType: Object.fromEntries(types.map((ty) => [ty, ordered.filter((t) => t.type === ty).length])),
      byRole: Object.fromEntries(roles.map((r) => [r, ordered.filter((t) => t.role === r).length])),
      byRarity: {
        Common: ordered.filter((t) => t.rarity === 'Common').length,
        Rare: ordered.filter((t) => t.rarity === 'Rare').length,
      },
    },
    types, roles, typeChart,
    // Your half of the Horde field. Zobos spawn beyond row 0 and never stand here.
    hordeGrid: { columns: 6, rows: 5, maxDeployed: 15, maxLevel: 7 },
  };
  await writeFile(path.join(ROOT, 'data/meta.json'), JSON.stringify(meta, null, 2) + '\n');

  const imgs = await Promise.all(
    ['tatari', 'glitter'].map((d) =>
      readdir(path.join(ROOT, 'data/images', d)).then((f) => f.length).catch(() => 0))
  );

  console.log('\nWrote data/tatari.json and data/meta.json');
  console.log(`  images: ${imgs[0]} normal, ${imgs[1]} glitter`);
  console.log(`  missing sprites: ${ordered.filter((t) => !t.image).map((t) => t.name).join(', ') || 'none'}`);

  if (withImages) {
    // Wiki thumbnails share a width, not a box, so raw downloads vary wildly in
    // apparent size. Normalising is a separate step and safe to re-run.
    console.log('\nNext: python tools/normalize_images.py');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
