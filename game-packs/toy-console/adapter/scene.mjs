// Independent flat scene fixture. The shared presenter renders its framebuffer.

export function createScene() {
  return {
    sceneFormat: 'gba-classic-v1',
    setMode() {},
    createFrame(_instance, _memory, { width, height }) {
      return {
        image: new ImageData(new Uint8ClampedArray(width * height * 4), width, height),
      };
    },
    renderFrame() {
      return {
        sceneKind: 0,
        enhanced: false,
        screenEffects: false,
        fieldKind: 0,
        bgPriorities: [],
        spritePriority: 0,
        worldGridOffsetX: 0,
        worldGridOffsetY: 0,
        worldPixelOriginX: 0,
        worldPixelOriginY: 0,
        objectSourceCount: 0,
      };
    },
    presenterOptions({ canvas, width, height, scale, onFailure }) {
      return { canvas, width, height, worldWidth: 1, worldHeight: 1, scale, onFailure };
    },
  };
}
