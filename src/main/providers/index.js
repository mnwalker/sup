'use strict';

const claude = require('./claude');
const codex = require('./codex');
const cursor = require('./cursor');
const antigravity = require('./antigravity');

// Order here is the order rings appear in the tab.
const providers = [claude, codex, cursor, antigravity];

function byId(id) {
  return providers.find((p) => p.id === id) || null;
}

module.exports = { providers, byId };
