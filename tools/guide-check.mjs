/**
 * Checks docs/discord-guide.md before it is pasted into Discord: every message
 * fits Discord's 2,000 characters, and every picture it links is in the repo.
 *
 *   node tools/guide-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const md = readFileSync('docs/discord-guide.md', 'utf8');
const SITE = 'https://jeremycanlas.github.io/clash-of-critters-horde-planner/';
const messages = [...md.matchAll(/<!-- message -->\n([\s\S]*?)\n<!-- \/message -->/g)].map((m) => m[1]);
let bad = 0;
messages.forEach((m, i) => {
  const n = [...m].length;
  if (n > 2000) { bad++; console.log(`message ${i + 1}: ${n} characters, over 2,000`); }
  for (const [url] of m.matchAll(/https:\/\/\S+\.png/g)) {
    if (!existsSync(url.replace(SITE, ''))) { bad++; console.log(`message ${i + 1}: no such picture ${url}`); }
  }
  console.log(`message ${i + 1}: ${n} characters`);
});
if (!messages.length) { console.log('no messages found'); process.exit(1); }
process.exit(bad ? 1 : 0);
