// Small independent WASM runtime fixture; intentionally does not import
// Emerald compatibility helpers or the shared WASM boot implementation.

function section(id, payload) {
  return [id, payload.length, ...payload];
}

function name(value) {
  const bytes = new TextEncoder().encode(value);
  return [bytes.length, ...bytes];
}

const MODULE_BYTES = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  ...section(1, [1, 96, 0, 0]),
  ...section(3, [2, 0, 0]),
  ...section(5, [1, 0, 1]),
  ...section(7, [
    3,
    ...name('memory'), 2, 0,
    ...name('ToyStart'), 0, 0,
    ...name('ToyStep'), 0, 1,
  ]),
  ...section(10, [2, 2, 0, 11, 2, 0, 11]),
]);

export function createRuntime() {
  let instance = null;
  let disposed = false;
  const saves = new Uint8Array(16);
  let pressedButtons = [];

  return {
    async instantiate(options = {}) {
      const module = await WebAssembly.compile(MODULE_BYTES);
      options.validateModule?.(module);
      instance = await WebAssembly.instantiate(module, {});
      return { bytes: MODULE_BYTES.buffer, module, instance, memory: instance.exports.memory };
    },
    start() {
      if (!instance) throw new Error('toy runtime is not instantiated');
      instance.exports.ToyStart();
    },
    setButtons(buttons) { pressedButtons = [...buttons]; },
    setInputMask(mask) { pressedButtons = [`legacy-mask:${mask}`]; },
    step() {
      if (!instance || disposed) throw new Error('toy runtime is not running');
      instance.exports.ToyStep();
    },
    saveView(byteLength) {
      if (byteLength !== saves.byteLength) throw new Error(`toy save must be ${saves.byteLength} bytes`);
      return saves;
    },
    saveGame() { return 1; },
    suspend() {},
    dispose() { disposed = true; instance = null; },
    get pressedButtons() { return [...pressedButtons]; },
  };
}
