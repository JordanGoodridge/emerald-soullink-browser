import assert from 'node:assert/strict';
import test from 'node:test';

import { createRoomScopedFloor } from './lobby-broadcast.mjs';

test('a fresh floor broadcasts the first authority it sees', () => {
  const floor = createRoomScopedFloor();
  assert.equal(floor.revisionFor('ABCD2345'), -1);
  assert.equal(floor.shouldBroadcast('ABCD2345', 0), true);
  assert.equal(floor.shouldBroadcast('ABCD2345', 13), true);
});

test('the floor suppresses repeats inside one room and advances upward', () => {
  const floor = createRoomScopedFloor();
  floor.commit('ABCD2345', 13);
  assert.equal(floor.shouldBroadcast('ABCD2345', 13), false);
  assert.equal(floor.shouldBroadcast('ABCD2345', 12), false);
  assert.equal(floor.shouldBroadcast('ABCD2345', 14), true);
  floor.commit('ABCD2345', 14);
  assert.equal(floor.revisionFor('ABCD2345'), 14);
});

test('moving to another room restarts the floor instead of starving it', () => {
  const floor = createRoomScopedFloor();
  floor.commit('QZDTNQEY', 41);
  assert.equal(floor.revisionFor('CP4SXRXR'), -1);
  assert.equal(floor.shouldBroadcast('CP4SXRXR', 16), true);
  floor.commit('CP4SXRXR', 16);
  assert.equal(floor.shouldBroadcast('CP4SXRXR', 16), false);
  assert.equal(floor.shouldBroadcast('CP4SXRXR', 17), true);
});

test('re-entering a previous room starts from a clean floor', () => {
  const floor = createRoomScopedFloor();
  floor.commit('QZDTNQEY', 41);
  floor.commit('CP4SXRXR', 16);
  assert.equal(floor.revisionFor('QZDTNQEY'), -1);
  // One redundant broadcast is harmless: receivers reject equal authority.
  assert.equal(floor.shouldBroadcast('QZDTNQEY', 41), true);
});

test('a missing or invalid authority never broadcasts', () => {
  const floor = createRoomScopedFloor();
  assert.equal(floor.shouldBroadcast('ABCD2345', undefined), false);
  assert.equal(floor.shouldBroadcast('ABCD2345', -1), false);
  assert.equal(floor.shouldBroadcast('', 3), false);
  assert.throws(() => floor.commit('ABCD2345', -2), /non-negative authority/);
  assert.throws(() => floor.commit('', 2), /room code/);
});
