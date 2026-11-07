import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bearingFor,
  buildRegionMarkers,
  buildPeopleMap,
  distanceFor,
  formatPeerLocation,
  regionSectionForName,
  sameWorld,
  worldKeyFor,
} from './map-overlay-model.mjs';

const route103 = { mapGroup: 1, mapNum: 2, layoutId: 'layout_1a', variant: 'base' };
const route104 = { mapGroup: 1, mapNum: 5, layoutId: 'layout_2b', variant: 'base' };
const names = new Map([
  [worldKeyFor(route103), 'Route 103'],
  [worldKeyFor(route104), 'Route 104'],
]);
const nameFor = (world) => names.get(worldKeyFor(world)) ?? null;

const self = {
  playerId: 'self',
  world: route103,
  pose: { xPx: 100, yPx: 100 },
};

function member(playerId, name, world, { activity = 'overworld', pose = null, battleAnchor = null, connection = 'connected' } = {}) {
  return {
    playerId,
    name,
    connection,
    visible: true,
    latest: { state: { activity, world, pose, battleAnchor } },
  };
}

test('peers on the same map are grouped first with distance and bearing', () => {
  const result = buildPeopleMap({
    self,
    members: [
      member('self', 'Me', route103, { pose: { xPx: 100, yPx: 100 } }),
      member('p2', 'May', route103, { pose: { xPx: 164, yPx: 100 } }),
      member('p3', 'Wally', route104, { pose: { xPx: 10, yPx: 10 } }),
    ],
    nameFor,
  });

  assert.equal(result.total, 2);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].sameMap, true);
  assert.equal(result.groups[0].mapName, 'Route 103');
  const may = result.groups[0].peers[0];
  assert.equal(may.name, 'May');
  assert.equal(may.distancePx, 64);
  assert.equal(may.bearing, 'E');
  assert.equal(result.groups[1].sameMap, false);
  assert.equal(result.groups[1].peers[0].distancePx, null);
  assert.equal(result.groups[1].peers[0].bearing, null);
});

test('same-map peers sort by distance', () => {
  const result = buildPeopleMap({
    self,
    members: [
      member('far', 'Far', route103, { pose: { xPx: 300, yPx: 100 } }),
      member('near', 'Near', route103, { pose: { xPx: 116, yPx: 100 } }),
    ],
    nameFor,
  });
  assert.deepEqual(result.groups[0].peers.map((peer) => peer.name), ['Near', 'Far']);
});

test('layout or variant difference prevents a same-map match', () => {
  const variant = { ...route103, variant: 'dynamic' };
  assert.equal(sameWorld(route103, route104), false);
  assert.equal(sameWorld(route103, variant), false);

  const result = buildPeopleMap({
    self,
    members: [member('p2', 'May', variant, { pose: { xPx: 100, yPx: 100 } })],
    nameFor,
  });
  assert.equal(result.groups[0].sameMap, false);
  assert.equal(result.groups[0].peers[0].distancePx, null);
});

test('battle anchors keep a peer locatable while they are in battle', () => {
  const result = buildPeopleMap({
    self,
    members: [member('p2', 'May', null, {
      activity: 'battle',
      battleAnchor: { world: route103, pose: { xPx: 132, yPx: 100 }, epoch: 1 },
    })],
    nameFor,
  });
  const peer = result.groups[0].peers[0];
  assert.equal(peer.mapName, 'Route 103');
  assert.equal(peer.marker, 'battle');
  assert.equal(peer.activityLabel, 'In battle');
  assert.equal(peer.distancePx, 32);
});

test('members without a known world are grouped separately', () => {
  const result = buildPeopleMap({
    self,
    members: [member('p2', 'May', null, { activity: 'loading' })],
    nameFor,
  });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].peers[0].mapName, 'No area');
  assert.equal(result.groups[0].peers[0].worldKey, null);
});

test('self is excluded and connection state is preserved', () => {
  const result = buildPeopleMap({
    self,
    members: [
      member('self', 'Me', route103),
      member('p2', 'May', route104, { connection: 'reconnecting' }),
    ],
    nameFor,
  });
  assert.equal(result.total, 1);
  assert.equal(result.groups[0].peers[0].connection, 'reconnecting');
});

test('bearing and distance helpers handle degenerate input', () => {
  assert.equal(bearingFor(0, -10), 'N');
  assert.equal(bearingFor(10, 0), 'E');
  assert.equal(bearingFor(0, 10), 'S');
  assert.equal(bearingFor(-10, 0), 'W');
  assert.equal(bearingFor(0, 0), null);
  assert.equal(bearingFor(Number.NaN, 1), null);
  assert.equal(distanceFor(null, { xPx: 0, yPx: 0 }), null);
  assert.equal(distanceFor({ xPx: 0, yPx: 0 }, { xPx: 3, yPx: 4 }), 5);
});

test('formatPeerLocation reads naturally with and without a distance', () => {
  assert.equal(formatPeerLocation({ mapName: 'Route 103', distancePx: 64, bearing: 'E' }), 'Route 103 · 64 px E');
  assert.equal(formatPeerLocation({ mapName: 'Route 104', distancePx: null }), 'Route 104');
});

test('stale peers keep their last area but claim Away', () => {
  const stale = member('p2', 'May', route103, { pose: { xPx: 164, yPx: 100 } });
  stale.latest.receivedMs = 1000;
  const result = buildPeopleMap({
    self,
    members: [stale],
    nameFor,
    serverNowMs: 7000,
    visibleSnapshotAgeMs: 5000,
  });
  const peer = result.groups[0].peers[0];
  assert.equal(peer.stale, true);
  assert.equal(peer.activityLabel, 'Away');
  assert.equal(peer.mapName, 'Route 103');
  assert.equal(peer.distancePx, null);
  assert.equal(formatPeerLocation(peer), 'Route 103');
});

test('region map resolves route and town interiors to their outdoor section', () => {
  const sections = [
    { id: 1, key: 'MAPSEC_LITTLEROOT_TOWN', name: 'Littleroot Town', x: 4, y: 11, width: 1, height: 1 },
    { id: 2, key: 'MAPSEC_ROUTE_104', name: 'Route 104', x: 0, y: 7, width: 1, height: 3 },
  ];
  assert.equal(regionSectionForName('Route104 Mr Brineys House', sections)?.id, 2);
  assert.equal(regionSectionForName('Littleroot Town Brendans House 1F', sections)?.id, 1);
  assert.equal(regionSectionForName('No known area', sections), null);
});

test('region markers use section centers and separate friends sharing an area', () => {
  const sections = [{ id: 18, name: 'Route 103', x: 4, y: 8, width: 4, height: 1 }];
  const markers = buildRegionMarkers({
    peers: [
      { name: 'May', mapName: 'Route 103' },
      { name: 'Wally', mapName: 'Route 103' },
    ],
    sections,
  });
  assert.equal(markers.length, 2);
  assert.equal(markers[0].x, 21.428571428571427);
  assert.notDeepEqual([markers[0].x, markers[0].y], [markers[1].x, markers[1].y]);
});
