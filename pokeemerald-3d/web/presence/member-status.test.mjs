import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_AREA,
  awayLabel,
  memberFreshness,
  memberMapName,
} from './member-status.mjs';

const world = { mapGroup: 0, mapNum: 10, layoutId: 'layout_b', variant: 'base' };

function member(receivedMs) {
  return {
    playerId: 'p2',
    name: 'May',
    latest: receivedMs === null ? null : {
      receivedMs,
      state: { world, activity: 'overworld', pose: null },
    },
  };
}

test('freshness compares the newest snapshot against the server clock', () => {
  const peer = member(9000);
  assert.equal(memberFreshness(peer, { serverNowMs: 12000, visibleSnapshotAgeMs: 5000 }).stale, false);
  assert.equal(memberFreshness(peer, { serverNowMs: 14001, visibleSnapshotAgeMs: 5000 }).stale, true);
});

test('an unknown clock or missing snapshot never accuses a peer', () => {
  assert.equal(memberFreshness(member(9000), { serverNowMs: null }).stale, false);
  assert.equal(memberFreshness(member(null), { serverNowMs: 20000 }).stale, false);
});

test('the last known area survives a stale snapshot', () => {
  const peer = member(1000);
  assert.equal(memberMapName(peer, () => 'Oldale Town'), 'Oldale Town');
  assert.equal(memberMapName(member(null), () => 'Oldale Town'), NO_AREA);
});

test('away labels name the area they were last seen in', () => {
  assert.equal(awayLabel('Oldale Town'), 'Away · Oldale Town');
  assert.equal(awayLabel(null), `Away · ${NO_AREA}`);
});
