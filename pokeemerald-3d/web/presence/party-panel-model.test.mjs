import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPartyPanel } from './party-panel-model.mjs';

const members = [
  { playerId: 'p1', name: 'Ash' },
  { playerId: 'p2', name: 'Misty' },
];

test('builds self first, then peers, with availability and normalized members', () => {
  const model = buildPartyPanel({
    self: {
      playerId: 'p1',
      party: { availability: 'available', members: [{ species: 25, speciesName: 'PIKACHU', level: 18, hp: 42 }], revision: 1 },
    },
    members,
    parties: {
      p2: { availability: 'available', members: [{ species: 6, speciesName: 'CHARIZARD', level: 40 }], revision: 1 },
    },
    speciesNameFor: () => null,
  });
  assert.equal(model.players.length, 2);
  assert.equal(model.players[0].isSelf, true);
  assert.equal(model.players[0].name, 'Ash');
  assert.deepEqual(model.players[0].members, [{ species: 25, speciesName: 'PIKACHU', nickname: null, level: 18, hp: 42 }]);
  assert.equal(model.players[1].playerId, 'p2');
  assert.equal(model.players[1].isSelf, false);
  assert.equal(model.players[1].members[0].speciesName, 'CHARIZARD');
});

test('resolves species names through the provided resolver when absent', () => {
  const model = buildPartyPanel({
    self: { playerId: 'p1', party: { availability: 'available', members: [{ species: 25 }], revision: 1 } },
    members,
    speciesNameFor: (id) => (id === 25 ? 'PIKACHU' : null),
  });
  assert.equal(model.players[0].members[0].speciesName, 'PIKACHU');
});

test('represents hidden and unavailable peers without leaking members', () => {
  const model = buildPartyPanel({
    self: { playerId: 'p1', party: { availability: 'hidden', members: [], revision: 2 } },
    members,
    parties: { p2: { availability: 'unavailable', members: [], revision: 0 } },
  });
  assert.equal(model.players[0].availability, 'hidden');
  assert.deepEqual(model.players[0].members, []);
  assert.equal(model.players[1].availability, 'unavailable');
});

test('caps at four players and never duplicates self', () => {
  const parties = {};
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
    parties[id] = { availability: 'available', members: [], revision: 1 };
  }
  const many = [
    ...members,
    { playerId: 'p3', name: 'Brock' },
    { playerId: 'p4', name: 'Gary' },
    { playerId: 'p5', name: 'Oak' },
  ];
  const model = buildPartyPanel({
    self: { playerId: 'p1', party: { availability: 'available', members: [], revision: 1 } },
    members: many,
    parties,
  });
  assert.equal(model.players.length, 4);
  assert.equal(model.players.filter((player) => player.playerId === 'p1').length, 1);
});

test('maps SoulLink links into readable pairs and attaches inline partner metadata to party slots', () => {
  const model = buildPartyPanel({
    self: {
      playerId: 'p1',
      party: { availability: 'available', members: [{ species: 25, level: 18, hp: 42 }], revision: 1 },
    },
    members,
    parties: {
      p2: { availability: 'available', members: [{ species: 6, nickname: 'Blaze', level: 19, hp: 50 }], revision: 1 },
    },
    areas: {
      'emerald:section:1': { label: 'Route 101' },
    },
    links: {
      'link:emerald:section:1': {
        linkId: 'link:emerald:section:1',
        areaKey: 'emerald:section:1',
        status: 'active',
        members: [
          { playerId: 'p1', species: 25, nickname: null, level: 18, status: 'alive' },
          { playerId: 'p2', species: 6, nickname: 'Blaze', level: 19, status: 'alive' },
        ],
      },
      'link:emerald:starter': {
        linkId: 'link:emerald:starter',
        areaKey: 'emerald:starter',
        status: 'active',
        members: [
          { playerId: 'p1', species: 258, nickname: 'Mud', level: 12, status: 'alive' },
          { playerId: 'p2', species: 255, nickname: 'Torch', level: 12, status: 'alive' },
        ],
      },
    },
    speciesNameFor: (id) => ({ 25: 'PIKACHU', 6: 'CHARIZARD', 258: 'MUDKIP', 255: 'TORCHIC' })[id] ?? null,
  });
  assert.equal(model.links.length, 2);
  assert.deepEqual(model.links[0].pairs.map((pair) => pair.name), ['Ash', 'Misty']);
  assert.deepEqual(model.links[0].pairs.map((pair) => pair.speciesName), ['PIKACHU', 'CHARIZARD']);
  assert.equal(model.links[0].pairs[1].nickname, 'Blaze');
  assert.equal(model.links[0].status, 'active');
  assert.equal(model.links[0].areaLabel, 'Route 101');
  assert.equal(model.links[0].placement, 'party');
  assert.equal(model.links[1].areaLabel, 'Starter');
  assert.equal(model.links[1].placement, 'boxed');

  const ashSlot0 = model.players[0].members[0];
  assert.ok(ashSlot0.link);
  assert.equal(ashSlot0.link.areaLabel, 'Route 101');
  assert.equal(ashSlot0.link.partners.length, 1);
  assert.equal(ashSlot0.link.partners[0].name, 'Misty');
  assert.equal(ashSlot0.link.partners[0].label, 'Blaze');

  const mistySlot0 = model.players[1].members[0];
  assert.ok(mistySlot0.link);
  assert.equal(mistySlot0.link.partners[0].name, 'Ash');
  assert.equal(mistySlot0.link.partners[0].label, 'PIKACHU');
});

test('marks peers stale from their newest presence snapshot', () => {
  const model = buildPartyPanel({
    self: { playerId: 'p1', party: { availability: 'available', members: [], revision: 1 } },
    members: [
      { playerId: 'p1', name: 'Ash' },
      {
        playerId: 'p2',
        name: 'Misty',
        latest: {
          receivedMs: 1000,
          state: {
            activity: 'overworld',
            world: { mapGroup: 0, mapNum: 10, layoutId: 'layout_b', variant: 'base' },
            pose: null,
            battleAnchor: null,
          },
        },
      },
    ],
    parties: { p2: { availability: 'available', members: [{ species: 6 }], revision: 1 } },
    serverNowMs: 7000,
    visibleSnapshotAgeMs: 5000,
    nameFor: () => 'Oldale Town',
  });
  const peer = model.players.find((player) => player.playerId === 'p2');
  assert.equal(model.players[0].stale, false);
  assert.equal(peer.stale, true);
  assert.equal(peer.mapName, 'Oldale Town');
  assert.equal(peer.members[0].species, 6);
});
