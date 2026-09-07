'use strict';

const path = require('path');

const { editorDataDir, firstExisting, HOME } = require('../lib/paths');
const { readItemTable } = require('../lib/vscdb');
const { getJson } = require('../lib/http');
const { usageWindow, providerResult } = require('../lib/shape');

const API = 'https://cursor.com';
const MIN_INTERVAL_MS = 120 * 1000;

const AUTH_KEYS = ['cursorAuth/accessToken', 'cursorAuth/cachedEmail', 'cursorAuth/stripeMembershipType'];

function stateDbPath() {
  return firstExisting([
    path.join(editorDataDir('Cursor'), 'User', 'globalStorage', 'state.vscdb'),
    path.join(HOME, '.cursor', 'User', 'globalStorage', 'state.vscdb'),
  ]);
}

/** JWT payloads carry the WorkOS subject we need to build the session cookie. */
function decodeJwt(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Cursor's web API authenticates with a cookie whose value is
 * `<workos user id>::<jwt>` — the same pair the desktop app holds locally.
 */
function sessionCookie(token) {
  const claims = decodeJwt(token) || {};
  const sub = String(claims.sub || '');
  const userId = sub.includes('|') ? sub.split('|').pop() : sub;
  if (!userId) return null;
  return { cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`, userId };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The usage-summary payload has changed shape more than once, so pull out
 * whichever of the known field groups is present instead of assuming one.
 */
function windowsFromSummary(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const windows = [];
  const resetsAt = payload.billingCycleEnd || payload.currentPeriodEnd || payload.nextResetTimestampUtc || null;

  const spendUsed = num(payload.usedCents ?? payload.tokenUsage?.totalCents ?? payload.spendCents);
  const spendLimit = num(payload.limitCents ?? payload.hardLimitCents ?? payload.spendLimitCents);
  if (spendUsed != null && spendLimit) {
    windows.push(
      usageWindow({
        key: 'included',
        label: 'Included usage',
        percent: (spendUsed / spendLimit) * 100,
        resetsAt,
        detail: `$${(spendUsed / 100).toFixed(2)} of $${(spendLimit / 100).toFixed(2)}`,
        used: spendUsed,
        limit: spendLimit,
      })
    );
  }

  const reqUsed = num(payload.numRequests ?? payload.requestsUsed);
  const reqLimit = num(payload.maxRequestUsage ?? payload.requestLimit);
  if (reqUsed != null && reqLimit) {
    windows.push(
      usageWindow({
        key: 'requests',
        label: 'Requests',
        percent: (reqUsed / reqLimit) * 100,
        resetsAt,
        detail: `${reqUsed} of ${reqLimit}`,
        used: reqUsed,
        limit: reqLimit,
      })
    );
  }

  return windows;
}

/** Legacy per-model request counters — still the most reliable endpoint. */
function windowsFromLegacyUsage(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const resetsAt = payload.startOfMonth ? addMonth(payload.startOfMonth) : null;
  const windows = [];
  for (const [model, stats] of Object.entries(payload)) {
    if (model === 'startOfMonth' || !stats || typeof stats !== 'object') continue;
    const used = num(stats.numRequests);
    const limit = num(stats.maxRequestUsage);
    if (used == null || !limit) continue;
    windows.push(
      usageWindow({
        key: model,
        label: model,
        percent: (used / limit) * 100,
        resetsAt,
        detail: `${used} of ${limit} requests`,
        used,
        limit,
      })
    );
  }
  return windows;
}

function addMonth(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

async function collect(ctx = {}) {
  const id = 'cursor';
  const label = 'Cursor';

  const manualCookie = ctx.settings && ctx.settings.cursorCookie;
  const dbPath = stateDbPath();

  if (!dbPath && !manualCookie) {
    return [
      providerResult({
        id,
        label,
        status: 'not-installed',
        detail: 'Cursor is not installed for this user (no state.vscdb found).',
      }),
    ];
  }

  let cookie = manualCookie ? `WorkosCursorSessionToken=${encodeURIComponent(manualCookie)}` : null;
  let userId = null;
  let plan = null;
  let email = null;

  if (!cookie) {
    let items;
    try {
      items = await readItemTable(dbPath, AUTH_KEYS);
    } catch (err) {
      return [providerResult({ id, label, status: 'error', detail: `Could not read Cursor state: ${err.message}` })];
    }
    const token = items['cursorAuth/accessToken'];
    email = items['cursorAuth/cachedEmail'] || null;
    plan = items['cursorAuth/stripeMembershipType'] || null;
    if (!token) {
      return [
        providerResult({
          id,
          label,
          status: 'unauthenticated',
          detail: 'Cursor is installed but not signed in on this machine.',
        }),
      ];
    }
    const built = sessionCookie(token);
    if (!built) {
      return [providerResult({ id, label, status: 'error', detail: 'Stored Cursor token is not in the expected format.' })];
    }
    cookie = built.cookie;
    userId = built.userId;
  }

  const headers = {
    Cookie: cookie,
    Accept: 'application/json',
    Origin: API,
    Referer: `${API}/dashboard`,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Sup',
  };

  const errors = [];

  try {
    const summary = await getJson(`${API}/api/usage-summary`, { headers });
    const windows = windowsFromSummary(summary);
    if (windows.length) {
      return [providerResult({ id, label, account: email, status: 'ok', plan, windows })];
    }
  } catch (err) {
    errors.push(err);
  }

  if (userId) {
    try {
      const legacy = await getJson(`${API}/api/usage?user=${encodeURIComponent(userId)}`, { headers });
      const windows = windowsFromLegacyUsage(legacy);
      if (windows.length) {
        return [providerResult({ id, label, account: email, status: 'ok', plan, windows })];
      }
    } catch (err) {
      errors.push(err);
    }
  }

  const first = errors[0];
  return [
    providerResult({
      id,
      label,
      account: email,
      status: 'error',
      plan,
      detail:
        first && first.status === 401
          ? 'Cursor session rejected — sign in again in Cursor.'
          : first
            ? first.message
            : 'Cursor returned no usage figures for this account.',
    }),
  ];
}

module.exports = {
  id: 'cursor',
  label: 'Cursor',
  minIntervalMs: MIN_INTERVAL_MS,
  collect,
  _internal: { decodeJwt, sessionCookie, windowsFromSummary, windowsFromLegacyUsage, stateDbPath },
};
