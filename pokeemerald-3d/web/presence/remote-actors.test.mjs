import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteActorStore } from './remote-actors.mjs';
import {
  WORLD_A, WORLD_B, WORLD_VARIANT, member, presence, snapshot, standingAt,
} from './fixtures.mjs';

function baseStore(options = {}) {
  const store = createRemoteActorStore({ interpolationDelayMs: 50, ...options });
  const self = member('p1', { latest: snapshot('p1', { seq: 1, receivedMs: 1000 }) });
  const remote = member('p2', { latest: snapshot('p2', { seq: 1, receivedMs: 1000 }) });
  store.replaceRoster([self, remote], 1);
  return { store, self, remote };
}

function context(overrides = {}) {
  return {
    selfId: 'p1', world: WORLD_A, canRenderWorld: true,
    serverNowMs: 1050, clockReady: true, ...overrides,
  };
}

test('same-world overworld actors are visible; self is excluded', () => {
  const { store } = baseStore();
  const actors = store.sample(context());
  assert.equal(actors.length, 1);
  assert.equal(actors[0].playerId, 'p2');
  assert.equal(actors[0].pose.xPx, 168);
  assert.equal(actors[0].busy, false);
});

test('different map or variant hides the actor but keeps the roster entry', () => {
  const { store } = baseStore();
  assert.equal(store.sample(context({ world: WORLD_B })).length, 0);
  assert.equal(store.sample(context({ world: WORLD_VARIANT })).length, 0);
  assert.equal(store.getMembers().length, 2);

  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 1100, state: presence({ epoch: 2, world: WORLD_B }),
  }));
  assert.equal(store.sample(context({ world: WORLD_B })).length, 1);
  assert.equal(store.sample(context({ world: WORLD_A })).length, 0);
});

test('battle, loading, away and unsupported hide immediately', () => {
  const { store } = baseStore();
  for (const activity of ['battle', 'loading', 'away', 'unsupported']) {
    store.ingest(snapshot('p2', {
      seq: 2, receivedMs: 1100,
      state: presence({ activity, pose: null }),
    }));
    assert.equal(store.sample(context()).length, 0, activity);
  }
});

test('cutscene freezes a visible ghost at the last pose', () => {
  const { store } = baseStore();
  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 1100, state: presence({ activity: 'cutscene' }),
  }));
  const actors = store.sample(context({ serverNowMs: 1120 }));
  assert.equal(actors.length, 1);
  assert.equal(actors[0].busy, true);
  assert.equal(actors[0].marker, 'cutscene');
  assert.equal(actors[0].pose.xPx, 168);
});

test('dialogue and menu freeze at the last pose with busy=true', () => {
  const { store } = baseStore();
  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 1100, state: presence({ activity: 'dialogue' }),
  }));
  const actors = store.sample(context({ serverNowMs: 1120 }));
  assert.equal(actors.length, 1);
  assert.equal(actors[0].busy, true);
  assert.equal(actors[0].pose.xPx, 168);
});

test('null pose, reconnecting member and stale snapshot are hidden', () => {
  const { store } = baseStore();
  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 2000, state: presence({ activity: 'loading', pose: null }),
  }));
  assert.equal(store.sample(context({ serverNowMs: 2050 })).length, 0);

  store.replaceRoster([
    member('p1'),
    member('p2', { connection: 'reconnecting', latest: snapshot('p2', { seq: 3, receivedMs: 2050 }) }),
  ], 2);
  assert.equal(store.sample(context({ serverNowMs: 2100 })).length, 0);

  store.replaceRoster([
    member('p1'),
    member('p2', { latest: snapshot('p2', { seq: 4, receivedMs: 3000 }) }),
  ], 3);
  assert.equal(store.sample(context({ serverNowMs: 8001 })).length, 0);
  assert.equal(store.sample(context({ serverNowMs: 8000 })).length, 1);
});

test('interpolation uses bracketing samples and never extrapolates', () => {
  const { store } = baseStore();
  store.sample(context({ serverNowMs: 1000 }));
  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 1100,
    state: presence({ pose: standingAt(11, 11, { facing: 'left' }) }),
  }));

  const midway = store.sample(context({ serverNowMs: 1100 }));
  assert.equal(midway[0].pose.xPx, 176);
  assert.equal(midway[0].pose.yPx, 184);
  assert.equal(midway[0].pose.facing, 'down');

  const after = store.sample(context({ serverNowMs: 1200 }));
  assert.equal(after[0].pose.xPx, 184);
  assert.equal(after[0].pose.facing, 'left');
});

test('a warp epoch snaps without sliding across worlds', () => {
  const { store } = baseStore();
  store.sample(context({ serverNowMs: 1000 }));
  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 1100,
    state: presence({ epoch: 2, world: WORLD_B, pose: standingAt(2, 3) }),
  }));
  const actors = store.sample(context({ world: WORLD_B, serverNowMs: 1150 }));
  assert.equal(actors.length, 1);
  assert.equal(actors[0].pose.xPx, 40);
  assert.equal(actors[0].pose.yPx, 64);
});

test('out-of-order sequences, worlds without epochs and old generations are ignored', () => {
  const { store } = baseStore();
  store.ingest(snapshot('p2', {
    seq: 10, receivedMs: 1500, state: presence({ pose: standingAt(4, 4) }),
  }));
  store.ingest(snapshot('p2', {
    seq: 9, receivedMs: 1600, state: presence({ pose: standingAt(9, 9) }),
  }));
  assert.equal(store.sample(context({ serverNowMs: 1550 }))[0].pose.xPx, 72);

  store.ingest(snapshot('p2', {
    seq: 11, receivedMs: 1700, state: presence({ world: WORLD_B }),
  }));
  const stillA = store.sample(context({ serverNowMs: 1750 }));
  assert.equal(stillA.length, 1, 'world change without a new epoch is ignored');
  assert.equal(stillA[0].pose.xPx, 72);
  assert.equal(store.sample(context({ world: WORLD_B, serverNowMs: 1750 })).length, 0);

  store.ingest(snapshot('p2', {
    generation: 2, seq: 12, receivedMs: 1800, state: presence({ world: WORLD_B }),
  }));
  assert.equal(store.sample(context({ world: WORLD_B, serverNowMs: 1850 })).length, 0);
});

test('a large unexplained displacement clears interpolation history', () => {
  const { store } = baseStore();
  store.sample(context({ serverNowMs: 1000 }));
  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 1100, state: presence({ pose: standingAt(40, 40) }),
  }));
  const actors = store.sample(context({ serverNowMs: 1100 }));
  assert.equal(actors[0].pose.xPx, 648);
});

test('without a clock estimate the latest pose is used', () => {
  const { store } = baseStore();
  store.sample(context({ serverNowMs: 1000 }));
  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 1100, state: presence({ pose: standingAt(20, 20) }),
  }));
  const actors = store.sample(context({ clockReady: false, serverNowMs: 1100 }));
  assert.equal(actors[0].pose.xPx, 328);
});

test('rendering can be disabled without losing roster membership', () => {
  const { store } = baseStore();
  assert.equal(store.sample(context({ canRenderWorld: false })).length, 0);
  assert.equal(store.getMembers().length, 2);
  assert.equal(store.sample(context()).length, 1);
});

test('roster revisions only move forward and removals clear history', () => {
  const { store } = baseStore();
  store.replaceRoster([member('p1')], 1);
  assert.equal(store.getMembers().length, 2, 'older revision ignored');
  store.replaceRoster([member('p1')], 2);
  assert.equal(store.getMembers().length, 1);
  assert.equal(store.sample(context()).length, 0);
});

test('roster latest snapshots seed the history', () => {
  const store = createRemoteActorStore({ interpolationDelayMs: 50 });
  store.replaceRoster([
    member('p1'),
    member('p2', {
      latest: snapshot('p2', {
        seq: 4, receivedMs: 1000, state: presence({ pose: standingAt(6, 7) }),
      }),
    }),
  ], 1);
  const actors = store.sample(context({ serverNowMs: 1000 }));
  assert.equal(actors.length, 1);
  assert.equal(actors[0].pose.xPx, 104);
  assert.equal(actors[0].pose.yPx, 128);
});

test('away clears interpolation history and returning snaps to the fresh pose', () => {
  const { store } = baseStore();
  store.sample(context({ serverNowMs: 1000 }));
  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 1100, state: presence({ pose: standingAt(11, 11) }),
  }));
  assert.equal(store.sample(context({ serverNowMs: 1100 }))[0].pose.xPx, 176);

  store.ingest(snapshot('p2', {
    seq: 3, receivedMs: 1200, state: presence({ activity: 'away', pose: null }),
  }));
  assert.equal(store.sample(context({ serverNowMs: 1200 })).length, 0);

  store.ingest(snapshot('p2', {
    seq: 4, receivedMs: 1300, state: presence({ pose: standingAt(14, 11) }),
  }));
  const back = store.sample(context({ serverNowMs: 1300 }));
  assert.equal(back.length, 1);
  assert.equal(back[0].pose.xPx, 232, 'no slide from the pre-away pose');
});

test('changing the local world clears remote interpolation history', () => {
  const { store } = baseStore();
  store.sample(context({ serverNowMs: 1000 }));
  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 1100, state: presence({ pose: standingAt(11, 11) }),
  }));
  assert.equal(store.sample(context({ serverNowMs: 1100 }))[0].pose.xPx, 176);

  assert.equal(store.sample(context({ world: WORLD_B, serverNowMs: 1150 })).length, 0);
  const back = store.sample(context({ serverNowMs: 1050 }));
  assert.equal(back.length, 1);
  assert.equal(back[0].pose.xPx, 184, 'fresh snapshot after the local world changes');
});

test('clearInterpolation keeps roster membership and latest snapshots', () => {
  const { store } = baseStore();
  store.clearInterpolation();
  assert.equal(store.getMembers().length, 2);
  assert.equal(store.sample(context()).length, 1);
});

test('a battle peer leaves a stationary marker in the anchor world', () => {
  const { store } = baseStore();
  const anchorPose = standingAt(4, 5);
  store.ingest(snapshot('p2', {
    seq: 2,
    receivedMs: 1100,
    state: {
      epoch: 2,
      activity: 'battle',
      world: null,
      pose: null,
      battleAnchor: { world: WORLD_A, pose: anchorPose, epoch: 1 },
    },
  }));
  const actors = store.sample(context({ serverNowMs: 1150 }));
  assert.equal(actors.length, 1);
  assert.equal(actors[0].marker, 'battle');
  assert.equal(actors[0].pose.xPx, anchorPose.xPx);
});

test('a battle peer without an anchor or in another world shows nothing', () => {
  const { store } = baseStore();
  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 1100,
    state: { epoch: 2, activity: 'battle', world: null, pose: null, battleAnchor: null },
  }));
  assert.equal(store.sample(context({ serverNowMs: 1150 })).length, 0);

  store.ingest(snapshot('p2', {
    seq: 3, receivedMs: 1200,
    state: {
      epoch: 3, activity: 'battle', world: null, pose: null,
      battleAnchor: { world: WORLD_B, pose: standingAt(1, 1), epoch: 2 },
    },
  }));
  assert.equal(store.sample(context({ serverNowMs: 1250 })).length, 0);
});

test('stale battle markers hide and returning restores a live actor', () => {
  const { store } = baseStore();
  store.ingest(snapshot('p2', {
    seq: 2, receivedMs: 1100,
    state: {
      epoch: 2, activity: 'battle', world: null, pose: null,
      battleAnchor: { world: WORLD_A, pose: standingAt(4, 5), epoch: 1 },
    },
  }));
  assert.equal(store.sample(context({ serverNowMs: 1150 })).length, 1);
  assert.equal(store.sample(context({ serverNowMs: 1100 + 6000 })).length, 0);

  store.ingest(snapshot('p2', {
    seq: 3, receivedMs: 7200, state: presence({ epoch: 3, pose: standingAt(6, 6) }),
  }));
  const back = store.sample(context({ serverNowMs: 7250 }));
  assert.equal(back.length, 1);
  assert.equal(back[0].marker, null);
  assert.equal(back[0].pose.xPx, standingAt(6, 6).xPx);
});

test('interpolates on the sender clock so arrival jitter cannot stall motion', () => {
  const store = createRemoteActorStore({
    interpolationDelayMs: 200,
    historySamples: 8,
    visibleSnapshotAgeMs: 5000,
  });
  store.replaceRoster([
    member('p1', { latest: snapshot('p1', { seq: 1, receivedMs: 900 }) }),
    member('p2'),
  ], 1);

  const delays = [60, 320, 90, 110, 70];
  for (let i = 0; i < delays.length; i++) {
    const sampleMs = 1000 + i * 100;
    store.ingest(snapshot('p2', {
      seq: i + 1,
      sampleMs,
      receivedMs: sampleMs + delays[i],
      state: presence({ pose: { ...presence().pose, xPx: 100 + i * 16 } }),
    }));
  }

  const ctx = (serverNowMs) => ({
    selfId: 'p1', world: WORLD_A, canRenderWorld: true, serverNowMs, clockReady: true,
  });
  store.sample(ctx(1300));

  const at1160 = store.sample(ctx(1360))[0];
  assert.equal(Math.round(at1160.pose.xPx), 116);
  const at1210 = store.sample(ctx(1410))[0];
  assert.equal(Math.round(at1210.pose.xPx), 124);

  let last = -Infinity;
  for (let t = 1060; t <= 1460; t += 20) {
    const actor = store.sample(ctx(t + 200))[0];
    assert.ok(actor.pose.xPx >= last - 1e-6, `motion went backwards at ${t}`);
    last = actor.pose.xPx;
  }
});

test('peers on directly connected maps are translated into local space', () => {
  const mapSize = { width: 20, height: 20 };
  const remotePose = { ...presence().pose, xPx: 40, yPx: 32 };
  const cases = [
    { name: 'south', direction: 1, offset: 3, x: 40 + 48, y: 32 + 320 },
    { name: 'north', direction: 2, offset: 0, x: 40, y: 32 - 160 },
    { name: 'west', direction: 3, offset: 1, x: 40 - 160, y: 32 + 16 },
    { name: 'east', direction: 4, offset: 2, x: 40 + 320, y: 32 - 32 },
  ];

  for (const room of cases) {
    const store = createRemoteActorStore({ interpolationDelayMs: 200 });
    store.replaceRoster([
      member('p1', { latest: snapshot('p1', { seq: 1, receivedMs: 1000 }) }),
      member('p2', {
        latest: snapshot('p2', {
          seq: 1, receivedMs: 1100, state: presence({ world: WORLD_B, pose: remotePose }),
        }),
      }),
    ], 1);

    const context = {
      selfId: 'p1', world: WORLD_A, canRenderWorld: true,
      serverNowMs: 1150, clockReady: true,
      mapSize,
      connections: [{
        mapGroup: WORLD_B.mapGroup, mapNum: WORLD_B.mapNum,
        direction: room.direction, offset: room.offset, width: 10, height: 10,
      }],
    };

    const actors = store.sample(context);
    assert.equal(actors.length, 1, room.name);
    assert.equal(actors[0].crossBorder, true, room.name);
    assert.equal(actors[0].pose.xPx, room.x, `${room.name} x`);
    assert.equal(actors[0].pose.yPx, room.y, `${room.name} y`);
    assert.deepEqual(actors[0].world, WORLD_A, room.name);
  }
});

test('unconnected worlds stay hidden even when another map is visible', () => {
  const store = createRemoteActorStore({ interpolationDelayMs: 200 });
  store.replaceRoster([
    member('p1', { latest: snapshot('p1', { seq: 1, receivedMs: 1000 }) }),
    member('p2', {
      latest: snapshot('p2', { seq: 1, receivedMs: 1100, state: presence({ world: WORLD_VARIANT }) }),
    }),
  ], 1);
  const actors = store.sample({
    selfId: 'p1', world: WORLD_A, canRenderWorld: true,
    serverNowMs: 1150, clockReady: true,
    mapSize: { width: 20, height: 20 },
    connections: [{ mapGroup: 0, mapNum: 1, direction: 1, offset: 0, width: 10, height: 10 }],
  });
  assert.equal(actors.length, 0);
});
