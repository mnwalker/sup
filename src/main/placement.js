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

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

module.exports = { isVertical, sizeFor, collapsedSize, expandedSize, boundsFor, clamp };
