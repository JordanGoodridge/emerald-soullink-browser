import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOBBY_BUNDLE_FORMAT,
  LOBBY_BUNDLE_VERSION,
  parseLobbyBundle,
  serializeLobbyBundle,
  validateLobbyRecord,
} from './lobby-store.mjs';

const record = {
  format: LOBBY_BUNDLE_FORMAT,
  schemaVersion: LOBBY_BUNDLE_VERSION,
  roomCode: 'ABCD2345',
  hostPlayerId: 'host',
  revision: 3,
  members: [{ playerId: 'host', name: 'Ash' }, { playerId: 'guest', name: 'Misty' }],
  settings: { randomizeWild: true, randomizeStarters: false },
  runState: { runId: 'run-2', seed: 101, status: 'active' },
  slots: {
    'slot-1': { slotId: 'slot-1', ownerPlayerId: 'host', revision: 2, gameId: 'emerald', formatId: 'emerald-flash', formatVersion: 1, saveBytes: new Uint8Array([1, 2, 3, 4]) },
    'slot-2': { slotId: 'slot-2', ownerPlayerId: 'guest', revision: 1, gameId: null, formatId: null, formatVersion: null, saveBytes: null },
  },
  savedAt: 1234,
};

test('lobby backup round-trips shared run state and independent slot saves', async () => {
  const text = serializeLobbyBundle(record);
  const restored = await parseLobbyBundle(text, {
    validateSave: async ({ gameId, formatId, formatVersion, saveBytes }) =>
      gameId === 'emerald' && formatId === 'emerald-flash' && formatVersion === 1 && saveBytes.length === 4,
  });
  assert.deepEqual(restored.settings, record.settings);
  assert.deepEqual(restored.runState, record.runState);
  assert.deepEqual(restored.slots['slot-1'].saveBytes, new Uint8Array([1, 2, 3, 4]));
  assert.equal(restored.slots['slot-2'].saveBytes, null);
});

test('lobby backup rejects unsupported identity, malformed membership and invalid slot images', async () => {
  assert.throws(() => validateLobbyRecord({ ...record, roomCode: '../bad' }), /room code/);
  assert.throws(() => validateLobbyRecord({ ...record, members: [{ playerId: 'same' }, { playerId: 'same' }] }), /unique player IDs/);
  assert.throws(() => validateLobbyRecord({
    ...record,
    slots: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`slot-${index}`, { ownerPlayerId: null, revision: 0 }])),
  }), /one to four player slots/);
  assert.throws(() => validateLobbyRecord({
    ...record,
    slots: { 'slot-1': { ownerPlayerId: 'host', revision: -1, saveBytes: new Uint8Array([1]) } },
  }), /revision/);
  assert.throws(() => validateLobbyRecord({
    ...record,
    slots: {
      'slot-1': { ownerPlayerId: 'host', revision: 0 },
      'slot-2': { ownerPlayerId: 'host', revision: 0 },
    },
  }), /more than one lobby slot/);
  await assert.rejects(parseLobbyBundle(serializeLobbyBundle(record), {
    validateSave: async () => false,
  }), /failed game validation/);
  await assert.rejects(parseLobbyBundle(serializeLobbyBundle(record)), /validator is required/);
});

test('portable lobby backup rejects invalid JSON and unrecognized versions', async () => {
  await assert.rejects(parseLobbyBundle('{bad'), /not valid JSON/);
  const invalidVersion = JSON.parse(serializeLobbyBundle(record));
  invalidVersion.schemaVersion = 99;
  await assert.rejects(parseLobbyBundle(JSON.stringify(invalidVersion)), /unsupported/);
});

test('Standard lobby records keep per-player saves without shared run rules', () => {
  const standard = validateLobbyRecord({
    ...record,
    mode: 'standard',
    settings: {},
    runState: null,
  });
  assert.equal(standard.mode, 'standard');
  assert.equal(standard.runState, null);
  assert.equal(standard.slots['slot-1'].ownerPlayerId, 'host');
  assert.throws(() => validateLobbyRecord({ ...standard, runState: record.runState }), /cannot contain shared/);
});
