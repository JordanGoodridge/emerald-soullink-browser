// Persistent character customization store (localStorage) keyed by rigId +
// optional per-gameId slot overrides.

import {
  DEFAULT_RIG_ID,
  normalizeHexColor,
  resolveCharacterSchema,
} from './character-catalog.mjs';

export const CHARACTER_STORAGE_KEY = 'poketech.character.v1';

export function defaultCustomizationForSchema(schema = resolveCharacterSchema()) {
  const equipped = {};
  for (const slot of schema.clothingSlots ?? []) {
    equipped[slot.id] = slot.defaultItemId ?? slot.items?.[0]?.id ?? '';
  }
  const colors = {};
  for (const aspect of schema.colorAspects ?? []) {
    colors[aspect.id] = normalizeHexColor(aspect.defaultHex);
  }
  return {
    version: 1,
    rigId: schema.id ?? DEFAULT_RIG_ID,
    equipped,
    colors,
  };
}

export function normalizeCustomization(raw, schema = resolveCharacterSchema()) {
  const defaults = defaultCustomizationForSchema(schema);
  const input = raw && typeof raw === 'object' ? raw : {};
  const rawEquipped = input.equipped && typeof input.equipped === 'object' ? input.equipped : {};
  const rawColors = input.colors && typeof input.colors === 'object' ? input.colors : {};

  const equipped = {};
  for (const slot of schema.clothingSlots ?? []) {
    const requested = rawEquipped[slot.id];
    const valid = (slot.items ?? []).some((item) => item.id === requested);
    equipped[slot.id] = valid ? requested : defaults.equipped[slot.id];
  }

  const colors = {};
  for (const aspect of schema.colorAspects ?? []) {
    colors[aspect.id] = normalizeHexColor(rawColors[aspect.id], defaults.colors[aspect.id]);
  }

  return {
    version: 1,
    rigId: schema.id ?? DEFAULT_RIG_ID,
    equipped,
    colors,
  };
}

export function isDefaultCustomization(customization, schema = resolveCharacterSchema()) {
  const normalized = normalizeCustomization(customization, schema);
  const defaults = defaultCustomizationForSchema(schema);
  for (const [slotId, itemId] of Object.entries(defaults.equipped)) {
    if (normalized.equipped[slotId] !== itemId) return false;
  }
  for (const [aspectId, hex] of Object.entries(defaults.colors)) {
    if (normalized.colors[aspectId] !== hex) return false;
  }
  return true;
}

export function createCharacterStore({
  storage = globalThis.localStorage,
  key = CHARACTER_STORAGE_KEY,
} = {}) {
  function readEnvelope() {
    try {
      const raw = storage?.getItem?.(key);
      if (!raw) return { version: 1, rigs: {}, games: {} };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return { version: 1, rigs: {}, games: {} };
      return {
        version: 1,
        rigs: parsed.rigs && typeof parsed.rigs === 'object' ? { ...parsed.rigs } : {},
        games: parsed.games && typeof parsed.games === 'object' ? { ...parsed.games } : {},
      };
    } catch {
      return { version: 1, rigs: {}, games: {} };
    }
  }

  function writeEnvelope(envelope) {
    try {
      storage?.setItem?.(key, JSON.stringify(envelope));
    } catch {
      // Ignore storage quota / private mode failures.
    }
  }

  function load({ gameId = 'emerald', rigId = null, manifest = null } = {}) {
    const schema = resolveCharacterSchema({ gameId, rigId, manifest });
    const envelope = readEnvelope();
    const rigEntry = envelope.rigs?.[schema.id] ?? {};
    const gameEntry = gameId ? (envelope.games?.[gameId] ?? {}) : {};
    const merged = {
      equipped: {
        ...(rigEntry.equipped ?? {}),
        ...(gameEntry.equipped ?? {}),
      },
      colors: {
        ...(rigEntry.colors ?? {}),
        ...(gameEntry.colors ?? {}),
      },
    };
    return normalizeCustomization(merged, schema);
  }

  function save(customization, { gameId = 'emerald', rigId = null, manifest = null } = {}) {
    const schema = resolveCharacterSchema({ gameId, rigId, manifest });
    const normalized = normalizeCustomization(customization, schema);
    const envelope = readEnvelope();
    envelope.rigs[schema.id] = {
      equipped: { ...normalized.equipped },
      colors: { ...normalized.colors },
    };
    if (gameId) {
      envelope.games[gameId] = {
        equipped: { ...normalized.equipped },
        colors: { ...normalized.colors },
      };
    }
    writeEnvelope(envelope);
    return normalized;
  }

  function reset({ gameId = 'emerald', rigId = null, manifest = null } = {}) {
    const schema = resolveCharacterSchema({ gameId, rigId, manifest });
    const defaults = defaultCustomizationForSchema(schema);
    return save(defaults, { gameId, rigId: schema.id, manifest });
  }

  return {
    load,
    save,
    reset,
  };
}
