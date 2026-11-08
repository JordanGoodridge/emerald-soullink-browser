// Emerald party reader.
//
// Reads the typed WASM party exports into the game-agnostic party model. The
// engine currently exports species, level and current HP per party slot;
// nickname and status are omitted until a C bridge exports them. Read-only:
// this never mutates saves or party state, and it is only called after a
// completed frame.

import {
  normalizePartyMember,
  PARTY_MAX_MEMBERS,
  partySignature,
} from '../../presence/party-model.mjs';
import { speciesName } from './species-names-emerald.mjs';
import { EMERALD_MOVE_NAMES, moveName } from './move-names-emerald.mjs';

export function createEmeraldPartyModel({
  exports = null,
  speciesNames = null,
  moveNames = null,
} = {}) {
  let wasm = exports;
  let revision = 0;
  // A null sentinel forces the first observed content (even an empty party) to
  // advance the revision, matching the world model's first-read epoch bump.
  let lastSignature = null;

  function resolveSpeciesName(id) {
    if (speciesNames && Object.prototype.hasOwnProperty.call(speciesNames, id)) {
      return speciesNames[id] ?? null;
    }
    return speciesName(id);
  }

  function resolveMoveName(id) {
    if (moveNames && Object.prototype.hasOwnProperty.call(moveNames, id)) {
      return moveNames[id] ?? null;
    }
    return moveName(id);
  }

  function bind(nextExports) {
    wasm = nextExports;
    lastSignature = null;
  }

  function read() {
    if (!wasm || typeof wasm.WasmRunPartyCount !== 'function') {
      return { availability: 'unavailable', members: [], revision };
    }

    const count = Math.max(0, Math.min(wasm.WasmRunPartyCount?.() ?? 0, PARTY_MAX_MEMBERS));
    const members = [];
    for (let index = 0; index < count; index++) {
      const species = wasm.WasmRunPartySpecies?.(index) ?? 0;
      if (!Number.isInteger(species) || species <= 0) continue;
      const member = normalizePartyMember({
        species,
        speciesName: resolveSpeciesName(species) ?? undefined,
        level: wasm.WasmRunPartyLevel?.(index) ?? null,
        hp: wasm.WasmRunPartyHp?.(index) ?? null,
      });
      if (!member) continue;
      members.push(member);
    }

    const signature = partySignature(members);
    if (signature !== lastSignature) {
      lastSignature = signature;
      revision++;
    }
    return { availability: 'available', members, revision };
  }

  function readMoveRelearnerMon(index) {
    if (!wasm || !Number.isInteger(index) || index < 0
      || index >= (wasm.WasmRunPartyCount?.() ?? 0)
      || typeof wasm.WasmRunPartyMove !== 'function') return null;
    const species = wasm.WasmRunPartySpecies?.(index) ?? 0;
    const level = wasm.WasmRunPartyLevel?.(index) ?? 0;
    const low = wasm.WasmRunPartyPidLo?.(index);
    const high = wasm.WasmRunPartyPidHi?.(index);
    if (!species || !level || !Number.isInteger(low) || !Number.isInteger(high)) return null;
    const personality = (((high & 0xffff) << 16) | (low & 0xffff)) >>> 0;
    const moves = Array.from({ length: 4 }, (_, slot) => wasm.WasmRunPartyMove(index, slot));
    const levelUpMoves = [];
    const candidateCount = wasm.WasmRunRelearnableMoveCount?.(index) ?? 0;
    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
      levelUpMoves.push(wasm.WasmRunRelearnableMoveAt(index, candidateIndex));
    }
    return { index, species, level, personality, moves, levelUpMoves };
  }

  function setMove(index, slot, move) {
    if (typeof wasm?.WasmRunSetPartyMove !== 'function') return false;
    return wasm.WasmRunSetPartyMove(index, slot, move) === 1;
  }

  function rememberMoves(store) {
    if (!store || typeof wasm?.WasmRunPartyCount !== 'function'
      || typeof wasm.WasmRunPartyMove !== 'function') return;
    const count = Math.max(0, Math.min(wasm.WasmRunPartyCount(), PARTY_MAX_MEMBERS));
    for (let index = 0; index < count; index++) {
      const species = wasm.WasmRunPartySpecies?.(index) ?? 0;
      const low = wasm.WasmRunPartyPidLo?.(index);
      const high = wasm.WasmRunPartyPidHi?.(index);
      if (!species || !Number.isInteger(low) || !Number.isInteger(high)) continue;
      const personality = (((high & 0xffff) << 16) | (low & 0xffff)) >>> 0;
      const moves = [
        wasm.WasmRunPartyMove(index, 0),
        wasm.WasmRunPartyMove(index, 1),
        wasm.WasmRunPartyMove(index, 2),
        wasm.WasmRunPartyMove(index, 3),
      ];
      store.remember(personality, moves);
    }
  }

  const mergedMoveIds = [
    ...Object.keys(EMERALD_MOVE_NAMES),
    ...Object.keys(moveNames ?? {}),
  ];

  return {
    bind,
    read,
    readMoveRelearnerMon,
    setMove,
    rememberMoves,
    speciesName: resolveSpeciesName,
    moveName: resolveMoveName,
    maxMoveId: mergedMoveIds.reduce((max, id) => Math.max(max, Number(id)), 0),
    get revision() { return revision; },
  };
}
