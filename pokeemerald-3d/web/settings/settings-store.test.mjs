import test from 'node:test';
import assert from 'node:assert/strict';

import { createSettingsStore } from './settings-store.mjs';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from './settings-schema.mjs';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

test('store reads and normalizes stored settings', () => {
  const storage = fakeStorage({
    [SETTINGS_STORAGE_KEY]: JSON.stringify({ controlScheme: 'wasd', peerNameTags: false }),
  });
  const store = createSettingsStore({ storage });
  assert.equal(store.get().controlScheme, 'wasd');
  assert.equal(store.get().peerNameTags, false);
  assert.equal(store.get().peerIcons, true);
});

test('store falls back to defaults for corrupt storage', () => {
  const storage = fakeStorage({ [SETTINGS_STORAGE_KEY]: '{{{' });
  const store = createSettingsStore({ storage });
  assert.deepEqual(store.get(), { ...DEFAULT_SETTINGS });
});

test('set persists and notifies once per real change', () => {
  const storage = fakeStorage();
  const store = createSettingsStore({ storage });
  const seen = [];
  store.subscribe((settings) => seen.push(settings), { immediate: false });

  store.set({ controlScheme: 'wasd' });
  store.set({ controlScheme: 'wasd' });
  store.set({ peerIcons: false });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].controlScheme, 'wasd');
  assert.equal(seen[1].peerIcons, false);
  assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).controlScheme, 'wasd');
});

test('subscribe delivers the current value immediately and unsubscribes', () => {
  const store = createSettingsStore({ storage: fakeStorage() });
  const seen = [];
  const unsubscribe = store.subscribe((settings) => seen.push(settings.controlScheme));
  assert.deepEqual(seen, ['arrows']);
  unsubscribe();
  store.set({ controlScheme: 'wasd' });
  assert.deepEqual(seen, ['arrows']);
});

test('storage failures keep the in-session value', () => {
  const store = createSettingsStore({
    storage: {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('full'); },
    },
  });
  assert.deepEqual(store.get(), { ...DEFAULT_SETTINGS });
  const next = store.set({ peerNameTags: false });
  assert.equal(next.peerNameTags, false);
});

test('reset restores defaults and can skip persistence', () => {
  const storage = fakeStorage();
  const store = createSettingsStore({ storage });
  store.set({ controlScheme: 'wasd', peerIcons: false });
  const reset = store.reset();
  assert.deepEqual(reset, { ...DEFAULT_SETTINGS });
  assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)), { ...DEFAULT_SETTINGS });

  store.set({ controlScheme: 'wasd' }, { persist: false });
  assert.equal(store.get().controlScheme, 'wasd');
  assert.equal(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).controlScheme, 'arrows');
});

test('a throwing subscriber does not stop the others', () => {
  const store = createSettingsStore({ storage: fakeStorage() });
  const seen = [];
  store.subscribe(() => { throw new Error('boom'); }, { immediate: false });
  store.subscribe((settings) => seen.push(settings.controlScheme), { immediate: false });
  store.set({ controlScheme: 'wasd' });
  assert.deepEqual(seen, ['wasd']);
});

test('store normalizes soundMuted and soundVolume within 0..100 integer bounds', () => {
  const store = createSettingsStore({ storage: fakeStorage() });
  assert.equal(store.get().soundMuted, false);
  assert.equal(store.get().soundVolume, 80);

  store.set({ soundMuted: true, soundVolume: 42.6 });
  assert.equal(store.get().soundMuted, true);
  assert.equal(store.get().soundVolume, 43);

  store.set({ soundVolume: 150 });
  assert.equal(store.get().soundVolume, 100);

  store.set({ soundVolume: -25 });
  assert.equal(store.get().soundVolume, 0);

  store.set({ soundVolume: 'invalid' });
  assert.equal(store.get().soundVolume, 80);
});
