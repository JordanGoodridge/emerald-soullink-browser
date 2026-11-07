import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  fetchVerifiedResource,
  loadPack,
  resolvePackModule,
} from './loader.mjs';
import { createPackAdapters } from './composition.mjs';
import { createSaveStore } from '../save-store.mjs';
import * as toyRuntimeAdapter from '../../../game-packs/toy-console/adapter/runtime.mjs';
import * as toySceneAdapter from '../../../game-packs/toy-console/adapter/scene.mjs';
import * as toySaveAdapter from '../../../game-packs/toy-console/adapter/saves.mjs';

const realIndex = JSON.parse(
  await readFile(new URL('../../../game-packs/index.json', import.meta.url), 'utf8'),
);
const realManifest = JSON.parse(
  await readFile(new URL('../../../game-packs/emerald/manifest.json', import.meta.url), 'utf8'),
);
const realToyManifest = JSON.parse(
  await readFile(new URL('../../../game-packs/toy-console/manifest.json', import.meta.url), 'utf8'),
);

const origin = 'https://example.test';
const indexPath = `${origin}/game-packs/index.json`;
const manifestPath = `${origin}/game-packs/emerald/manifest.json`;
const toyManifestPath = `${origin}/game-packs/toy-console/manifest.json`;

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

function fakeFetch(overrides = {}) {
  return async (url) => {
    if (overrides[url]) return overrides[url];
    if (url === indexPath) return jsonResponse(realIndex);
    if (url === manifestPath) return jsonResponse(realManifest);
    if (url === toyManifestPath) return jsonResponse(realToyManifest);
    return { ok: false, status: 404 };
  };
}

test('loads a pack and imports all mandatory adapters', async () => {
  const pack = await loadPack({
    gameId: 'emerald',
    baseUrl: `${origin}/`,
    fetchImpl: fakeFetch(),
    requireDigests: false,
    importModule: async (url) => {
      if (url.endsWith('runtime.mjs')) return { createRuntime() {} };
      if (url.endsWith('scene.mjs')) return { createScene() {} };
      if (url.endsWith('saves.mjs')) return { createSaveCodec() {} };
      if (url.endsWith('run.mjs')) return { createRunAdapter() {} };
      if (url.endsWith('rules.mjs')) return { createRulesAdapter() {} };
      if (url.endsWith('party.mjs')) return { createPartyAdapter() {} };
      return { createWorldModel() {} };
    },
  });
  assert.equal(pack.entry.id, 'emerald');
  assert.equal(typeof pack.adapters.runtime.createRuntime, 'function');
  assert.equal(typeof pack.adapters.scene.createScene, 'function');
  assert.equal(typeof pack.adapters.saves.createSaveCodec, 'function');
  assert.equal(typeof pack.adapters.world.createWorldModel, 'function');
  assert.equal(typeof pack.adapters.run.createRunAdapter, 'function');
  assert.equal(typeof pack.adapters.rules.createRulesAdapter, 'function');
  assert.equal(typeof pack.adapters.party.createPartyAdapter, 'function');
});

test('a synthetic non-Emerald pack loads and composes independent runtime, scene, and save adapters', async () => {
  const fakeIndex = {
    schemaVersion: 1,
    default: 'toy-console',
    games: [{ id: 'toy-console', title: 'Toy Console', packVersion: '1', manifest: 'toy/manifest.json' }],
  };
  const fakeManifest = {
    schemaVersion: 1,
    game: { id: 'toy-console', title: 'Toy Console', packVersion: '1' },
    build: { source: 'synthetic:toy', sourceRevision: 'test-1', recipe: 'test fixture', artifact: 'toy.wasm' },
    runtime: {
      kind: 'source-wasm', adapter: 'adapter/runtime.mjs', abiVersion: 1,
      module: { id: 'toy-runtime', kind: 'runtime', group: 'boot', embedded: false, url: 'toy.wasm', sha256: 'pending' },
      entry: ['start', 'tick'], requiredExports: [],
    },
    rendering: {
      modes: ['classic'], defaultMode: 'classic', sceneFormat: 'gba-classic-v1', width: 8, height: 8,
      adapter: 'adapter/scene.mjs',
    },
    resources: [{ id: 'toy-runtime', kind: 'runtime', group: 'boot', embedded: false, url: 'toy.wasm', sha256: 'pending' }],
    saves: { formatId: 'toy-save', formatVersion: 1, bytes: 4, codec: 'adapter/saves.mjs' },
    nuzlocke: { support: 'none' },
    capabilities: { rendering: ['classic'], presence: 'none', rules: 'none', link: 'none', customUi: false },
  };
  const fetched = async (url) => {
    if (url === `${origin}/game-packs/index.json`) return jsonResponse(fakeIndex);
    if (url === `${origin}/game-packs/toy/manifest.json`) return jsonResponse(fakeManifest);
    return { ok: false, status: 404 };
  };
  const imports = {
    'runtime.mjs': {
      createRuntime: () => {
        let frames = 0;
        const lifecycle = [];
        return {
          init() { lifecycle.push('init'); },
          step() { frames++; lifecycle.push('step'); },
          suspend() { lifecycle.push('suspend'); },
          dispose() { lifecycle.push('dispose'); },
          get frames() { return frames; },
          get lifecycle() { return [...lifecycle]; },
        };
      },
    },
    'scene.mjs': { createScene: () => ({ sceneFormat: 'gba-classic-v1', present: () => 'toy-frame' }) },
    'saves.mjs': {
      createSaveCodec: () => ({
        formatId: 'toy-save', formatVersion: 1,
        validate: (bytes) => bytes instanceof Uint8Array && bytes.length === 4
          ? { ok: true } : { ok: false, reason: 'toy save must be four bytes' },
        exportRaw: (bytes) => new Uint8Array(bytes),
      }),
    },
  };
  const loaded = await loadPack({
    baseUrl: `${origin}/`,
    fetchImpl: fetched,
    requireDigests: false,
    importModule: async (url) => imports[url.slice(url.lastIndexOf('/') + 1)],
  });
  const services = createPackAdapters(loaded, {
    runtime: {},
    scene: {},
    saves: {},
  });
  services.runtime.init();
  services.runtime.step();
  services.runtime.step();
  services.runtime.suspend();
  services.runtime.dispose();

  assert.equal(loaded.entry.id, 'toy-console');
  assert.equal(loaded.manifest.capabilities.presence, 'none');
  assert.equal(services.runtime.frames, 2);
  assert.deepEqual(services.runtime.lifecycle, ['init', 'step', 'step', 'suspend', 'dispose']);
  assert.equal(services.scene.present(), 'toy-frame');
  assert.deepEqual(services.saves.validate(new Uint8Array(4)), { ok: true });
  assert.equal(services.world, null);
  assert.equal(services.run, null);
  assert.equal(services.party, null);
  assert.equal(services.rules, null);

  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  };
  const toySave = createSaveStore({
    gameId: loaded.entry.id, formatId: services.saves.formatId, formatVersion: services.saves.formatVersion,
    profile: 'shared-profile', codec: services.saves, storage,
  });
  const otherPackSave = createSaveStore({
    gameId: 'other-console', formatId: services.saves.formatId, formatVersion: services.saves.formatVersion,
    profile: 'shared-profile', codec: services.saves, storage,
  });
  toySave.save(new Uint8Array([1, 2, 3, 4]));
  otherPackSave.save(new Uint8Array([4, 3, 2, 1]));
  assert.notEqual(toySave.key, otherPackSave.key);
  assert.deepEqual([...toySave.load().bytes], [1, 2, 3, 4]);
  assert.deepEqual([...otherPackSave.load().bytes], [4, 3, 2, 1]);
});

test('the checked-in toy pack registers, runs a non-Emerald WASM lifecycle, and isolates its saves', async () => {
  const modules = {
    'runtime.mjs': toyRuntimeAdapter,
    'scene.mjs': toySceneAdapter,
    'saves.mjs': toySaveAdapter,
  };
  const loaded = await loadPack({
    gameId: 'toy-console',
    baseUrl: `${origin}/`,
    fetchImpl: fakeFetch(),
    requireDigests: false,
    importModule: async (url) => modules[url.slice(url.lastIndexOf('/') + 1)],
  });
  const services = createPackAdapters(loaded, {
    runtime: {}, scene: {}, saves: {},
  });
  const running = await services.runtime.instantiate();
  assert.ok(running.instance instanceof WebAssembly.Instance);
  assert.equal(running.memory.buffer.byteLength, 65536);
  services.runtime.start();
  services.runtime.setButtons(['a', 'start']);
  services.runtime.step();
  services.runtime.setInputMask(5);
  services.runtime.step();
  services.runtime.suspend();
  assert.deepEqual(services.runtime.pressedButtons, ['legacy-mask:5']);

  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  };
  const toyStore = createSaveStore({
    gameId: loaded.entry.id, formatId: services.saves.formatId, formatVersion: services.saves.formatVersion,
    profile: 'same-profile', codec: services.saves, storage,
  });
  const peerStore = createSaveStore({
    gameId: 'other-game', formatId: services.saves.formatId, formatVersion: services.saves.formatVersion,
    profile: 'same-profile', codec: services.saves, storage,
  });
  toyStore.save(new Uint8Array(16).fill(0x31));
  peerStore.save(new Uint8Array(16).fill(0x72));
  assert.notEqual(toyStore.key, peerStore.key);
  assert.equal(toyStore.load().bytes[0], 0x31);
  assert.equal(peerStore.load().bytes[0], 0x72);
  assert.equal(services.world, null);
  assert.equal(services.run, null);
  assert.equal(services.party, null);
  assert.equal(services.rules, null);
  services.runtime.dispose();
});

test('missing adapter exports are a named contract error', async () => {
  await assert.rejects(
    () => loadPack({
      gameId: 'emerald',
      baseUrl: `${origin}/`,
      fetchImpl: fakeFetch(),
      requireDigests: false,
      importModule: async (url) => (url.endsWith('runtime.mjs') ? {} : {
        createScene() {},
        createSaveCodec() {},
        createWorldModel() {},
      }),
    }),
    (error) => error.code === 'adapter_contract',
  );
});

test('rejects duplicated index capabilities that disagree with the selected manifest', async () => {
  const mismatchIndex = structuredClone(realIndex);
  mismatchIndex.games.find((entry) => entry.id === 'emerald').capabilities.rules = 'none';
  await assert.rejects(() => loadPack({
    gameId: 'emerald',
    baseUrl: `${origin}/`,
    fetchImpl: fakeFetch({
      [indexPath]: jsonResponse(mismatchIndex),
      [manifestPath]: jsonResponse(realManifest),
    }),
    requireDigests: false,
  }), (error) => error.code === 'capability_mismatch');
});

test('adapter paths cannot escape the pack directory', () => {
  assert.throws(
    () => resolvePackModule(manifestPath, '../outside.mjs'),
    (error) => error.code === 'path_escape',
  );
  assert.equal(
    resolvePackModule(manifestPath, 'adapter/runtime.mjs'),
    `${origin}/game-packs/emerald/adapter/runtime.mjs`,
  );
});

test('resource digests are verified', async () => {
  const manifestUrl = manifestPath;
  const resource = {
    id: 'wasm',
    embedded: false,
    url: 'dist/game.wasm',
    sha256: 'abc123',
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  const result = await fetchVerifiedResource(manifestUrl, resource, {
    fetchImpl,
    digestImpl: async () => 'abc123',
  });
  assert.equal(result.verified, true);
  assert.deepEqual([...result.bytes], [1, 2, 3]);

  await assert.rejects(
    () => fetchVerifiedResource(manifestUrl, resource, {
      fetchImpl,
      digestImpl: async () => 'def456',
    }),
    (error) => error.code === 'digest_mismatch',
  );
});
