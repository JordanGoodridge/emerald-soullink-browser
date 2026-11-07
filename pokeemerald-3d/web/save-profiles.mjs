// Save profile discovery and switching.
//
// A profile is the name in `?saveProfile=<name>`; it selects a separate flash
// image in localStorage. Two tabs must never write the same image, so profiles
// held by another tab are reported as unavailable.
//
// No DOM or WASM dependencies: callers pass the storage/locks objects and the
// current URL. Tests use fakes.

import { SAVE_PROFILE_LOCK_PREFIX } from './save-profile-lock.mjs';

export const SAVE_STORAGE_PREFIX = 'pokeemerald.wasm.flash.v1';
export const DEFAULT_PROFILE_LABEL = 'Default';
export const MAX_PROFILE_NAME_LENGTH = 24;

const PROFILE_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;

export function normalizeSaveProfile(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return PROFILE_PATTERN.test(name) ? name : '';
}

export function saveStorageKeyFor(profile) {
  const name = normalizeSaveProfile(profile);
  return name ? `${SAVE_STORAGE_PREFIX}.${name}` : SAVE_STORAGE_PREFIX;
}

export function saveProfileFromStorageKey(key) {
  if (key === SAVE_STORAGE_PREFIX) return '';
  if (typeof key !== 'string' || !key.startsWith(`${SAVE_STORAGE_PREFIX}.`)) return null;
  const name = key.slice(SAVE_STORAGE_PREFIX.length + 1);
  return normalizeSaveProfile(name) === name ? name : null;
}

export function saveProfileLabel(profile) {
  return normalizeSaveProfile(profile) || DEFAULT_PROFILE_LABEL;
}

// Profiles that have a flash image stored in this browser, newest name first.
export function listStoredProfiles(storage = globalThis.localStorage) {
  const found = new Map();
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      const profile = saveProfileFromStorageKey(key);
      if (profile === null) continue;
      const value = storage.getItem(key) || '';
      found.set(profile, { profile, hasSave: value.length > 0 });
    }
  } catch {
    // Storage may be disabled; report nothing rather than failing the dialog.
  }
  return [...found.values()].sort((a, b) => a.profile.localeCompare(b.profile));
}

// Profiles currently locked by any tab on this origin.
export async function listProfilesInUse(locks = globalThis.navigator?.locks) {
  const inUse = new Set();
  if (!locks || typeof locks.query !== 'function') return inUse;
  try {
    const state = await locks.query();
    for (const lock of [...(state?.held ?? []), ...(state?.pending ?? [])]) {
      const name = lock?.name;
      if (typeof name !== 'string' || !name.startsWith(SAVE_PROFILE_LOCK_PREFIX)) continue;
      const profile = saveProfileFromStorageKey(name.slice(SAVE_PROFILE_LOCK_PREFIX.length));
      if (profile !== null) inUse.add(profile);
    }
  } catch {
    // Query is best effort; an empty set still lets the user pick a profile.
  }
  return inUse;
}

export function saveProfileUrl(href, profile) {
  const url = new URL(href);
  const name = normalizeSaveProfile(profile);
  if (name) url.searchParams.set('saveProfile', name);
  else url.searchParams.delete('saveProfile');
  return url.toString();
}
