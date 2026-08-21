/**
 * The two settings that describe the reader rather than the formation.
 *
 * Everything else the toolbar offers — Sandbox, Zobo ground, the pulls — is part
 * of the plan, so it lives in the formation, rides the share link and travels to
 * whoever opens it. These two are the opposite of that. Which theme you want and
 * whether you can tell Fire from Rock are facts about you and your screen, so
 * they live in localStorage: on every visit, on every page, and on nobody else's.
 *
 * A share link carrying them would be actively wrong. It would impose one
 * player's eyesight on everyone who opened the link.
 *
 * Both are written to <html> rather than <body>, because card.js reads the
 * palette off document.documentElement when it draws the shareable card. A
 * body-scoped flag would be invisible to it, and the card would come out in the
 * colours the reader had just said they could not use.
 */

const THEME_KEY = 'coc.theme';
const CONTRAST_KEY = 'coc.contrast';
const PLAYER_CONTRAST_KEY = 'coc.player-contrast';

/** 'system' is the absence of a choice, and is not stored. */
export const THEMES = ['system', 'light', 'dark'];

const read = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }   // private mode
};
const write = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode: the setting still applies, it just will not last */ }
};

// ---------------------------------------------------------------- theme

export function theme() {
  const stored = read(THEME_KEY);
  return THEMES.includes(stored) ? stored : 'system';
}

/**
 * 'system' clears the attribute rather than setting one.
 *
 * The stylesheet answers the system case in a media query, so the way to follow
 * the system is to say nothing and let it. Storing 'system' explicitly would
 * also work, but leaving the key absent means a browser that has never been told
 * anything and one that has been told to follow along are the same state, which
 * is one fewer thing to keep consistent.
 */
export function setTheme(next) {
  const value = THEMES.includes(next) ? next : 'system';
  write(THEME_KEY, value === 'system' ? null : value);
  applyTheme();
  return value;
}

function applyTheme() {
  const chosen = theme();
  if (chosen === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = chosen;
}

// ---------------------------------------------------------------- contrast

/**
 * Stored answer first, the operating system's second.
 *
 * Someone who has turned on Increase Contrast at the OS level has already
 * answered this question once, and asking again in a checkbox they have to find
 * is asking twice. But an explicit answer here has to win in both directions —
 * including turning it off on a machine whose system setting says otherwise —
 * so the stored value is consulted before the media query, not merged with it.
 */
export function contrast() {
  const stored = read(CONTRAST_KEY);
  if (stored === null) return matchMedia('(prefers-contrast: more)').matches;
  return stored === '1';
}

export function setContrast(on) {
  write(CONTRAST_KEY, on ? '1' : '0');
  applyContrast();
  return on;
}

function applyContrast() {
  if (contrast()) document.documentElement.dataset.contrast = 'more';
  else delete document.documentElement.dataset.contrast;
}

// ------------------------------------------------------- player contrast

/**
 * The player-outline half of contrast, on its own switch.
 *
 * Only the P1/P2 pair, none of the element palette or letters. It exists to test
 * that half in isolation, so unlike contrast() it has no system-setting fallback
 * -- there is no OS toggle for "my two teammates' outlines look alike" -- and
 * defaults off until someone turns it on. High contrast already includes this,
 * so the two can be on together and the stylesheet treats it as a superset.
 */
export function playerContrast() {
  return read(PLAYER_CONTRAST_KEY) === '1';
}

export function setPlayerContrast(on) {
  write(PLAYER_CONTRAST_KEY, on ? '1' : '0');
  applyPlayerContrast();
  return on;
}

function applyPlayerContrast() {
  if (playerContrast()) document.documentElement.dataset.playerContrast = 'more';
  else delete document.documentElement.dataset.playerContrast;
}

// ---------------------------------------------------------------- boot

/**
 * Called by every page's entry module, first thing.
 *
 * The controls only exist on index.html, but the settings apply everywhere: a
 * reader who has chosen dark and then follows the Community link should not be
 * handed a white page because that page has no switch on it.
 */
export function applyPrefs() {
  applyTheme();
  applyContrast();
  applyPlayerContrast();
}
