// Persisted customisation settings with a subscribe hook.
//
// Storage is injected so tests never touch localStorage, and a failing storage
// call must not break the running session: settings still apply until reload.

import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  normalizeSettings,
  parseSettings,
  serializeSettings,
  settingsEqual,
} from './settings-schema.mjs';

export function createSettingsStore({
  storage = globalThis.localStorage,
  key = SETTINGS_STORAGE_KEY,
  initial = null,
} = {}) {
  const listeners = new Set();
  let current = normalizeSettings(initial ?? readStored());

  function readStored() {
    try {
      return parseSettings(storage?.getItem?.(key) ?? '');
    } catch {
      return normalizeSettings(null);
    }
  }

  function get() {
    return { ...current };
  }

  function notify() {
    const value = get();
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        // A failing subscriber must not stop the others or the game loop.
      }
    }
  }

  function set(patch = {}, { persist = true } = {}) {
    const next = normalizeSettings({ ...current, ...patch });
    const changed = !settingsEqual(current, next);
    current = next;
    if (changed && persist) {
      try {
        storage?.setItem?.(key, serializeSettings(next));
      } catch {
        // Keep the in-session value when storage is unavailable or full.
      }
    }
    if (changed) notify();
    return get();
  }

  function subscribe(listener, { immediate = true } = {}) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    if (immediate) listener(get());
    return () => listeners.delete(listener);
  }

  function reset(options) {
    return set(DEFAULT_SETTINGS, options);
  }

  return {
    key,
    get,
    set,
    subscribe,
    reset,
  };
}
