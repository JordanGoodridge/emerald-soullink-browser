// Player-facing customisation settings.
//
// Pure data: no DOM, storage or WASM dependencies. The store owns I/O and the
// shell owns rendering, so both stay testable with fakes.

export const SETTINGS_VERSION = 2;
export const SETTINGS_STORAGE_KEY = 'pokeemerald.settings.v1';

export const CONTROL_SCHEMES = Object.freeze(['arrows', 'wasd']);

const BOOLEAN_KEYS = Object.freeze([
  'peerNameTags',
  'peerIndicators',
  'peerIcons',
  'peopleMap',
  'partyShared',
  'soundMuted',
]);

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_VERSION,
  controlScheme: 'arrows',
  peerNameTags: true,
  peerIndicators: true,
  peerIcons: true,
  peopleMap: true,
  partyShared: true,
  soundMuted: false,
  soundVolume: 80,
});

export function normalizeControlScheme(value) {
  return CONTROL_SCHEMES.includes(value) ? value : DEFAULT_SETTINGS.controlScheme;
}

export function normalizeSoundVolume(value) {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.soundVolume;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

// Unknown keys are dropped, missing booleans fall back to defaults, and an
// unknown scheme falls back without discarding the rest of the object.
export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const settings = {
    schemaVersion: SETTINGS_VERSION,
    controlScheme: normalizeControlScheme(input.controlScheme),
    soundVolume: normalizeSoundVolume(input.soundVolume),
  };
  for (const key of BOOLEAN_KEYS) {
    settings[key] = typeof input[key] === 'boolean' ? input[key] : DEFAULT_SETTINGS[key];
  }
  return settings;
}

export function parseSettings(text) {
  if (typeof text !== 'string' || !text.trim()) return normalizeSettings(null);
  try {
    return normalizeSettings(JSON.parse(text));
  } catch {
    return normalizeSettings(null);
  }
}

export function serializeSettings(settings) {
  return JSON.stringify(normalizeSettings(settings));
}

export function settingsEqual(a, b) {
  return serializeSettings(a) === serializeSettings(b);
}

export const SETTINGS_BOOLEAN_KEYS = BOOLEAN_KEYS;
