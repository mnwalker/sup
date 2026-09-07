'use strict';

const RING_R = 7;
const RING_C = 2 * Math.PI * RING_R;

const els = {
  body: document.body,
  rings: document.getElementById('rings'),
  panelBody: document.getElementById('panelBody'),
  updatedAt: document.getElementById('updatedAt'),
  refresh: document.getElementById('refresh'),
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
  return `resets in ${days}d ${hours % 24}h`;
}

function sessionLabel(session) {
  switch (session && session.state) {
    case 'working':
      return 'working';
    case 'waiting':
      return 'waiting on you';
    case 'idle':
      return 'idle';
    default:
      return null;
  }
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
    const session = sessionLabel(provider.session);
    if (session) {
      const chip = el('span', 'chip', provider.session.project ? `${session} \u00b7 ${provider.session.project}` : session);
      chip.dataset.session = provider.session.state;
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

    row.append(main);

    els.panelBody.append(row);
  }
}

function render() {
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
  if (hovering === next) return;
  hovering = next;
  els.body.dataset.state = next ? 'expanded' : 'collapsed';
  if (next) window.sup.expand();
  else window.sup.collapse();
}

document.addEventListener('mouseenter', () => setHovering(true), true);
document.addEventListener('mouseleave', () => setHovering(false), true);
// Some window managers deliver the first pointer event as mouseover rather than
// mouseenter, so treat a move over the document as a hover too.
document.addEventListener('mouseover', () => setHovering(true));
document.addEventListener('mouseout', (event) => {
  if (!event.relatedTarget) setHovering(false);
});

els.refresh.addEventListener('click', () => window.sup.refresh());

window.sup.onUpdate((payload) => {
  snapshot = payload;
  render();
});
window.sup.onConfig(applyConfig);
window.sup.ready();

// Reset countdowns stay honest without waiting for the next poll.
setInterval(render, 30000);
