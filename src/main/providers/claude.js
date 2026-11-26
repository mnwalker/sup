'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { claudeConfigDirs, readJson } = require('../lib/paths');
const { getJson } = require('../lib/http');
const { usageWindow, providerResult } = require('../lib/shape');
const { listSessions, groupByProject, summarise, pendingToolCall, pendingToolCalls } = require('../lib/sessions');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const FALLBACK_VERSION = '2.0.0';

// The endpoint buckets requests per access token and answers 429 to anything
// that does not look like Claude Code, so we never poll faster than this.
const MIN_INTERVAL_MS = 180 * 1000;

let cachedVersion = null;

/**
 * Claude Code sends `User-Agent: claude-code/<version>`. Anything else lands in
 * an aggressively rate limited bucket, so it is worth reporting the real
 * installed version when we can find one.
 */
async function claudeUserAgent() {
  if (process.env.SUP_CLAUDE_UA) return process.env.SUP_CLAUDE_UA;
  if (cachedVersion) return `claude-code/${cachedVersion}`;

  const version = await detectVersion();
  cachedVersion = version || FALLBACK_VERSION;
  return `claude-code/${cachedVersion}`;
}

function detectVersion() {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /(\d+\.\d+\.\d+)/.exec(String(stdout));
      resolve(m ? m[1] : null);
    });
  });
}

function credentialsFromBlob(raw, source) {
  const oauth = raw && (raw.claudeAiOauth || raw.claude_ai_oauth);
  if (!oauth || !oauth.accessToken) return null;
  return {
    accessToken: oauth.accessToken,
    expiresAt: oauth.expiresAt || null,
    subscriptionType: oauth.subscriptionType || null,
    source,
  };
}

/**
 * Claude Code on macOS keeps the same OAuth blob in the login keychain under
 * "Claude Code-credentials". A config dir picked with CLAUDE_CONFIG_DIR gets
 * its own item, suffixed with the first 8 hex chars of sha256(dir).
 */
function keychainServices(dir) {
  const defaultDir = path.join(os.homedir(), '.claude');
  const base = 'Claude Code-credentials';
  if (path.resolve(dir) === defaultDir) return [base];
  const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
  return [`${base}-${hash}`];
}

function readKeychain(service) {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(String(stdout).trim()));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function readCredentials(dir) {
  // Linux and Windows keep the OAuth blob on disk; macOS uses the keychain.
  const file = path.join(dir, '.credentials.json');
  const fromFile = credentialsFromBlob(readJson(file), file);
  if (fromFile || process.platform !== 'darwin') return fromFile;

  for (const service of keychainServices(dir)) {
    const creds = credentialsFromBlob(await readKeychain(service), `keychain:${service}`);
    if (creds) return creds;
  }
  return null;
}

function windowsFromUsage(payload) {
  const windows = [];
  const push = (key, label, node) => {
    if (!node || typeof node.utilization !== 'number') return;
    windows.push(usageWindow({ key, label, percent: node.utilization, resetsAt: node.resets_at }));
  };

  push('five_hour', 'Session (5h)', payload.five_hour);
  push('seven_day', 'Weekly (all models)', payload.seven_day);
  push('seven_day_opus', 'Weekly Opus', payload.seven_day_opus);
  push('seven_day_sonnet', 'Weekly Sonnet', payload.seven_day_sonnet);

  const extra = payload.extra_usage;
  if (extra && extra.is_enabled && typeof extra.utilization === 'number') {
    windows.push(
      usageWindow({
        key: 'extra_usage',
        label: 'Extra usage credits',
        percent: extra.utilization,
        used: extra.used_credits,
        limit: extra.monthly_limit,
      })
    );
  }

  return windows;
}

/**
 * Pull the state of one Claude Code transcript out of its records.
 *
 * Records carry `cwd` and `gitBranch` directly, which beats decoding them from
 * the encoded directory name, and assistant messages carry a `stop_reason` that
 * says plainly whether the turn ended or a tool is running.
 */
function parseClaudeSession(records) {
  let cwd = null;
  let branch = null;
  let lastStop = null;

  for (const rec of records) {
    if (rec.cwd) cwd = rec.cwd;
    if (rec.gitBranch) branch = rec.gitBranch;
    const msg = rec.message;
    if (msg && typeof msg === 'object' && msg.role === 'assistant' && msg.stop_reason) {
      lastStop = msg.stop_reason;
    }
  }

  const blocks = (rec) => {
    const content = rec.message && rec.message.content;
    return Array.isArray(content) ? content : [];
  };

  const hooks = {
    // A user record holding only tool_result blocks is the tail of the current
    // turn, not the start of a new one.
    isUserPrompt: (rec) =>
      rec.type === 'user' &&
      rec.message &&
      rec.message.role === 'user' &&
      !blocks(rec).some((b) => b && b.type === 'tool_result'),
    toolUsesOf: (rec) =>
      blocks(rec)
        .filter((b) => b && b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input })),
    toolResultsOf: (rec) =>
      blocks(rec)
        .filter((b) => b && b.type === 'tool_result' && b.tool_use_id)
        .map((b) => b.tool_use_id),
  };

  const unresolved = pendingToolCalls(records, hooks);

  return {
    cwd,
    branch,
    lastStop,
    pending: unresolved[0] || null,
    // Subagents run inside the parent transcript, so an unanswered Task call
    // is one agent still out there.
    agents: unresolved.filter((call) => call.background).length,
  };
}

async function collectOne({ dir, label }, ctx) {
  const account = label === 'default' ? null : label;
  const id = 'claude';
  const displayLabel = 'Claude Code';

  const sessions = groupByProject(
    await listSessions(path.join(dir, 'projects'), {
      parse: parseClaudeSession,
      kind: 'claude',
      processes: ctx.processes || [],
      processesKnown: Boolean(ctx.processesKnown),
      limit: 24,
    })
  );
  const session = summarise(sessions);
  const creds = await readCredentials(dir);
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const token = (creds && creds.accessToken) || envToken;

  if (!token) {
    return providerResult({
      id,
      label: displayLabel,
      account,
      status: 'unauthenticated',
      detail: `No OAuth token in ${process.platform === 'darwin' ? 'the keychain or ' : ''}${path.join(dir, '.credentials.json')} — run \`claude\` and sign in.`,
      session,
      sessions,
    });
  }

  if (creds && creds.expiresAt && creds.expiresAt < Date.now()) {
    // Refreshing here would race Claude Code for the credential file, so we
    // report the stale token instead of trying to rewrite it ourselves.
    return providerResult({
      id,
      label: displayLabel,
      account,
      status: 'unauthenticated',
      detail: 'Stored token has expired — start Claude Code once to refresh it.',
      plan: creds.subscriptionType,
      session,
      sessions,
    });
  }

  try {
    const payload = await getJson(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'User-Agent': await claudeUserAgent(),
        'Content-Type': 'application/json',
      },
    });

    return providerResult({
      id,
      label: displayLabel,
      account,
      status: 'ok',
      plan: creds && creds.subscriptionType,
      windows: windowsFromUsage(payload),
      session,
      sessions,
    });
  } catch (err) {
    const detail =
      err.status === 401
        ? 'Token rejected — start Claude Code once to refresh it.'
        : err.status === 429
          ? 'Rate limited by the usage endpoint; backing off.'
          : err.message;
    return providerResult({ id, label: displayLabel, account, status: 'error', detail, session, sessions });
  }
}

async function collect(ctx = {}) {
  const dirs = claudeConfigDirs();
  if (!dirs.length) {
    return [
      providerResult({
        id: 'claude',
        label: 'Claude Code',
        status: 'not-installed',
        detail: 'No ~/.claude directory found.',
      }),
    ];
  }
  return Promise.all(dirs.map((d) => collectOne(d, ctx)));
}

/**
 * A digest of every account's current token, so the poller can tell when the
 * signed-in account changes (switching accounts in Claude Code or its VS Code
 * extension rewrites the token) and refresh at once instead of showing the
 * previous account's windows for up to the full polling interval.
 */
async function fingerprint() {
  const tokens = await Promise.all(
    claudeConfigDirs().map(async ({ dir }) => {
      const creds = await readCredentials(dir);
      return `${dir}=${(creds && creds.accessToken) || ''}`;
    })
  );
  tokens.push(`env=${process.env.CLAUDE_CODE_OAUTH_TOKEN || ''}`);
  return crypto.createHash('sha256').update(tokens.join('\n')).digest('hex');
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  minIntervalMs: MIN_INTERVAL_MS,
  collect,
  fingerprint,
  // exported for tests
  _internal: { windowsFromUsage, parseClaudeSession, readCredentials },
};
