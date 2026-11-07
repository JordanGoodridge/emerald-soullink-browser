import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmeraldPartyModel } from './party-emerald.mjs';

function fakeExports(party = []) {
  return {
    WasmRunPartyCount: () => party.length,
    WasmRunPartySpecies: (index) => party[index]?.species ?? 0,
    WasmRunPartyLevel: (index) => party[index]?.level ?? 0,
    WasmRunPartyHp: (index) => party[index]?.hp ?? 0,
  };
}

test('reads species, level and hp into a normalized party', () => {
  const model = createEmeraldPartyModel({
    exports: fakeExports([
      { species: 25, level: 18, hp: 42 },
      { species: 6, level: 40, hp: 120 },
    ]),
  });
  assert.deepEqual(model.read(), {
    availability: 'available',
    members: [
      { species: 25, speciesName: 'PIKACHU', level: 18, hp: 42 },
      { species: 6, speciesName: 'CHARIZARD', level: 40, hp: 120 },
    ],
    revision: 1,
  });
});

test('exposes pack-specific creature catalog helpers to shared UI', () => {
  const model = createEmeraldPartyModel({ exports: fakeExports([]) });
  assert.equal(model.speciesName(25), 'PIKACHU');
  assert.equal(model.moveName(1), 'POUND');
  assert.equal(model.moveName(9999), null);
  assert.equal(model.maxMoveId, 354);
});

test('owns game-specific move relearner access through the party adapter', () => {
  const calls = [];
  const model = createEmeraldPartyModel({ exports: {
    WasmRunPartyCount: () => 1,
    WasmRunPartySpecies: () => 25,
    WasmRunPartyLevel: () => 18,
    WasmRunPartyPidLo: () => 0x5678,
    WasmRunPartyPidHi: () => 0x1234,
    WasmRunPartyMove: (_index, slot) => slot + 1,
    WasmRunRelearnableMoveCount: () => 2,
    WasmRunRelearnableMoveAt: (_index, candidate) => candidate + 10,
    WasmRunSetPartyMove: (...args) => { calls.push(args); return 1; },
  } });
  assert.deepEqual(model.readMoveRelearnerMon(0), {
    index: 0,
    species: 25,
    level: 18,
    personality: 0x12345678,
    moves: [1, 2, 3, 4],
    levelUpMoves: [10, 11],
  });
  assert.equal(model.readMoveRelearnerMon(1), null);
  assert.equal(model.setMove(0, 2, 11), true);
  assert.deepEqual(calls, [[0, 2, 11]]);
});

test('remembers current moves through the pack adapter without shell export knowledge', () => {
  const remembered = [];
  const model = createEmeraldPartyModel({ exports: {
    WasmRunPartyCount: () => 1,
    WasmRunPartySpecies: () => 25,
    WasmRunPartyPidLo: () => 0x5678,
    WasmRunPartyPidHi: () => 0x1234,
    WasmRunPartyMove: (_index, slot) => slot + 2,
  } });
  model.rememberMoves({ remember: (...args) => remembered.push(args) });
  assert.deepEqual(remembered, [[0x12345678, [2, 3, 4, 5]]]);
});

test('skips empty slots and clamps to the shared party cap', () => {
  const party = Array.from({ length: 8 }, (_, index) => ({
    species: index < 3 ? index + 1 : 0,
    level: 5,
    hp: 10,
  }));
  const model = createEmeraldPartyModel({ exports: fakeExports(party) });
  assert.deepEqual(model.read(), {
    availability: 'available',
    members: [
      { species: 1, speciesName: 'BULBASAUR', level: 5, hp: 10 },
      { species: 2, speciesName: 'IVYSAUR', level: 5, hp: 10 },
      { species: 3, speciesName: 'VENUSAUR', level: 5, hp: 10 },
    ],
    revision: 1,
  });
});

test('an empty party is still available', () => {
  const model = createEmeraldPartyModel({ exports: fakeExports([]) });
  assert.deepEqual(model.read(), {
    availability: 'available',
    members: [],
    revision: 1,
  });
});

test('missing party exports fail closed to unavailable', () => {
  const model = createEmeraldPartyModel({ exports: {} });
  assert.deepEqual(model.read(), { availability: 'unavailable', members: [], revision: 0 });
  assert.deepEqual(createEmeraldPartyModel().read(), { availability: 'unavailable', members: [], revision: 0 });
});

test('revision advances only when the party changes', () => {
  const model = createEmeraldPartyModel({
    exports: fakeExports([{ species: 25, level: 18, hp: 42 }]),
  });
  assert.equal(model.read().revision, 1);
  assert.equal(model.read().revision, 1);
  model.bind(fakeExports([{ species: 25, level: 19, hp: 42 }]));
  assert.equal(model.read().revision, 2);
});
