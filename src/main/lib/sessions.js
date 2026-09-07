'use strict';

const fs = require('fs');
const path = require('path');
const { tailJsonl, findJsonlFiles } = require('./jsonl');

const WORKING_WINDOW_MS = 90 * 1000; // touched this recently => the agent is mid-turn
const IDLE_AFTER_MS = 20 * 60 * 1000; // nothing for this long => not an open session

/**
 * Work out whether an agent is busy, waiting for the human, or idle, by looking
 * at the transcript files the CLIs already write. Purely a heuristic: the CLIs
 * do not publish a status file, so we infer it from what was appended last.
 */
async function detectSession(rootDir, classify) {
  if (!rootDir || !fs.existsSync(rootDir)) return { state: 'unknown', since: null, project: null };

  const files = await findJsonlFiles(rootDir, { limit: 8 });
  if (!files.length) return { state: 'idle', since: null, project: null };

  const newest = files[0];
  const age = Date.now() - newest.mtimeMs;
  const project = projectNameFor(newest.file, rootDir);

  if (age > IDLE_AFTER_MS) {
    return { state: 'idle', since: new Date(newest.mtimeMs).toISOString(), project };
  }

  const records = await tailJsonl(newest.file, 128 * 1024);
  const verdict = classify(records) || 'unknown';

  // Even if the last record looks like a finished answer, a file being written
  // to right now means the agent is still going.
  const state = age < WORKING_WINDOW_MS && verdict === 'waiting' ? 'working' : verdict;

  return { state, since: new Date(newest.mtimeMs).toISOString(), project };
}

/**
 * Claude Code encodes the project cwd into the directory name
 * (~/.claude/projects/-home-me-code-myapp/<session>.jsonl).
 */
function projectNameFor(file, rootDir) {
  const rel = path.relative(rootDir, file);
  const first = rel.split(path.sep)[0];
  if (!first || first === rel) return null;
  const decoded = first.replace(/^-/, '').replace(/-/g, '/');
  return path.basename(decoded) || decoded;
}

module.exports = { detectSession, projectNameFor, WORKING_WINDOW_MS, IDLE_AFTER_MS };
