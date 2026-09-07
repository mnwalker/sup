'use strict';

const path = require('path');
const fs = require('fs');

const { listProcesses, listeningPortsForPid } = require('../lib/proc');
const { postJson } = require('../lib/http');
const { usageWindow, providerResult } = require('../lib/shape');
const { editorDataDir, exists } = require('../lib/paths');

const MIN_INTERVAL_MS = 300 * 1000; // the IDE caches quota for ~5 minutes anyway
const SERVICE = 'exa.language_server_pb.LanguageServerService';

let cachedEndpoint = null; // { port, csrf, pid }

/**
 * Antigravity has no on-disk usage file: the numbers live in the language
 * server the IDE launches. We find that process, read the CSRF token off its
 * command line, and ask it the same question the IDE's own UI asks.
 */
function isAntigravityLanguageServer(proc) {
  const cmd = proc.cmdline.toLowerCase();
  if (!/language_server/.test(cmd)) return false;
  return /antigravity/.test(cmd) || /app_data_dir[= ]\S*antigravity/.test(cmd);
}

function csrfFromArgv(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const m = /^--?csrf[_-]?token=(.+)$/i.exec(arg);
    if (m) return m[1];
    if (/^--?csrf[_-]?token$/i.test(arg) && argv[i + 1]) return argv[i + 1];
  }
  return null;
}

async function discoverEndpoint() {
  const procs = await listProcesses();
  const server = procs.find(isAntigravityLanguageServer);
  if (!server) return null;

  const csrf = csrfFromArgv(server.argv);
  const ports = await listeningPortsForPid(server.pid);
  if (!ports.length) return null;

  for (const port of ports) {
    if (await probe(port, csrf)) return { port, csrf, pid: server.pid };
  }
  return null;
}

async function probe(port, csrf) {
  try {
    await callRpc(port, csrf, 'GetUnleashData');
    return true;
  } catch (err) {
    // A 4xx still proves something is speaking Connect on this port.
    return Boolean(err.status && err.status >= 400 && err.status < 500);
  }
}

function callRpc(port, csrf, method, body = {}) {
  const headers = { 'Connect-Protocol-Version': '1' };
  if (csrf) headers['X-Codeium-Csrf-Token'] = csrf;
  return postJson(`https://127.0.0.1:${port}/${SERVICE}/${method}`, body, {
    headers,
    insecure: true, // the language server serves a self-signed cert on loopback
    timeoutMs: 6000,
  });
}

const RESET_KEYS = ['resetTime', 'reset_time', 'resetsAt', 'resets_at', 'nextResetTime', 'refreshTime'];
const USED_KEYS = ['used', 'usedCount', 'used_count', 'consumed', 'usage'];
const LIMIT_KEYS = ['limit', 'total', 'quota', 'maxCount', 'max_count', 'allowance'];
const PERCENT_KEYS = ['percentUsed', 'percent_used', 'usedPercent', 'used_percent', 'utilization'];

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
  }
  return null;
}

function toEpoch(value) {
  if (value == null) return null;
  if (typeof value === 'number') return new Date(value > 1e12 ? value : value * 1000);
  if (typeof value === 'string') {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 1e9) return new Date(asNum > 1e12 ? asNum : asNum * 1000);
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'object' && value.seconds != null) return new Date(Number(value.seconds) * 1000);
  return null;
}

/**
 * The quota payload is a proto-JSON tree whose exact shape moves between
 * Antigravity releases, so collect every node that carries a used/limit or
 * percentage pair rather than following a fixed path.
 */
function windowsFromQuota(payload, depth = 0, name = null, out = []) {
  if (!payload || typeof payload !== 'object' || depth > 6) return out;

  if (Array.isArray(payload)) {
    for (const item of payload) windowsFromQuota(item, depth + 1, name, out);
    return out;
  }

  const label = payload.modelName || payload.model || payload.name || payload.displayName || name;
  const percent = pick(payload, PERCENT_KEYS);
  const used = pick(payload, USED_KEYS);
  const limit = pick(payload, LIMIT_KEYS);
  const resetsAt = toEpoch(pick(payload, RESET_KEYS));

  let value = null;
  if (typeof percent === 'number') {
    value = percent <= 1 ? percent * 100 : percent;
  } else if (Number(used) >= 0 && Number(limit) > 0) {
    value = (Number(used) / Number(limit)) * 100;
  }

  if (value != null && label) {
    out.push(
      usageWindow({
        key: String(label),
        label: String(label),
        percent: value,
        resetsAt,
        detail: Number(limit) > 0 ? `${Number(used)} of ${Number(limit)}` : null,
        used: used == null ? null : Number(used),
        limit: limit == null ? null : Number(limit),
      })
    );
  }

  for (const [key, child] of Object.entries(payload)) {
    if (child && typeof child === 'object') windowsFromQuota(child, depth + 1, label || key, out);
  }
  return out;
}

function dedupe(windows) {
  const seen = new Map();
  for (const w of windows) {
    const existing = seen.get(w.key);
    if (!existing || (existing.percent ?? -1) < (w.percent ?? -1)) seen.set(w.key, w);
  }
  return [...seen.values()].slice(0, 8);
}

function installed() {
  return exists(editorDataDir('Antigravity')) || exists(path.join(require('os').homedir(), '.antigravity'));
}

async function collect() {
  const id = 'antigravity';
  const label = 'Antigravity';

  if (process.platform !== 'linux' && process.platform !== 'win32') {
    return [providerResult({ id, label, status: 'error', detail: 'Unsupported platform.' })];
  }

  let endpoint = cachedEndpoint;
  if (endpoint) {
    // Make sure the cached process is still alive before reusing its port.
    if (!fs.existsSync(`/proc/${endpoint.pid}`) && process.platform === 'linux') endpoint = cachedEndpoint = null;
  }
  if (!endpoint) {
    endpoint = cachedEndpoint = await discoverEndpoint();
  }

  if (!endpoint) {
    return [
      providerResult({
        id,
        label,
        status: installed() ? 'unauthenticated' : 'not-installed',
        detail: installed()
          ? 'Antigravity is installed but not running — quota is only readable while the IDE is open.'
          : 'Antigravity does not appear to be installed.',
      }),
    ];
  }

  for (const method of ['RetrieveUserQuotaSummary', 'GetUserStatus']) {
    try {
      const payload = await callRpc(endpoint.port, endpoint.csrf, method);
      const windows = dedupe(windowsFromQuota(payload));
      if (windows.length) {
        return [providerResult({ id, label, status: 'ok', windows })];
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        cachedEndpoint = null;
        return [
          providerResult({
            id,
            label,
            status: 'error',
            detail: 'Language server rejected the request (CSRF token not found on its command line).',
          }),
        ];
      }
    }
  }

  cachedEndpoint = null;
  return [
    providerResult({
      id,
      label,
      status: 'error',
      detail: 'Reached the Antigravity language server but could not read a quota from its reply. Run `npm run probe antigravity` to dump the payload.',
    }),
  ];
}

module.exports = {
  id: 'antigravity',
  label: 'Antigravity',
  minIntervalMs: MIN_INTERVAL_MS,
  collect,
  _internal: { isAntigravityLanguageServer, csrfFromArgv, windowsFromQuota, dedupe, toEpoch, callRpc, discoverEndpoint },
};
