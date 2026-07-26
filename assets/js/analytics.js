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

export function buildAnalytics() {
  if (location.hostname !== PUBLISHED_HOST) return;

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://gc.zgo.at/count.js';
  script.dataset.goatcounter = ENDPOINT;
  document.head.append(script);
  live = true;
}

/**
 * Counts one labelled action. Does nothing off the published site, and nothing
 * when the script is blocked — an ad blocker eating it is fine, and expected.
 */
export function track(label) {
  if (!live) return;
  try {
    window.goatcounter?.count?.({ path: label, title: label, event: true });
  } catch { /* never let a counter break the app */ }
}
