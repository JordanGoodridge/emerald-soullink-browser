import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAVE_STORAGE_PREFIX,
  listProfilesInUse,
  listStoredProfiles,
  normalizeSaveProfile,
  saveProfileFromStorageKey,
  saveProfileLabel,
  saveProfileUrl,
  saveStorageKeyFor,
} from './save-profiles.mjs';
import { SAVE_PROFILE_LOCK_PREFIX } from './save-profile-lock.mjs';

function fakeStorage(entries) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
  };
}

test('normalizeSaveProfile accepts safe names and rejects the rest', () => {
  assert.equal(normalizeSaveProfile('alice'), 'alice');
  assert.equal(normalizeSaveProfile('  co-op_2 '), 'co-op_2');
  assert.equal(normalizeSaveProfile(''), '');
  assert.equal(normalizeSaveProfile('has space'), '');
  assert.equal(normalizeSaveProfile('x'.repeat(25)), '');
  assert.equal(normalizeSaveProfile(null), '');
});

test('storage keys round-trip per profile', () => {
  assert.equal(saveStorageKeyFor(''), SAVE_STORAGE_PREFIX);
  assert.equal(saveStorageKeyFor('alice'), `${SAVE_STORAGE_PREFIX}.alice`);
  assert.equal(saveProfileFromStorageKey(SAVE_STORAGE_PREFIX), '');
  assert.equal(saveProfileFromStorageKey(`${SAVE_STORAGE_PREFIX}.alice`), 'alice');
  assert.equal(saveProfileFromStorageKey('unrelated.key'), null);
  assert.equal(saveProfileFromStorageKey(`${SAVE_STORAGE_PREFIX}.bad name`), null);
});

test('labels fall back to Default', () => {
  assert.equal(saveProfileLabel(''), 'Default');
  assert.equal(saveProfileLabel('alice'), 'alice');
});

test('listStoredProfiles reports saved and empty profiles, sorted', () => {
  const profiles = listStoredProfiles(fakeStorage({
    [SAVE_STORAGE_PREFIX]: 'AAAA',
    [`${SAVE_STORAGE_PREFIX}.zoe`]: '',
    [`${SAVE_STORAGE_PREFIX}.alice`]: 'BBBB',
    'pokeemerald.wasm.renderScale.v1': '4',
  }));
  assert.deepEqual(profiles, [
    { profile: '', hasSave: true },
    { profile: 'alice', hasSave: true },
    { profile: 'zoe', hasSave: false },
  ]);
});

test('listStoredProfiles survives disabled storage', () => {
  const hostile = {
    get length() { throw new Error('blocked'); },
    key() { throw new Error('blocked'); },
    getItem() { throw new Error('blocked'); },
  };
  assert.deepEqual(listStoredProfiles(hostile), []);
});

test('listProfilesInUse maps held and pending locks back to profiles', async () => {
  const locks = {
    query: async () => ({
      held: [
        { name: `${SAVE_PROFILE_LOCK_PREFIX}${SAVE_STORAGE_PREFIX}` },
        { name: `${SAVE_PROFILE_LOCK_PREFIX}${SAVE_STORAGE_PREFIX}.alice` },
      ],
      pending: [{ name: `${SAVE_PROFILE_LOCK_PREFIX}${SAVE_STORAGE_PREFIX}.bob` }],
    }),
  };
  const inUse = await listProfilesInUse(locks);
  assert.deepEqual([...inUse].sort(), ['', 'alice', 'bob']);
});

test('listProfilesInUse ignores unrelated locks and missing APIs', async () => {
  const locks = { query: async () => ({ held: [{ name: 'other-app' }], pending: [] }) };
  assert.equal((await listProfilesInUse(locks)).size, 0);
  assert.equal((await listProfilesInUse(undefined)).size, 0);
  assert.equal((await listProfilesInUse({ query: async () => { throw new Error('x'); } })).size, 0);
});

test('saveProfileUrl only changes the saveProfile parameter', () => {
  const base = 'https://example.test/?speed=2&presenceUrl=wss%3A%2F%2Frelay%2Fpresence';
  assert.equal(
    saveProfileUrl(base, 'alice'),
    'https://example.test/?speed=2&presenceUrl=wss%3A%2F%2Frelay%2Fpresence&saveProfile=alice',
  );
  assert.equal(
    saveProfileUrl('https://example.test/?saveProfile=alice&speed=2', ''),
    'https://example.test/?speed=2',
  );
  assert.equal(saveProfileUrl('https://example.test/?saveProfile=alice', 'bad name'), 'https://example.test/');
});
