'use strict';

const { EventEmitter } = require('events');
const { providers } = require('./providers');
const settings = require('./settings');

const MAX_BACKOFF_MS = 15 * 60 * 1000;

/**
 * Refreshes each provider on its own schedule. Providers that are failing get
 * backed off exponentially so a signed-out tool never turns into a request
 * loop against someone's API.
 */
class Poller extends EventEmitter {
  constructor() {
    super();
    this.state = new Map(); // providerId -> { results, nextRunAt, failures, running }
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 5000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Force every enabled provider to refresh on the next tick. */
  refreshNow() {
    for (const entry of this.state.values()) entry.nextRunAt = 0;
    this.tick();
  }

  entryFor(id) {
    if (!this.state.has(id)) this.state.set(id, { results: [], nextRunAt: 0, failures: 0, running: false });
    return this.state.get(id);
  }

  intervalFor(provider, entry) {
    const configured = settings.load().pollIntervalMs;
    const base = Math.max(provider.minIntervalMs || 60000, configured);
    if (!entry.failures) return base;
    return Math.min(base * 2 ** Math.min(entry.failures, 5), MAX_BACKOFF_MS);
  }

  tick() {
    const config = settings.load();
    const now = Date.now();

    for (const provider of providers) {
      if (config.enabled[provider.id] === false) {
        this.state.delete(provider.id);
        continue;
      }
      const entry = this.entryFor(provider.id);
      if (entry.running || now < entry.nextRunAt) continue;

      entry.running = true;
      Promise.resolve()
        .then(() => provider.collect({ settings: config }))
        .then((results) => {
          entry.results = Array.isArray(results) ? results : [results];
          const bad = entry.results.some((r) => r.status === 'error');
          entry.failures = bad ? entry.failures + 1 : 0;
        })
        .catch((err) => {
          entry.failures += 1;
          entry.results = [
            {
              id: provider.id,
              key: provider.id,
              label: provider.label,
              account: null,
              status: 'error',
              detail: err.message,
              plan: null,
              windows: [],
              session: { state: 'unknown', since: null, project: null },
              updatedAt: new Date().toISOString(),
            },
          ];
        })
        .finally(() => {
          entry.running = false;
          entry.nextRunAt = Date.now() + this.intervalFor(provider, entry);
          this.emit('update', this.snapshot());
        });
    }
  }

  snapshot() {
    const config = settings.load();
    const out = [];
    for (const provider of providers) {
      if (config.enabled[provider.id] === false) continue;
      const entry = this.state.get(provider.id);
      if (entry && entry.results.length) out.push(...entry.results);
      else out.push(pendingResult(provider));
    }
    return { providers: out, generatedAt: new Date().toISOString() };
  }
}

function pendingResult(provider) {
  return {
    id: provider.id,
    key: provider.id,
    label: provider.label,
    account: null,
    status: 'pending',
    detail: 'Checking…',
    plan: null,
    windows: [],
    session: { state: 'unknown', since: null, project: null },
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { Poller };
