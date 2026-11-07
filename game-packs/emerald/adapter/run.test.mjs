import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createEmeraldRunAdapter } from './run.mjs';
import { createWasmHelpers } from '../../../pokeemerald-3d/web/packs/shared/runtime-wasm.mjs';
import { starterChoicesForRun } from '../../../pokeemerald-3d/web/run/starter-choices.mjs';
import {
  createRunEngineHooks,
  RUN_KIND_CHAMPION,
  RUN_KIND_ELITE,
  RUN_KIND_GYM,
  RUN_KIND_STARTER,
  RUN_KIND_TRAINER,
  RUN_KIND_WILD,
} from '../../../pokeemerald-3d/web/run/engine-adapter.mjs';

test('Emerald encounter keys group submaps by region section and keep gifts explicit', () => {
  const adapter = createEmeraldRunAdapter({ regionMap: { sections: [{ id: 18, name: 'Route 101' }] } });
  assert.equal(adapter.areaKey({ sectionId: 18, encounterMethod: 'land' }), 'emerald:section:18');
  assert.equal(adapter.areaKey({ sectionId: 18, encounterMethod: 'water' }), 'emerald:section:18');
  assert.equal(adapter.areaKey({}, { giftId: 'starter' }), 'emerald:gift:starter');
  assert.equal(adapter.areaLabel('emerald:section:18', { sectionId: 18 }), 'Route 101');
});

test('Emerald adapter fails closed when run-only exports are missing', () => {
  const adapter = createEmeraldRunAdapter({ regionMap: { sections: [] } });
  assert.equal(adapter.sectionId({ world: { mapGroup: 0, mapNum: 1 } }), null);
  assert.deepEqual(adapter.speciesTable({}), []);
  assert.equal(adapter.trainerKind(265, {}), 'unknown');
  assert.equal(adapter.gymAceLevel(0, {}), null);
  assert.equal(adapter.isWorldValid({}), false);
  assert.equal(adapter.isWorldValid({ WasmPresenceValid: () => 1 }), true);
  assert.equal(adapter.capabilities.encounter, 'enforce');
});

test('Emerald adapter enumerates only source-declared species and maps trainer categories', () => {
  const adapter = createEmeraldRunAdapter();
  const exports = {
    WasmRunSpeciesCount: () => 3,
    WasmRunSpeciesAt: (index) => [1, 382, 386][index],
    WasmRunTrainerKind: (trainerId) => trainerId === 265 ? 2 : 1,
  };
  assert.deepEqual(adapter.speciesTable(exports), [{ species: 1 }, { species: 382 }, { species: 386 }]);
  assert.equal(adapter.trainerKind(265, exports), 'gym');
  assert.equal(adapter.trainerKind(1, exports), 'normal');
});

test('Emerald species table uses internal species IDs through Chimecho, not the National Dex count', () => {
  const adapter = createEmeraldRunAdapter();
  const species = adapter.speciesTable({
    WasmRunSpeciesCount: () => 411,
    WasmRunSpeciesAt: (index) => index + 1,
  });
  assert.equal(species.length, 386);
  assert.deepEqual(species[0], { species: 1 });
  assert.deepEqual(species.at(-1), { species: 411 });
  assert.equal(species.some(({ species: id }) => id >= 252 && id <= 276), false);
  assert.deepEqual(adapter.starterChoices, [277, 280, 283]);
  for (let seed = 1; seed <= 250; seed++) {
    const choices = starterChoicesForRun({ seed, runId: `audit-${seed}`, localPlayerId: 'p1', options: { randomizeStarters: true } }, species);
    assert.equal(choices.length, 3);
    assert.equal(choices.some((id) => id >= 252 && id <= 276), false);
  }
});

test('Emerald filters retired question-mark Unown IDs from even a malformed species export', () => {
  const adapter = createEmeraldRunAdapter();
  const species = adapter.speciesTable({
    WasmRunSpeciesCount: () => 5,
    WasmRunSpeciesAt: (index) => [251, 252, 276, 277, 411][index],
  });
  assert.deepEqual(species, [{ species: 251 }, { species: 277 }, { species: 411 }]);
});

test('Emerald wild, trainer, boss and starter randomization never generates retired Unown placeholders', () => {
  const adapter = createEmeraldRunAdapter();
  const exports = {
    WasmRunSpeciesCount: () => 411,
    WasmRunSpeciesAt: (index) => index + 1,
  };
  const hooks = createRunEngineHooks({
    enabled: true,
    seed: 'emerald-species-audit',
    adapter,
    exports,
    options: { randomizeWild: true, randomizeTrainers: true, randomizeGyms: true, randomizeStarters: true },
  });
  for (const kind of [RUN_KIND_WILD, RUN_KIND_TRAINER, RUN_KIND_GYM, RUN_KIND_ELITE, RUN_KIND_CHAMPION, RUN_KIND_STARTER]) {
    for (let context = 0; context < 100; context++) {
      const species = hooks.WasmRunRandomSpecies(kind, 1, context, context + 1);
      assert.ok(species >= 1 && species <= 411);
      assert.equal(species >= 252 && species <= 276, false, `kind ${kind} generated retired species ${species}`);
    }
  }
});

test('Emerald SoulLink quick-start loads the base save, replaces only the starter, and saves', () => {
  const adapter = createEmeraldRunAdapter();
  const calls = [];
  const result = adapter.quickStartFromBase({
    starterSpecies: 382,
    baseSaveBytes: new Uint8Array(131072),
    loadBaseSave(bytes) { calls.push(['base', bytes.byteLength]); },
    exports: {
      WasmRunLoadBaseSave() { calls.push('load-save'); return 1; },
      WasmRunReplaceStarter(species) { calls.push(['replace-starter', species]); return 1; },
      WasmRunSetMoney(amount) { calls.push(['set-money', amount]); return amount; },
      WasmRunPartyCount() { return 1; },
      WasmRunPartySpecies() { return 382; },
      WasmRunGiveStarterPokeballs() { calls.push('give-five-pokeballs'); return 1; },
      WasmRunQuickStartSave() { calls.push('save'); return 1; },
    },
    runFrames(frames) { calls.push(['frames', frames]); },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, [
    ['base', 131072], 'load-save', ['frames', 180], ['replace-starter', 382],
    ['set-money', 999999], 'give-five-pokeballs', ['frames', 1], 'save',
  ]);
});

test('Emerald SoulLink quick-start skips presetting max money when infiniteMoney is disabled', () => {
  const adapter = createEmeraldRunAdapter();
  const calls = [];
  const result = adapter.quickStartFromBase({
    starterSpecies: 382,
    baseSaveBytes: new Uint8Array(131072),
    loadBaseSave(bytes) { calls.push(['base', bytes.byteLength]); },
    options: { infiniteMoney: false },
    exports: {
      WasmRunLoadBaseSave() { calls.push('load-save'); return 1; },
      WasmRunReplaceStarter(species) { calls.push(['replace-starter', species]); return 1; },
      WasmRunSetMoney(amount) { calls.push(['set-money', amount]); return amount; },
      WasmRunPartyCount() { return 1; },
      WasmRunPartySpecies() { return 382; },
      WasmRunGiveStarterPokeballs() { calls.push('give-five-pokeballs'); return 1; },
      WasmRunQuickStartSave() { calls.push('save'); return 1; },
    },
    runFrames(frames) { calls.push(['frames', frames]); },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, [
    ['base', 131072], 'load-save', ['frames', 180], ['replace-starter', 382],
    'give-five-pokeballs', ['frames', 1], 'save',
  ]);
});

test('Emerald SoulLink quick-start refuses to save if the selected starter was not created', () => {
  const adapter = createEmeraldRunAdapter();
  let saved = false;
  const result = adapter.quickStartFromBase({
    starterSpecies: 382,
    baseSaveBytes: new Uint8Array(131072),
    loadBaseSave() {},
    exports: {
      WasmRunLoadBaseSave() { return 1; },
      WasmRunReplaceStarter() { return 1; },
      WasmRunPartyCount() { return 1; },
      WasmRunPartySpecies() { return 0; },
      WasmRunGiveStarterPokeballs() { return 1; },
      WasmRunQuickStartSave() { saved = true; return 1; },
    },
  });
  assert.equal(result, false);
  assert.equal(saved, false);
});

test('Emerald SoulLink quick-start fails closed when the base save or exports are missing', () => {
  const adapter = createEmeraldRunAdapter();
  assert.equal(adapter.quickStartFromBase({ starterSpecies: 252, baseSaveBytes: new Uint8Array(10) }), false);
});

test('WASM party level sync and capture auto-level respect highest living party level, Gym cap, evolution, and lobby toggle', async () => {
  const wasmUrl = new URL('../../../pokeemerald-3d/build/wasm/pokeemerald.wasm', import.meta.url);
  const savUrl = new URL('../resources/soullink-base.sav', import.meta.url);
  const wasmBytes = await fs.readFile(wasmUrl);
  const mod = await WebAssembly.compile(wasmBytes);
  let views = null;
  let exportsRef = null;
  let opts = {
    gymLevelCap: true,
    infiniteRareCandies: true,
    rareCandyPartyLevelCeiling: true,
    moveRelearner: true,
  };
  const hooks = createRunEngineHooks({
    enabled: () => true,
    seed: 's',
    adapter: createEmeraldRunAdapter(),
    getExports: () => exportsRef,
    getOptions: () => opts,
    getState: () => ({
      status: 'active',
      localPlayerId: 'p1',
      ownedSpecies: { p1: [] },
      areas: {
        'emerald:section:0': {
          status: 'pending',
          claims: { p1: { playerId: 'p1', species: 263, status: 'claimed' } },
        },
      },
    }),
    isSynchronized: () => true,
  });
  const helpers = createWasmHelpers(() => views);
  const inst = await WebAssembly.instantiate(mod, helpers.createImports(mod, { runHooks: hooks }));
  exportsRef = inst.exports;
  const b = exportsRef.memory.buffer;
  views = { u8: new Uint8Array(b), u16: new Uint16Array(b), u32: new Uint32Array(b) };
  views.u16[0x04000130 >> 1] = 0x03ff;
  exportsRef.AgbMain();
  const sav = await fs.readFile(savUrl);
  views.u8.set(sav, 0x0e000000);
  assert.equal(exportsRef.WasmRunLoadBaseSave(), 1);
  for (let i = 0; i < 60; i++) exportsRef.WasmRunFrame();
  assert.equal(exportsRef.WasmRunReplaceStarter(277), 1);

  assert.equal(exportsRef.WasmRunDebugAddPartyMon(280, 5, 0x11112222), 1);
  assert.equal(exportsRef.WasmRunDebugAddPartyMon(283, 18, 0x33334444), 1);
  exportsRef.WasmRunProcessSafePoint(0);
  assert.equal(exportsRef.WasmRunPartyLevel(0), 15);
  assert.equal(exportsRef.WasmRunPartyLevel(1), 15);
  assert.equal(exportsRef.WasmRunPartySpecies(1), 280);

  assert.equal(exportsRef.WasmRunTestCreateWildMon(263, 3, 0), 1);
  assert.notEqual(exportsRef.WasmRunDebugAcceptWildCapture(), 2);
  assert.equal(exportsRef.WasmRunPartyLevel(3), 15);

  assert.equal(exportsRef.WasmRunDebugSetBadgeCount(1), 19);
  exportsRef.WasmRunProcessSafePoint(0);
  assert.equal(exportsRef.WasmRunPartyLevel(1), 18);
  assert.equal(exportsRef.WasmRunPartySpecies(1), 281);

  opts = { ...opts, rareCandyPartyLevelCeiling: false, infiniteRareCandies: false };
  assert.equal(exportsRef.WasmRunDebugAddPartyMon(263, 4, 0x55556666), 1);
  exportsRef.WasmRunProcessSafePoint(0);
  assert.equal(exportsRef.WasmRunPartyLevel(4), 4);
});

test('Wally tutorial party swap preserves player starter even if a save or safe-point occurs mid-tutorial', async () => {
  const wasmUrl = new URL('../../../pokeemerald-3d/build/wasm/pokeemerald.wasm', import.meta.url);
  const wasmBytes = await fs.readFile(wasmUrl);
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const adapter = createEmeraldRunAdapter();

  let views = null;
  let exportsRef = null;
  const hooks = createRunEngineHooks({
    enabled: () => true,
    seed: 'wally-tutorial-test',
    adapter,
    getExports: () => exportsRef,
  });

  const helpers = createWasmHelpers(() => views);
  const instance = await WebAssembly.instantiate(wasmModule, helpers.createImports(wasmModule, { runHooks: hooks }));
  exportsRef = instance.exports;
  const buf = exportsRef.memory.buffer;
  views = {
    u8: new Uint8Array(buf),
    u16: new Uint16Array(buf),
    u32: new Uint32Array(buf),
  };

  assert.equal(exportsRef.SetSaveBlocksPointers !== undefined, true);
  // Verify WASM BST and Legendary exports for UPR-ZX Similar Strength:
  assert.equal(exportsRef.WasmRunSpeciesBst(288), 240); // SPECIES_ZIGZAGOON (288) = 240
  assert.equal(exportsRef.WasmRunSpeciesBst(383), 430); // SPECIES_LAIRON (383) = 430
  assert.equal(exportsRef.WasmRunSpeciesBst(303), 283); // SPECIES_SHEDINJA (303): 236 * 6 / 5 = 283
  assert.equal(exportsRef.WasmRunSpeciesIsLegendary(288), 0);
  assert.equal(exportsRef.WasmRunSpeciesIsLegendary(404), 1); // SPECIES_KYOGRE (404)
  assert.equal(exportsRef.WasmRunSpeciesIsLegendary(406), 1); // SPECIES_RAYQUAZA (406)
  assert.equal(exportsRef.WasmRunSpeciesPowerTier(288), 0); // Zigzagoon -> Unevolved (Tier 0)
  assert.equal(exportsRef.WasmRunSpeciesPowerTier(58), 0);  // Growlithe -> Unevolved (Tier 0)
  assert.equal(exportsRef.WasmRunSpeciesPowerTier(382), 0); // Aron -> Unevolved (Tier 0)
  assert.equal(exportsRef.WasmRunSpeciesPowerTier(383), 1); // Lairon -> Mid-stage (Tier 1)
  assert.equal(exportsRef.WasmRunSpeciesPowerTier(278), 1); // Grovyle -> Mid-stage (Tier 1)
  assert.equal(exportsRef.WasmRunSpeciesPowerTier(384), 2); // Aggron -> Fully evolved (Tier 2)
  assert.equal(exportsRef.WasmRunSpeciesPowerTier(404), 3); // Kyogre -> Legendary (Tier 3)
  assert.equal(exportsRef.WasmBattleHudCount(), 0);         // Outside battle -> 0 HUD entries

  exportsRef.SetSaveBlocksPointers(0);
  exportsRef.ZeroPlayerPartyMons();
  assert.equal(exportsRef.WasmRunDebugAddPartyMon(277, 5, 0x12345678), 1); // Treecko Lv 5
  const starterPidLo = exportsRef.WasmRunPartyPidLo(0);
  const starterPidHi = exportsRef.WasmRunPartyPidHi(0);
  assert.equal(exportsRef.WasmCanSaveGame(), 1);

  // PetalburgCity_EventScript_WallyTutorial: SavePlayerParty -> LoadWallyZigzagoon
  exportsRef.SavePlayerParty();
  exportsRef.LoadWallyZigzagoon();

  // Out-of-band saves are blocked while Wally's Zigzagoon is active, and WASM party
  // readers still report the player's real starter rather than Wally's Zigzagoon.
  assert.equal(exportsRef.WasmCanSaveGame(), 0);
  assert.equal(exportsRef.WasmRunPartySpecies(0), 277);
  assert.equal(exportsRef.WasmRunPartyPidLo(0), starterPidLo);
  assert.equal(exportsRef.WasmRunPartyPidHi(0), starterPidHi);

  // Even if CopyPartyAndObjectsToSave() and WasmRunProcessSafePoint(0) run mid-tutorial,
  // SaveBlock1 and LoadPlayerParty must restore the real starter, never Zigzagoon.
  exportsRef.CopyPartyAndObjectsToSave();
  exportsRef.WasmRunProcessSafePoint(0);
  exportsRef.LoadPlayerParty();

  assert.equal(exportsRef.WasmCanSaveGame(), 1);
  assert.equal(exportsRef.WasmRunPartyCount(), 1);
  assert.equal(exportsRef.WasmRunPartySpecies(0), 277);
  assert.equal(exportsRef.WasmRunPartyLevel(0), 5);
  assert.equal(exportsRef.WasmRunPartyPidLo(0), starterPidLo);
  assert.equal(exportsRef.WasmRunPartyPidHi(0), starterPidHi);
});
