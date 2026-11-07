// Profile/slot-local history of moves observed on each Pokémon. Emerald's save
// format stores only the four current moves, so this sidecar preserves moves
// a Pokémon knew earlier without changing the native save block layout.

export const MOVE_HISTORY_VERSION = 1;

function personalityKey(value) {
  return Number.isInteger(value) && value >= 0 ? String(value >>> 0) : null;
}

function normalizeMoves(value, maxMoveId) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((move) => Number.isInteger(move) && move > 0 && move <= maxMoveId))];
}

function normalizeHistory(value, maxMoveId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== MOVE_HISTORY_VERSION
    || !value.pokemon || typeof value.pokemon !== 'object' || Array.isArray(value.pokemon)) {
    return { schemaVersion: MOVE_HISTORY_VERSION, pokemon: {} };
  }
  const pokemon = {};
  for (const [key, moves] of Object.entries(value.pokemon)) {
    if (!/^\d+$/.test(key)) continue;
    const normalized = normalizeMoves(moves, maxMoveId);
    if (normalized.length) pokemon[key] = normalized;
  }
  return { schemaVersion: MOVE_HISTORY_VERSION, pokemon };
}

export function createMoveHistoryStore({ storage = globalThis.localStorage, key, maxMoveId = 0xffff } = {}) {
  if (typeof key !== 'string' || !key) throw new Error('move history store requires a storage key');
  let current = { schemaVersion: MOVE_HISTORY_VERSION, pokemon: {} };
  try {
    const raw = storage?.getItem?.(key);
    if (raw) current = normalizeHistory(JSON.parse(raw), maxMoveId);
  } catch {
    current = { schemaVersion: MOVE_HISTORY_VERSION, pokemon: {} };
  }

  function persist() {
    try {
      storage?.setItem?.(key, JSON.stringify(current));
    } catch {
      // History remains available in-session if browser storage is unavailable.
    }
  }

  function get(personality) {
    const id = personalityKey(personality);
    return id ? [...(current.pokemon[id] ?? [])] : [];
  }

  function remember(personality, moves) {
    const id = personalityKey(personality);
    if (!id || !Array.isArray(moves)) return false;
    const previous = current.pokemon[id];
    let hasNew = false;
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      if (Number.isInteger(move) && move > 0 && move <= maxMoveId && (!previous || !previous.includes(move))) {
        hasNew = true;
        break;
      }
    }
    if (!hasNew) return false;
    const next = [...new Set([...(previous ?? []), ...normalizeMoves(moves, maxMoveId)])];
    if (previous && next.length === previous.length) return false;
    current.pokemon[id] = next;
    persist();
    return true;
  }

  return {
    key,
    get,
    remember,
    snapshot: () => structuredClone(current),
  };
}
