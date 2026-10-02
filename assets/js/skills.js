/**
 * The Skill data page. Its content is static HTML written by
 * tools/skills-page.mjs; this only filters it, by name or skill and by type.
 * The cards stay in the page for search engines either way.
 */
import { applyPrefs } from './prefs.js';
import { buildAnalytics, trackOnce } from './analytics.js';
import { $, $$ } from './ui.js';

applyPrefs();
buildAnalytics();

let type = '';
let onlyNumbers = false;
const find = $('#sk-find');

function filter() {
  const q = find.value.trim().toLowerCase();
  let shown = 0;
  for (const line of $$('#sk-list > .sk__line')) {
    const keep = (!type || line.dataset.type === type) && (!onlyNumbers || 'numbers' in line.dataset);
    // A horde skill matching keeps the whole line: it belongs to all of it.
    const lineHit = keep && !!q && line.querySelector('.sk__horde')?.textContent.toLowerCase().includes(q);
    let cards = 0;
    for (const el of $$('.sk', line)) {
      // The name, or anything written on the card: a skill, an effect, a number.
      const hit = keep && (!q || lineHit || el.dataset.name.includes(q) || el.textContent.toLowerCase().includes(q));
      el.hidden = !hit;
      if (hit) cards++;
    }
    line.hidden = !cards;
    shown += cards;
  }
  $('#sk-none').hidden = shown > 0;
  if (q) trackOnce('skills-searched');
}

find.addEventListener('input', filter);
$('#sk-types').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  type = b.dataset.type;
  for (const x of $$('#sk-types [data-type]')) x.setAttribute('aria-pressed', String(x === b));
  filter();
  trackOnce('skills-filtered');
});
$('#sk-numbers').addEventListener('click', (e) => {
  onlyNumbers = !onlyNumbers;
  e.currentTarget.setAttribute('aria-pressed', String(onlyNumbers));
  filter();
  trackOnce('skills-numbers-only');
});

// Arriving at skills.html#cribking opens on that card: the link a guide gives.
// On a hash change too, for a second link followed on the same page.
const target = () => {
  for (const el of $$('.sk.is-target')) el.classList.remove('is-target');
  if (location.hash) document.getElementById(location.hash.slice(1))?.classList.add('is-target');
};
target();
addEventListener('hashchange', target);
