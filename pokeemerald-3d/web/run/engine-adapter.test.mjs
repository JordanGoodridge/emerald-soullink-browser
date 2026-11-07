import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunEngineHooks, RUN_KIND_GYM, RUN_KIND_STARTER, RUN_KIND_TRAINER, RUN_KIND_WILD } from './engine-adapter.mjs';

const species = Array.from({ length: 20 }, (_, index) => ({ species: index + 1 }));
const adapter = { speciesTable: () => species };

test('disabled hooks preserve original species and allow actions', () => {
  const hooks = createRunEngineHooks({ adapter, seed: 1 });
  assert.equal(hooks.WasmRunRandomSpecies(RUN_KIND_WILD, 382, 10, 0), 382);
  assert.equal(hooks.WasmRunAllowCapture(1, 25, 0, 0), 1);
  assert.equal(hooks.WasmRunAllowItemEffect(25, 0, 0, 83, 0), 1);
});

test('enabled hooks randomize wild, trainer, gym and starter species from shared pool', () => {
  const hooks = createRunEngineHooks({
    enabled: true, seed: 'emerald-chaos', adapter,
    options: { randomizeWild: true, randomizeTrainers: true, randomizeGyms: true, randomizeStarters: true },
  });
  for (const kind of [RUN_KIND_WILD, RUN_KIND_TRAINER, RUN_KIND_GYM, RUN_KIND_STARTER]) {
    const speciesId = hooks.WasmRunRandomSpecies(kind, 1, kind + 10, 0);
    assert.ok(speciesId >= 1 && speciesId <= 20);
  }
});

test('same run seed and encounter context use independent random streams per player', () => {
  const state = { status: 'active', members: [{ playerId: 'p1' }, { playerId: 'p2' }] };
  const outputsFor = (playerId) => {
    const hooks = createRunEngineHooks({
      enabled: true,
      seed: 'shared-run-seed',
      adapter,
      options: { randomizeWild: true, randomizeTrainers: true, randomizeGyms: true, randomizeStarters: true },
      getState: () => ({ ...state, localPlayerId: playerId }),
    });
    return [RUN_KIND_WILD, RUN_KIND_TRAINER, RUN_KIND_GYM, RUN_KIND_STARTER]
      .map((kind) => hooks.WasmRunRandomSpecies(kind, 1, 18, 3));
  };
  const playerOne = outputsFor('p1');
  const playerTwo = outputsFor('p2');
  assert.equal(playerOne.length, 4);
  assert.equal(playerTwo.length, 4);
  assert.ok(playerOne.every((species, index) => species !== playerTwo[index]), { playerOne, playerTwo });
  assert.ok(playerOne.every((species) => species >= 1 && species <= 20));
  assert.ok(playerTwo.every((species) => species >= 1 && species <= 20));
});

test('trainer and gym randomization can be independently toggled', () => {
  const hooks = createRunEngineHooks({
    enabled: true, seed: 2, adapter,
    options: { randomizeTrainers: false, randomizeGyms: false },
  });
  assert.equal(hooks.WasmRunRandomSpecies(RUN_KIND_TRAINER, 25, 1, 0), 25);
  assert.equal(hooks.WasmRunRandomSpecies(RUN_KIND_GYM, 25, 1, 0), 25);
});

test('power balance wild, trainer, and gym options operate independently and stay within similar-strength pools', () => {
  const tieredSpecies = [
    { species: 10, bst: 200 },
    { species: 11, bst: 205 },
    { species: 12, bst: 210 },
    { species: 13, bst: 215 },
    { species: 14, bst: 220 },
    { species: 100, bst: 420 },
    { species: 101, bst: 430 },
    { species: 102, bst: 440 },
    { species: 103, bst: 450 },
    { species: 104, bst: 460 },
    { species: 382, bst: 670, isLegendary: true },
  ];
  const tieredAdapter = { speciesTable: () => tieredSpecies };
  const hooks = createRunEngineHooks({
    enabled: true,
    seed: 'power-balance-seed',
    adapter: tieredAdapter,
    options: {
      randomizeWild: false,
      powerBalanceWild: true,
      randomizeTrainers: false,
      powerBalanceTrainers: true,
      randomizeGyms: false,
      powerBalanceGyms: false,
      dupesClause: true,
    },
    getState: () => ({
      status: 'active',
      localPlayerId: 'p1',
      ownedSpecies: { p1: [10, 11] },
    }),
  });

  // Wild encounters for species 10 (BST 200) stay in the low-BST pool [10..14] and respect Dupes Clause.
  for (let slot = 0; slot < 30; slot++) {
    const wildPick = hooks.WasmRunRandomSpecies(RUN_KIND_WILD, 10, 18, slot);
    assert.equal([12, 13, 14].includes(wildPick), true, `unexpected wild pick ${wildPick}`);
  }

  // Trainer battles for species 102 (BST 440) stay in the mid-BST pool [100..104].
  for (let slot = 0; slot < 30; slot++) {
    const trainerPick = hooks.WasmRunRandomSpecies(RUN_KIND_TRAINER, 102, 5, slot);
    assert.equal([100, 101, 102, 103, 104].includes(trainerPick), true, `unexpected trainer pick ${trainerPick}`);
  }

  // Gyms have both randomizeGyms and powerBalanceGyms false, so they keep vanilla species.
  assert.equal(hooks.WasmRunRandomSpecies(RUN_KIND_GYM, 102, 1, 0), 102);

  // Wild route 12-slot deduplication guarantees distinct species across slots 0..11 when pool >= 12.
  const widePool = Array.from({ length: 24 }, (_, idx) => ({ species: idx + 1, tier: 0 }));
  const wideHooks = createRunEngineHooks({
    enabled: true,
    seed: 'dedupe-route-seed',
    adapter: { speciesTable: () => widePool },
    options: { powerBalanceWild: true },
  });
  const routeSlots = Array.from({ length: 12 }, (_, slot) =>
    wideHooks.WasmRunRandomSpecies(RUN_KIND_WILD, 1, 18, slot));
  assert.equal(new Set(routeSlots).size, 12, `expected 12 unique species across route slots, got ${routeSlots}`);
});

test('host SoulLink PC policy blocks boxing a living link member unless enabled', () => {
  const linkState = {
    mode: 'soullink',
    localPlayerId: 'p1',
    links: {
      'link:route': {
        status: 'active',
        members: [
          { playerId: 'p1', pid: 42, status: 'alive' },
          { playerId: 'p2', pid: 84, status: 'alive' },
        ],
      },
    },
  };
  let blockedPid = null;
  const hooks = createRunEngineHooks({
    enabled: true,
    adapter,
    getOptions: () => ({ allowLinkedPcBoxing: false }),
    getState: () => linkState,
    onPcBoxBlocked: (event) => { blockedPid = event.pid; },
  });
  assert.equal(hooks.WasmRunAllowPcBoxing(42), 0);
  assert.equal(blockedPid, 42);
  assert.equal(hooks.WasmRunAllowPcBoxing(43), 1);

  const allowed = createRunEngineHooks({
    enabled: true,
    adapter,
    getOptions: () => ({ allowLinkedPcBoxing: true }),
    getState: () => linkState,
  });
  assert.equal(allowed.WasmRunAllowPcBoxing(42), 1);
});

test('wild true-random selection rerolls species already owned under optional clauses', () => {
  const runAdapter = createRunEngineHooks({
    enabled: true,
    seed: 31,
    adapter,
    options: { randomizeWild: true, dupesClause: true, partnerSpeciesClause: true },
    getState: () => ({
      status: 'active',
      localPlayerId: 'p1',
      ownedSpecies: { p1: [1, 2, 3], p2: [4, 5, 6] },
    }),
  });
  for (let slot = 0; slot < 80; slot++) {
    const speciesId = runAdapter.WasmRunRandomSpecies(RUN_KIND_WILD, 1, 18, slot);
    assert.equal([1, 2, 3, 4, 5, 6].includes(speciesId), false);
    assert.ok(speciesId >= 1 && speciesId <= 20);
  }
});

test('active run exposes gym cap, unlimited-candy, and infinite-money hooks', () => {
  const hooks = createRunEngineHooks({
    enabled: true, seed: 3, adapter, options: { infiniteRareCandies: true, infiniteMoney: true }, getGymCap: () => 15,
    allowItemEffect: ({ itemId, highestLivingPartyLevel, gymCap }) => itemId !== 83
      || highestLivingPartyLevel > 0 && gymCap > 0,
  });
  assert.equal(hooks.WasmRunInfiniteRareCandy(), 1);
  assert.equal(hooks.WasmRunInfiniteMoney(), 1);
  assert.equal(hooks.WasmRunAllowItemEffect(1, 0, 0, 83, 1, 5, 12, 15, 0), 1);
  assert.equal(hooks.WasmRunAllowItemEffect(1, 0, 0, 68, 1, 11, 12, 15, 1), 1);
  assert.equal(hooks.WasmRunAllowItemEffect(1, 0, 0, 68, 1, 12, 12, 15, 1), 0);
  assert.equal(hooks.WasmRunAllowItemEffect(1, 0, 0, 68, 1, 15, 12, 15, 1), 0);

  const syncOffHooks = createRunEngineHooks({
    enabled: true, seed: 3, adapter,
    options: { infiniteRareCandies: true, rareCandyPartyLevelCeiling: false, infiniteMoney: false },
    getGymCap: () => 15,
  });
  assert.equal(syncOffHooks.WasmRunInfiniteRareCandy(), 0);
  assert.equal(syncOffHooks.WasmRunInfiniteMoney(), 0);
  assert.equal(syncOffHooks.WasmRunAllowItemEffect(1, 0, 0, 68, 1, 11, 12, 15, 1), 0);
});

test('capture gates fail closed while the authoritative run channel is unavailable', () => {
  const hooks = createRunEngineHooks({
    enabled: true,
    seed: 5,
    adapter,
    isSynchronized: () => false,
  });
  assert.equal(hooks.WasmRunAllowCapture(1, 25, 0, 0), 0);
});

test('capture gate allows catching an already-claimed local first encounter during a transient reconnect', () => {
  const hooks = createRunEngineHooks({
    enabled: true,
    seed: 5,
    adapter: { ...adapter, areaKey: () => 'area:1' },
    isSynchronized: () => false,
    getState: () => ({
      status: 'active',
      localPlayerId: 'p1',
      ownedSpecies: { p1: [] },
      areas: { 'area:1': { status: 'pending', claims: { p1: { species: 25, status: 'claimed' } } } },
    }),
  });
  assert.equal(hooks.WasmRunAllowCapture(1, 25, 0, 0), 1);
  assert.equal(hooks.WasmRunAllowCapture(1, 26, 0, 0), 0);
});

test('capture gate rejects an owned species even if a claim is already present', () => {
  const hooks = createRunEngineHooks({
    enabled: true,
    seed: 5,
    adapter: { ...adapter, areaKey: () => 'area:1' },
    isSynchronized: () => true,
    options: { dupesClause: true },
    getState: () => ({
      status: 'active',
      localPlayerId: 'p1',
      ownedSpecies: { p1: [25] },
      areas: { 'area:1': { status: 'pending', claims: { p1: { species: 25, status: 'claimed' } } } },
    }),
  });
  assert.equal(hooks.WasmRunAllowCapture(1, 25, 0, 0), 0);
});
