/**
 * Inline SVG icons for the five elemental types and six roles.
 *
 * These are drawn here rather than pulled from the wiki so they stay crisp at
 * any size, follow the page theme, and add no extra requests. Type colours are
 * eyeballed from the in-game badges.
 */

export const TYPE_COLORS = {
  Water: '#37a7e6',
  Fire: '#e8453c',
  Grass: '#57c14a',
  Lightning: '#f2be16',
  Rock: '#a2762f',
};

const TYPE_PATHS = {
  // droplet
  Water: '<path d="M12 2.6c3.6 4.3 6.4 7.7 6.4 11.1A6.4 6.4 0 0 1 12 20.2a6.4 6.4 0 0 1-6.4-6.5c0-3.4 2.8-6.8 6.4-11.1Z"/>',
  // flame
  Fire: '<path d="M12.6 2.2c.3 2.6-.9 3.9-2.3 5.4-1.6 1.7-3.5 3.6-3.5 6.7A5.9 5.9 0 0 0 12.7 21a5.6 5.6 0 0 0 5.5-5.8c0-2.4-1-3.7-1.9-5-.3 1-1 1.7-1.8 1.9.6-2.9-.3-6.9-1.9-9.9Z"/>',
  // leaf
  Grass: '<path d="M20.3 3.4C11.6 2.6 5.3 6.4 5.3 12.6c0 1.7.5 3.2 1.4 4.4L4 19.7a1.1 1.1 0 0 0 1.6 1.6l2.7-2.7c1.2.9 2.7 1.4 4.4 1.4 6.2 0 10-6.3 9.2-15a1 1 0 0 0-1.6-1.6Zm-2.9 4.2-7 7a1 1 0 0 0 1.4 1.4l7-7c-.3 3.9-2.4 7-6.1 7-3.4 0-5.4-2-5.4-5.4 0-3.7 3.1-5.8 7-6.1Z"/>',
  // bolt
  Lightning: '<path d="M13.9 2 5.6 12.7a.8.8 0 0 0 .6 1.3h4l-1.4 7.3a.5.5 0 0 0 .9.4l8.5-10.9a.8.8 0 0 0-.6-1.3h-4l1.2-7a.5.5 0 0 0-.9-.5Z"/>',
  // stacked stones
  Rock: '<path d="M11.4 3.2 7.2 6.5a1 1 0 0 0-.3 1.1l1 3.1a1 1 0 0 0 1 .7h6.2a1 1 0 0 0 1-.7l1-3.1a1 1 0 0 0-.3-1.1l-4.2-3.3a1 1 0 0 0-1.2 0ZM4.6 13.6a1 1 0 0 0-.9.7l-1 3.7a1 1 0 0 0 1 1.3h16.6a1 1 0 0 0 1-1.3l-1-3.7a1 1 0 0 0-1-.7Z"/>',
};

const ROLE_PATHS = {
  // crossed swords
  DPS: '<path d="M14.1 3h5a.9.9 0 0 1 .9.9v5L13.4 15.5 7.6 9.7ZM6.2 11.1l6.7 6.7-1.5 1.5-1.1-1.1-2.4 2.4a1.6 1.6 0 0 1-2.3-2.3l2.4-2.4-1.2-1.2Z"/>',
  // shield
  Guardian: '<path d="M12 2.2 4.5 5v6.4c0 4.4 3.1 8.5 7.5 10.4 4.4-1.9 7.5-6 7.5-10.4V5Zm0 2.3 5.3 2v5c0 3.2-2.1 6.3-5.3 8-3.2-1.7-5.3-4.8-5.3-8v-5Z"/>',
  // brick wall
  Tank: '<path d="M3 4.6h7.2v4.2H3Zm8.7 0H21v4.2h-9.3ZM3 10.3h4.4v3.4H3Zm5.9 0h6.2v3.4H8.9Zm7.7 0H21v3.4h-4.4ZM3 15.2h9.3v4.2H3Zm10.8 0H21v4.2h-7.2Z"/>',
  // cross
  Healer: '<path d="M9.6 2.6h4.8a1 1 0 0 1 1 1v5h5a1 1 0 0 1 1 1v4.8a1 1 0 0 1-1 1h-5v5a1 1 0 0 1-1 1H9.6a1 1 0 0 1-1-1v-5h-5a1 1 0 0 1-1-1V9.6a1 1 0 0 1 1-1h5v-5a1 1 0 0 1 1-1Z"/>',
  // hourglass
  Support: '<path d="M6 2.4h12a1 1 0 0 1 0 2h-.6v1.7c0 2-1 3.9-2.7 5l-1.4.9 1.4.9c1.7 1.1 2.7 3 2.7 5v1.7h.6a1 1 0 0 1 0 2H6a1 1 0 0 1 0-2h.6v-1.7c0-2 1-3.9 2.7-5l1.4-.9-1.4-.9c-1.7-1.1-2.7-3-2.7-5V4.4H6a1 1 0 0 1 0-2Z"/>',
  // faceted gem
  Specialist: '<path d="M12 2.2 2.9 9.1 12 21.8 21.1 9.1Zm0 3.1 4.7 3.6-4.7 6.6-4.7-6.6Z"/>',
};

function svg(inner, extra = '') {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" ${extra}>${inner}</svg>`;
}

/** Icon for an elemental type, wrapped in its coloured badge. */
export function typeIcon(type, { badge = true } = {}) {
  const path = TYPE_PATHS[type];
  if (!path) return '';
  const glyph = svg(path);
  if (!badge) return `<span class="icon icon--type" data-type="${type}">${glyph}</span>`;
  return `<span class="badge badge--type" data-type="${type}" title="${type}">${glyph}</span>`;
}

/** Icon for a role, wrapped in a neutral badge. */
export function roleIcon(role, { badge = true } = {}) {
  const path = ROLE_PATHS[role];
  if (!path) return '';
  const glyph = svg(path);
  if (!badge) return `<span class="icon icon--role">${glyph}</span>`;
  return `<span class="badge badge--role" data-role="${role}" title="${role}">${glyph}</span>`;
}

export const TYPES = Object.keys(TYPE_COLORS);
export const ROLES = Object.keys(ROLE_PATHS);
