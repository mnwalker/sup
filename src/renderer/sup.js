'use strict';

const RING_R = 7;
const RING_C = 2 * Math.PI * RING_R;

const els = {
  body: document.body,
  pill: document.getElementById('pill'),
  rings: document.getElementById('rings'),
  panelBody: document.getElementById('panelBody'),
  updatedAt: document.getElementById('updatedAt'),
  refresh: document.getElementById('refresh'),
  quit: document.getElementById('quit'),
};

let config = { warnAt: 75, dangerAt: 90, edge: 'right', collapsedWidth: 190 };
let snapshot = { providers: [] };

function levelFor(percent) {
  if (percent == null) return 'unknown';
  if (percent >= config.dangerAt) return 'danger';
  if (percent >= config.warnAt) return 'warn';
  return 'ok';
}

/** The window closest to its cap is the one worth showing at a glance. */
function worstWindow(windows) {
  let worst = null;
  for (const w of windows || []) {
    if (w.percent == null) continue;
    if (!worst || w.percent > worst.percent) worst = w;
  }
  return worst;
}

function formatReset(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'resetting now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `resets in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  // A countdown in days leaves the reader to work out which day that is, so
  // name it. Within the week the weekday is unambiguous; beyond it, the date.
  // (A date is clear enough by itself, and the line has no room to spare.)
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (days >= 6) return `resets ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
  return `resets ${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time} (${days}d ${hours % 24}h)`;
}

const STATE_LABELS = {
  active: 'active',
  agents: 'waiting on agents',
  input: 'waiting for you',
  stopped: 'recently stopped',
  inactive: 'inactive',
};

function sessionLabel(session) {
  return (session && STATE_LABELS[session.state]) || null;
}

/**
 * A short headline for the provider's meta line — the full breakdown is in the
 * list right below it, so this only names the state that wants attention.
 */
function summariseCounts(counts) {
  if (!counts) return null;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return null;

  const headline = ['input', 'agents', 'active'].find((state) => counts[state]);
  const size = total === 1 ? '1 project' : `${total} projects`;
  return headline ? `${size} \u00b7 ${counts[headline]} ${STATE_LABELS[headline]}` : size;
}

function formatAge(ms) {
  if (!Number.isFinite(ms)) return '';
  const secs = Math.round(ms / 1000);
  if (secs < 45) return 'now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function statusLine(provider) {
  switch (provider.status) {
    case 'ok':
      return provider.plan ? String(provider.plan) : null;
    case 'pending':
      return 'checking…';
    case 'unauthenticated':
      return provider.detail || 'not signed in';
    case 'not-installed':
      return provider.detail || 'not installed';
    default:
      return provider.detail || 'unavailable';
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function ringSvg(percent, level) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 18 18');

  const mk = (cls) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', '9');
    c.setAttribute('cy', '9');
    c.setAttribute('r', String(RING_R));
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke-width', '2.4');
    c.setAttribute('stroke-linecap', 'round');
    c.setAttribute('class', cls);
    return c;
  };

  svg.append(mk('track'));
  const value = mk('value');
  const filled = percent == null ? 0 : Math.max(0, Math.min(100, percent)) / 100;
  value.setAttribute('stroke-dasharray', String(RING_C));
  value.setAttribute('stroke-dashoffset', String(RING_C * (1 - filled)));
  if (level === 'unknown') value.setAttribute('stroke-dashoffset', String(RING_C));
  svg.append(value);
  return svg;
}

function renderRings() {
  els.rings.replaceChildren();
  for (const provider of snapshot.providers) {
    const worst = worstWindow(provider.windows);
    const level = provider.status === 'ok' ? levelFor(worst && worst.percent) : 'unknown';

    const ring = el('div', 'ring');
    ring.dataset.level = level;
    ring.dataset.session = (provider.session && provider.session.state) || 'unknown';
    ring.title = `${provider.label}${provider.account ? ` (${provider.account})` : ''}`;
    ring.append(ringSvg(worst && worst.percent, level), el('span', 'pip'));
    els.rings.append(ring);
  }
  if (!snapshot.providers.length) {
    els.rings.append(el('span', 'row-sub', 'no providers'));
  }
}

function renderPanel() {
  els.panelBody.replaceChildren();

  if (!snapshot.providers.length) {
    els.panelBody.append(el('div', 'empty', 'No providers enabled. Use the tray icon to turn some on.'));
    return;
  }

  for (const provider of snapshot.providers) {
    const worst = worstWindow(provider.windows);
    const level = provider.status === 'ok' ? levelFor(worst && worst.percent) : 'unknown';

    const row = el('div', 'row');

    const ring = el('div', 'ring');
    ring.dataset.level = level;
    ring.dataset.session = (provider.session && provider.session.state) || 'unknown';
    ring.append(ringSvg(worst && worst.percent, level), el('span', 'pip'));
    row.append(ring);

    const main = el('div', 'row-main');

    const head = el('div', 'row-head');
    head.append(el('div', 'row-name', provider.label + (provider.account ? ` \u00b7 ${provider.account}` : '')));
    if (worst && worst.percent != null) {
      head.append(el('div', 'row-pct', `${Math.round(worst.percent)}%`));
    }
    main.append(head);

    const meta = el('div', 'row-meta');
    const sub = statusLine(provider);
    if (sub) meta.append(el('span', 'row-sub', sub));
    const counts = summariseCounts(provider.session && provider.session.counts);
    const session = sessionLabel(provider.session);
    if (counts || session) {
      const chip = el('span', 'chip', counts || session);
      chip.dataset.session = (provider.session && provider.session.state) || 'unknown';
      meta.append(chip);
    }
    if (meta.childElementCount) main.append(meta);

    if (provider.windows.length) {
      const bars = el('div', 'bars');
      for (const w of provider.windows) {
        const bits = [];
        if (w.percent != null) bits.push(`${Math.round(w.percent)}%`);
        const reset = formatReset(w.resetsAt);
        if (reset) bits.push(reset);
        if (w.detail) bits.push(w.detail);

        const line = el('div', 'bar-line');
        line.append(el('b', null, w.label), el('span', null, bits.join(' \u00b7 ')));

        const bar = el('div', 'bar');
        bar.dataset.level = levelFor(w.percent);
        const fill = el('span');
        fill.style.width = `${w.percent == null ? 0 : Math.min(100, w.percent)}%`;
        bar.append(fill);

        const barRow = el('div', 'bar-row');
        barRow.append(line, bar);
        bars.append(barRow);
      }
      main.append(bars);
    }

    if (provider.sessions && provider.sessions.length) {
      main.append(sessionList(provider.sessions));
    }

    row.append(main);

    els.panelBody.append(row);
  }
}

const MAX_SESSION_ROWS = 6;

function sessionList(sessions) {
  const wrap = el('div', 'sessions');

  for (const s of sessions.slice(0, MAX_SESSION_ROWS)) {
    const row = el('div', 'session');
    row.dataset.state = s.state;
    row.title = [
      s.cwd,
      s.branch && `branch ${s.branch}`,
      s.sessionCount > 1 && `${s.sessionCount} sessions`,
      s.agents > 0 && `${s.agents} agent${s.agents === 1 ? '' : 's'} outstanding`,
    ]
      .filter(Boolean)
      .join('\n');

    const who = el('div', 'who');
    who.append(document.createTextNode(s.project || s.id.slice(0, 8)));
    // Several transcripts for one project collapse into a single row.
    if (s.sessionCount > 1) who.append(el('em', 'tally', ` \u00d7${s.sessionCount}`));
    if (s.branch) who.append(el('em', null, ` \u00b7 ${s.branch}`));

    // "waiting on agents" is more useful as "waiting on 3 agents".
    const label =
      s.state === 'agents' && s.agents > 1
        ? `waiting on ${s.agents} agents`
        : STATE_LABELS[s.state] || s.state;

    const age = Date.now() - new Date(s.lastActivity).getTime();
    row.append(el('span', 'dot'), who, el('div', 'what', `${label} \u00b7 ${formatAge(age)}`));
    wrap.append(row);
  }

  if (sessions.length > MAX_SESSION_ROWS) {
    wrap.append(el('div', 'session-more', `+${sessions.length - MAX_SESSION_ROWS} more`));
  }
  return wrap;
}

function render() {
  syncBlink();
  renderRings();
  renderPanel();
  els.updatedAt.textContent = snapshot.generatedAt
    ? `updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`
    : '—';
}

function applyConfig(next) {
  config = { ...config, ...next };
  els.body.dataset.edge = config.edge || 'right';
  // On a side edge the tab cannot size itself from its contents, so hand the
  // configured length to CSS.
  els.body.style.setProperty('--tab-length', `${config.collapsedWidth || 190}px`);
  render();
}

/* The window is exactly the size of the tab when collapsed, so the pointer
   being anywhere inside it counts as a hover; once expanded the window covers
   the panel too, and leaving it collapses again. */
let hovering = false;

function setHovering(next) {
  if (dragging || hovering === next) return;
  hovering = next;
  els.body.dataset.state = next ? 'expanded' : 'collapsed';
  if (next) window.sup.expand();
  else window.sup.collapse();
}

/* While collapsed, only the tab itself opens the panel. On macOS and Windows
   the window stays panel-sized and passes the pointer through, so moves over
   the empty part of it still arrive here and must not count. Once open, the
   whole window is the panel, and leaving it closes again. */
function overTab(event) {
  return Boolean(event.target && event.target.closest && event.target.closest('.pill'));
}

function hoverFrom(event) {
  if (!hovering && overTab(event)) setHovering(true);
}

document.addEventListener('mouseover', hoverFrom);
document.addEventListener('mousemove', hoverFrom);
// Only leaving the whole page closes it. (A capturing mouseleave on document
// fires for every element the pointer leaves, so moving from the tab onto the
// panel closed the panel before it could be used.)
document.documentElement.addEventListener('mouseleave', () => setHovering(false));
document.addEventListener('mouseout', (event) => {
  if (!event.relatedTarget) setHovering(false);
});

/*
 * Dragging the tab. A press only becomes a drag once the pointer has moved a
 * few pixels, so an ordinary hover or click on the tab behaves as before. The
 * main process snaps the tab to whichever screen edge is nearest the pointer;
 * pointer capture keeps the events coming once the pointer leaves the window.
 */
const DRAG_THRESHOLD = 5;
let dragging = false;
let press = null;
let pendingPoint = null;

function screenPoint(event) {
  return { x: Math.round(event.screenX), y: Math.round(event.screenY) };
}

els.pill.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  press = screenPoint(event);
  els.pill.setPointerCapture(event.pointerId);
});

els.pill.addEventListener('pointermove', (event) => {
  if (!press) return;
  const point = screenPoint(event);
  if (!dragging) {
    if (Math.hypot(point.x - press.x, point.y - press.y) < DRAG_THRESHOLD) return;
    dragging = true;
    hovering = false;
    els.body.dataset.state = 'collapsed';
    els.body.dataset.dragging = 'true';
    window.sup.dragStart();
  }
  // One move per frame is plenty; the window cannot be repositioned faster.
  if (!pendingPoint) {
    requestAnimationFrame(() => {
      window.sup.dragMove(pendingPoint);
      pendingPoint = null;
    });
  }
  pendingPoint = point;
});

function endPress(event) {
  if (!press) return;
  press = null;
  if (!dragging) return;
  dragging = false;
  delete els.body.dataset.dragging;
  window.sup.dragEnd(event.type === 'pointerup' ? screenPoint(event) : null);
}

els.pill.addEventListener('pointerup', endPress);
els.pill.addEventListener('pointercancel', endPress);

/*
 * The main process shrinks the window a moment after the pointer leaves (so
 * the panel does not flicker at the seam), which means the page is "collapsed"
 * for a few frames inside a window still sized for the panel. Track the real
 * window size, so anything that only fits the small window waits for it.
 * Collapsed, the window is one tab deep (28px); open, it is hundreds.
 */
function syncWindowSize() {
  els.body.dataset.window = Math.min(window.innerWidth, window.innerHeight) > 60 ? 'open' : 'tab';
}
window.addEventListener('resize', syncWindowSize);
syncWindowSize();

els.refresh.addEventListener('click', () => window.sup.refresh());
els.quit.addEventListener('click', () => window.sup.quit());

window.sup.onUpdate((payload) => {
  snapshot = payload;
  render();
});
window.sup.onConfig(applyConfig);
window.sup.ready();

// Reset countdowns stay honest without waiting for the next poll.
setInterval(render, 30000);

/*
 * The activity blink. Runs only while something is actually active, and at a
 * pace a human reads rather than one the compositor pays for: two repaints of
 * one dot per cycle, versus sixty a second for the CSS animation it replaces.
 */
let blinkTimer = null;

function syncBlink() {
  const wanted =
    config.blink !== false && snapshot.providers.some((p) => p.session && p.session.state === 'active');

  if (wanted && !blinkTimer) {
    blinkTimer = setInterval(() => {
      els.body.dataset.blink = els.body.dataset.blink === 'off' ? 'on' : 'off';
    }, 1200);
  } else if (!wanted && blinkTimer) {
    clearInterval(blinkTimer);
    blinkTimer = null;
    delete els.body.dataset.blink;
  }
}
