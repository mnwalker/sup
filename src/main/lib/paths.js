'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();

function xdg(envVar, fallback) {
  const v = process.env[envVar];
  if (v && path.isAbsolute(v)) return v;
  return path.join(HOME, ...fallback);
}

const configHome = () => xdg('XDG_CONFIG_HOME', ['.config']);
const dataHome = () => xdg('XDG_DATA_HOME', ['.local', 'share']);
const cacheHome = () => xdg('XDG_CACHE_HOME', ['.cache']);

/** Our own settings live under the XDG config dir (or %APPDATA% on Windows). */
function appConfigDir() {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(appdata, 'Sup');
  }
  return path.join(configHome(), 'sup');
}

/**
 * Roaming-app data dir for a third party editor (Cursor, Antigravity, ...).
 * These are Electron apps, so they use the same layout everywhere.
 */
function editorDataDir(name) {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(appdata, name);
  }
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', name);
  }
  return path.join(configHome(), name);
}

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** First readable path from the list, or null. */
function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && exists(c)) return c;
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Claude Code config directories.
 *
 * Claude Code honours CLAUDE_CONFIG_DIR; people running a second (work/personal)
 * account conventionally point it at ~/.claude-<slug>, so we pick those up too
 * and treat each as its own account.
 */
function claudeConfigDirs() {
  const dirs = [];
  const seen = new Set();
  const add = (dir, label) => {
    if (!dir || seen.has(dir) || !exists(dir)) return;
    seen.add(dir);
    dirs.push({ dir, label });
  };

  const envDirs = (process.env.CLAUDE_CONFIG_DIR || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const d of envDirs) add(path.resolve(d), path.basename(d).replace(/^\.claude-?/, '') || 'env');

  add(path.join(HOME, '.claude'), 'default');

  try {
    for (const entry of fs.readdirSync(HOME, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = /^\.claude-(.+)$/.exec(entry.name);
      if (m) add(path.join(HOME, entry.name), m[1]);
    }
  } catch {
    /* unreadable home, nothing to do */
  }

  return dirs;
}

function codexHome() {
  const env = process.env.CODEX_HOME;
  if (env && path.isAbsolute(env)) return env;
  return firstExisting([path.join(HOME, '.codex'), path.join(configHome(), 'codex')]) || path.join(HOME, '.codex');
}

module.exports = {
  HOME,
  configHome,
  dataHome,
  cacheHome,
  appConfigDir,
  editorDataDir,
  exists,
  firstExisting,
  readJson,
  claudeConfigDirs,
  codexHome,
};
