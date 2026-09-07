'use strict';

const fs = require('fs');
const path = require('path');
const { tailJsonl, findJsonlFiles } = require('./jsonl');
const { hasProcessIn } = require('./processes');

/**
 * One row per open session, not one per tool.
 *
 * None of the CLIs publish a status file, so each session's state is inferred
 * from two things: the transcript it is already writing, and whether a process
 * of that CLI is still sitting in the project directory. The second half is
 * what tells "finished, your turn" apart from "that session is over".
 */

const DEFAULT_THRESHOLDS = {
  activeMs: 90 * 1000, // written to this recently => mid-turn
  recentMs: 30 * 60 * 1000, // ended this recently => worth still showing
  staleMs: 4 * 60 * 60 * 1000, // idle this long => stop calling it waiting
};

const STATES = {
  active: { label: 'active', rank: 2 },
  agents: { label: 'waiting on agents', rank: 1 },
  input: { label: 'waiting for you', rank: 0 },
  stopped: { label: 'recently stopped', rank: 3 },
  inactive: { label: 'inactive', rank: 4 },
};

/** Tools that hand work off and then block on it. */
const BACKGROUND_TOOLS = new Set(['Task', 'Agent']);
/** Tools that exist purely to ask the human something. */
const PROMPT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function classifyTool(name, input) {
  if (!name) return {};
  if (BACKGROUND_TOOLS.has(name)) return { background: true };
  if (PROMPT_TOOLS.has(name)) return { prompt: true };
  // A backgrounded shell command is the same kind of wait as a subagent.
  if (input && input.run_in_background) return { background: true };
  return {};
}

/**
 * `alive` is deliberately optimistic when we cannot enumerate processes (we
 * only can on Linux): better to fall back to the transcript than to report
 * every session as stopped.
 *
 * "Waiting for you" means the session actually asked something. It is NOT the
 * same as the turn having ended — every finished turn ends the same way, so
 * treating that as a question labels every idle session as needing attention,
 * which is worse than useless. A finished turn is just a stopped session.
 */
function deriveState({ ageMs, pending, alive, thresholds = DEFAULT_THRESHOLDS }) {
  const { activeMs, recentMs } = thresholds;

  if (!alive) return ageMs <= recentMs ? 'stopped' : 'inactive';
  if (pending && pending.background) return 'agents';
  if (pending && pending.prompt) return 'input';
  if (ageMs <= activeMs) return 'active';
  if (pending) return 'active'; // mid-turn on something slow
  return ageMs <= recentMs ? 'stopped' : 'inactive';
}

/**
 * Parsed transcripts, keyed by file and the mtime they were parsed at. Most
 * sessions do not change between polls, so re-reading and re-parsing every
 * transcript each time is pure waste.
 */
const parseCache = new Map();

function cachedParse(file, mtimeMs, records, parse) {
  const hit = parseCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.info;
  const info = parse(records) || {};
  parseCache.set(file, { mtimeMs, info });
  return info;
}

async function listSessions(rootDir, opts = {}) {
  const {
    parse,
    kind,
    processes = [],
    processesKnown = false,
    limit = 12,
    maxAgeMs = 24 * 60 * 60 * 1000,
    thresholds = DEFAULT_THRESHOLDS,
  } = opts;

  if (!rootDir || !fs.existsSync(rootDir)) return [];

  const files = await findJsonlFiles(rootDir, { limit: limit * 4 });
  const now = Date.now();
  const fresh = files.filter((f) => now - f.mtimeMs <= maxAgeMs && f.size > 0);

  const seen = new Set();
  const sessions = [];
  for (const { file, mtimeMs } of fresh.slice(0, limit)) {
    seen.add(file);

    const cached = parseCache.get(file);
    let info;
    if (cached && cached.mtimeMs === mtimeMs) {
      info = cached.info;
    } else {
      const records = await tailJsonl(file, 32 * 1024);
      if (!records.length) continue;
      info = cachedParse(file, mtimeMs, records, parse);
    }
    const ageMs = now - mtimeMs;
    const alive = processesKnown ? hasProcessIn(processes, kind, info.cwd) : ageMs <= thresholds.staleMs;

    const state = deriveState({ ageMs, pending: info.pending, alive, thresholds });

    sessions.push({
      id: path.basename(file, '.jsonl'),
      project: info.cwd ? path.basename(info.cwd) : null,
      cwd: info.cwd || null,
      branch: info.branch || null,
      state,
      stateLabel: STATES[state].label,
      waitingOn: info.pending ? info.pending.name : null,
      lastActivity: new Date(mtimeMs).toISOString(),
      ageMs,
    });
  }

  // Drop cache entries for transcripts that aged out, so this cannot grow
  // without bound over a long-running day.
  for (const key of parseCache.keys()) {
    if (!seen.has(key) && key.startsWith(rootDir)) parseCache.delete(key);
  }

  sessions.sort((a, b) => STATES[a.state].rank - STATES[b.state].rank || a.ageMs - b.ageMs);
  return sessions.slice(0, limit);
}

/** The one session the collapsed tab should speak for. */
function summarise(sessions) {
  if (!sessions.length) return { state: 'unknown', since: null, project: null };
  const top = sessions[0];
  return {
    state: top.state,
    since: top.lastActivity,
    project: top.project,
    waitingOn: top.waitingOn,
    counts: sessions.reduce((acc, s) => {
      acc[s.state] = (acc[s.state] || 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * The last tool call of the current turn that has no result yet. Only the
 * current turn is considered, because our tail window may start after an older
 * call's result and we would wrongly call it pending.
 */
function pendingToolCall(records, { isUserPrompt, toolUsesOf, toolResultsOf }) {
  const resolved = new Set();
  const candidates = [];

  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i];
    for (const id of toolResultsOf(rec)) resolved.add(id);
    for (const use of toolUsesOf(rec)) candidates.push(use);
    if (isUserPrompt(rec)) break; // start of the current turn
  }

  for (const use of candidates) {
    if (!resolved.has(use.id)) return { ...use, ...classifyTool(use.name, use.input) };
  }
  return null;
}

module.exports = {
  listSessions,
  summarise,
  deriveState,
  pendingToolCall,
  classifyTool,
  STATES,
  DEFAULT_THRESHOLDS,
};
