// Emerald scene buffer mapping.
//
// The presenter is shared and game-agnostic; this module only maps the engine's
// exported scene buffers into typed views for one frame, and supplies the
// presenter options that need engine world dimensions.
//
// The pack adapter receives this factory through the loader context.

export function createEmeraldFrame(instance, memory, { width = 240, height = 160 } = {}) {
  const exports = instance.exports;
  const ptr = exports.WasmDisplayBuffer();
  const size = exports.WasmDisplayBufferSize();
  return {
    image: new ImageData(new Uint8ClampedArray(memory.buffer, ptr, size), width, height),
    worldPixels: new Uint8ClampedArray(memory.buffer, exports.WasmWorldBuffer(), exports.WasmWorldBufferSize()),
    worldStructuralAlphaPixels: new Uint8Array(memory.buffer, exports.WasmWorldStructuralAlphaBuffer(), exports.WasmWorldStructuralAlphaBufferSize()),
    worldHeightPixels: new Int16Array(memory.buffer, exports.WasmWorldHeightBuffer(), exports.WasmWorldHeightBufferSize() / 2),
    worldGroundHeightPixels: new Int16Array(memory.buffer, exports.WasmWorldGroundHeightBuffer(), exports.WasmWorldGroundHeightBufferSize() / 2),
    worldGeometryPixels: new Uint16Array(memory.buffer, exports.WasmWorldGeometryBuffer(), exports.WasmWorldGeometryBufferSize() / 2),
    worldReceiverPixels: new Uint16Array(memory.buffer, exports.WasmWorldReceiverBuffer(), exports.WasmWorldReceiverBufferSize() / 2),
    worldFacadePixels: new Uint32Array(memory.buffer, exports.WasmWorldFacadeBuffer(), exports.WasmWorldFacadeBufferSize() / 4),
    layerPixels: new Uint8Array(memory.buffer, exports.WasmDisplayLayerBuffer(), exports.WasmDisplayLayerBufferSize()),
    objectIds: new Uint8Array(memory.buffer, exports.WasmDisplayObjectIdBuffer(), exports.WasmDisplayObjectIdBufferSize()),
    bgPriorities: new Uint8Array(memory.buffer, exports.WasmDisplayBgPriorityBuffer(), exports.WasmDisplayBgPriorityBufferSize()),
    objectSourcePixels: new Uint8Array(memory.buffer, exports.WasmDisplayObjectSourceBuffer(), exports.WasmDisplayObjectSourceBufferSize()),
    objectDescriptors: new Int32Array(memory.buffer, exports.WasmDisplayObjectDescriptorBuffer(), exports.WasmDisplayObjectDescriptorBufferSize() / 4),
    objectPixels: new Uint8ClampedArray(memory.buffer, exports.WasmDisplayObjectBuffer(), exports.WasmDisplayObjectBufferSize()),
    objectPriorities: new Uint8Array(memory.buffer, exports.WasmDisplayObjectPriorities(), exports.WasmDisplayObjectPrioritiesSize()),
    screenEffectPixels: new Uint8Array(memory.buffer, exports.WasmDisplayScreenEffectBuffer(), exports.WasmDisplayScreenEffectBufferSize()),
    screenEffectSources: new Int16Array(memory.buffer, exports.WasmDisplayScreenEffectSourceBuffer(), exports.WasmDisplayScreenEffectSourceBufferSize() / 2),
  };
}

export function emeraldPresenterOptions({
  canvas,
  width = 240,
  height = 160,
  scale,
  worldWidth,
  worldHeight,
  onFailure,
}) {
  return { canvas, width, height, worldWidth, worldHeight, scale, onFailure };
}

function refreshEmeraldObjectEventSpriteFlags(exports, memoryView, flags) {
  flags.fill(0);
  const base = exports.gObjectEvents.value;
  for (let id = 0; id < 16; id++) {
    const event = base + id * 0x24;
    if (memoryView[event] & 1) flags[memoryView[event + 4]] = 1;
  }
}

export function createEmeraldScene() {
  const bgPrioritiesScratch = [0, 0, 0, 0];
  return {
    sceneFormat: 'emerald-scene-v1',
    createFrame: createEmeraldFrame,
    renderFrame(instance, { mode = 'hd2d', memoryView = null, objectEventSpriteFlags = null } = {}) {
      const exports = instance.exports;
      const sceneKind = exports.WasmDisplaySceneKind();
      const enhanced = mode === 'hd2d' && sceneKind !== 0;
      const screenEffects = enhanced && sceneKind === 2;
      if (enhanced) {
        exports.WasmRenderHd2dFrame(screenEffects ? 1 : 0);
        if (memoryView && objectEventSpriteFlags) {
          refreshEmeraldObjectEventSpriteFlags(exports, memoryView, objectEventSpriteFlags);
        }
      } else {
        exports.WasmRenderFrame();
      }
      bgPrioritiesScratch[0] = exports.WasmDisplayBgPriority(0);
      bgPrioritiesScratch[1] = exports.WasmDisplayBgPriority(1);
      bgPrioritiesScratch[2] = exports.WasmDisplayBgPriority(2);
      bgPrioritiesScratch[3] = exports.WasmDisplayBgPriority(3);
      return {
        sceneKind,
        enhanced,
        screenEffects,
        fieldKind: exports.WasmPresenceFieldKind(),
        bgPriorities: bgPrioritiesScratch,
        spritePriority: exports.WasmPresenceSpritePriority(),
        worldGridOffsetX: exports.WasmWorldGridOffsetX(),
        worldGridOffsetY: exports.WasmWorldGridOffsetY(),
        worldPixelOriginX: exports.WasmWorldPixelOriginX(),
        worldPixelOriginY: exports.WasmWorldPixelOriginY(),
        objectSourceCount: exports.WasmDisplayObjectSourceCount(),
      };
    },
    setMode(instance, mode) {
      const exports = instance?.exports;
      exports?.WasmSetHd2dEnabled?.(mode === 'hd2d' ? 1 : 0);
      exports?.WasmRefreshHd2dObjectEvents?.();
    },
    presenterOptions(options = {}) {
      const exports = options.instance?.exports;
      return emeraldPresenterOptions({
        ...options,
        worldWidth: options.worldWidth ?? exports?.WasmWorldWidth?.(),
        worldHeight: options.worldHeight ?? exports?.WasmWorldHeight?.(),
      });
    },
  };
}
