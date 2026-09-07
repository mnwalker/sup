'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const claude = require('../src/main/providers/claude')._internal;
const codex = require('../src/main/providers/codex')._internal;
const cursor = require('../src/main/providers/cursor')._internal;
const antigravity = require('../src/main/providers/antigravity')._internal;
const placement = require('../src/main/placement');
const { worstWindow } = require('../src/main/lib/shape');

test('claude: maps the oauth usage payload to windows', () => {
  const windows = claude.windowsFromUsage({
    five_hour: { utilization: 33, resets_at: '2026-04-11T07:00:00.528743+00:00' },
    seven_day: { utilization: 13, resets_at: '2026-04-17T00:59:59.951713+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 1, resets_at: '2026-04-16T03:00:00.951719+00:00' },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  });

  assert.deepEqual(
    windows.map((w) => w.key),
    ['five_hour', 'seven_day', 'seven_day_sonnet']
  );
  assert.equal(windows[0].percent, 33);
  assert.equal(windows[0].resetsAt, '2026-04-11T07:00:00.528Z');
});

test('claude: includes extra usage credits only when enabled', () => {
  const windows = claude.windowsFromUsage({
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25 },
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].percent, 25);
  assert.equal(windows[0].limit, 5000);
});

test('claude: a trailing tool_use means it is still working', () => {
  const working = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use' }] } }];
  const waiting = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }];
  assert.equal(claude.classifyClaudeRecords(working), 'working');
  assert.equal(claude.classifyClaudeRecords(waiting), 'waiting');
  assert.equal(claude.classifyClaudeRecords([]), 'unknown');
});

test('codex: finds rate limits wherever they are nested', () => {
  const record = {
    timestamp: '2026-09-06T10:00:00Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 3600 },
        secondary: { used_percent: 8, window_minutes: 10080, resets_in_seconds: 200000 },
      },
    },
  };

  const rl = codex.findRateLimits(record);
  assert.ok(rl);
  const windows = codex.windowsFromRateLimits(rl, Date.parse(record.timestamp));
  assert.equal(windows.length, 2);
  assert.equal(windows[0].label, 'Session (5h)');
  assert.equal(windows[1].label, 'Weekly');
  assert.equal(windows[0].resetsAt, '2026-09-06T11:00:00.000Z');
});

test('codex: null rate limits are not mistaken for data', () => {
  assert.equal(codex.findRateLimits({ payload: { type: 'token_count', rate_limits: null } }), null);
});

test('codex: classifies the last transcript event', () => {
  assert.equal(codex.classifyCodexRecords([{ payload: { type: 'agent_message' } }]), 'waiting');
  assert.equal(codex.classifyCodexRecords([{ payload: { type: 'exec_command_begin' } }]), 'working');
});

test('cursor: builds the session cookie from the stored jwt', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'auth0|user_ABC123' })).toString('base64url');
  const built = cursor.sessionCookie(`header.${payload}.sig`);
  assert.equal(built.userId, 'user_ABC123');
  assert.match(built.cookie, /^WorkosCursorSessionToken=user_ABC123%3A%3A/);
});

test('cursor: rejects a token without a subject', () => {
  assert.equal(cursor.sessionCookie('not.a.jwt'), null);
});

test('cursor: legacy request counters become a percentage', () => {
  const windows = cursor.windowsFromLegacyUsage({
    'gpt-4': { numRequests: 120, maxRequestUsage: 500 },
    'gpt-3.5-turbo': { numRequests: 5, maxRequestUsage: null },
    startOfMonth: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].percent, 24);
  assert.equal(windows[0].resetsAt, '2026-10-01T00:00:00.000Z');
});

test('antigravity: reads the csrf token off the command line', () => {
  assert.equal(antigravity.csrfFromArgv(['ls', '--csrf_token=abc']), 'abc');
  assert.equal(antigravity.csrfFromArgv(['ls', '--csrf_token', 'def']), 'def');
  assert.equal(antigravity.csrfFromArgv(['ls']), null);
});

test('antigravity: only matches its own language server', () => {
  assert.equal(
    antigravity.isAntigravityLanguageServer({ cmdline: '/opt/antigravity/language_server --app_data_dir antigravity' }),
    true
  );
  assert.equal(antigravity.isAntigravityLanguageServer({ cmdline: '/usr/bin/pyright-langserver' }), false);
});

test('antigravity: pulls per-model quota out of an unfamiliar tree', () => {
  const windows = antigravity.dedupe(
    antigravity.windowsFromQuota({
      userQuota: {
        modelQuotas: [
          { modelName: 'gemini-3-pro', used: 12, limit: 100, resetTime: '2026-09-07T00:00:00Z' },
          { modelName: 'claude-opus-4-5', usedPercent: 80 },
        ],
      },
    })
  );
  const byName = Object.fromEntries(windows.map((w) => [w.key, w.percent]));
  assert.equal(byName['gemini-3-pro'], 12);
  assert.equal(byName['claude-opus-4-5'], 80);
});

test('antigravity: fractional utilisation is scaled to a percentage', () => {
  const [w] = antigravity.windowsFromQuota({ name: 'gemini', utilization: 0.42 });
  assert.equal(w.percent, 42);
});

test('placement: the tab centres on the chosen edge', () => {
  const config = {
    edge: 'top',
    offset: 0,
    collapsedWidth: 190,
    collapsedHeight: 28,
    expandedWidth: 400,
    expandedHeight: 420,
  };
  const area = { x: 0, y: 0, width: 1920, height: 1080 };

  assert.deepEqual(placement.boundsFor(config, area, placement.collapsedSize(config)), {
    x: 865,
    y: 0,
    width: 190,
    height: 28,
  });

  // Expanding keeps the same edge and centre line.
  const expanded = placement.boundsFor(config, area, placement.expandedSize(config));
  assert.equal(expanded.y, 0);
  assert.equal(expanded.x + expanded.width / 2, 960);
});

test('placement: side edges run the tab vertically and hug the far edge', () => {
  const config = {
    edge: 'right',
    offset: 0,
    collapsedWidth: 190,
    collapsedHeight: 28,
    expandedWidth: 400,
    expandedHeight: 420,
  };
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const bounds = placement.boundsFor(config, area, placement.collapsedSize(config));
  assert.deepEqual(bounds, { x: 1892, y: 445, width: 28, height: 190 });

  // Opening keeps the tab pinned to the same edge; only the panel is added.
  const expanded = placement.boundsFor(config, area, placement.expandedSize(config));
  assert.equal(expanded.x + expanded.width, 1920);
  assert.equal(expanded.height, 420);
});

test('placement: an offset past the edge is clamped back on screen', () => {
  const config = {
    edge: 'top',
    offset: 5000,
    collapsedWidth: 190,
    collapsedHeight: 28,
    expandedWidth: 400,
    expandedHeight: 420,
  };
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const bounds = placement.boundsFor(config, area, placement.collapsedSize(config));
  assert.equal(bounds.x, 1920 - 190);
});

test('shape: the fullest window is the one the tab shows', () => {
  const worst = worstWindow([
    { key: 'a', percent: 12 },
    { key: 'b', percent: 91 },
    { key: 'c', percent: null },
  ]);
  assert.equal(worst.key, 'b');
  assert.equal(worstWindow([{ key: 'a', percent: null }]), null);
});
