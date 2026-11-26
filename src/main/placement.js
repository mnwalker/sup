'use strict';

/**
 * Where the tab sits, and how big it is, for a given screen edge.
 *
 * The collapsed tab rotates to run along whichever edge it is on, so its
 * configured "width" is really its length along that edge and its "height" its
 * depth into the screen. The expanded panel is always a horizontal card.
 */

function isVertical(edge) {
  return edge === 'left' || edge === 'right';
}

function sizeFor(edge, { length, depth }) {
  return isVertical(edge) ? { width: depth, height: length } : { width: length, height: depth };
}

function collapsedSize(config) {
  return sizeFor(config.edge, { length: config.collapsedWidth, depth: config.collapsedHeight });
}

function expandedSize(config) {
  return { width: config.expandedWidth, height: config.expandedHeight };
}

/**
 * Anchor the window to the chosen edge, centred along it and shifted by
 * `offset`. Expanding grows away from the edge, so the tab never appears to
 * move while it opens.
 */
function boundsFor(config, area, size) {
  const { edge, offset = 0 } = config;
  const x0 = area.x;
  const y0 = area.y;

  if (edge === 'top' || edge === 'bottom') {
    const x = Math.round(x0 + (area.width - size.width) / 2 + offset);
    const y = edge === 'top' ? y0 : y0 + area.height - size.height;
    return { x: clamp(x, x0, x0 + area.width - size.width), y, ...size };
  }

  const y = Math.round(y0 + (area.height - size.height) / 2 + offset);
  const x = edge === 'left' ? x0 : x0 + area.width - size.width;
  return { x, y: clamp(y, y0, y0 + area.height - size.height), ...size };
}

/**
 * Where a tab dropped at `point` belongs on `area`: the edge nearest the
 * point, and how far along that edge from its centre. The result plugs
 * straight back into boundsFor as { edge, offset }.
 */
function snapToEdge(point, area) {
  const distances = {
    left: point.x - area.x,
    right: area.x + area.width - point.x,
    top: point.y - area.y,
    bottom: area.y + area.height - point.y,
  };
  const edge = Object.keys(distances).reduce((a, b) => (distances[b] < distances[a] ? b : a));
  const offset = isVertical(edge)
    ? Math.round(point.y - (area.y + area.height / 2))
    : Math.round(point.x - (area.x + area.width / 2));
  return { edge, offset };
}

/**
 * Where the tab sits inside a panel-sized window: against the screen edge,
 * centred along it (the page lays it out the same way).
 */
function tabRect(edge, win, tab) {
  if (isVertical(edge)) {
    const x = edge === 'left' ? win.x : win.x + win.width - tab.width;
    return { x, y: Math.round(win.y + (win.height - tab.height) / 2), ...tab };
  }
  const y = edge === 'top' ? win.y : win.y + win.height - tab.height;
  return { x: Math.round(win.x + (win.width - tab.width) / 2), y, ...tab };
}

function contains(rect, point) {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

module.exports = { isVertical, sizeFor, collapsedSize, expandedSize, boundsFor, snapToEdge, tabRect, contains, clamp };
