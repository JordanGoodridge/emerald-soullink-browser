import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPeerOverlay, TAG_HEAD_OFFSET } from './peer-overlay-model.mjs';

const members = [
  { playerId: 'p1', name: 'Brendan' },
  { playerId: 'p2', name: 'May' },
];

function actor(playerId, screenX, screenY, extra = {}) {
  return { playerId, screenX, screenY, layer: 3, ...extra };
}

test('on-screen actors get name tags above the head', () => {
  const { tags, indicators } = buildPeerOverlay({
    actors: [actor('p1', 120, 100)],
    members,
    settings: {},
  });
  assert.equal(indicators.length, 0);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].label, 'Brendan');
  assert.equal(tags[0].y, 100 - TAG_HEAD_OFFSET);
});

test('off-screen actors get indicators with names and their atlas layer', () => {
  const { tags, indicators } = buildPeerOverlay({
    actors: [actor('p2', 400, 100)],
    members,
    settings: {},
  });
  assert.equal(tags.length, 0);
  assert.equal(indicators.length, 1);
  assert.equal(indicators[0].label, 'May');
  assert.equal(indicators[0].edge, 'right');
  assert.equal(indicators[0].layer, 3);
});

test('battle markers are labelled and mark the indicator', () => {
  const { tags, indicators } = buildPeerOverlay({
    actors: [actor('p1', 120, 100, { marker: 'battle' }), actor('p2', -20, 80, { marker: 'battle' })],
    members,
    settings: {},
  });
  assert.equal(tags[0].label, 'Brendan (battle)');
  assert.equal(indicators[0].label, 'May (battle)');
  assert.equal(indicators[0].marker, 'battle');
});

test('settings disable tags and indicators independently', () => {
  const actors = [actor('p1', 120, 100), actor('p2', 400, 100)];
  const noTags = buildPeerOverlay({ actors, members, settings: { peerNameTags: false } });
  assert.equal(noTags.tags.length, 0);
  assert.equal(noTags.indicators.length, 1);

  const noIndicators = buildPeerOverlay({ actors, members, settings: { peerIndicators: false } });
  assert.equal(noIndicators.tags.length, 1);
  assert.equal(noIndicators.indicators.length, 0);

  const none = buildPeerOverlay({
    actors,
    members,
    settings: { peerNameTags: false, peerIndicators: false },
  });
  assert.deepEqual(none, { tags: [], indicators: [] });
});

test('unknown names fall back and non-finite positions are dropped', () => {
  const { tags, indicators } = buildPeerOverlay({
    actors: [actor('ghost', 50, 50), { playerId: 'bad', screenX: Number.NaN, screenY: 10 }, null],
    members,
    settings: {},
  });
  assert.equal(tags.length, 1);
  assert.equal(tags[0].label, 'Player');
  assert.equal(indicators.length, 0);
});

test('actors exactly on the viewport edge count as on-screen', () => {
  const { tags } = buildPeerOverlay({
    actors: [actor('p1', 0, 0), actor('p2', 240, 160)],
    members,
    settings: {},
  });
  assert.equal(tags.length, 2);
});

test('projected head geometry overrides the flat field offset', () => {
  const projected = new Map([['p1', { x: 60, y: 30, footY: 62 }]]);
  const { tags } = buildPeerOverlay({
    actors: [actor('p1', 40, 50)],
    members,
    settings: {},
    projected,
  });
  assert.equal(tags.length, 1);
  assert.equal(tags[0].x, 60);
  assert.equal(tags[0].y, 30);
});

test('projected foot decides on-screen placement, not the flat position', () => {
  const projected = new Map([['p1', { x: 120, y: 10, footY: 80 }]]);
  const { tags } = buildPeerOverlay({
    actors: [actor('p1', 400, 100)],
    members,
    settings: {},
    projected,
  });
  assert.equal(tags.length, 1);
});

test('actors with projected geometry use the flat offset when projection is absent', () => {
  const { tags } = buildPeerOverlay({
    actors: [actor('p1', 120, 100)],
    members,
    settings: {},
    projected: new Map(),
  });
  assert.equal(tags[0].y, 100 - TAG_HEAD_OFFSET);
});

test('cross-border peers never produce edge arrows', () => {
  const { indicators } = buildPeerOverlay({
    actors: [
      actor('p2', 400, 100, { crossBorder: true }),
      { playerId: 'p3', screenX: 380, screenY: 100 },
    ],
    members: [...members, { playerId: 'p3', name: 'Wally' }],
    settings: {},
  });
  assert.equal(indicators.length, 1);
  assert.equal(indicators[0].playerId, 'p3');
});

test('cutscene markers are labelled for peers', () => {
  const { tags } = buildPeerOverlay({
    actors: [actor('p2', 120, 100, { marker: 'cutscene', busy: true })],
    members,
    settings: {},
  });
  assert.equal(tags.length, 1);
  assert.equal(tags[0].label, 'May (cutscene)');
});

test('battle markers include the peer lead living Pokémon name when party snapshot is available', () => {
  const parties = {
    p1: {
      availability: 'available',
      members: [
        { species: 288, speciesName: 'ZIGZAGOON', hp: 0 },
        { species: 383, speciesName: 'LAIRON', hp: 38 },
      ],
    },
  };
  const { tags, indicators } = buildPeerOverlay({
    actors: [actor('p1', 120, 100, { marker: 'battle' }), actor('p1', -20, 80, { marker: 'battle' })],
    members,
    parties,
    settings: {},
  });
  assert.equal(tags[0].label, 'Brendan (battle · Lairon)');
  assert.equal(indicators[0].label, 'Brendan (battle · Lairon)');
});
