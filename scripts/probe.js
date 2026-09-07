'use strict';

/**
 * Runs the providers outside Electron and prints what they found. Useful when a
 * tool shows up as "unavailable" and you want to know why.
 *
 *   npm run probe              # every provider
 *   npm run probe -- cursor    # just one
 *   npm run probe -- antigravity --raw
 */

const { providers, byId } = require('../src/main/providers');
const settings = require('../src/main/settings');

async function main() {
  const args = process.argv.slice(2);
  const raw = args.includes('--raw');
  const names = args.filter((a) => !a.startsWith('--'));
  const selected = names.length ? names.map(byId).filter(Boolean) : providers;

  if (!selected.length) {
    console.error(`unknown provider. known: ${providers.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }

  if (raw && selected.length === 1 && selected[0].id === 'antigravity') {
    return dumpAntigravity();
  }

  const config = settings.load();
  for (const provider of selected) {
    process.stdout.write(`\n=== ${provider.label} (${provider.id}) ===\n`);
    try {
      const results = await provider.collect({ settings: config });
      console.log(JSON.stringify(results, null, 2));
    } catch (err) {
      console.log(`failed: ${err.stack || err.message}`);
    }
  }
}

/** Dump the language server's replies verbatim so new payload shapes can be mapped. */
async function dumpAntigravity() {
  const { _internal } = require('../src/main/providers/antigravity');
  const endpoint = await _internal.discoverEndpoint();
  if (!endpoint) {
    console.log('No Antigravity language server found. Is the IDE running?');
    return;
  }
  console.log(`language server pid=${endpoint.pid} port=${endpoint.port} csrf=${endpoint.csrf ? 'yes' : 'no'}`);
  for (const method of ['RetrieveUserQuotaSummary', 'GetUserStatus', 'GetAvailableModels']) {
    try {
      const payload = await _internal.callRpc(endpoint.port, endpoint.csrf, method);
      console.log(`\n--- ${method} ---\n${JSON.stringify(payload, null, 2)}`);
    } catch (err) {
      console.log(`\n--- ${method} --- failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
