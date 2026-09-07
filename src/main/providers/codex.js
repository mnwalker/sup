'use strict';

const fs = require('fs');
const path = require('path');

const { codexHome, readJson, exists } = require('../lib/paths');
const { getJson } = require('../lib/http');
const { usageWindow, providerResult } = require('../lib/shape');
const { listSessions, summarise } = require('../lib/sessions');
const { tailJsonl, findJsonlFiles } = require('../lib/jsonl');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const MIN_INTERVAL_MS = 60 * 1000;

function readAuth(home) {
  const candidates = [
    path.join(home, 'auth.json'),
    path.join(require('os').homedir(), '.config', 'codex', 'auth.json'),
  ];
  for (const file of candidates) {
    const raw = readJson(file);
    const token = raw && ((raw.tokens && raw.tokens.access_token) || raw.access_token);
    if (token) return { token, accountId: raw.tokens && raw.tokens.account_id, source: file };
  }
  return null;
}

/**
 * Rollout logs nest the rate-limit block differently between Codex releases, so
 * rather than hard-coding a path we walk the record and take the first object
 * that looks like a rate-limit snapshot.
 */
function findRateLimits(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (node.rate_limits && typeof node.rate_limits === 'object') {
    const rl = node.rate_limits;
    if (rl.primary || rl.secondary || rl.primary_window || rl.secondary_window) return rl;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = findRateLimits(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** `{used_percent, window_minutes, resets_in_seconds}` -> our window shape. */
function windowFromLane(key, lane, observedAt) {
  if (!lane || typeof lane !== 'object') return null;
  const percent = lane.used_percent != null ? lane.used_percent : lane.usedPercent;
  if (percent == null) return null;

  const minutes = lane.window_minutes != null ? lane.window_minutes : lane.windowMinutes;
  const resetsIn = lane.resets_in_seconds != null ? lane.resets_in_seconds : lane.resetsInSeconds;
  const resetsAt = resetsIn != null ? new Date(observedAt + resetsIn * 1000) : null;

  return usageWindow({
    key,
    label: describeWindow(key, minutes),
    percent,
    resetsAt,
  });
}

function describeWindow(key, minutes) {
  if (!minutes) return key === 'primary' ? 'Session' : 'Weekly';
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 7 ? 'Weekly' : `${days}-day window`;
  }
  if (minutes % 60 === 0) return `Session (${minutes / 60}h)`;
  return `${minutes}m window`;
}

function windowsFromRateLimits(rl, observedAt) {
  const primary = rl.primary || rl.primary_window;
  const secondary = rl.secondary || rl.secondary_window;
  const out = [windowFromLane('primary', primary, observedAt), windowFromLane('secondary', secondary, observedAt)];
  for (const extra of rl.additional_rate_limits || []) {
    const w = windowFromLane(extra.name || 'additional', extra, observedAt);
    if (w) out.push(w);
  }
  return out.filter(Boolean);
}

/** Newest rate-limit snapshot across the recent rollout files. */
async function latestRateLimitsFromLogs(home) {
  const roots = [path.join(home, 'sessions'), path.join(home, 'archived_sessions')].filter(exists);
  if (!roots.length) return null;

  const files = [];
  for (const root of roots) files.push(...(await findJsonlFiles(root, { limit: 12 })));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { file, mtimeMs } of files.slice(0, 6)) {
    const records = await tailJsonl(file, 512 * 1024);
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const rl = findRateLimits(records[i]);
      if (!rl) continue;
      const ts = Date.parse(records[i].timestamp || '') || mtimeMs;
      const windows = windowsFromRateLimits(rl, ts);
      if (windows.length) return { windows, observedAt: ts, file };
    }
  }
  return null;
}

function windowsFromLiveUsage(payload) {
  const rl = findRateLimits(payload) || payload;
  const windows = windowsFromRateLimits(rl, Date.now());
  return windows;
}

/** Payload types that mean the model is mid-turn rather than done. */
const CODEX_WORKING = new Set([
  'user_message',
  'agent_reasoning',
  'exec_command_begin',
  'exec_command_end',
  'patch_apply_begin',
  'task_started',
]);
const CODEX_DONE = new Set(['agent_message', 'task_complete', 'turn_complete']);

/**
 * Codex rollouts carry the working directory in their opening meta record,
 * which is the only reliable project name: the files themselves live under
 * sessions/YYYY/MM/DD, so the path says nothing about the project.
 */
function parseCodexSession(records) {
  let cwd = null;
  let lastStop = null;
  let pending = null;

  for (const rec of records) {
    const payload = rec.payload || rec;
    if (rec.cwd) cwd = rec.cwd;
    if (payload && payload.cwd) cwd = payload.cwd;

    const type = payload && payload.type;
    if (!type) continue;

    if (type === 'exec_command_begin') pending = { id: payload.call_id, name: 'shell command' };
    if (type === 'exec_command_end' && pending && pending.id === payload.call_id) pending = null;

    if (CODEX_DONE.has(type)) lastStop = 'end_turn';
    else if (CODEX_WORKING.has(type)) lastStop = 'tool_use';
  }

  return { cwd, lastStop, pending };
}

async function collect(ctx = {}) {
  const home = codexHome();
  const id = 'codex';
  const label = 'Codex';

  if (!fs.existsSync(home)) {
    return [providerResult({ id, label, status: 'not-installed', detail: `No ${home} directory found.` })];
  }

  const sessions = await listSessions(path.join(home, 'sessions'), {
    parse: parseCodexSession,
    kind: 'codex',
    processes: ctx.processes || [],
    processesKnown: Boolean(ctx.processesKnown),
  });
  const session = summarise(sessions);
  const auth = readAuth(home);

  // Prefer the live account endpoint; rollout logs only tell us what the limits
  // were the last time Codex actually ran.
  if (auth) {
    try {
      const payload = await getJson(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'codex-cli',
        },
      });
      const windows = windowsFromLiveUsage(payload);
      if (windows.length) {
        return [providerResult({ id, label, status: 'ok', windows, session, sessions })];
      }
    } catch {
      /* fall through to the local logs */
    }
  }

  const fromLogs = await latestRateLimitsFromLogs(home);
  if (fromLogs) {
    return [
      providerResult({
        id,
        label,
        status: 'ok',
        detail: `From session logs, last seen ${new Date(fromLogs.observedAt).toISOString()}`,
        windows: fromLogs.windows,
        session,
        sessions,
      }),
    ];
  }

  return [
    providerResult({
      id,
      label,
      status: auth ? 'error' : 'unauthenticated',
      detail: auth
        ? 'Signed in, but no rate-limit data yet — run a Codex turn and it will appear.'
        : `No credentials in ${path.join(home, 'auth.json')} — run \`codex login\`.`,
      session,
      sessions,
    }),
  ];
}

module.exports = {
  id: 'codex',
  label: 'Codex',
  minIntervalMs: MIN_INTERVAL_MS,
  collect,
  _internal: { findRateLimits, windowsFromRateLimits, parseCodexSession, describeWindow },
};
