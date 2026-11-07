import test from 'node:test';
import assert from 'node:assert/strict';
import { createWasmHelpers, createWasmRuntime, dispatchRunImport } from './runtime-wasm.mjs';

test('signed 16/32-bit memory helpers preserve values', () => {
  const buffer = new ArrayBuffer(64);
  const u8 = new Uint8Array(buffer);
  const u16 = new Uint16Array(buffer);
  const u32 = new Uint32Array(buffer);
  const helpers = createWasmHelpers(() => ({ u8, u16, u32 }));

  helpers.writeS16(0, -2);
  assert.equal(helpers.readS16(0), -2);
  helpers.writeS32(4, -123456);
  assert.equal(helpers.readS32(4), -123456);
  helpers.writeS32(8, 0x7fffffff);
  assert.equal(helpers.readS32(8), 0x7fffffff);
});

test('a missing view provider fails loudly', () => {
  const helpers = createWasmHelpers(() => null);
  assert.throws(() => helpers.readS16(0), /not initialized/);
});

test('run imports default to vanilla species and permissive gates when no run is wired', () => {
  assert.equal(dispatchRunImport('WasmRunRandomSpecies', [1, 382]), 382);
  assert.equal(dispatchRunImport('WasmRunAllowCapture', [0, 25]), 1);
  assert.equal(dispatchRunImport('WasmRunAllowItemEffect', [25, 0, 0, 83, 0]), 1);
  assert.equal(dispatchRunImport('WasmRunOnEncounter', []), undefined);
});

test('run imports dispatch to injected hooks', () => {
  assert.equal(dispatchRunImport('WasmRunRandomSpecies', [2, 1, 10, 0], {
    WasmRunRandomSpecies: (kind, species, area, slot) => species + kind + area + slot,
  }), 13);
});

test('WASM runtime resolves its module from the selected manifest and instantiates through injected imports', async () => {
  let requestedUrl;
  let importsForCalled = false;
  const wasmBytes = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 4, 1, 96, 0, 0,
    3, 3, 2, 0, 0,
    7, 15, 2, 5, 115, 116, 97, 114, 116, 0, 0, 3, 114, 117, 110, 0, 1,
    10, 7, 2, 2, 0, 11, 2, 0, 11,
  ]);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', wasmBytes));
  const digest = [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const manifest = {
    runtime: {
      module: { url: 'dist/game.wasm', sha256: digest },
      entry: ['start', 'run'],
      requiredExports: ['start', 'run'],
    },
  };
  const runtime = createWasmRuntime({
    manifest,
    manifestUrl: 'https://example.test/game-packs/fake/manifest.json',
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        arrayBuffer: async () => wasmBytes.buffer,
      };
    },
    importsFor: () => {
      importsForCalled = true;
      return {};
    },
  });

  const result = await runtime.instantiate();
  assert.equal(runtime.moduleUrl, 'https://example.test/game-packs/fake/dist/game.wasm');
  assert.equal(requestedUrl, runtime.moduleUrl);
  assert.equal(importsForCalled, true);
  assert.ok(result.instance instanceof WebAssembly.Instance);
  assert.equal(result.bytes.byteLength, wasmBytes.length);
  assert.doesNotThrow(() => runtime.start());
  assert.doesNotThrow(() => runtime.step());
  runtime.dispose();
  assert.throws(() => runtime.step(), /not instantiated/);

  const badDigestRuntime = createWasmRuntime({
    manifest: { ...manifest, runtime: { ...manifest.runtime, module: { ...manifest.runtime.module, sha256: '0'.repeat(64) } } },
    manifestUrl: 'https://example.test/game-packs/fake/manifest.json',
    fetchImpl: async () => { throw new Error('module cache should be used'); },
    importsFor: () => ({}),
  });
  await assert.rejects(() => badDigestRuntime.instantiate(), /digest mismatch/);

  const missingExportRuntime = createWasmRuntime({
    manifest: { ...manifest, runtime: { ...manifest.runtime, requiredExports: ['missing'] } },
    manifestUrl: 'https://example.test/game-packs/fake/manifest.json',
    fetchImpl: async () => { throw new Error('module cache should be used'); },
    importsFor: () => ({}),
  });
  await assert.rejects(() => missingExportRuntime.instantiate(), /missing required export missing/);
});
