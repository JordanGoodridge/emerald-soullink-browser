// Run-mode configuration. The selected ruleset determines the isolated local save slot.

export const RUN_SETTINGS_VERSION = 2;
export const RUN_SETTINGS_STORAGE_KEY = 'pokeemerald.run.settings.v1';
export const RUN_MODES = Object.freeze(['standard', 'nuzlocke', 'soullink']);

export function saveSlotForMode(mode) {
  if (mode === 'soullink') return 'soulrun';
  if (mode === 'nuzlocke') return 'nuzlocke';
  return 'main';
}

const MODE_DEFAULTS = Object.freeze({
  standard: Object.freeze({}),
  nuzlocke: Object.freeze({
    dupesClause: false,
    randomizeWild: false,
    powerBalanceWild: false,
    randomizeTrainers: false,
    powerBalanceTrainers: false,
    randomizeGyms: false,
    powerBalanceGyms: false,
    randomizeStarters: false,
    skipIntro: false,
    gymLevelCap: false,
    infiniteRareCandies: false,
    rareCandyPartyLevelCeiling: false,
    infiniteMoney: false,
  }),
  soullink: Object.freeze({ allowLinkedPcBoxing: true }),
});

export function defaultRunSettingsForMode(mode) {
  const normalizedMode = RUN_MODES.includes(mode) ? mode : 'standard';
  return {
    ...DEFAULT_RUN_SETTINGS,
    ...MODE_DEFAULTS[normalizedMode],
    mode: normalizedMode,
    saveSlot: saveSlotForMode(normalizedMode),
  };
}

export const DEFAULT_RUN_SETTINGS = Object.freeze({
  schemaVersion: RUN_SETTINGS_VERSION,
  mode: 'standard',
  dupesClause: true,
  partnerSpeciesClause: false,
  allowLinkedPcBoxing: false,
  randomizeWild: true,
  powerBalanceWild: false,
  randomizeTrainers: true,
  powerBalanceTrainers: false,
  randomizeGyms: true,
  powerBalanceGyms: false,
  randomizeStarters: true,
  autoNewRunOnWipe: true,
  skipIntro: true,
  gymLevelCap: true,
  infiniteRareCandies: true,
  rareCandyPartyLevelCeiling: true,
  moveRelearner: true,
  infiniteMoney: true,
  saveSlot: 'main',
});

const BOOLEAN_KEYS = Object.freeze([
  'dupesClause',
  'partnerSpeciesClause',
  'allowLinkedPcBoxing',
  'randomizeWild',
  'powerBalanceWild',
  'randomizeTrainers',
  'powerBalanceTrainers',
  'randomizeGyms',
  'powerBalanceGyms',
  'randomizeStarters',
  'autoNewRunOnWipe',
  'skipIntro',
  'gymLevelCap',
  'infiniteRareCandies',
  'rareCandyPartyLevelCeiling',
  'moveRelearner',
  'infiniteMoney',
]);

export const MUTUALLY_EXCLUSIVE_RANDOMIZER_PAIRS = Object.freeze([
  Object.freeze(['randomizeWild', 'powerBalanceWild']),
  Object.freeze(['randomizeTrainers', 'powerBalanceTrainers']),
  Object.freeze(['randomizeGyms', 'powerBalanceGyms']),
]);

export function normalizeRunSettings(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = RUN_MODES.includes(input.mode) ? input.mode : DEFAULT_RUN_SETTINGS.mode;
  const defaults = defaultRunSettingsForMode(mode);
  const isLegacySettings = !Number.isSafeInteger(input.schemaVersion)
    || input.schemaVersion < RUN_SETTINGS_VERSION;
  const normalized = {
    schemaVersion: RUN_SETTINGS_VERSION,
    mode,
    saveSlot: saveSlotForMode(mode),
  };
  for (const key of BOOLEAN_KEYS) {
    const migratedLinkedBoxingDefault = key === 'allowLinkedPcBoxing'
      && mode === 'soullink' && isLegacySettings;
    normalized[key] = migratedLinkedBoxingDefault
      ? defaults[key]
      : typeof input[key] === 'boolean' ? input[key] : defaults[key];
  }
  for (const [randomKey, powerBalanceKey] of MUTUALLY_EXCLUSIVE_RANDOMIZER_PAIRS) {
    if (normalized[powerBalanceKey] === true) {
      normalized[randomKey] = false;
    }
  }
  return normalized;
}

export function parseRunSettings(text) {
  if (typeof text !== 'string' || !text.trim()) return normalizeRunSettings(null);
  try {
    return normalizeRunSettings(JSON.parse(text));
  } catch {
    return normalizeRunSettings(null);
  }
}

export function serializeRunSettings(settings) {
  return JSON.stringify(normalizeRunSettings(settings));
}
