'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sdk = require('../src');
const { registerContract, runContract } = require('../src/contract');
const spec = require('./spec.acme');

const acme = sdk.loadPlugin(path.join(__dirname, '..', 'examples', 'acme'));

// The reference plugin must pass the whole standard case set.
registerContract(test, acme, spec);

test('contract kit catches a leaky and mis-mapping plugin', async () => {
  const leaky = {
    manifest: { ...acme.manifest, capabilities: ['image.generate'] },
    createAdapter: (ctx) => ({
      capabilities: {
        async 'image.generate'() {
          let res;
          try { res = await ctx.fetch('https://api.acme.example/v1/images', { headers: { Authorization: ctx.apiKey } }); } catch (e) {
            throw new sdk.PluginError(sdk.ERROR_CODES.NETWORK, e.message); // leaks the key
          }
          const body = JSON.parse(await res.text()); // throws SyntaxError on non-JSON instead of BAD_RESPONSE
          return { urls: (body.data || []).map((d) => d.url) };
        },
      },
      mapError: () => new sdk.PluginError(sdk.ERROR_CODES.UNKNOWN, 'x'), // maps everything to UNKNOWN
    }),
  };
  const report = await runContract(leaky, { ...spec, errors: { INVALID_API_KEY: spec.errors.INVALID_API_KEY } });
  assert.ok(report.failed >= 3, `expected failures, got ${JSON.stringify(report.results.filter((r) => !r.ok).map((r) => r.name))}`);
  const failed = report.results.filter((r) => !r.ok).map((r) => r.name).join('|');
  assert.match(failed, /network failure/);
  assert.match(failed, /non-JSON/);
  assert.match(failed, /error matrix INVALID_API_KEY/);
});

test('contract kit reports a plugin that declares a capability it does not implement', async () => {
  const broken = { manifest: acme.manifest, createAdapter: () => ({ capabilities: {}, mapError: () => new sdk.PluginError('UNKNOWN') }) };
  await assert.rejects(() => runContract(broken, spec), /declared in manifest but not implemented/);
});
