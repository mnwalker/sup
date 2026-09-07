'use strict';

/**
 * Shared shapes every provider returns, so the renderer never has to know which
 * service a number came from.
 */

/** A rate-limit window, e.g. "5h session, 33% used, resets 07:00". */
function usageWindow({ key, label, percent, resetsAt = null, detail = null, used = null, limit = null }) {
  const pct = percent == null ? null : Math.max(0, Math.min(100, Number(percent)));
  return {
    key,
    label,
    percent: pct == null || Number.isNaN(pct) ? null : pct,
    resetsAt: resetsAt ? new Date(resetsAt).toISOString() : null,
    detail,
    used,
    limit,
  };
}

/**
 * status:
 *   ok              usage numbers were read successfully
 *   unauthenticated no usable credentials were found on disk
 *   not-installed   the tool does not appear to be installed at all
 *   error           we tried and failed (network, unexpected payload, ...)
 */
function providerResult({
  id,
  label,
  account = null,
  status,
  detail = null,
  windows = [],
  session = null,
  sessions = [],
  plan = null,
}) {
  return {
    id,
    key: account ? `${id}:${account}` : id,
    label,
    account,
    status,
    detail,
    plan,
    windows: windows.filter(Boolean),
    session: session || { state: 'unknown', since: null, project: null },
    sessions,
    updatedAt: new Date().toISOString(),
  };
}

/** The window closest to its limit — what the collapsed tab shows. */
function worstWindow(windows) {
  let worst = null;
  for (const w of windows) {
    if (w.percent == null) continue;
    if (!worst || w.percent > worst.percent) worst = w;
  }
  return worst;
}

module.exports = { usageWindow, providerResult, worstWindow };
