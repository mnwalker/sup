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

/**
 * Matching only argv[0] misses the common case: installed from npm, these CLIs
 * run as `node .../@anthropic-ai/claude-code/cli.js`, where nothing is called
 * "claude" at all. So check the whole command line for either the executable
 * name or the package path.
 */
const KINDS = [
  {
    kind: 'claude',
    exe: /(^|\/)claude$/,
    path: /(@anthropic-ai\/claude-code|claude-code\/cli\.js|\/\.claude\/local\/)/,
  },
  {
    kind: 'codex',
    exe: /(^|\/)codex(-cli)?$/,
    path: /(@openai\/codex|codex-cli\/|\/\.codex\/bin\/)/,
  },
];

function kindOf(proc) {
  const argv = proc.argv || [];
  for (const { kind, exe, path: pathRe } of KINDS) {
    if (argv.some((arg) => arg && exe.test(arg.split(' ')[0]))) return kind;
    if (argv.some((arg) => arg && pathRe.test(arg))) return kind;
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
