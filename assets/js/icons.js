/**
 * The in-game icons for the five elemental types and six roles.
 *
 * These are the wiki's own art (Category:In-game_Icons), pulled by
 * tools/scrape-wiki.mjs into data/images/icons and squared off to a common
 * 64px box by tools/normalize_images.py. They arrive already badged — types
 * are ringed colour discs, roles are dark plates — so the wrappers here only
 * size and align them, they draw no background of their own.
 */

/** Filter order. Their colours live in app.css as --water, --fire and so on. */
export const TYPES = ['Water', 'Fire', 'Grass', 'Lightning', 'Rock'];
export const ROLES = ['DPS', 'Guardian', 'Tank', 'Healer', 'Support', 'Specialist'];

const ICON_DIR = 'data/images/icons';
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Not lazy: there are only eleven distinct files and the browser dedupes them
// to eleven requests however many cards are on screen, so deferring them just
// leaves holes in every badge while the roster paints.
function img(name, cls) {
  return `<img class="${cls}" src="${ICON_DIR}/${slug(name)}.png" alt=""` +
         ` width="64" height="64" decoding="async">`;
}

/** Icon for an elemental type. `badge: false` renders it a little larger. */
export function typeIcon(type, { badge = true } = {}) {
  if (!TYPES.includes(type)) return '';
  const glyph = img(type, 'icon__art');
  if (!badge) return `<span class="icon icon--type" data-type="${type}">${glyph}</span>`;
  return `<span class="badge badge--type" data-type="${type}" title="${type}">${glyph}</span>`;
}

/** Icon for a role. */
export function roleIcon(role, { badge = true } = {}) {
  if (!ROLES.includes(role)) return '';
  const glyph = img(role, 'icon__art');
  if (!badge) return `<span class="icon icon--role">${glyph}</span>`;
  return `<span class="badge badge--role" data-role="${role}" title="${role}">${glyph}</span>`;
}
