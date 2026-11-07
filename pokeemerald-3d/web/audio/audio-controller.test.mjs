import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioController } from './audio-controller.mjs';

function createMockWasmAudio({ sampleRate = 32768, maxFrames = 4096 } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bufferPtr = 1024;
  const pcmView = new Int16Array(memory.buffer, bufferPtr, maxFrames * 2);
  let availableFrames = 0;
  const consumedCalls = [];

  return {
    consumedCalls,
    writeFrames(stereoPairs) {
      for (let i = 0; i < stereoPairs.length; i++) {
        pcmView[i * 2] = stereoPairs[i][0];
        pcmView[i * 2 + 1] = stereoPairs[i][1];
      }
      availableFrames = stereoPairs.length;
    },
    instance: {
      exports: {
        memory,
        WasmAudioSampleRate: () => sampleRate,
        WasmAudioAvailableFrames: () => availableFrames,
        WasmAudioBufferPtr: () => bufferPtr,
        WasmAudioConsumeFrames: (count) => {
          consumedCalls.push(count);
          availableFrames = Math.max(0, availableFrames - count);
        },
      },
    },
  };
}

function createFakeAudioContextClass() {
  const instances = [];

  class FakeAudioContext {
    constructor(options = {}) {
      this.sampleRate = options.sampleRate || 32768;
      this.state = 'suspended';
      this.currentTime = 0;
      this.destination = { kind: 'destination' };
      this.gainNode = null;
      this.scriptProcessor = null;
      instances.push(this);
    }

    createGain() {
      const node = {
        gain: {
          value: 1,
          setValueAtTime(v) {
            this.value = v;
          },
        },
        connectedTo: null,
        connect(dest) {
          this.connectedTo = dest;
        },
        disconnect() {
          this.connectedTo = null;
        },
      };
      this.gainNode = node;
      return node;
    }

    createScriptProcessor(bufferSize, inputChannels, outputChannels) {
      const node = {
        bufferSize,
        inputChannels,
        outputChannels,
        onaudioprocess: null,
        connectedTo: null,
        connect(dest) {
          this.connectedTo = dest;
        },
        disconnect() {
          this.connectedTo = null;
        },
      };
      this.scriptProcessor = node;
      return node;
    }

    async resume() {
      this.state = 'running';
    }

    async suspend() {
      this.state = 'suspended';
    }

    async close() {
      this.state = 'closed';
    }
  }

  FakeAudioContext.instances = instances;
  return FakeAudioContext;
}

test('pullFromWasm converts interleaved s16 stereo samples and consumes WASM frames', async () => {
  const wasm = createMockWasmAudio({ sampleRate: 32768 });
  const FakeAudioContext = createFakeAudioContextClass();
  const controller = createAudioController({
    getInstance: () => wasm.instance,
    initialVolume: 80,
    initialMuted: false,
    AudioContextClass: FakeAudioContext,
  });

  await controller.unlock();
  assert.equal(controller.getState().running, true);

  wasm.writeFrames([
    [16384, -16384],
    [32767, -32768],
    [0, 8192],
  ]);

  const pulled = controller.pullFromWasm();
  assert.equal(pulled, 3);
  assert.deepEqual(wasm.consumedCalls, [3]);
  assert.equal(controller.getState().bufferedFrames, 3);
  assert.equal(controller.getState().totalFramesPulled, 3);

  const outL = new Float32Array(4);
  const outR = new Float32Array(4);
  const ctx = FakeAudioContext.instances[0];
  ctx.scriptProcessor.onaudioprocess({
    outputBuffer: {
      numberOfChannels: 2,
      getChannelData: (ch) => (ch === 0 ? outL : outR),
    },
  });

  assert.ok(Math.abs(outL[0] - 0.5) < 1e-5);
  assert.ok(Math.abs(outR[0] - -0.5) < 1e-5);
  assert.ok(Math.abs(outL[1] - 32767 / 32768) < 1e-5);
  assert.ok(Math.abs(outR[1] - -1.0) < 1e-5);
  assert.equal(outL[2], 0);
  assert.ok(Math.abs(outR[2] - 0.25) < 1e-5);
  // Remainder of output buffer is zero-padded cleanly on underrun.
  assert.equal(outL[3], 0);
  assert.equal(outR[3], 0);
  assert.equal(controller.getState().bufferedFrames, 0);
});

test('setVolume and setMuted / toggleMuted update GainNode and clamp 0..100', async () => {
  const wasm = createMockWasmAudio();
  const FakeAudioContext = createFakeAudioContextClass();
  const controller = createAudioController({
    getInstance: () => wasm.instance,
    initialVolume: 50,
    initialMuted: false,
    AudioContextClass: FakeAudioContext,
  });

  await controller.unlock();
  const ctx = FakeAudioContext.instances[0];
  assert.ok(Math.abs(ctx.gainNode.gain.value - 0.5) < 1e-6);

  controller.setVolume(125);
  assert.equal(controller.getState().volume, 100);
  assert.equal(ctx.gainNode.gain.value, 1);

  controller.setVolume(-10);
  assert.equal(controller.getState().volume, 0);
  assert.equal(ctx.gainNode.gain.value, 0);

  controller.setVolume(75);
  assert.ok(Math.abs(ctx.gainNode.gain.value - 0.75) < 1e-6);

  const mutedNow = controller.toggleMuted();
  assert.equal(mutedNow, true);
  assert.equal(ctx.gainNode.gain.value, 0);

  // While muted, pulling from WASM still consumes frames so C ring buffer never overflows.
  wasm.writeFrames([[1000, 1000], [2000, 2000]]);
  controller.pullFromWasm();
  assert.deepEqual(wasm.consumedCalls, [2]);
  assert.equal(controller.getState().bufferedFrames, 0);

  const unmutedNow = controller.toggleMuted();
  assert.equal(unmutedNow, false);
  assert.ok(Math.abs(ctx.gainNode.gain.value - 0.75) < 1e-6);
});

test('fast-forward downsampling and latency cap bound ring buffer without lag buildup', () => {
  const wasm = createMockWasmAudio({ sampleRate: 10000, maxFrames: 4096 });
  const controller = createAudioController({
    getInstance: () => wasm.instance,
    AudioContextClass: null,
    maxLatencySeconds: 0.1, // 1000 frames max capacity
  });

  const frames = Array.from({ length: 1600 }, (_, i) => [i, -i]);
  wasm.writeFrames(frames);

  // At 2x speed, frames are strided by 2 (800 frames queued).
  controller.pullFromWasm({ speedMultiplier: 2 });
  assert.equal(controller.getState().bufferedFrames, 800);

  // Pulling another 1600 frames at 1x caps at ringCapacityFrames (1000) and drops oldest excess.
  wasm.writeFrames(frames);
  controller.pullFromWasm({ speedMultiplier: 1 });
  const state = controller.getState();
  assert.equal(state.bufferedFrames, state.ringCapacityFrames);
  assert.ok(state.droppedFrames > 0);
});

test('automate mode consumes WASM frames without creating AudioContext', async () => {
  const wasm = createMockWasmAudio();
  const FakeAudioContext = createFakeAudioContextClass();
  const controller = createAudioController({
    getInstance: () => wasm.instance,
    AudioContextClass: FakeAudioContext,
    automate: true,
  });

  const unlocked = await controller.unlock();
  assert.equal(unlocked, false);
  assert.equal(FakeAudioContext.instances.length, 0);

  wasm.writeFrames([[4096, -4096]]);
  const pulled = controller.pullFromWasm();
  assert.equal(pulled, 1);
  assert.deepEqual(wasm.consumedCalls, [1]);
  assert.equal(controller.getState().bufferedFrames, 0);
});
