// Deterministic frame pacing for the emulator tick loop.
//
// Pure math with no DOM, WASM or timers so the pacing policy is unit-testable.
// The pacer owns the fractional-frame accumulator and decides how many whole
// game frames to run each display tick.

export const MS_PER_FRAME = 1000 / 60;

// A dropped display frame doubles elapsedMs and, at high speed, the number of
// emulated frames owed. This cap keeps fast-forward smooth instead of bursting
// after lag or a tab pause; it is ~4 seconds at 60fps.
export const MAX_FRAME_BACKLOG = 240;

export function createFramePacer({ maxBacklog = MAX_FRAME_BACKLOG } = {}) {
  let accumulator = 0;

  function reset() {
    accumulator = 0;
  }

  // Advance by elapsedMs and return how many whole game frames to run this
  // tick. At finite speed the per-tick work is capped so a dropped display
  // frame cannot double the jump at high speed; the 2-frame floor lets 1x
  // absorb a single dropped frame without falling behind real time. Returns
  // Infinity for unlimited speed (the caller runs as many as fit the budget).
  function advance(elapsedMs, speed) {
    if (speed === Infinity) return Infinity;
    accumulator += speed * elapsedMs / MS_PER_FRAME;
    if (accumulator > maxBacklog) accumulator = maxBacklog;

    const perTickCap = Math.max(2, Math.round(speed));
    const frames = Math.min(Math.floor(accumulator), perTickCap);
    if (frames === 0) return 0;

    const residual = accumulator - frames;
    accumulator = Math.min(Math.max(0, residual), perTickCap);
    return frames;
  }

  return { advance, reset, get backlog() { return accumulator; } };
}
