import assert from 'node:assert/strict';
import test from 'node:test';

import { createMoveHistoryStore } from './move-history.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('remembered moves are deduplicated per Pokémon and persisted', () => {
  const storage = memoryStorage();
  const first = createMoveHistoryStore({ storage, key: 'save/move-history', maxMoveId: 354 });
  assert.equal(first.remember(0x12345678, [1, 2, 2, 0, 355]), true);
  assert.deepEqual(first.get(0x12345678), [1, 2]);
  assert.equal(first.remember(0x12345678, [2, 1]), false);
  assert.equal(first.remember(0x12345678, [7]), true);

  const reloaded = createMoveHistoryStore({ storage, key: 'save/move-history', maxMoveId: 354 });
  assert.deepEqual(reloaded.get(0x12345678), [1, 2, 7]);
  assert.deepEqual(reloaded.get(0x87654321), []);
});

test('malformed history is ignored and invalid personality IDs are rejected', () => {
  const storage = memoryStorage();
  storage.setItem('save/move-history', '{not json');
  const store = createMoveHistoryStore({ storage, key: 'save/move-history' });
  assert.deepEqual(store.snapshot(), { schemaVersion: 1, pokemon: {} });
  assert.equal(store.remember(-1, [1]), false);
  assert.equal(store.remember(1, [0, -2, 3.4]), false);
});

test('history is isolated by the caller-provided save key', () => {
  const storage = memoryStorage();
  createMoveHistoryStore({ storage, key: 'emerald/profile-a/soulrun' }).remember(10, [1]);
  const other = createMoveHistoryStore({ storage, key: 'emerald/profile-b/soulrun' });
  assert.deepEqual(other.get(10), []);
});
