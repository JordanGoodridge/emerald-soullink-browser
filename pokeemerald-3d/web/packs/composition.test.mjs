import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackAdapter, createPackAdapters } from './composition.mjs';

test('composes required and optional services without game-specific branches', () => {
  const calls = [];
  const factory = (name) => (context) => {
    calls.push([name, context.marker]);
    return { kind: name };
  };
  const services = createPackAdapters({
    entry: { id: 'different-game' },
    adapters: {
      runtime: { createRuntime: factory('runtime') },
      scene: { createScene: factory('scene') },
      saves: { createSaveCodec: factory('saves') },
      world: null,
      run: null,
      party: { createPartyAdapter: factory('party') },
      rules: null,
    },
  }, {
    runtime: { marker: 'runtime-context' },
    scene: { marker: 'scene-context' },
    saves: { marker: 'save-context' },
    party: { marker: 'party-context' },
  });

  assert.deepEqual(services.runtime, { kind: 'runtime' });
  assert.deepEqual(services.scene, { kind: 'scene' });
  assert.deepEqual(services.saves, { kind: 'saves' });
  assert.deepEqual(services.party, { kind: 'party' });
  assert.equal(services.world, null);
  assert.equal(services.rules, null);
  assert.deepEqual(calls, [
    ['runtime', 'runtime-context'],
    ['scene', 'scene-context'],
    ['saves', 'save-context'],
    ['party', 'party-context'],
  ]);
  assert.equal(Object.isFrozen(services), true);
});

test('rejects a missing loaded pack or a broken declared adapter contract', () => {
  assert.throws(() => createPackAdapters(null), /loaded pack/);
  assert.throws(() => createPackAdapters({
    entry: { id: 'different-game' },
    adapters: { runtime: {} },
  }, { runtime: {} }), /createRuntime/);
});

test('creates resource-dependent optional seams through the same adapter boundary', () => {
  const regionMap = { sections: [{ id: 1, name: 'Test Route' }] };
  let received;
  const service = createPackAdapter({
    entry: { id: 'different-game' },
    adapters: {
      run: { createRunAdapter: (context) => { received = context; return { areaKey: () => 'test:area' }; } },
    },
  }, 'run', { manifest: { game: { id: 'different-game' } }, regionMap });

  assert.equal(service.areaKey(), 'test:area');
  assert.equal(received.regionMap, regionMap);
  assert.equal(createPackAdapter({ adapters: {} }, 'rules'), null);
  assert.throws(() => createPackAdapter({ adapters: {} }, 'unknown'), /unknown pack adapter seam/);
});

test('defers run and rules factories until their full dependency context is available', () => {
  const calls = [];
  const services = createPackAdapters({
    entry: { id: 'emerald' },
    adapters: {
      runtime: { createRuntime: () => ({}) },
      scene: { createScene: () => ({}) },
      saves: { createSaveCodec: () => ({}) },
      run: { createRunAdapter: (context) => { calls.push(['run', context.regionMap]); return {}; } },
      rules: { createRulesAdapter: (context) => { calls.push(['rules', context.runtime]); return {}; } },
    },
  }, { runtime: {}, scene: {}, saves: {} });

  assert.equal(services.run, null);
  assert.equal(services.rules, null);
  assert.deepEqual(calls, []);
  createPackAdapter({ adapters: {
    run: { createRunAdapter: (context) => { calls.push(['run', context.regionMap]); return {}; } },
    rules: { createRulesAdapter: (context) => { calls.push(['rules', context.runtime]); return {}; } },
  } }, 'run', { regionMap: 'ready' });
  createPackAdapter({ adapters: {
    rules: { createRulesAdapter: (context) => { calls.push(['rules', context.runtime]); return {}; } },
  } }, 'rules', { runtime: 'ready' });
  assert.deepEqual(calls, [['run', 'ready'], ['rules', 'ready']]);
});
