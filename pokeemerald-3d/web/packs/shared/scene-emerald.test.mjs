import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmeraldFrame, createEmeraldScene, emeraldPresenterOptions } from './scene-emerald.mjs';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

function fakeInstance() {
  const value = (name) => () => name.endsWith('Size') ? 16 : 0;
  return {
    exports: {
      WasmDisplayBuffer: value('WasmDisplayBuffer'),
      WasmDisplayBufferSize: value('WasmDisplayBufferSize'),
      WasmWorldBuffer: value('WasmWorldBuffer'),
      WasmWorldBufferSize: value('WasmWorldBufferSize'),
      WasmWorldStructuralAlphaBuffer: value('WasmWorldStructuralAlphaBuffer'),
      WasmWorldStructuralAlphaBufferSize: value('WasmWorldStructuralAlphaBufferSize'),
      WasmWorldHeightBuffer: value('WasmWorldHeightBuffer'),
      WasmWorldHeightBufferSize: value('WasmWorldHeightBufferSize'),
      WasmWorldGroundHeightBuffer: value('WasmWorldGroundHeightBuffer'),
      WasmWorldGroundHeightBufferSize: value('WasmWorldGroundHeightBufferSize'),
      WasmWorldGeometryBuffer: value('WasmWorldGeometryBuffer'),
      WasmWorldGeometryBufferSize: value('WasmWorldGeometryBufferSize'),
      WasmWorldReceiverBuffer: value('WasmWorldReceiverBuffer'),
      WasmWorldReceiverBufferSize: value('WasmWorldReceiverBufferSize'),
      WasmWorldFacadeBuffer: value('WasmWorldFacadeBuffer'),
      WasmWorldFacadeBufferSize: value('WasmWorldFacadeBufferSize'),
      WasmDisplayLayerBuffer: value('WasmDisplayLayerBuffer'),
      WasmDisplayLayerBufferSize: value('WasmDisplayLayerBufferSize'),
      WasmDisplayObjectIdBuffer: value('WasmDisplayObjectIdBuffer'),
      WasmDisplayObjectIdBufferSize: value('WasmDisplayObjectIdBufferSize'),
      WasmDisplayBgPriorityBuffer: value('WasmDisplayBgPriorityBuffer'),
      WasmDisplayBgPriorityBufferSize: value('WasmDisplayBgPriorityBufferSize'),
      WasmDisplayObjectSourceBuffer: value('WasmDisplayObjectSourceBuffer'),
      WasmDisplayObjectSourceBufferSize: value('WasmDisplayObjectSourceBufferSize'),
      WasmDisplayObjectDescriptorBuffer: value('WasmDisplayObjectDescriptorBuffer'),
      WasmDisplayObjectDescriptorBufferSize: value('WasmDisplayObjectDescriptorBufferSize'),
      WasmDisplayObjectBuffer: value('WasmDisplayObjectBuffer'),
      WasmDisplayObjectBufferSize: value('WasmDisplayObjectBufferSize'),
      WasmDisplayObjectPriorities: value('WasmDisplayObjectPriorities'),
      WasmDisplayObjectPrioritiesSize: value('WasmDisplayObjectPrioritiesSize'),
      WasmDisplayScreenEffectBuffer: value('WasmDisplayScreenEffectBuffer'),
      WasmDisplayScreenEffectBufferSize: value('WasmDisplayScreenEffectBufferSize'),
      WasmDisplayScreenEffectSourceBuffer: value('WasmDisplayScreenEffectSourceBuffer'),
      WasmDisplayScreenEffectSourceBufferSize: value('WasmDisplayScreenEffectSourceBufferSize'),
    },
  };
}

test('maps exported scene buffers into typed views', () => {
  const frame = createEmeraldFrame(fakeInstance(), { buffer: new ArrayBuffer(4096) });
  assert.equal(frame.image.width, 240);
  assert.equal(frame.image.height, 160);
  assert.equal(frame.image.data.length, 16);
  assert.equal(frame.worldHeightPixels.length, 8);
  assert.equal(frame.worldFacadePixels.length, 4);
  assert.equal(frame.objectDescriptors.length, 4);
  assert.equal(frame.screenEffectSources.length, 8);
});

test('exposes the scene format and presenter options', () => {
  const scene = createEmeraldScene();
  assert.equal(scene.sceneFormat, 'emerald-scene-v1');
  const modeCalls = [];
  scene.setMode({ exports: {
    WasmSetHd2dEnabled: (enabled) => modeCalls.push(['enabled', enabled]),
    WasmRefreshHd2dObjectEvents: () => modeCalls.push(['refresh']),
  } }, 'classic');
  assert.deepEqual(modeCalls, [['enabled', 0], ['refresh']]);
  assert.deepEqual(scene.presenterOptions({
    canvas: 'canvas', width: 240, height: 160, scale: 4, worldWidth: 800, worldHeight: 600, onFailure: 'handler',
  }), {
    canvas: 'canvas', width: 240, height: 160, worldWidth: 800, worldHeight: 600, scale: 4, onFailure: 'handler',
  });
  assert.deepEqual(scene.presenterOptions({
    canvas: 'canvas', width: 240, height: 160, scale: 4, onFailure: 'handler',
    instance: { exports: { WasmWorldWidth: () => 800, WasmWorldHeight: () => 600 } },
  }), {
    canvas: 'canvas', width: 240, height: 160, worldWidth: 800, worldHeight: 600, scale: 4, onFailure: 'handler',
  });
});

test('scene adapter owns engine render calls and reports shared presenter metadata', () => {
  const calls = [];
  const exports = {
    WasmDisplaySceneKind: () => 2,
    WasmRenderHd2dFrame: (effects) => calls.push(['hd2d', effects]),
    WasmRenderFrame: () => calls.push(['classic']),
    WasmPresenceFieldKind: () => 2,
    WasmDisplayBgPriority: (layer) => layer,
    WasmPresenceSpritePriority: () => 2,
    WasmWorldGridOffsetX: () => 1,
    WasmWorldGridOffsetY: () => 2,
    WasmWorldPixelOriginX: () => 3,
    WasmWorldPixelOriginY: () => 4,
    WasmDisplayObjectSourceCount: () => 5,
  };
  const scene = createEmeraldScene();
  const frame = scene.renderFrame({ exports }, { mode: 'hd2d' });
  assert.deepEqual(calls, [['hd2d', 1]]);
  assert.deepEqual(frame, {
    sceneKind: 2,
    enhanced: true,
    screenEffects: true,
    fieldKind: 2,
    bgPriorities: [0, 1, 2, 3],
    spritePriority: 2,
    worldGridOffsetX: 1,
    worldGridOffsetY: 2,
    worldPixelOriginX: 3,
    worldPixelOriginY: 4,
    objectSourceCount: 5,
  });
  scene.renderFrame({ exports }, { mode: 'classic' });
  assert.deepEqual(calls, [['hd2d', 1], ['classic']]);
});
