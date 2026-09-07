'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const claude = require('../src/main/providers/claude')._internal;
const codex = require('../src/main/providers/codex')._internal;
const cursor = require('../src/main/providers/cursor')._internal;
const antigravity = require('../src/main/providers/antigravity')._internal;
const placement = require('../src/main/placement');
const { worstWindow } = require('../src/main/lib/shape');
const { deriveState, groupByProject } = require('../src/main/lib/sessions');
const { kindOf } = require('../src/main/lib/processes');

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

test('claude: reads cwd, branch and stop_reason off the transcript', () => {
  const info = claude.parseClaudeSession([
    { type: 'user', cwd: '/home/me/code/shop', gitBranch: 'main', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
  ]);
  assert.equal(info.cwd, '/home/me/code/shop');
  assert.equal(info.branch, 'main');
  assert.equal(info.lastStop, 'end_turn');
  assert.equal(info.pending, null);
});

test('claude: an unanswered tool call is pending, an answered one is not', () => {
  const use = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } };
  const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } };

  assert.equal(claude.parseClaudeSession([use]).pending.name, 'Bash');
  assert.equal(claude.parseClaudeSession([use, result]).pending, null);
});

test('claude: only the current turn counts as pending', () => {
  // An older call whose result fell outside the tail window must not look live.
  const old = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Read' }] } };
  const prompt = { type: 'user', message: { role: 'user', content: 'next thing please' } };
  const done = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } };

  assert.equal(claude.parseClaudeSession([old, prompt, done]).pending, null);
});

test('claude: a Task call is a background agent, not ordinary work', () => {
  const task = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Task' }] } };
  assert.equal(claude.parseClaudeSession([task]).pending.background, true);

  const bg = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { run_in_background: true } }] } };
  assert.equal(claude.parseClaudeSession([bg]).pending.background, true);
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

test('codex: takes the project from the rollout, not the dated path', () => {
  const info = codex.parseCodexSession([
    { timestamp: 't', payload: { type: 'session_meta', cwd: '/home/me/code/infra' } },
    { timestamp: 't', payload: { type: 'agent_message' } },
  ]);
  assert.equal(info.cwd, '/home/me/code/infra');
  assert.equal(info.lastStop, 'end_turn');
});

test('codex: an unfinished shell command is pending', () => {
  const begin = { payload: { type: 'exec_command_begin', call_id: 'c1' } };
  const end = { payload: { type: 'exec_command_end', call_id: 'c1' } };
  assert.ok(codex.parseCodexSession([begin]).pending);
  assert.equal(codex.parseCodexSession([begin, end]).pending, null);
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

test('session state: a dead process means stopped, then inactive', () => {
  const base = { pending: null, lastStop: 'end_turn', alive: false };
  assert.equal(deriveState({ ...base, ageMs: 5 * 60 * 1000 }), 'stopped');
  assert.equal(deriveState({ ...base, ageMs: 5 * 60 * 60 * 1000 }), 'inactive');
});

test('session state: a live session is placed by what it is waiting on', () => {
  const live = { alive: true, ageMs: 10 * 60 * 1000 };
  assert.equal(deriveState({ ...live, pending: { name: 'Task', background: true } }), 'agents');
  assert.equal(deriveState({ ...live, pending: { name: 'AskUserQuestion', prompt: true } }), 'input');
  assert.equal(deriveState({ ...live, pending: { name: 'Bash' } }), 'active');
});

test('session state: a finished turn is stopped, never "waiting for you"', () => {
  // Every completed turn ends the same way, so treating that as a question
  // would label every idle session as needing attention.
  const finished = { alive: true, pending: null, lastStop: 'end_turn' };
  assert.equal(deriveState({ ...finished, ageMs: 10 * 60 * 1000 }), 'stopped');
  assert.equal(deriveState({ ...finished, ageMs: 3 * 60 * 60 * 1000 }), 'inactive');
});

test('session state: only an explicit ask counts as waiting for you', () => {
  const live = { alive: true, ageMs: 10 * 60 * 1000 };
  for (const name of ['Bash', 'Edit', 'Read', 'WebFetch']) {
    assert.notEqual(deriveState({ ...live, pending: { name } }), 'input', `${name} must not read as a question`);
  }
  assert.equal(deriveState({ ...live, pending: { name: 'ExitPlanMode', prompt: true } }), 'input');
});

test('session state: a fresh write beats everything else', () => {
  assert.equal(deriveState({ ageMs: 1000, pending: null, lastStop: 'end_turn', alive: true }), 'active');
});

test('session state: a long-idle live session stops claiming to wait', () => {
  const old = { ageMs: 6 * 60 * 60 * 1000, pending: null, alive: true };
  assert.equal(deriveState(old), 'inactive');
});

const sess = (cwd, state, ageMs, extra = {}) => ({
  id: `${cwd}-${ageMs}`,
  cwd,
  project: cwd.split('/').pop(),
  branch: 'main',
  state,
  ageMs,
  lastActivity: new Date(Date.now() - ageMs).toISOString(),
  agents: 0,
  ...extra,
});

test('grouping: many transcripts for one project become one row', () => {
  // Every `claude` run in a directory writes its own transcript, so a project
  // worked on all day would otherwise fill the list with identical rows.
  const rows = groupByProject([
    sess('/code/rentals', 'inactive', 9e6),
    sess('/code/rentals', 'active', 1000),
    sess('/code/rentals', 'stopped', 5e5),
    sess('/code/shop', 'stopped', 6e5),
  ]);

  assert.equal(rows.length, 2);
  const rentals = rows.find((r) => r.project === 'rentals');
  assert.equal(rentals.sessionCount, 3);
  // The state that most wants attention wins, and the freshest time is kept.
  assert.equal(rentals.state, 'active');
  assert.equal(rentals.ageMs, 1000);
});

test('grouping: outstanding agents are summed across a project', () => {
  const [row] = groupByProject([
    sess('/code/rentals', 'agents', 2000, { agents: 2, waitingOn: 'Task' }),
    sess('/code/rentals', 'active', 3000, { agents: 1 }),
  ]);
  assert.equal(row.agents, 3);
  assert.equal(row.state, 'agents');
});

test('grouping: the most urgent project sorts first', () => {
  const rows = groupByProject([
    sess('/code/a', 'inactive', 9e6),
    sess('/code/b', 'active', 1000),
    sess('/code/c', 'input', 5e5),
  ]);
  assert.deepEqual(
    rows.map((r) => r.project),
    ['c', 'b', 'a']
  );
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

test('processes: recognises the agent CLIs however they were installed', () => {
  assert.equal(kindOf({ argv: ['/usr/local/bin/claude', '--resume'] }), 'claude');
  // The npm install has nothing called "claude" on the command line at all.
  assert.equal(kindOf({ argv: ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'] }), 'claude');
  assert.equal(kindOf({ argv: ['/home/m/.claude/local/node_modules/.bin/claude'] }), 'claude');
  assert.equal(kindOf({ argv: ['/usr/bin/codex', 'exec'] }), 'codex');
  assert.equal(kindOf({ argv: ['node', '/usr/lib/node_modules/@openai/codex/bin/codex.js'] }), 'codex');
});

test('processes: does not match our own app or lookalikes', () => {
  assert.equal(kindOf({ argv: ['/opt/Sup/supbar'] }), null);
  assert.equal(kindOf({ argv: ['/usr/bin/claude-helper'] }), null);
  assert.equal(kindOf({ argv: ['vim', 'claude-notes.md'] }), null);
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
