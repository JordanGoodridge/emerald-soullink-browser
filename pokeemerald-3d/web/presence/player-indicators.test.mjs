import test from 'node:test';
import assert from 'node:assert/strict';
import { computeIndicators, indicatorHue } from './player-indicators.mjs';

const viewport = { width: 240, height: 160 };

test('an on-screen peer has no indicator', () => {
  assert.deepEqual(computeIndicators({
    actors: [{ playerId: 'p2', screenX: 120, screenY: 80 }],
    ...viewport,
  }), []);
});

test('a peer outside each edge clamps to that edge', () => {
  const [left] = computeIndicators({ actors: [{ playerId: 'p2', screenX: -40, screenY: 80 }], ...viewport });
  assert.equal(left.edge, 'left');
  assert.ok(left.x < 20 && left.y === 80);

  const [right] = computeIndicators({ actors: [{ playerId: 'p3', screenX: 320, screenY: 80 }], ...viewport });
  assert.equal(right.edge, 'right');
  assert.ok(right.x > 220);

  const [up] = computeIndicators({ actors: [{ playerId: 'p4', screenX: 120, screenY: -60 }], ...viewport });
  assert.equal(up.edge, 'up');
  assert.ok(up.y < 20);

  const [down] = computeIndicators({ actors: [{ playerId: 'p5', screenX: 120, screenY: 260 }], ...viewport });
  assert.equal(down.edge, 'down');
  assert.ok(down.y > 140);
});

test('diagonal peers pick the dominant axis and stay inside the inset box', () => {
  const [indicator] = computeIndicators({
    actors: [{ playerId: 'p2', screenX: 260, screenY: 100 }], ...viewport,
  });
  assert.equal(indicator.edge, 'right');
  assert.ok(indicator.x <= 230 && indicator.x >= 0);
  assert.ok(indicator.y >= 0 && indicator.y <= 160);
});

test('markers keep their battle flag and junk input is ignored', () => {
  const list = computeIndicators({
    actors: [
      { playerId: 'p2', screenX: 400, screenY: 80, marker: 'battle' },
      { playerId: 'p3', screenX: Number.NaN, screenY: 0 },
      null,
    ],
    ...viewport,
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].marker, 'battle');
});

test('indicator colour is stable per player', () => {
  assert.equal(indicatorHue('p1'), indicatorHue('p1'));
  assert.notEqual(indicatorHue('p1'), indicatorHue('p2'));
  assert.ok(indicatorHue('p1') >= 0 && indicatorHue('p1') < 360);
});
