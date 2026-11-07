import test from 'node:test';
import assert from 'node:assert/strict';
import { starterChoicesForRun } from './starter-choices.mjs';

const pool = Array.from({ length: 12 }, (_, index) => index + 1);
const run = {
  runId: 'run-a',
  seed: 7182,
  localPlayerId: 'p1',
  options: { randomizeStarters: true },
};

test('randomized starter choices are deterministic per player and differ across players', () => {
  const choicesA = starterChoicesForRun(run, pool);
  const choicesB = starterChoicesForRun(structuredClone(run), pool);
  const choicesForPartner = starterChoicesForRun({ ...run, localPlayerId: 'p2' }, pool);
  assert.deepEqual(choicesA, choicesB);
  assert.equal(new Set(choicesA).size, 3);
  assert.notDeepEqual(choicesA, choicesForPartner);
  assert.notDeepEqual(choicesA, starterChoicesForRun({ ...run, seed: 7183 }, pool));
});

test('disabling starter randomization preserves the game-provided choices', () => {
  assert.deepEqual(starterChoicesForRun({ ...run, options: { randomizeStarters: false } }, pool, [277, 280, 283]), [277, 280, 283]);
});

test('there is no default choice and too-small random pools fail closed', () => {
  assert.throws(() => starterChoicesForRun(run, [1, 2]), /three distinct choices/);
  assert.throws(() => starterChoicesForRun({ options: {} }, pool), /authoritative run seed/);
});
