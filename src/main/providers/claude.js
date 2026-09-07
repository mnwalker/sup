'use strict';

const path = require('path');
const { execFile } = require('child_process');

const { claudeConfigDirs, readJson } = require('../lib/paths');
const { getJson } = require('../lib/http');
const { usageWindow, providerResult } = require('../lib/shape');
const { detectSession } = require('../lib/sessions');

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

function readCredentials(dir) {
  // Linux and Windows keep the OAuth blob on disk; macOS uses the keychain,
  // which we cannot reach from here (and do not need to on this platform).
  const file = path.join(dir, '.credentials.json');
  const raw = readJson(file);
  const oauth = raw && (raw.claudeAiOauth || raw.claude_ai_oauth);
  if (!oauth || !oauth.accessToken) return null;
  return {
    accessToken: oauth.accessToken,
    expiresAt: oauth.expiresAt || null,
    subscriptionType: oauth.subscriptionType || null,
    source: file,
  };
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

/** Last transcript record tells us whether Claude is mid-turn or waiting on us. */
function classifyClaudeRecords(records) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i];
    const type = rec.type || (rec.message && rec.message.role);
    if (type === 'user' || (rec.message && rec.message.role === 'user')) {
      // A user turn was just appended (or a tool result came back): Claude is up.
      return 'working';
    }
    if (type === 'assistant' || (rec.message && rec.message.role === 'assistant')) {
      const content = (rec.message && rec.message.content) || [];
      const blocks = Array.isArray(content) ? content : [];
      const hasToolUse = blocks.some((b) => b && b.type === 'tool_use');
      return hasToolUse ? 'working' : 'waiting';
    }
  }
  return 'unknown';
}

async function collectOne({ dir, label }) {
  const account = label === 'default' ? null : label;
  const id = 'claude';
  const displayLabel = 'Claude Code';

  const session = await detectSession(path.join(dir, 'projects'), classifyClaudeRecords);
  const creds = readCredentials(dir);
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const token = (creds && creds.accessToken) || envToken;

  if (!token) {
    return providerResult({
      id,
      label: displayLabel,
      account,
      status: 'unauthenticated',
      detail: `No OAuth token in ${path.join(dir, '.credentials.json')} — run \`claude\` and sign in.`,
      session,
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
    });
  } catch (err) {
    const detail =
      err.status === 401
        ? 'Token rejected — start Claude Code once to refresh it.'
        : err.status === 429
          ? 'Rate limited by the usage endpoint; backing off.'
          : err.message;
    return providerResult({ id, label: displayLabel, account, status: 'error', detail, session });
  }
}

async function collect() {
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
  return Promise.all(dirs.map(collectOne));
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  minIntervalMs: MIN_INTERVAL_MS,
  collect,
  // exported for tests
  _internal: { windowsFromUsage, classifyClaudeRecords, readCredentials },
};
