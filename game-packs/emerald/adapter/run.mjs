// Emerald-only facts used by the shared run core. Engine-specific exports are
// optional until the WASM run-hook phase implements and advertises them.

const SECTION_PREFIX = 'emerald:section:';
const MAP_PREFIX = 'emerald:map:';
// Emerald keeps these retired Unown form IDs in NUM_SPECIES for legacy saves,
// but its source graphics intentionally map them to double question marks.
const OLD_UNOWN_SPECIES_FIRST = 252;
const OLD_UNOWN_SPECIES_LAST = 276;
export const EMERALD_MAX_MONEY = 999_999;
export const SAVE_BLOCK1_MONEY_OFFSET = 0x490;

export function createEmeraldRunAdapter({
  id = 'emerald',
  regionMap = null,
  trainerIdFromMemory = null,
  randomizer = { wild: true, trainers: true, gyms: true, starters: true },
  precedence = { gameOwns: [], pokeTechAdds: [], conflicts: [] },
} = {}) {
  const sectionPrefix = `${id}:section:`;
  const mapPrefix = `${id}:map:`;
  const giftPrefix = `${id}:gift:`;

  function sectionId(sample = {}, exports = null) {
    if (Number.isInteger(sample.sectionId) && sample.sectionId >= 0) return sample.sectionId;
    const exported = exports?.WasmRunMapSection?.();
    return Number.isInteger(exported) && exported >= 0 ? exported : null;
  }

  function areaKey(sample = {}, { exports = null, giftId = null, separateMethods = false } = {}) {
    if (giftId !== null && giftId !== undefined) return `${giftPrefix}${String(giftId)}`;
    const section = sectionId(sample, exports);
    if (section !== null) {
      const method = separateMethods && sample.encounterMethod ? `:${sample.encounterMethod}` : '';
      return `${sectionPrefix}${section}${method}`;
    }
    const world = sample.world ?? sample;
    if (Number.isInteger(world.mapGroup) && Number.isInteger(world.mapNum)) {
      return `${mapPrefix}${world.mapGroup}:${world.mapNum}`;
    }
    return null;
  }

  function areaLabel(key, sample = {}, exports = null) {
    if (key?.startsWith(giftPrefix)) return `Gift: ${key.slice(giftPrefix.length)}`;
    const section = sectionId(sample, exports);
    const entry = regionMap?.sections?.find((candidate) => candidate.id === section);
    if (entry?.name) return entry.name;
    return key ?? 'Unknown Emerald area';
  }

  function speciesTable(exports = null) {
    const count = exports?.WasmRunSpeciesCount?.();
    const readSpecies = exports?.WasmRunSpeciesAt;
    const readBst = typeof exports?.WasmRunSpeciesBst === 'function' ? exports.WasmRunSpeciesBst : null;
    const readIsLegendary = typeof exports?.WasmRunSpeciesIsLegendary === 'function' ? exports.WasmRunSpeciesIsLegendary : null;
    const readPowerTier = typeof exports?.WasmRunSpeciesPowerTier === 'function' ? exports.WasmRunSpeciesPowerTier : null;
    if (!Number.isInteger(count) || count < 1 || typeof readSpecies !== 'function') return [];
    const rows = [];
    for (let index = 0; index < count; index++) {
      const species = readSpecies(index);
      if (Number.isInteger(species) && species > 0
          && (species < OLD_UNOWN_SPECIES_FIRST || species > OLD_UNOWN_SPECIES_LAST)) {
        const row = { species };
        if (readBst) {
          const bst = readBst(species);
          if (Number.isInteger(bst) && bst > 0) row.bst = bst;
        }
        if (readIsLegendary) {
          row.isLegendary = Boolean(readIsLegendary(species));
        }
        if (readPowerTier) {
          const tier = readPowerTier(species);
          if (Number.isInteger(tier) && tier >= 0) row.tier = tier;
        }
        rows.push(row);
      }
    }
    return rows;
  }

  return {
    id,
    modes: ['nuzlocke', 'soullink'],
    areaKey,
    areaLabel,
    isWildArea(sample = {}) {
      return sample.activity === 'overworld' && sample.kind !== 'gift' && sample.kind !== 'static';
    },
    sectionId,
    isWorldValid(exports = null) {
      return Boolean(exports?.WasmPresenceValid?.());
    },
    regionMap,
    trainerIdFromMemory,
    loadSavedGame(exports = null) {
      return typeof exports?.WasmRunLoadBaseSave === 'function'
        && Boolean(exports.WasmRunLoadBaseSave());
    },
    speciesTable,
    // Emerald source constants: SPECIES_TREECKO, SPECIES_TORCHIC, SPECIES_MUDKIP.
    starterChoices: Object.freeze([277, 280, 283]),
    trainerKind(trainerId, exports = null) {
      const kind = exports?.WasmRunTrainerKind?.(trainerId);
      return ({ 1: 'normal', 2: 'gym', 3: 'elite', 4: 'champion' })[kind] ?? 'unknown';
    },
    gymAceLevel(index, exports = null) {
      const level = exports?.WasmRunGymAceLevel?.(index);
      return Number.isInteger(level) && level > 0 ? level : null;
    },
    quickStartFromBase({ starterSpecies, baseSaveBytes, loadBaseSave, exports = null, runFrames = () => {}, options = null } = {}) {
      if (!Number.isInteger(starterSpecies) || starterSpecies <= 0
          || baseSaveBytes?.byteLength !== 131072 || typeof loadBaseSave !== 'function'
          || typeof exports?.WasmRunLoadBaseSave !== 'function'
          || typeof exports?.WasmRunReplaceStarter !== 'function'
          || typeof exports?.WasmRunPartyCount !== 'function'
          || typeof exports?.WasmRunPartySpecies !== 'function'
          || typeof exports?.WasmRunGiveStarterPokeballs !== 'function'
          || typeof exports?.WasmRunQuickStartSave !== 'function') return false;
      loadBaseSave(baseSaveBytes);
      if (!exports.WasmRunLoadBaseSave()) return false;
      runFrames(180);
      if (!exports.WasmRunReplaceStarter(starterSpecies)) return false;
      // Ensure the post-Pokédex / Running Shoes story state is unlocked in the
      // loaded base save so the very first step onto Route 101 is an active,
      // catchable Nuzlocke/SoulLink encounter without a pre-Pokédex detour.
      if (typeof exports.FlagSet === 'function') {
        for (const flag of [
          0x860, // FLAG_SYS_POKEMON_GET
          0x52,  // FLAG_RESCUED_BIRCH
          0x74,  // FLAG_ADVENTURE_STARTED
          0x861, // FLAG_SYS_POKEDEX_GET
          0x8e4, // FLAG_RECEIVED_POKEDEX_FROM_BIRCH
          0x2d0, // FLAG_HIDE_ROUTE_101_BIRCH_ZIGZAGOON_BATTLE
          0x2bc, // FLAG_HIDE_ROUTE_101_BIRCH_STARTERS_BAG
          0x2ee, // FLAG_HIDE_ROUTE_101_ZIGZAGOON
          0x379, // FLAG_HIDE_LITTLEROOT_TOWN_BIRCHS_LAB_RIVAL
          0x2d3, // FLAG_HIDE_ROUTE_103_RIVAL
          0x82,  // FLAG_DEFEATED_RIVAL_ROUTE103
          0x8c0, // FLAG_SYS_B_DASH
          0x112, // FLAG_RECEIVED_RUNNING_SHOES
        ]) exports.FlagSet(flag);
      }
      if (typeof exports.FlagClear === 'function') {
        exports.FlagClear(0x2d1); // FLAG_HIDE_LITTLEROOT_TOWN_BIRCHS_LAB_BIRCH
        exports.FlagClear(0x2f8); // FLAG_HIDE_ROUTE_101_BOY
      }
      if (typeof exports.SetUnlockedPokedexFlags === 'function') {
        exports.SetUnlockedPokedexFlags();
      }
      if (typeof exports.EnableNationalPokedex === 'function') {
        exports.EnableNationalPokedex();
      }
      if (typeof exports.VarSet === 'function') {
        const starterIndex = starterSpecies === 277 ? 0 : starterSpecies === 280 ? 1 : starterSpecies === 283 ? 2 : starterSpecies % 3;
        exports.VarSet(0x4023, starterIndex); // VAR_STARTER_MON
        exports.VarSet(0x4092, 7); // VAR_LITTLEROOT_INTRO_STATE
        exports.VarSet(0x4050, 4); // VAR_LITTLEROOT_TOWN_STATE
        exports.VarSet(0x4084, 5); // VAR_BIRCH_LAB_STATE
        exports.VarSet(0x4060, 3); // VAR_ROUTE101_STATE
        exports.VarSet(0x408d, 4); // VAR_LITTLEROOT_RIVAL_STATE
        exports.VarSet(0x4051, 1); // VAR_OLDALE_TOWN_STATE
        exports.VarSet(0x40cd, 1); // VAR_CABLE_CLUB_TUTORIAL_STATE
      }
      if (typeof exports.SpeciesToNationalPokedexNum === 'function'
          && typeof exports.GetSetPokedexFlag === 'function') {
        const nationalDex = exports.SpeciesToNationalPokedexNum(starterSpecies);
        if (nationalDex > 0) {
          exports.GetSetPokedexFlag(nationalDex, 2); // FLAG_SET_SEEN
          exports.GetSetPokedexFlag(nationalDex, 3); // FLAG_SET_CAUGHT
        }
      }
      if (options?.infiniteMoney !== false) {
        if (typeof exports.WasmRunSetMoney === 'function') {
          exports.WasmRunSetMoney(EMERALD_MAX_MONEY);
        } else if (typeof exports.SetMoney === 'function' && exports.gSaveBlock1Ptr?.value && exports.memory?.buffer) {
          const saveBlock1Ptr = new DataView(exports.memory.buffer).getUint32(exports.gSaveBlock1Ptr.value, true);
          if (saveBlock1Ptr > 0) {
            exports.SetMoney(saveBlock1Ptr + SAVE_BLOCK1_MONEY_OFFSET, EMERALD_MAX_MONEY);
          }
        }
      }
      // Do not persist or enter gameplay if the engine didn't actually create
      // the selected species in the party. The native summary renders species 0
      // as a question mark, which otherwise looks like a successful quick-start.
      if (exports.WasmRunPartyCount() < 1
          || exports.WasmRunPartySpecies(0) !== starterSpecies) return false;
      if (!exports.WasmRunGiveStarterPokeballs()) return false;
      runFrames(1);
      return exports.WasmRunQuickStartSave() === 1;
    },
    saveSlot: 'soulrun',
    capabilities: Object.freeze({
      encounter: 'enforce',
      captureGate: 'enforce',
      faintRelease: 'enforce',
      reviveGate: 'enforce',
      linkedPcBoxing: 'enforce',
      quickStart: 'table',
      tracker: regionMap ? 'map-data' : 'none',
      randomizer: Object.freeze({
        wild: Boolean(randomizer?.wild),
        trainers: Boolean(randomizer?.trainers),
        gyms: Boolean(randomizer?.gyms),
        starters: Boolean(randomizer?.starters),
      }),
    }),
    precedence: Object.freeze({
      gameOwns: Object.freeze([...(precedence?.gameOwns ?? [])]),
      pokeTechAdds: Object.freeze([...(precedence?.pokeTechAdds ?? [])]),
      conflicts: Object.freeze([...(precedence?.conflicts ?? [])]),
    }),
  };
}

export function createRunAdapter(context = {}) {
  return createEmeraldRunAdapter({
    regionMap: context.regionMap ?? context.resources?.regionMap ?? null,
    trainerIdFromMemory: context.shared?.emeraldTrainerId ?? null,
  });
}
