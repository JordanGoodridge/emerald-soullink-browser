import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunState, reduceRunEvent } from './run-state.mjs';
import { buildRunTracker } from './tracker-model.mjs';

test('tracker distinguishes unvisited sections and reports area/link members', () => {
  let run = createRunState({ runId: 'r', seed: 1, members: [{ playerId: 'p1', name: 'A' }, { playerId: 'p2', name: 'B' }] });
  run = reduceRunEvent(run, { eventId: '1', type: 'encounter.claim', playerId: 'p1', areaKey: 'route101:land', sectionId: 10, label: 'Route 101', species: 382, level: 3 }).state;
  run = reduceRunEvent(run, { eventId: '2', type: 'encounter.claim', playerId: 'p2', areaKey: 'route101:land', sectionId: 10, label: 'Route 101', species: 25, level: 3 }).state;
  run = reduceRunEvent(run, { eventId: '3', type: 'encounter.resolve', playerId: 'p1', areaKey: 'route101:land', result: 'caught' }).state;
  run = reduceRunEvent(run, { eventId: '4', type: 'encounter.resolve', playerId: 'p2', areaKey: 'route101:land', result: 'caught' }).state;
  const tracker = buildRunTracker({ run, regionMap: { sections: [{ id: 10, name: 'Route 101', x: 4, y: 10 }, { id: 11, name: 'Route 102', x: 4, y: 9 }] } });
  assert.equal(tracker.sections[0].status, 'linked');
  assert.equal(tracker.sections[1].status, 'unvisited');
  assert.equal(tracker.links[0].members.length, 2);
  assert.equal(tracker.links[0].members[0].name, 'A');
});

test('tracker reports caught and waiting player slots for a pending encounter', () => {
  let run = createRunState({ runId: 'r', seed: 1, members: [{ playerId: 'p1' }, { playerId: 'p2' }, { playerId: 'p3' }] });
  const claimed = reduceRunEvent(run, { eventId: '1', type: 'encounter.claim', playerId: 'p1', areaKey: 'r:water', sectionId: 2, species: 25 }).state;
  run = reduceRunEvent(claimed, { eventId: '2', type: 'encounter.resolve', playerId: 'p1', areaKey: 'r:water', result: 'caught' }).state;
  const tracker = buildRunTracker({ run, regionMap: { sections: [{ id: 2 }] } });
  assert.equal(tracker.sections[0].status, 'pending');
  assert.deepEqual(tracker.pending[0].members.map((member) => member.status), ['caught', 'waiting', 'waiting']);
  assert.equal(tracker.summary.visited, 1);
});

test('tracker distinguishes a visited available route from unvisited and separates gifts', () => {
  let run = createRunState({ runId: 'r', seed: 1, members: [{ playerId: 'p1', name: 'A' }] , allowSolo: true });
  run = reduceRunEvent(run, { eventId: 'visit', type: 'area.visit', playerId: 'p1', areaKey: 'emerald:section:10', sectionId: 10, label: 'Route 101' }).state;
  run = reduceRunEvent(run, { eventId: 'gift', type: 'encounter.claim', playerId: 'p1', areaKey: 'emerald:gift:starter', sectionId: 10, label: 'Starter', species: 25, isGift: true }).state;
  const tracker = buildRunTracker({ run, regionMap: { sections: [{ id: 10, name: 'Route 101' }, { id: 11, name: 'Route 102' }] } });
  assert.equal(tracker.sections[0].status, 'available');
  assert.equal(tracker.sections[0].visited, true);
  assert.equal(tracker.sections[1].visited, false);
  assert.equal(tracker.gifts.length, 1);
  assert.equal(tracker.gifts[0].label, 'Starter');
});
