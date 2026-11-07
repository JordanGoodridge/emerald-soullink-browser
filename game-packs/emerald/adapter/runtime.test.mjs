import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './runtime.mjs';

test('Emerald runtime delegates WASM lifecycle and save-memory view to injected compatibility helpers', () => {
  const buffer = new Uint8Array([1, 2, 3, 4]);
  let receivedContext;
  const runtime = createRuntime({
    manifest: { game: { id: 'emerald' } },
    shared: {
      createEmeraldRuntime: (context) => {
        receivedContext = context;
        return {
          step() {},
          instantiate: async () => ({}),
          saveView: (bytes) => context.shared.emeraldFlashView(context.getMemoryView(), bytes),
        };
      },
      emeraldFlashView: (memory, bytes) => memory.subarray(0, bytes),
    },
    getMemoryView: () => buffer,
  });
  assert.equal(receivedContext.manifest.game.id, 'emerald');
  assert.equal(typeof runtime.step, 'function');
  assert.deepEqual([...runtime.saveView(3)], [1, 2, 3]);
});
