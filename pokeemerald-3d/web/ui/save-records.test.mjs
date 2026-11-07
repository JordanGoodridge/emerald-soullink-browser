import test from 'node:test';
import assert from 'node:assert/strict';
import {
  latestRecordByGame,
  listLocalSaveRecords,
  recordBytes,
} from './save-records.mjs';

function fakeStorage(values) {
  const map = new Map(Object.entries(values));
  return {
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { return map.get(key) ?? null; },
  };
}

test('lists valid namespaced records and ignores malformed entries', () => {
  const key = 'pokeemerald.save.v2/emerald/emerald-flash-128k/1/~/main';
  const runKey = 'pokeemerald.save.v2/emerald/emerald-flash-128k/1/run/main';
  const storage = fakeStorage({
    [key]: JSON.stringify({
      schemaVersion: 1,
      gameId: 'emerald',
      formatId: 'emerald-flash-128k',
      formatVersion: 1,
      profile: '',
      slot: 'main',
      updatedAt: 100,
      bytes: 'AQID',
    }),
    [runKey]: JSON.stringify({
      schemaVersion: 1,
      gameId: 'emerald',
      formatId: 'emerald-flash-128k',
      formatVersion: 1,
      profile: 'run',
      slot: 'main',
      updatedAt: 200,
      bytes: 'BAUG',
    }),
    'pokeemerald.save.v2/bad': '{}',
  });

  const records = listLocalSaveRecords({ storage });
  assert.equal(records.length, 2);
  assert.equal(latestRecordByGame(records).get('emerald').profile, 'run');
  assert.deepEqual([...recordBytes(records[0])], [1, 2, 3]);
});
