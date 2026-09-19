/**
 * Cozy Farm reward calculator: a score in, what it has paid out, what comes
 * next, and what a target would add. The sums live in farm-math.js; this only
 * reads the boxes and prints.
 */

import { applyPrefs } from './prefs.js';
import { buildAnalytics, trackOnce } from './analytics.js';
import { $, esc } from './ui.js';
import { parseScore, earned, nextTier, gain } from './farm-math.js';

applyPrefs();
buildAnalytics();

const farm = await (await fetch('data/farm.json')).json();
const ORDER = Object.keys(farm.items);
const num = (n) => n.toLocaleString('en-US');

/* Ordered by the items list so the grid never reshuffles between scores. */
function prizesHTML(prizes) {
  const rows = ORDER.filter((k) => prizes[k]);
  if (!rows.length) return '<p class="muted">Nothing yet.</p>';
  return `<ul class="farm__prizes">${rows.map((k) => `
    <li class="farm__prize">
      <img src="data/images/farm/${k}.png" alt="" width="48" height="48">
      <span class="farm__count">${num(prizes[k])}</span>
      <span class="farm__name">${esc(farm.items[k])}</span>
    </li>`).join('')}</ul>`;
}

/* The game's own shorthand (246K, 1136K) keeps a row of the full list on one line. */
const short = (n) => (n >= 1000 ? `${n / 1000}K` : String(n));

function chipsHTML(prizes) {
  return ORDER.filter((k) => prizes[k]).map((k) => `
    <span class="farm__chip" title="${esc(farm.items[k])}">
      <img src="data/images/farm/${k}.png" alt="${esc(farm.items[k])}" width="32" height="32" loading="lazy">${short(prizes[k])}
    </span>`).join('');
}

/* Built once; render() only moves the reached/next marks. */
$('#farm-all').innerHTML = farm.tiers.map(([at, prizes]) => `
  <li class="farm__tier" data-at="${at}">
    <span class="farm__reach">Reach ${num(at)}</span>
    <span class="farm__chips">${chipsHTML(prizes)}</span>
  </li>`).join('') + `
  <li class="farm__tier farm__tier--bonus">
    <span class="farm__reach">Every ${num(farm.overflow.every)} after that</span>
    <span class="farm__chips">${chipsHTML(farm.overflow.bonus)}</span>
  </li>`;

function markTiers(score, nextAt) {
  for (const li of document.querySelectorAll('#farm-all [data-at]')) {
    const at = Number(li.dataset.at);
    li.classList.toggle('is-reached', score >= at);
    li.classList.toggle('is-next', at === nextAt);
  }
  // Wide layout only (the list scrolls on its own there): bring the next tier into view.
  const box = $('.farm__right');
  const next = $('#farm-all .is-next');
  if (next && box.scrollHeight > box.clientHeight) {
    box.scrollTop = next.offsetTop - box.offsetTop - box.clientHeight / 3;
  }
}

function render() {
  const score = parseScore($('#farm-score').value) ?? 0;
  const target = parseScore($('#farm-target').value);

  const next = nextTier(farm, score);
  $('#farm-next-head').textContent = `Next tier: ${num(next.at)} (${num(next.at - score)} to go)`;
  $('#farm-next').innerHTML = prizesHTML(next.prizes);
  markTiers(score, next.at);

  const tiers = farm.tiers.filter(([at]) => score >= at).length;
  $('#farm-earned-head').textContent = `Earned so far: ${tiers} of ${farm.tiers.length} tiers`;
  $('#farm-earned').innerHTML = prizesHTML(earned(farm, score));

  const showGain = target !== null && target > score;
  $('#farm-gain-panel').hidden = !showGain;
  if (showGain) {
    $('#farm-gain-head').textContent = `Reaching ${num(target)} adds`;
    $('#farm-gain').innerHTML = prizesHTML(gain(farm, score, target));
  }

  // Keep the link shareable: ?score=354&target=1.2m
  const q = new URLSearchParams();
  if ($('#farm-score').value.trim()) q.set('score', $('#farm-score').value.trim());
  if ($('#farm-target').value.trim()) q.set('target', $('#farm-target').value.trim());
  history.replaceState(null, '', q.size ? `?${q}` : location.pathname);
}

const params = new URLSearchParams(location.search);
$('#farm-score').value = params.get('score') ?? '';
$('#farm-target').value = params.get('target') ?? '';
$('#farm-score').addEventListener('input', render);
$('#farm-target').addEventListener('input', render);
// Once a visit, and on change rather than every keystroke: a visitor who typed a
// score used the calculator, one who only looked did not. A shared link with
// ?score= already filled counts as a look.
$('#farm-score').addEventListener('change', () => trackOnce('farm-score-entered'));
$('#farm-target').addEventListener('change', () => trackOnce('farm-target-set'));
render();
