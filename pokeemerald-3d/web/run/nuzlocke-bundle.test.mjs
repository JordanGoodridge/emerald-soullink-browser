import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNuzlockeBundle, serializeNuzlockeBundle } from './nuzlocke-bundle.mjs';

const runState = {
  runId: 'nuzlocke-1',
  gameId: 'emerald',
  contentVersion: 'emerald-nuzlocke-v1',
  seed: 123,
  mode: 'nuzlocke',
  options: { mode: 'nuzlocke', saveSlot: 'nuzlocke' },
  status: 'active',
  members: [{ playerId: 'solo:emerald:default', active: true }],
  areas: {},
  links: {},
  deaths: [],
  events: [],
};

const input = {
  gameId: 'emerald',
  formatId: 'emerald-flash',
  formatVersion: 1,
  profile: '',
  playerId: 'solo:emerald:default',
  saveBytes: new Uint8Array([0, 1, 2, 255]),
  runState,
};

test('Nuzlocke backup round-trips the game save and solo run history together', () => {
  const data = serializeNuzlockeBundle(input);
  const restored = parseNuzlockeBundle(data, {
    ...input,
    saveBytesLength: input.saveBytes.length,
  });
  assert.deepEqual(restored.bytes, input.saveBytes);
  assert.deepEqual(restored.runState, runState);
});

test('Nuzlocke backup rejects a save from another profile or game', () => {
  const data = serializeNuzlockeBundle(input);
  assert.throws(() => parseNuzlockeBundle(data, { ...input, profile: 'other' }), /different local profile/);
  assert.throws(() => parseNuzlockeBundle(data, { ...input, gameId: 'emerald-kaizo' }), /different game/);
});

test('Nuzlocke backup rejects malformed history and wrong-sized save bytes', () => {
  assert.throws(() => serializeNuzlockeBundle({ ...input, runState: { ...runState, mode: 'soullink' } }), /run history/);
  const data = serializeNuzlockeBundle(input);
  assert.throws(() => parseNuzlockeBundle(data, { ...input, saveBytesLength: 8 }), /must contain 8 bytes/);
});
