// Namespaced save records with one-way legacy migration.
//
// A record is keyed by game, save format, format version, profile and slot. The
// save codec only validates/normalizes bytes; this module owns storage records,
// metadata and the migration path. The caller owns the Web Lock and the boot
// ordering.
//
// Legacy Emerald keys are read-only during migration. They are never deleted
// automatically and never overwrite an existing destination record.

import { normalizeSaveProfile } from './save-profiles.mjs';

export const SAVE_RECORD_SCHEMA_VERSION = 1;
export const SAVE_RECORD_PREFIX = 'pokeemerald.save.v2';
export const DEFAULT_SLOT = 'main';
export const DEFAULT_PROFILE_KEY = '~';

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function profileKeyFor(profile) {
  return normalizeSaveProfile(profile) || DEFAULT_PROFILE_KEY;
}

export function saveRecordKey({
  gameId,
  formatId,
  formatVersion,
  profile = '',
  slot = DEFAULT_SLOT,
}) {
  if (!gameId || !formatId) throw new Error('save record requires gameId and formatId');
  return [
    SAVE_RECORD_PREFIX,
    gameId,
    formatId,
    String(formatVersion),
    profileKeyFor(profile),
    slot,
  ].join('/');
}

export function parseSaveRecordKey(key) {
  if (typeof key !== 'string' || !key.startsWith(`${SAVE_RECORD_PREFIX}/`)) return null;
  const parts = key.slice(SAVE_RECORD_PREFIX.length + 1).split('/');
  if (parts.length !== 5) return null;
  const [gameId, formatId, version, profileKey, slot] = parts;
  if (!gameId || !formatId || !/^\d+$/.test(version) || !profileKey || !slot) return null;
  return {
    gameId,
    formatId,
    formatVersion: Number(version),
    profile: profileKey === DEFAULT_PROFILE_KEY ? '' : profileKey,
    profileKey,
    slot,
  };
}

export function legacySaveKey(template, profile = '') {
  const name = normalizeSaveProfile(profile);
  return name ? `${template}.${name}` : template;
}

function matchingLegacyKeys(templates, profile) {
  return [...new Set((templates || []).map((template) => legacySaveKey(template, profile)))];
}

export function createSaveStore({
  gameId,
  formatId,
  formatVersion,
  profile = '',
  slot = DEFAULT_SLOT,
  codec,
  storage = globalThis.localStorage,
  legacyStorageKeys = [],
  now = () => Date.now(),
} = {}) {
  if (!gameId) throw new Error('save store requires gameId');
  if (!formatId) throw new Error('save store requires formatId');
  if (!codec || typeof codec.validate !== 'function') throw new Error('save store requires a codec');

  const key = saveRecordKey({ gameId, formatId, formatVersion, profile, slot });
  const legacyKeys = matchingLegacyKeys(legacyStorageKeys, profile);
  let lastError = null;

  function readRecord() {
    let raw;
    try {
      raw = storage?.getItem(key);
    } catch (error) {
      lastError = { code: 'storage_read_failed', message: error.message };
      return null;
    }
    if (!raw) return null;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      lastError = { code: 'record_invalid', message: 'save record is not valid JSON' };
      return null;
    }
    if (record?.schemaVersion !== SAVE_RECORD_SCHEMA_VERSION
      || record.gameId !== gameId
      || record.formatId !== formatId
      || record.formatVersion !== formatVersion
      || record.profile !== normalizeSaveProfile(profile)
      || record.slot !== slot
      || typeof record.bytes !== 'string') {
      lastError = { code: 'record_invalid', message: 'save record metadata does not match this profile' };
      return null;
    }
    let bytes;
    try {
      bytes = base64ToBytes(record.bytes);
    } catch {
      lastError = { code: 'record_invalid', message: 'save record bytes are not valid base64' };
      return null;
    }
    const validation = codec.validate(bytes);
    if (!validation.ok) {
      lastError = { code: 'record_invalid', message: validation.reason };
      return null;
    }
    return { bytes, updatedAt: record.updatedAt ?? null };
  }

  function writeRecord(bytes) {
    const validation = codec.validate(bytes);
    if (!validation.ok) {
      lastError = { code: 'save_invalid', message: validation.reason };
      return false;
    }
    const record = {
      schemaVersion: SAVE_RECORD_SCHEMA_VERSION,
      gameId,
      formatId,
      formatVersion,
      profile: normalizeSaveProfile(profile),
      slot,
      updatedAt: now(),
      bytes: bytesToBase64(bytes),
    };
    try {
      storage?.setItem(key, JSON.stringify(record));
      lastError = null;
      return true;
    } catch (error) {
      lastError = { code: 'storage_write_failed', message: error.message };
      return false;
    }
  }

  function readLegacy() {
    for (const legacyKey of legacyKeys) {
      let raw;
      try {
        raw = storage?.getItem(legacyKey);
      } catch (error) {
        lastError = { code: 'legacy_read_failed', message: error.message };
        continue;
      }
      if (!raw) continue;
      let bytes;
      try {
        bytes = base64ToBytes(raw);
      } catch {
        lastError = { code: 'legacy_invalid', message: `${legacyKey} is not valid base64` };
        continue;
      }
      const normalized = codec.normalize ? codec.normalize(bytes) : bytes;
      if (!normalized) {
        lastError = { code: 'legacy_invalid', message: `${legacyKey} is not a recognized save` };
        continue;
      }
      const validation = codec.validate(normalized);
      if (!validation.ok) {
        lastError = { code: 'legacy_invalid', message: validation.reason };
        continue;
      }
      return { bytes: normalized, legacyKey };
    }
    return null;
  }

  function migrateLegacy() {
    const existing = readRecord();
    if (existing) return { bytes: existing.bytes, migrated: false, source: 'record' };
    const legacy = readLegacy();
    if (!legacy) return { bytes: null, migrated: false, source: null };
    const wrote = writeRecord(legacy.bytes);
    return {
      bytes: legacy.bytes,
      migrated: wrote,
      source: wrote ? 'legacy' : null,
      legacyKey: legacy.legacyKey,
      updatedAt: wrote ? now() : null,
    };
  }

  return {
    key,
    legacyKeys,
    slot,
    get lastError() { return lastError; },
    hasRecord() {
      try {
        return Boolean(storage?.getItem(key));
      } catch {
        return false;
      }
    },
    load() {
      const existing = readRecord();
      if (existing) return { ...existing, source: 'record', migrated: false };
      return migrateLegacy();
    },
    save(bytes) {
      return writeRecord(bytes);
    },
    flush(bytes) {
      return writeRecord(bytes);
    },
    importBytes(bytes) {
      const normalized = codec.normalize ? codec.normalize(bytes) : bytes;
      if (!normalized) {
        lastError = { code: 'import_invalid', message: 'save did not normalize to a recognized format' };
        return null;
      }
      return writeRecord(normalized) ? normalized : null;
    },
    exportRaw(bytes) {
      return codec.exportRaw ? codec.exportRaw(bytes) : new Uint8Array(bytes);
    },
  };
}
