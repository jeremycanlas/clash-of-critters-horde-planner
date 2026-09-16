/**
 * Anonymous usage counts.
 *
 * GoatCounter, because it sets no cookies and stores no personal data. Only the
 * fixed labels below are ever sent — never a formation, never the name someone
 * signs a card with, never a share link. Those would leak what people are
 * planning, which is none of the tool's business.
 *
 * It only runs on the published site. A clone, a fork or a local server counts
 * nothing, so nobody else's traffic lands in this dashboard and nobody has to
 * strip anything out before running their own copy.
 */

const ENDPOINT = 'https://jacc.goatcounter.com/count';
const PUBLISHED_HOST = 'jeremycanlas.github.io';

let live = false;

/**
 * Labels counted before the script finished loading.
 *
 * count.js is async, so for the first moment of a page `window.goatcounter` is
 * undefined and every count against it is dropped. That is the moment several
 * of these fire in: the drafter counts `used` the instant it restores a
 * formation somebody already had, and the patch notes count which tab a link
 * opened on before anything has been clicked. Both were being counted into
 * nothing, and a counter that silently loses its earliest events is worse than
 * one that is simply absent, because the number it does report looks whole.
 *
 * Capped, because the script may never arrive at all -- an ad blocker eating it
 * is expected -- and an unbounded list of labels nobody will ever send is a
 * leak. Twenty is far more than any one page fires before load.
 */
const pending = [];
const PENDING_MAX = 20;

const send = (label) => {
  try {
    window.goatcounter?.count?.({ path: label, title: label, event: true });
  } catch { /* never let a counter break the app */ }
};

export function buildAnalytics() {
  if (location.hostname !== PUBLISHED_HOST) return;

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://gc.zgo.at/count.js';
  script.dataset.goatcounter = ENDPOINT;
  script.addEventListener('load', () => {
    while (pending.length) send(pending.shift());
  });
  document.head.append(script);
  live = true;
}

/**
 * Counts one labelled action. Does nothing off the published site, and nothing
 * when the script is blocked — an ad blocker eating it is fine, and expected.
 *
 * Anything counted before the script lands is held and sent when it does.
 */
export function track(label) {
  if (!live) return;
  if (window.goatcounter?.count) send(label);
  else if (pending.length < PENDING_MAX) pending.push(label);
}
