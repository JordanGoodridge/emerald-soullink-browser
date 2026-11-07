import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmeraldCompatibilityContext } from './emerald-compat.mjs';
import { FLASH_BASE } from './shared/save-codec-emerald.mjs';

test('legacy run settings migration is restricted to the Emerald compatibility boundary', () => {
  const context = createEmeraldCompatibilityContext();
  const storage = { getItem: (key) => key === 'legacy-run-settings' ? '{"mode":"standard"}' : null };
  assert.equal(context.legacyRunSettings('emerald', storage, 'legacy-run-settings'), '{"mode":"standard"}');
  assert.equal(context.legacyRunSettings('other-game', storage, 'legacy-run-settings'), null);
});

test('Emerald runtime bridge attaches its save-memory view without leaking the offset to app composition', () => {
  const context = createEmeraldCompatibilityContext();
  const calls = [];
  const memoryView = { subarray: (...range) => { calls.push(range); return 'save-view'; } };
  const runtime = context.createEmeraldRuntime({
    manifest: { runtime: { abiVersion: 1 } },
    shared: { createWasmRuntime: () => ({ step() {} }) },
    getMemoryView: () => memoryView,
  });
  assert.equal(runtime.step instanceof Function, true);
  assert.equal(runtime.saveView(131072), 'save-view');
  assert.deepEqual(calls, [[FLASH_BASE, FLASH_BASE + 131072]]);
});

test('Emerald runtime compatibility rejects an ABI version mismatch', () => {
  const context = createEmeraldCompatibilityContext();
  assert.throws(() => context.createEmeraldRuntime({
    manifest: { runtime: { abiVersion: 2 } },
    shared: { createWasmRuntime: () => ({}) },
  }), /ABI mismatch/);
});

test('Emerald runtime adapter translates semantic buttons and legacy masks to active-low input memory', () => {
  const context = createEmeraldCompatibilityContext();
  const writes = [];
  const inputView = new Proxy({}, {
    set(_target, key, value) { writes.push([Number(key), value]); return true; },
  });
  const runtime = context.createEmeraldRuntime({
    manifest: { runtime: { abiVersion: 1 } },
    shared: { createWasmRuntime: () => ({ step() {} }) },
    getInputView: () => inputView,
  });
  runtime.setButtons(['a', 'right']);
  runtime.setInputMask(0x3ff);
  assert.deepEqual(writes, [[0x04000130 >> 1, 0x03ee], [0x04000130 >> 1, 0]]);
});

test('emeraldSaveGame refuses to save when WasmCanSaveGame reports an active battle or tutorial swap', () => {
  const context = createEmeraldCompatibilityContext();
  const u8 = new Uint8Array(64);
  let saveCalls = 0;
  const blockedExports = {
    gSaveBlock1Ptr: { value: 0 },
    WasmCanSaveGame: () => 0,
    TrySavingData: () => { saveCalls++; return 1; },
  };
  assert.equal(context.emeraldSaveGame(blockedExports, { u8 }), 0);
  assert.equal(saveCalls, 0);

  const allowedExports = {
    gSaveBlock1Ptr: { value: 0 },
    WasmCanSaveGame: () => 1,
    TrySavingData: () => { saveCalls++; return 1; },
  };
  assert.equal(context.emeraldSaveGame(allowedExports, { u8 }), 1);
  assert.equal(saveCalls, 1);
});
