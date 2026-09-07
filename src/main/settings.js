'use strict';

const fs = require('fs');
const path = require('path');
const { appConfigDir } = require('./lib/paths');

const FILE = path.join(appConfigDir(), 'settings.json');

const DEFAULTS = {
  /** Which screen edge the tab hangs off: top | bottom | left | right. */
  edge: 'right',
  /** 'primary', 'cursor', or a zero-based display index. */
  display: 'primary',
  /** Pixels along the edge, away from centre. Negative moves left/up. */
  offset: 0,

  collapsedWidth: 190,
  collapsedHeight: 28,
  expandedWidth: 400,
  expandedHeight: 420,

  /** How often to refresh. Providers enforce their own sensible floor. */
  pollIntervalMs: 180000,

  enabled: {
    claude: true,
    codex: true,
    cursor: true,
    antigravity: true,
  },

  /** Set false if you have no compositor and the tab renders as a black box. */
  transparent: true,
  /** Keep the tab out of the way until you point at the edge. */
  peekOnly: false,
  /** X11 window type hint. 'toolbar' behaves best on most WMs. */
  windowType: 'toolbar',
  /** Optional manual Cursor session cookie (`<userId>::<jwt>`). */
  cursorCookie: null,
  /** Warn at these utilisation percentages. */
  warnAt: 75,
  dangerAt: 90,
};

let cache = null;

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    /* first run, or hand-edited into invalid JSON — fall back to defaults */
  }
  cache = { ...DEFAULTS, ...stored, enabled: { ...DEFAULTS.enabled, ...(stored.enabled || {}) } };
  return cache;
}

function save(patch) {
  const next = { ...load(), ...patch };
  if (patch && patch.enabled) next.enabled = { ...load().enabled, ...patch.enabled };
  cache = next;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

module.exports = { load, save, DEFAULTS, FILE };
