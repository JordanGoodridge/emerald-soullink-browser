import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameAdapter } from './game-adapter.mjs';

function fakeExports(overrides = {}) {
  const values = {
    WasmPresenceValid: () => 1,
    WasmPresenceMapGroup: () => 1,
    WasmPresenceMapNum: () => 2,
    WasmPresenceMapLayoutId: () => 0x1a,
    WasmPresenceMapType: () => 1,
    WasmPresenceActivity: () => 0,
    WasmPresenceGender: () => 0,
    WasmPresenceFacing: () => 1,
    WasmPresenceElevation: () => 3,
    WasmPresenceJumpPx: () => 0,
    WasmPresenceMotion: () => 0,
    WasmPresenceAnimNum: () => 0,
    WasmPresenceAnimCmdIndex: () => 0,
    WasmPresenceXPx: () => 104,
    WasmPresenceYPx: () => 216,
    WasmPresenceScreenX: () => 120,
    WasmPresenceScreenY: () => 112,
    ...overrides,
  };
  return values;
}

test('reads map identity, pose and screen anchor', () => {
  const adapter = createGameAdapter({ exports: fakeExports() });
  const frame = adapter.read();
  assert.deepEqual(frame.state.world, {
    mapGroup: 1, mapNum: 2, layoutId: 'layout_1a', variant: 'base',
  });
  assert.equal(frame.state.activity, 'overworld');
  assert.equal(frame.state.pose.xPx, 104);
  assert.equal(frame.state.pose.yPx, 216);
  assert.equal(frame.state.pose.facing, 'down');
  assert.equal(frame.state.pose.elevation, 3);
  assert.equal(frame.state.pose.appearance, 'brendan.on-foot');
  assert.equal(frame.state.pose.frame, 0);
  assert.deepEqual(frame.screen, { x: 120, y: 112 });
});

test('maps walking animation command indices to sheet cells', () => {
  const cells = [3, 0, 4, 0];
  for (let index = 0; index < cells.length; index++) {
    const adapter = createGameAdapter({
      exports: fakeExports({
        WasmPresenceMotion: () => 1,
        WasmPresenceAnimCmdIndex: () => index,
      }),
    });
    assert.equal(adapter.read().state.pose.frame, cells[index]);
  }
});

test('uses the left-facing cell and lets the renderer flip right-facing avatars', () => {
  const left = createGameAdapter({
    exports: fakeExports({ WasmPresenceMotion: () => 1, WasmPresenceFacing: () => 3 }),
  }).read();
  const right = createGameAdapter({
    exports: fakeExports({ WasmPresenceMotion: () => 1, WasmPresenceFacing: () => 4 }),
  }).read();
  assert.equal(left.state.pose.facing, 'left');
  assert.equal(right.state.pose.facing, 'right');
  assert.equal(left.state.pose.frame, right.state.pose.frame);
});

test('uses May and the idle cell for an up-facing female avatar', () => {
  const frame = createGameAdapter({
    exports: fakeExports({ WasmPresenceGender: () => 1, WasmPresenceFacing: () => 2 }),
  }).read();
  assert.equal(frame.state.pose.appearance, 'may.on-foot');
  assert.equal(frame.state.pose.frame, 1);
});

test('advances the epoch only when the world or validity changes', () => {
  let group = 1;
  let valid = 1;
  const adapter = createGameAdapter({
    exports: fakeExports({
      WasmPresenceMapGroup: () => group,
      WasmPresenceValid: () => valid,
    }),
  });
  const first = adapter.read();
  assert.equal(adapter.read().state.epoch, first.state.epoch);
  group = 2;
  const moved = adapter.read();
  assert.equal(moved.state.epoch, first.state.epoch + 1);
  assert.equal(adapter.read().state.epoch, moved.state.epoch);
  valid = 0;
  const hidden = adapter.read();
  assert.equal(hidden.state.world, null);
  assert.equal(hidden.state.pose, null);
  assert.equal(hidden.screen, null);
  valid = 1;
  assert.equal(adapter.read().state.epoch, hidden.state.epoch + 1);
});

test('keeps the epoch across a rebind but restarts the validity baseline', () => {
  const adapter = createGameAdapter({ exports: fakeExports() });
  const first = adapter.read();
  adapter.bind(fakeExports({ WasmPresenceMapGroup: () => 9 }));
  const afterBoot = adapter.read();
  assert.equal(afterBoot.state.epoch, first.state.epoch + 1);
  assert.equal(afterBoot.state.world.mapGroup, 9);
});

test('marks secret bases dynamic and preserves unsupported activity', () => {
  const adapter = createGameAdapter({
    exports: fakeExports({
      WasmPresenceMapType: () => 9,
      WasmPresenceActivity: () => 7,
    }),
  });
  const frame = adapter.read();
  assert.equal(frame.state.world.variant, 'dynamic');
  assert.equal(frame.state.activity, 'unsupported');
});

test('sanitizes out-of-range elevation and jump values', () => {
  const frame = createGameAdapter({
    exports: fakeExports({
      WasmPresenceElevation: () => 99,
      WasmPresenceJumpPx: () => 9999,
    }),
  }).read();
  assert.equal(frame.state.pose.elevation, 15);
  assert.equal(frame.state.pose.jumpPx, 256);
});

test('retains a battle anchor and clears it on return', () => {
  let activity = 0;
  const adapter = createGameAdapter({
    exports: fakeExports({ WasmPresenceActivity: () => activity, WasmPresenceFieldKind: () => 1 }),
  });
  const field = adapter.read();
  assert.equal(field.state.battleAnchor, null);

  activity = 3;
  const battle = adapter.read();
  assert.equal(battle.state.activity, 'battle');
  assert.equal(battle.state.pose, null);
  assert.equal(battle.state.battleAnchor.pose.xPx, 104);
  assert.equal(battle.state.battleAnchor.world.mapGroup, 1);

  activity = 0;
  const back = adapter.read();
  assert.equal(back.state.activity, 'overworld');
  assert.equal(back.state.battleAnchor, null);
});

test('rebinding the adapter drops the battle anchor', () => {
  const adapter = createGameAdapter({
    exports: fakeExports({ WasmPresenceActivity: () => 0, WasmPresenceFieldKind: () => 1 }),
  });
  adapter.read();
  adapter.bind(fakeExports({ WasmPresenceActivity: () => 3, WasmPresenceFieldKind: () => 3 }));
  const battle = adapter.read();
  assert.equal(battle.state.activity, 'battle');
  assert.equal(battle.state.battleAnchor, null);
});

test('reports explicit field context', () => {
  const outdoor = createGameAdapter({
    exports: fakeExports({ WasmPresenceFieldKind: () => 1 }),
  }).read();
  assert.equal(outdoor.fieldKind, 1);
  const battle = createGameAdapter({
    exports: fakeExports({ WasmPresenceActivity: () => 3, WasmPresenceFieldKind: () => 3 }),
  }).read();
  assert.equal(battle.fieldKind, 3);
});

test('a cutscene with a hidden avatar freezes the last field footpoint', () => {
  let valid = 1;
  let activity = 0;
  let group = 1;
  const adapter = createGameAdapter({
    exports: fakeExports({
      WasmPresenceValid: () => valid,
      WasmPresenceActivity: () => activity,
      WasmPresenceMapGroup: () => group,
      WasmPresenceFieldKind: () => 1,
    }),
  });
  const field = adapter.read();
  assert.equal(field.state.pose.xPx, 104);

  valid = 0;
  activity = 4;
  const scene = adapter.read();
  assert.equal(scene.state.activity, 'cutscene');
  assert.equal(scene.state.world.mapGroup, 1);
  assert.equal(scene.state.pose.xPx, 104);
  assert.equal(scene.screen, null);

  // A scene on a map the anchor does not belong to has nothing to freeze.
  group = 9;
  const elsewhere = adapter.read();
  assert.equal(elsewhere.state.activity, 'loading');
  assert.equal(elsewhere.state.pose, null);
});

test('loading never publishes a map identity', () => {
  const adapter = createGameAdapter({
    exports: fakeExports({ WasmPresenceValid: () => 0, WasmPresenceActivity: () => 5 }),
  });
  const frame = adapter.read();
  assert.equal(frame.state.activity, 'loading');
  assert.equal(frame.state.world, null);
});
