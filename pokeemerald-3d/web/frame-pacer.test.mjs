import test from 'node:test';
import assert from 'node:assert/strict';

import { createFramePacer, MAX_FRAME_BACKLOG, MS_PER_FRAME } from './frame-pacer.mjs';

test('1x runs one frame per display period', () => {
  const pacer = createFramePacer();
  assert.equal(pacer.advance(MS_PER_FRAME, 1), 1);
  assert.equal(pacer.advance(MS_PER_FRAME, 1), 1);
});

test('fractional accumulation carries across ticks', () => {
  const pacer = createFramePacer();
  // 0.5x: half a frame per period, so a frame runs every other tick.
  assert.equal(pacer.advance(MS_PER_FRAME, 0.5), 0);
  assert.equal(pacer.advance(MS_PER_FRAME, 0.5), 1);
});

test('8x runs eight frames per period when the display keeps up', () => {
  const pacer = createFramePacer();
  assert.equal(pacer.advance(MS_PER_FRAME, 8), 8);
  assert.equal(pacer.advance(MS_PER_FRAME, 8), 8);
});

test('a dropped display frame cannot double the jump at 8x', () => {
  const pacer = createFramePacer();
  // Two periods of elapsed time would owe 16 frames, but the per-tick cap
  // keeps it to 8 so playback stays smooth instead of bursting.
  assert.equal(pacer.advance(MS_PER_FRAME * 2, 8), 8);
});

test('1x still absorbs a single dropped frame without falling behind', () => {
  const pacer = createFramePacer();
  // 2-frame floor lets 1x catch up one dropped period.
  assert.equal(pacer.advance(MS_PER_FRAME * 2, 1), 2);
});

test('backlog is capped so a long pause cannot burst', () => {
  const pacer = createFramePacer();
  const frames = pacer.advance(MS_PER_FRAME * 100000, 8);
  assert.ok(frames <= 8);
  assert.ok(pacer.backlog <= MAX_FRAME_BACKLOG);
});

test('unlimited speed returns Infinity and never accumulates', () => {
  const pacer = createFramePacer();
  assert.equal(pacer.advance(MS_PER_FRAME, Infinity), Infinity);
  assert.equal(pacer.backlog, 0);
});

test('reset clears the accumulator', () => {
  const pacer = createFramePacer();
  pacer.advance(MS_PER_FRAME * 2, 8);
  pacer.reset();
  assert.equal(pacer.backlog, 0);
  assert.equal(pacer.advance(MS_PER_FRAME, 8), 8);
});
