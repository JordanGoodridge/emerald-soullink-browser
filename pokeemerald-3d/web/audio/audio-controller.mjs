// Web Audio streaming controller for GBA M4A + CGB stereo PCM output.
//
// Pulls interleaved signed 16-bit stereo PCM frames from the WASM export ring
// buffer (`WasmAudio*`), converts them to float32 [-1, 1], and streams them
// through a bounded low-latency ring buffer into Web Audio (`AudioContext` +
// `GainNode`).

import { DEFAULT_SETTINGS, normalizeSoundVolume } from '../settings/settings-schema.mjs';

export const DEFAULT_SAMPLE_RATE = 32768;
const DEFAULT_MAX_LATENCY_SECONDS = 0.15;
const SCRIPT_PROCESSOR_FRAMES = 1024;

function clampGain(volume, muted) {
  if (muted) return 0;
  return Math.max(0, Math.min(1, normalizeSoundVolume(volume) / 100));
}

export function createAudioController({
  getInstance = () => null,
  initialVolume = DEFAULT_SETTINGS.soundVolume,
  initialMuted = DEFAULT_SETTINGS.soundMuted,
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext || null,
  automate = false,
  maxLatencySeconds = DEFAULT_MAX_LATENCY_SECONDS,
} = {}) {
  let volume = normalizeSoundVolume(initialVolume);
  let muted = Boolean(initialMuted);
  let sampleRate = DEFAULT_SAMPLE_RATE;
  let ringCapacityFrames = Math.max(512, Math.ceil(sampleRate * maxLatencySeconds));
  let leftRing = new Float32Array(ringCapacityFrames);
  let rightRing = new Float32Array(ringCapacityFrames);
  let readIndex = 0;
  let writeIndex = 0;
  let bufferedFrames = 0;
  let totalFramesPulled = 0;
  let droppedFrames = 0;

  let audioCtx = null;
  let gainNode = null;
  let processorNode = null;
  let unlocked = false;
  let manuallySuspended = false;
  let disposed = false;
  let detachUnlockListeners = null;

  function ensureRingCapacity(nextSampleRate) {
    if (!Number.isFinite(nextSampleRate) || nextSampleRate <= 0) return;
    const normalizedRate = Math.round(nextSampleRate);
    if (normalizedRate === sampleRate) return;
    sampleRate = normalizedRate;
    const nextCapacity = Math.max(512, Math.ceil(sampleRate * maxLatencySeconds));
    if (nextCapacity === ringCapacityFrames) return;
    ringCapacityFrames = nextCapacity;
    leftRing = new Float32Array(ringCapacityFrames);
    rightRing = new Float32Array(ringCapacityFrames);
    readIndex = 0;
    writeIndex = 0;
    bufferedFrames = 0;
  }

  function updateGainNode() {
    if (!gainNode) return;
    const targetGain = clampGain(volume, muted);
    if (gainNode.gain && typeof gainNode.gain.setValueAtTime === 'function' && audioCtx) {
      try {
        gainNode.gain.setValueAtTime(targetGain, audioCtx.currentTime || 0);
      } catch {
        gainNode.gain.value = targetGain;
      }
    }
    if (gainNode.gain) {
      gainNode.gain.value = targetGain;
    }
  }

  function drainFrames(frameCount, outLeft, outRight) {
    const count = Math.max(0, Math.trunc(frameCount || 0));
    const available = Math.min(count, bufferedFrames);
    for (let i = 0; i < available; i++) {
      if (outLeft) outLeft[i] = leftRing[readIndex];
      if (outRight) outRight[i] = rightRing[readIndex];
      readIndex = (readIndex + 1) % ringCapacityFrames;
    }
    bufferedFrames -= available;
    for (let i = available; i < count; i++) {
      if (outLeft) outLeft[i] = 0;
      if (outRight) outRight[i] = 0;
    }
    return available;
  }

  function ensureAudioContext() {
    if (disposed || automate || !AudioContextClass) return null;
    if (audioCtx) return audioCtx;

    const exports = getInstance()?.exports;
    const wasmRate = typeof exports?.WasmAudioSampleRate === 'function'
      ? exports.WasmAudioSampleRate() >>> 0
      : 0;
    if (wasmRate > 0) {
      ensureRingCapacity(wasmRate);
    }

    try {
      audioCtx = new AudioContextClass({ sampleRate, latencyHint: 'interactive' });
    } catch {
      try {
        audioCtx = new AudioContextClass();
      } catch {
        audioCtx = null;
        return null;
      }
    }

    if (Number.isFinite(audioCtx.sampleRate) && audioCtx.sampleRate > 0) {
      ensureRingCapacity(audioCtx.sampleRate);
    }

    if (typeof audioCtx.createGain === 'function') {
      gainNode = audioCtx.createGain();
      updateGainNode();
      if (audioCtx.destination && typeof gainNode.connect === 'function') {
        gainNode.connect(audioCtx.destination);
      }
    }

    if (typeof audioCtx.createScriptProcessor === 'function') {
      processorNode = audioCtx.createScriptProcessor(SCRIPT_PROCESSOR_FRAMES, 0, 2);
      processorNode.onaudioprocess = (event) => {
        const outputBuffer = event?.outputBuffer;
        if (!outputBuffer) return;
        const outL = outputBuffer.getChannelData(0);
        const outR = outputBuffer.numberOfChannels > 1 ? outputBuffer.getChannelData(1) : null;
        if (muted || manuallySuspended) {
          outL.fill(0);
          if (outR) outR.fill(0);
          return;
        }
        drainFrames(outL.length, outL, outR);
      };
      if (gainNode && typeof processorNode.connect === 'function') {
        processorNode.connect(gainNode);
      } else if (audioCtx.destination && typeof processorNode.connect === 'function') {
        processorNode.connect(audioCtx.destination);
      }
    }

    return audioCtx;
  }

  function pushSampleFrame(left, right) {
    if (bufferedFrames >= ringCapacityFrames) {
      // Drop oldest frame so latency never accumulates.
      readIndex = (readIndex + 1) % ringCapacityFrames;
      bufferedFrames--;
      droppedFrames++;
    }
    leftRing[writeIndex] = left;
    rightRing[writeIndex] = right;
    writeIndex = (writeIndex + 1) % ringCapacityFrames;
    bufferedFrames++;
  }

  function scheduleFallbackBuffer(framesToSchedule) {
    // Used only if an AudioContext implementation lacks createScriptProcessor.
    if (!audioCtx || processorNode || typeof audioCtx.createBuffer !== 'function' || typeof audioCtx.createBufferSource !== 'function') {
      return;
    }
    if (audioCtx.state !== 'running' || muted || manuallySuspended || framesToSchedule <= 0) {
      return;
    }
    const count = Math.min(framesToSchedule, bufferedFrames);
    if (count <= 0) return;
    const buffer = audioCtx.createBuffer(2, count, sampleRate);
    const outL = buffer.getChannelData(0);
    const outR = buffer.getChannelData(1);
    drainFrames(count, outL, outR);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode || audioCtx.destination);
    source.start();
  }

  function pullFromWasm({ speedMultiplier = 1 } = {}) {
    if (disposed) return 0;
    const instance = getInstance();
    const exports = instance?.exports;
    if (!exports) return 0;

    const availableFn = exports.WasmAudioAvailableFrames;
    const ptrFn = exports.WasmAudioBufferPtr;
    const consumeFn = exports.WasmAudioConsumeFrames;
    if (typeof availableFn !== 'function' || typeof ptrFn !== 'function' || typeof consumeFn !== 'function') {
      return 0;
    }

    if (typeof exports.WasmAudioSampleRate === 'function') {
      const wasmRate = exports.WasmAudioSampleRate() >>> 0;
      if (wasmRate > 0 && !audioCtx) {
        ensureRingCapacity(wasmRate);
      }
    }

    const available = availableFn() >>> 0;
    if (available === 0) return 0;

    const ptr = ptrFn() >>> 0;
    const memBuffer = exports.memory?.buffer;
    if (!memBuffer || ptr === 0 || ptr + available * 4 > memBuffer.byteLength) {
      consumeFn(available);
      return 0;
    }

    // Even when muted, suspended, or in automate mode, we MUST consume frames
    // from WASM so the C ring buffer never stalls or overflows.
    if (automate || muted || manuallySuspended) {
      consumeFn(available);
      totalFramesPulled += available;
      return available;
    }

    const pcm = new Int16Array(memBuffer, ptr, available * 2);
    const stride = Number.isFinite(speedMultiplier) && speedMultiplier > 1
      ? Math.max(1, Math.round(speedMultiplier))
      : 1;

    let queued = 0;
    for (let frame = 0; frame < available; frame += stride) {
      const sampleOffset = frame * 2;
      const left = pcm[sampleOffset] / 32768;
      const right = pcm[sampleOffset + 1] / 32768;
      pushSampleFrame(left, right);
      queued++;
    }

    consumeFn(available);
    totalFramesPulled += available;

    if (audioCtx && !processorNode) {
      scheduleFallbackBuffer(queued);
    }

    return available;
  }

  async function unlock() {
    if (disposed || automate) return false;
    unlocked = true;
    const ctx = ensureAudioContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended' && !manuallySuspended && typeof ctx.resume === 'function') {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }
    return ctx.state === 'running';
  }

  function attachUnlockListeners(target = globalThis.window) {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    if (detachUnlockListeners) return detachUnlockListeners;

    const events = ['pointerdown', 'keydown', 'click'];
    const onGesture = () => {
      void unlock().then((running) => {
        if (running && detachUnlockListeners) {
          detachUnlockListeners();
        }
      });
    };

    for (const eventName of events) {
      target.addEventListener(eventName, onGesture, { passive: true });
    }

    detachUnlockListeners = () => {
      for (const eventName of events) {
        target.removeEventListener?.(eventName, onGesture, { passive: true });
      }
      detachUnlockListeners = null;
    };
    return detachUnlockListeners;
  }

  function setVolume(nextVolume) {
    volume = normalizeSoundVolume(nextVolume);
    updateGainNode();
    return volume;
  }

  function setMuted(nextMuted) {
    muted = Boolean(nextMuted);
    if (muted) {
      readIndex = 0;
      writeIndex = 0;
      bufferedFrames = 0;
    }
    updateGainNode();
    return muted;
  }

  function toggleMuted() {
    return setMuted(!muted);
  }

  async function suspend() {
    manuallySuspended = true;
    readIndex = 0;
    writeIndex = 0;
    bufferedFrames = 0;
    if (audioCtx && audioCtx.state === 'running' && typeof audioCtx.suspend === 'function') {
      try {
        await audioCtx.suspend();
      } catch {
        // Ignore suspend errors on closed contexts.
      }
    }
  }

  async function resume() {
    manuallySuspended = false;
    if (unlocked) {
      await unlock();
    }
  }

  async function dispose() {
    disposed = true;
    if (detachUnlockListeners) {
      detachUnlockListeners();
    }
    if (processorNode) {
      processorNode.onaudioprocess = null;
      try {
        processorNode.disconnect();
      } catch {
        // Ignore disconnect errors.
      }
      processorNode = null;
    }
    if (gainNode) {
      try {
        gainNode.disconnect();
      } catch {
        // Ignore disconnect errors.
      }
      gainNode = null;
    }
    if (audioCtx && typeof audioCtx.close === 'function') {
      try {
        await audioCtx.close();
      } catch {
        // Ignore close errors.
      }
    }
    audioCtx = null;
    readIndex = 0;
    writeIndex = 0;
    bufferedFrames = 0;
  }

  function getState() {
    return {
      muted,
      volume,
      effectiveGain: clampGain(volume, muted),
      sampleRate,
      running: Boolean(audioCtx && audioCtx.state === 'running' && !manuallySuspended),
      unlocked,
      bufferedFrames,
      ringCapacityFrames,
      totalFramesPulled,
      droppedFrames,
    };
  }

  return {
    unlock,
    attachUnlockListeners,
    pullFromWasm,
    drainFrames,
    setVolume,
    setMuted,
    toggleMuted,
    suspend,
    resume,
    dispose,
    getState,
  };
}
