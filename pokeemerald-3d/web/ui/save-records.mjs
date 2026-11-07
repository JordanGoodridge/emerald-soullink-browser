// Enumerate namespaced local save records for the library and save dialog.
//
// No network, DOM, WASM or lock dependencies: callers pass a Storage-like
// object. Invalid records are ignored rather than breaking the whole library.

import {
  SAVE_RECORD_PREFIX,
  SAVE_RECORD_SCHEMA_VERSION,
  parseSaveRecordKey,
} from '../save-store.mjs';

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function listLocalSaveRecords({ storage = globalThis.localStorage } = {}) {
  if (!storage) return [];
  const records = [];
  let length = 0;
  try {
    length = storage.length;
  } catch {
    return [];
  }
  for (let index = 0; index < length; index++) {
    let key;
    try {
      key = storage.key(index);
    } catch {
      continue;
    }
    const identity = parseSaveRecordKey(key);
    if (!identity) continue;
    let raw;
    try {
      raw = storage.getItem(key);
    } catch {
      continue;
    }
    if (!raw) continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (value?.schemaVersion !== SAVE_RECORD_SCHEMA_VERSION
      || value.gameId !== identity.gameId
      || value.formatId !== identity.formatId
      || value.formatVersion !== identity.formatVersion
      || value.profile !== identity.profile
      || value.slot !== identity.slot
      || typeof value.bytes !== 'string'
      || !value.bytes) {
      continue;
    }
    records.push({
      key,
      gameId: identity.gameId,
      formatId: identity.formatId,
      formatVersion: identity.formatVersion,
      profile: identity.profile,
      profileKey: identity.profileKey,
      slot: identity.slot,
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      bytes: value.bytes,
    });
  }
  return records;
}

export function latestRecordByGame(records) {
  const latest = new Map();
  for (const record of records || []) {
    const current = latest.get(record.gameId);
    if (!current || record.updatedAt > current.updatedAt) {
      latest.set(record.gameId, record);
    }
  }
  return latest;
}

export function latestRecordForProfile(records, gameId, profile = '') {
  let latest = null;
  for (const record of records || []) {
    if (record.gameId !== gameId || record.profile !== profile) continue;
    if (!latest || record.updatedAt > latest.updatedAt) latest = record;
  }
  return latest;
}

export function recordBytes(record) {
  if (!record?.bytes) return null;
  try {
    return decodeBase64(record.bytes);
  } catch {
    return null;
  }
}

export { SAVE_RECORD_PREFIX };
