import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSaveStore,
  legacySaveKey,
  parseSaveRecordKey,
  saveRecordKey,
} from './save-store.mjs';

const codec = {
  formatId: 'test-flash',
  formatVersion: 1,
  validate(bytes) {
    return bytes.length === 4
      ? { ok: true }
      : { ok: false, reason: 'expected 4 bytes' };
  },
  normalize(bytes) {
    return bytes.length === 4 ? bytes : null;
  },
  exportRaw(bytes) {
    return new Uint8Array(bytes);
  },
};

function fakeStorage(initial = {}, { failWrites = false } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) {
      if (failWrites) throw new Error('quota exceeded');
      map.set(key, value);
    },
    removeItem(key) { map.delete(key); },
  };
}

function store(storage, overrides = {}) {
  return createSaveStore({
    gameId: 'emerald',
    formatId: 'test-flash',
    formatVersion: 1,
    profile: '',
    codec,
    storage,
    legacyStorageKeys: ['pokeemerald.wasm.flash.v1'],
    ...overrides,
  });
}

test('save record keys namespace game, format, version, profile and slot', () => {
  assert.equal(
    saveRecordKey({ gameId: 'emerald', formatId: 'emerald-flash-128k', formatVersion: 1 }),
    'pokeemerald.save.v2/emerald/emerald-flash-128k/1/~/main',
  );
  assert.equal(
    saveRecordKey({ gameId: 'emerald-kaizo', formatId: 'kaizo-flash', formatVersion: 1, profile: 'ash' }),
    'pokeemerald.save.v2/emerald-kaizo/kaizo-flash/1/ash/main',
  );
  assert.deepEqual(parseSaveRecordKey('pokeemerald.save.v2/emerald/flash/1/~/main'), {
    gameId: 'emerald',
    formatId: 'flash',
    formatVersion: 1,
    profile: '',
    profileKey: '~',
    slot: 'main',
  });
  assert.equal(parseSaveRecordKey('pokeemerald.wasm.flash.v1'), null);
});

test('saves and loads a record with the same profile', () => {
  const storage = fakeStorage();
  const first = store(storage, { profile: 'ash', now: () => 1234 });
  assert.equal(first.save(new Uint8Array([1, 2, 3, 4])), true);
  assert.equal(first.load().bytes.length, 4);
  assert.equal(first.load().updatedAt, 1234);
  assert.deepEqual([...first.load().bytes], [1, 2, 3, 4]);

  const second = store(storage, { profile: 'misty' });
  assert.equal(second.hasRecord(), false);
  assert.equal(second.load().bytes, null);

  const kaizo = store(storage, { gameId: 'emerald-kaizo', formatId: 'kaizo-flash', profile: 'ash' });
  assert.equal(kaizo.hasRecord(), false);
});

test('migrates a legacy Emerald key once and keeps it', () => {
  const legacyKey = legacySaveKey('pokeemerald.wasm.flash.v1', 'ash');
  const storage = fakeStorage({ [legacyKey]: 'AQIDBA==' });
  const save = store(storage, { profile: 'ash' });
  const loaded = save.load();
  assert.equal(loaded.source, 'legacy');
  assert.equal(loaded.migrated, true);
  assert.deepEqual([...loaded.bytes], [1, 2, 3, 4]);
  assert.equal(storage.map.has(legacyKey), true);
  assert.equal(save.hasRecord(), true);

  const again = save.load();
  assert.equal(again.source, 'record');
  assert.equal(again.migrated, false);
});

test('a destination record wins over legacy bytes', () => {
  const legacyKey = legacySaveKey('pokeemerald.wasm.flash.v1', '');
  const storage = fakeStorage({ [legacyKey]: 'AQIDBA==' });
  const save = store(storage);
  assert.equal(save.save(new Uint8Array([9, 9, 9, 9])), true);
  assert.deepEqual([...save.load().bytes], [9, 9, 9, 9]);
  assert.equal(storage.map.has(legacyKey), true);
});

test('invalid records and failed writes are visible', () => {
  const storage = fakeStorage({}, { failWrites: true });
  const save = store(storage);
  assert.equal(save.save(new Uint8Array([1, 2, 3, 4])), false);
  assert.equal(save.lastError.code, 'storage_write_failed');
  assert.equal(save.importBytes(new Uint8Array([1, 2])), null);
  assert.equal(save.lastError.code, 'import_invalid');
  assert.equal(save.importBytes(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(save.lastError.code, 'storage_write_failed');
});

test('record metadata must match the store identity', () => {
  const storage = fakeStorage();
  const save = store(storage);
  const key = storage.map.size === 0 ? save.key : save.key;
  storage.map.set(key, JSON.stringify({
    schemaVersion: 1,
    gameId: 'other-game',
    formatId: 'test-flash',
    formatVersion: 1,
    profile: '',
    slot: 'main',
    bytes: 'AQIDBA==',
  }));
  assert.equal(save.load().bytes, null);
  assert.equal(save.lastError.code, 'record_invalid');
});
