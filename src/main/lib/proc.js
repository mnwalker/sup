'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Linux-only process inspection used to find a locally running language server.
 * Everything here degrades to an empty result on other platforms rather than
 * throwing, so callers can just report "not detected".
 */

async function listProcesses() {
  if (process.platform !== 'linux') return [];
  let entries;
  try {
    entries = await fsp.readdir('/proc');
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = await fsp.readFile(path.join('/proc', entry, 'cmdline'));
      if (!raw.length) continue;
      const argv = raw.toString('utf8').split('\0').filter(Boolean);
      out.push({ pid: Number(entry), argv, cmdline: argv.join(' ') });
    } catch {
      /* process exited, or not ours to read */
    }
  }
  return out;
}

/** Socket inodes owned by a pid, via /proc/<pid>/fd symlinks. */
async function socketInodes(pid) {
  const inodes = new Set();
  let fds;
  try {
    fds = await fsp.readdir(`/proc/${pid}/fd`);
  } catch {
    return inodes;
  }
  for (const fd of fds) {
    try {
      const link = await fsp.readlink(`/proc/${pid}/fd/${fd}`);
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m) inodes.add(m[1]);
    } catch {
      /* fd closed between readdir and readlink */
    }
  }
  return inodes;
}

const TCP_LISTEN = '0A';

/** Parse /proc/net/tcp{,6} and return listening sockets as {port, inode}. */
async function listeningSockets() {
  const results = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      if (cols[3] !== TCP_LISTEN) continue;
      const port = parseInt(cols[1].split(':')[1], 16);
      if (!Number.isFinite(port)) continue;
      results.push({ port, inode: cols[9] });
    }
  }
  return results;
}

/** Ports a given pid is listening on. */
async function listeningPortsForPid(pid) {
  const [inodes, sockets] = await Promise.all([socketInodes(pid), listeningSockets()]);
  const ports = new Set();
  for (const s of sockets) {
    if (inodes.has(s.inode)) ports.add(s.port);
  }
  return [...ports];
}

module.exports = { listProcesses, listeningPortsForPid, socketInodes, listeningSockets };
