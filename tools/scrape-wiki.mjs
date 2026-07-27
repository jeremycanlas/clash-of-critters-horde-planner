#!/usr/bin/env node
/**
 * Scrapes Tatari data + sprites from https://clashofcritters.wiki.gg
 *
 *   node tools/scrape-wiki.mjs            # data + images
 *   node tools/scrape-wiki.mjs --no-images
 *   node tools/scrape-wiki.mjs --icons-only   # just the type/role icons
 *
 * Writes:
 *   data/tatari.json          full roster
 *   data/meta.json            types, roles, type chart, counts
 *   data/images/tatari/*.png  normal sprites
 *   data/images/glitter/*.png glitter sprites
 *   data/images/icons/*.png   type + role icons (Category:In-game Icons)
 *   data/images/range/*.png   attack-range diagrams, where the wiki has one
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
const ICON_WIDTH = 128;
const RANGE_WIDTH = 480;

const ELEMENTS = ['Water', 'Fire', 'Grass', 'Lightning', 'Rock'];
const ROLES = ['DPS', 'Guardian', 'Healer', 'Tank', 'Support', 'Specialist'];
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

// ---------------------------------------------------------------- horde skills

/**
 * The level-up skills a Tatari learns in Horde Invasion, from the mode's own
 * page. Two things about how the wiki records them:
 *
 *   - they are learned at levels 3, 5 and 7, which is exactly what the level
 *     plan is built around;
 *   - they are shared across an evolution line, so the page lists only the base
 *     form. The base skill differs per form and already comes from the roster.
 *
 * Keyed by family name, therefore, and applied to every member of the line.
 */
async function parseHordeSkills() {
  const text = await wikitext('Zobo Horde Invasion');
  const byFamily = new Map();

  for (const row of tableRows(text, '!Level 3 Skill')) {
    const c = splitCells(row);
    if (c.length < 7) continue;
    const linked = c[1].match(/\[\[([^\]|]+)/);
    const family = squash(linked ? linked[1] : plain(c[1]));
    if (!family) continue;
    byFamily.set(family, {
      level3: skillOf(c[4]),
      level5: skillOf(c[5]),
      level7: skillOf(c[6]),
    });
  }
  return byFamily;
}

/**
 * `'''Forked Bolt:''' Attacks have a higher chance...` -> {name, text}
 *
 * The colon lives inside the bold in most rows and outside it in a few, and a
 * handful of skills have a colon in the name itself — "Technique: Veil" — so
 * the name is whatever is emboldened, minus a trailing colon.
 */
function skillOf(cell) {
  const named = cell.match(/'''\s*([\s\S]+?)\s*'''\s*:?\s*([\s\S]*)/);
  if (!named) {
    const text = plain(cell);
    return text ? { name: null, text } : null;
  }
  return { name: squash(named[1]).replace(/:$/, ''), text: plain(named[2]) };
}

// ---------------------------------------------------------------- skill types

/**
 * What a Tatari's skill actually does — Heal, Slow, Stun, ATK Boost and so on.
 *
 * The wiki tags these in the infobox with {{st|...}}, which files the page into
 * `Category:Skill Type: X`, so the categories are both the vocabulary and the
 * membership list. Far tidier than reading it out of prose.
 *
 * These describe the base skill. The Horde level-up skills bring their own
 * effects, which are only in their text.
 *
 * Each category page also carries a one-line definition of the effect — "The
 * Skills with ATK Boost effect can buff the ATK stat of the affected ally(s)"
 * — which is the only place the game's vocabulary is actually explained, so it
 * comes back too. Not every category has a page, and those simply have none.
 */
async function parseSkillTypes() {
  const cats = (await api({
    action: 'query', list: 'allcategories', acprefix: 'Skill Type', aclimit: 100,
  })).query.allcategories.map((c) => c.category);

  const byName = new Map();
  const describes = {};
  for (const cat of cats) {
    const type = cat.replace(/^Skill Type:\s*/, '');
    const members = (await api({
      action: 'query', list: 'categorymembers',
      cmtitle: `Category:${cat}`, cmlimit: 500, cmnamespace: 0,
    })).query.categorymembers;

    for (const m of members) {
      if (!byName.has(m.title)) byName.set(m.title, []);
      byName.get(m.title).push(type);
    }

    const blurb = await categoryBlurb(`Category:${cat}`);
    if (blurb) describes[type] = blurb;
  }
  for (const list of byName.values()) list.sort();
  return { byName, describes };
}

/**
 * The prose at the top of a category page, with the housekeeping stripped: the
 * {{stub}} marker, the parent category link, and any leftover templates.
 *
 * Redirects are followed — `Skill Type: DMG Boost` points at `Damage Boost`,
 * and both tags are in live use. Pages whose text is still a "known to TBA"
 * placeholder count as undescribed, because printing that in the app would be
 * worse than printing nothing.
 */
async function categoryBlurb(title) {
  const j = await api({
    action: 'query', titles: title, prop: 'revisions',
    rvprop: 'content', rvslots: 'main', redirects: 1,
  });
  const page = j.query.pages?.[0];
  const raw = page?.revisions?.[0]?.slots?.main?.content;
  if (!raw) return null;                       // no page written for this one yet

  const body = raw
    .replace(/\[\[Category:[^\]]*\]\]/gi, '')
    .replace(/\{\{[^}]*\}\}/g, '');
  const text = plain(body);
  if (!text || /\bTBA\b/i.test(text)) return null;
  return text;
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
async function resolveThumbs(files, width = THUMB_WIDTH) {
  const urls = new Map();
  const titles = [...new Set(files)];

  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const j = await api({
      action: 'query',
      titles: batch.map((f) => `File:${f}`).join('|'),
      prop: 'imageinfo',
      iiprop: 'url',
      iiurlwidth: String(width),
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

/**
 * Attack-range diagrams. These are in-game screenshots rather than schematics —
 * the Tatari stands at the bottom and the tiles it can hit are lit up — so they
 * are shown as pictures rather than turned into a grid overlay. Only about half
 * the roster has one on the wiki; the rest simply go without.
 *
 * They are also enormous at source, up to 1.4 MB each, hence the thumbnail
 * width. normalize_images.py re-encodes them to JPEG afterwards.
 */
async function fetchRangeImages(list) {
  const dir = path.join(ROOT, 'data/images/range');
  await mkdir(dir, { recursive: true });

  const wanted = list.map((t) => `${t.name} Attack Range.png`);
  const thumbs = await resolveThumbs(wanted, RANGE_WIDTH);

  let done = 0, missing = 0;
  const jobs = list.slice();
  const worker = async () => {
    while (jobs.length) {
      const t = jobs.shift();
      const url = thumbs.get(`${t.name} Attack Range.png`);
      if (!url) { missing++; continue; }
      // Downloaded as PNG, shipped as JPEG: normalize_images.py re-encodes them
      // and deletes the original, so the recorded path is the one that survives.
      const png = path.join(dir, `${t.slug}.png`);
      const jpg = path.join(dir, `${t.slug}.jpg`);
      try {
        const have = await stat(jpg).catch(() => null) || await stat(png).catch(() => null);
        if (!have || !have.size) await download(url, png);
        done++;
      } catch (err) {
        missing++;
        console.warn(`\n  ${t.name} range: ${err.message}`);
      }
      process.stdout.write(`\r  range diagrams ${done} ok, ${missing} without`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log();
}

/**
 * The in-game type and role icons, saved under slugged names so the app can
 * build a path straight from a Tatari's type/role. Redownloads every time —
 * there are only eleven and the wiki's art gets touched up now and then.
 */
async function fetchIcons() {
  const dir = path.join(ROOT, 'data/images/icons');
  await mkdir(dir, { recursive: true });

  const names = [...ELEMENTS, ...ROLES];
  const thumbs = await resolveThumbs(names.map((n) => `${n}.png`), ICON_WIDTH);

  let done = 0;
  const missing = [];
  for (const name of names) {
    const url = thumbs.get(`${name}.png`);
    if (!url) { missing.push(name); continue; }
    try {
      await download(url, path.join(dir, `${name.toLowerCase()}.png`));
      done++;
    } catch (err) {
      missing.push(name);
      console.warn(`\n  ${name}: ${err.message}`);
    }
  }
  console.log(`  icons: ${done}/${names.length}${missing.length ? `, missing ${missing.join(', ')}` : ''}`);
}

// ---------------------------------------------------------------- main

async function main() {
  const withImages = !process.argv.includes('--no-images');

  if (process.argv.includes('--icons-only')) {
    console.log('Downloading type/role icons...');
    await fetchIcons();
    return;
  }

  console.log('Fetching Tatari list...');
  const list = parseRoster(await wikitext('Tatari'));
  console.log(`  ${list.length} Tatari`);

  const families = groupFamilies(list);
  console.log(`  ${families} evolution families`);

  console.log('Fetching Horde Invasion skills...');
  const hordeSkills = await parseHordeSkills();
  let skilled = 0;
  for (const t of list) {
    t.hordeSkills = hordeSkills.get(t.family) ?? null;
    if (t.hordeSkills) skilled++;
  }
  console.log(`  ${hordeSkills.size} evolution lines documented, covering ${skilled}/${list.length} Tatari`);

  console.log('Fetching skill types...');
  const { byName: skillTypes, describes: skillTypeInfo } = await parseSkillTypes();
  let typed = 0;
  for (const t of list) {
    t.skillTypes = skillTypes.get(t.name) ?? [];
    if (t.skillTypes.length) typed++;
  }
  console.log(`  ${new Set([...skillTypes.values()].flat()).size} distinct types, on ${typed}/${list.length} Tatari`);
  console.log(`  ${Object.keys(skillTypeInfo).length} of them carry a description on the wiki`);

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
    console.log('Downloading type/role icons...');
    await fetchIcons();
    console.log('Downloading attack-range diagrams...');
    await fetchRangeImages(list);
  } else {
    // keep the paths so the app still works against an existing image folder
    for (const t of list) {
      if (t.sourceFile) t.image = `data/images/tatari/${t.slug}.png`;
      if (t.glitterSourceFile) t.glitterImage = `data/images/glitter/${t.slug}.png`;
    }
  }

  // Only about half the roster has a range diagram, and the set grows as the
  // wiki fills in — so the path is taken from what is actually on disk rather
  // than from what this run happened to fetch.
  let withRange = 0;
  for (const t of list) {
    const jpg = path.join(ROOT, 'data/images/range', `${t.slug}.jpg`);
    if (await stat(jpg).catch(() => null)) {
      t.rangeImage = `data/images/range/${t.slug}.jpg`;
      withRange++;
    }
  }
  console.log(`  attack-range diagrams on hand: ${withRange}/${list.length}`);

  const types = ELEMENTS.slice().sort();
  const roles = [...new Set(list.map((t) => t.role))].sort();

  const ordered = list.map((t) => ({
    name: t.name, slug: t.slug, type: t.type, role: t.role, tier: t.tier,
    family: t.family, familyId: t.familyId, stages: t.stages, rarity: t.rarity,
    evolutionLine: t.evolutionLine, battleRow: t.battleRow, previousRole: t.previousRole,
    etymology: t.etymology, skill: t.skill, description: t.description,
    hordeSkills: t.hordeSkills ?? null, rangeImage: t.rangeImage ?? null,
    skillTypes: t.skillTypes ?? [],
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
    /* What each skill type does, in the wiki's own words. Keyed by the same
       tag names that land in each Tatari's skillTypes. */
    skillTypeInfo,
    // Your half of the Horde field. Zobos spawn beyond row 0 and never stand here.
    hordeGrid: { columns: 6, rows: 6, maxDeployed: 15, maxLevel: 7 },
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
