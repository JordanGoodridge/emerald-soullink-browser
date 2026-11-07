import test from 'node:test';
import assert from 'node:assert/strict';
import { createRulesAdapter } from './rules.mjs';

const manifest = {
  nuzlocke: {
    support: 'enforce',
    requiredHooks: ['encounter', 'captureGate', 'faintRelease', 'reviveGate'],
  },
  capabilities: { rules: 'enforce' },
  run: {
    support: 'enforce', modes: ['nuzlocke', 'soullink'],
    capabilities: { linkedPcBoxing: 'enforce' },
  },
};

const capabilities = {
  encounter: 'enforce',
  captureGate: 'enforce',
  faintRelease: 'enforce',
  reviveGate: 'enforce',
  linkedPcBoxing: 'enforce',
};

test('Emerald RulesAdapter binds the shared run engine and exposes enforced gates', () => {
  const hooks = {
    WasmRunOnEncounter() {},
    WasmRunAllowCapture() {},
    WasmRunOnFaint() {},
    WasmRunShouldRelease() {},
    WasmRunAllowItemEffect() {},
    WasmRunAllowPcBoxing() {},
  };
  let bound = null;
  const runtime = {
    hooks,
    bindExports(value) { bound = value; },
  };
  const adapter = createRulesAdapter({
    manifest,
    runAdapter: { capabilities },
    runtime,
  });
  const exports = { memory: {} };
  adapter.bind(exports);
  assert.equal(adapter.support, 'enforce');
  assert.equal(adapter.hooks(), hooks);
  assert.equal(bound, exports);
  assert.equal(adapter.validateImports([
    'WasmRunOnEncounter', 'WasmRunAllowCapture', 'WasmRunOnFaint',
    'WasmRunShouldRelease', 'WasmRunAllowItemEffect',
    'WasmRunAllowPcBoxing',
  ]), true);
  assert.throws(() => adapter.validateImports(['WasmRunOnEncounter']), /requires WASM imports/);
});

test('Emerald RulesAdapter fails closed when manifest-required gates are not enforced', () => {
  assert.throws(() => createRulesAdapter({
    manifest,
    runAdapter: { capabilities: { ...capabilities, reviveGate: 'observe' } },
    runtime: { hooks: {}, bindExports() {} },
  }), /reviveGate/);
});
