'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { listProcesses } = require('./proc');

/**
 * Which agent CLIs are running right now, and in which directory.
 *
 * This is what separates "finished and waiting for you" from "the session is
 * over": if no `claude` process is sitting in a project, the transcript there
 * cannot be waiting on anything.
 */

const KINDS = [
  { kind: 'claude', test: (argv0) => /(^|\/)claude$/.test(argv0) },
  { kind: 'codex', test: (argv0) => /(^|\/)codex$/.test(argv0) },
];

function kindOf(proc) {
  const argv0 = proc.argv[0] || '';
  // node-launched CLIs show up as `node /path/to/claude`, so look at the script
  // argument too rather than only the interpreter.
  const candidates = [argv0, proc.argv[1] || ''];
  for (const { kind, test } of KINDS) {
    if (candidates.some((c) => c && test(c.split(' ')[0]))) return kind;
  }
  return null;
}

async function agentProcesses() {
  if (process.platform !== 'linux') return [];
  const procs = await listProcesses();
  const out = [];
  for (const proc of procs) {
    const kind = kindOf(proc);
    if (!kind) continue;
    let cwd = null;
    try {
      cwd = await fsp.readlink(`/proc/${proc.pid}/cwd`);
    } catch {
      /* the process exited, or belongs to another user */
    }
    out.push({ pid: proc.pid, kind, cwd });
  }
  return out;
}

/** Is one of `kind`'s processes working inside this directory? */
function hasProcessIn(processes, kind, dir) {
  if (!dir) return false;
  const target = path.resolve(dir);
  return processes.some((p) => p.kind === kind && p.cwd && path.resolve(p.cwd) === target);
}

module.exports = { agentProcesses, hasProcessIn, kindOf };
