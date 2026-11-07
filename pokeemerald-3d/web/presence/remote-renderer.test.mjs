import test from 'node:test';
import assert from 'node:assert/strict';
import { mapRemoteActors, remotePresenterOptions } from './remote-renderer.mjs';

function atlas() {
  return {
    pixels: new Uint8Array(32 * 64 * 64 * 4),
    layerCount: 9,
    revision: 4,
    layers: new Map([['brendan.on-foot', { offset: 0, frames: 9 }]]),
  };
}

function actor(overrides = {}) {
  return {
    playerId: 'p2',
    busy: false,
    pose: {
      xPx: 104 + 16,
      yPx: 216,
      jumpPx: 0,
      facing: 'down',
      appearance: 'brendan.on-foot',
      frame: 3,
      ...overrides,
    },
  };
}

const selfPose = { xPx: 104, yPx: 216 };
const selfScreen = { x: 120, y: 112 };

test('offsets a remote actor by map-space delta from the local foot anchor', () => {
  const [mapped] = mapRemoteActors({ actors: [actor()], selfPose, selfScreen, avatarAtlas: atlas() });
  assert.equal(mapped.screenX, 136);
  assert.equal(mapped.screenY, 112);
  assert.equal(mapped.layer, 3);
  assert.equal(mapped.hFlip, false);
});

test('lifts jump height out of the ground anchor and flips right-facing actors', () => {
  const [mapped] = mapRemoteActors({
    actors: [actor({ jumpPx: 12, facing: 'right' })],
    selfPose,
    selfScreen,
    avatarAtlas: atlas(),
  });
  assert.equal(mapped.screenY, 100);
  assert.equal(mapped.hFlip, true);
});

test('drops actors whose appearance has no loaded sheet', () => {
  assert.deepEqual(mapRemoteActors({
    actors: [actor({ appearance: 'may.on-foot' })],
    selfPose,
    selfScreen,
    avatarAtlas: atlas(),
  }), []);
});

test('requires a local pose, screen anchor and atlas', () => {
  assert.deepEqual(mapRemoteActors({ actors: [actor()] }), []);
  assert.deepEqual(mapRemoteActors({ actors: [actor()], selfPose, selfScreen }), []);
});

test('reports no presenter payload when the world cannot render', () => {
  assert.deepEqual(remotePresenterOptions({ canRender: false, avatarAtlas: atlas() }), {
    remoteActors: [], remoteAvatarPixels: null, remoteAvatarLayers: 0, remoteAvatarRevision: 0,
  });
  const options = remotePresenterOptions({
    canRender: true, avatarAtlas: atlas(), actors: [actor()], selfPose, selfScreen,
  });
  assert.equal(options.remoteActors.length, 1);
  assert.equal(options.remoteAvatarLayers, 9);
  assert.equal(options.remoteAvatarRevision, 4);
});

test('battle markers use a ghost layer when the atlas provides one', () => {
  const base = atlas();
  const ghostAtlas = { ...base, ghostOffset: 9, solidLayerCount: 9, layerCount: 18 };
  const [mapped] = mapRemoteActors({
    actors: [{ ...actor(), marker: 'battle' }],
    selfPose,
    selfScreen,
    avatarAtlas: ghostAtlas,
  });
  assert.equal(mapped.layer, 12);
  assert.equal(mapped.marker, 'battle');

  const [solid] = mapRemoteActors({ actors: [actor()], selfPose, selfScreen, avatarAtlas: ghostAtlas });
  assert.equal(solid.layer, 3);
});
