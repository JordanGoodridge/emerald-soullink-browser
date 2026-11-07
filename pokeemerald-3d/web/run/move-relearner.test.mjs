import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMoveRelearnerChoices } from './move-relearner.mjs';

test('merges legal level-up moves and previously known moves without duplicates', () => {
  assert.deepEqual(buildMoveRelearnerChoices({
    currentMoves: [1, 2, 0, 0],
    levelUpMoves: [1, 3, 4, 3],
    rememberedMoves: [2, 4, 5],
    maxMoveId: 10,
  }), [
    { move: 3, source: 'level-up' },
    { move: 4, source: 'level-up' },
    { move: 5, source: 'previously known' },
  ]);
});

test('filters empty, invalid and out-of-range move IDs', () => {
  assert.deepEqual(buildMoveRelearnerChoices({
    levelUpMoves: [0, -1, 2, 356],
    rememberedMoves: [1, 70000],
    maxMoveId: 355,
  }), [
    { move: 2, source: 'level-up' },
    { move: 1, source: 'previously known' },
  ]);
});
