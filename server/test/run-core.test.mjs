import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomService } from '../src/room-core.mjs';
import { createRunService } from '../src/run-core.mjs';
import { CONTENT_VERSION } from '../../pokeemerald-3d/web/presence/protocol.mjs';

function setup() {
  let id = 0;
  let seed = 100;
  const rooms = createRoomService({
    createRoomCode: () => 'ABCD2345',
    createPlayerId: () => `p${++id}`,
    createToken: () => `token${id}`,
  });
  rooms.create('s1', { type: 'create', contentVersion: CONTENT_VERSION, name: 'Ash' });
  rooms.join('s2', { type: 'join', room: 'ABCD2345', contentVersion: CONTENT_VERSION, name: 'Misty' });
  const runs = createRunService({ roomService: rooms, createRunId: () => `r${++id}`, createSeed: () => ++seed });
  return { rooms, runs };
}

test('run attach validates existing room token and start seeds all current room members', () => {
  const { runs } = setup();
  assert.equal(runs.attach({ roomCode: 'ABCD2345', playerId: 'p1', token: 'token1' }).ok, true);
  assert.equal(runs.attach({ roomCode: 'ABCD2345', playerId: 'p1', token: 'bad' }).ok, false);
  const started = runs.start('ABCD2345', 'p1', { token: 'token1' });
  assert.equal(started.accepted, true);
  assert.equal(started.state.members.length, 2);
  assert.equal(started.state.seed, 101);
});

test('host restores a saved SoulLink checkpoint into a room with matching players', () => {
  const { runs } = setup();
  const { state } = runs.start('ABCD2345', 'p1', {
    token: 'token1',
    settings: { randomizeWild: false, randomizeStarters: true },
  });
  const checkpoint = {
    runState: {
      ...state,
      areas: { route: { areaKey: 'route', claims: { p1: { playerId: 'p1', species: 25 } } } },
      events: [{ eventId: 'old-event', playerId: 'p2', type: 'encounter.skip' }],
    },
  };
  runs.deleteRoom('ABCD2345');
  const restored = runs.restore('ABCD2345', 'p1', checkpoint, { token: 'token1' });
  assert.equal(restored.accepted, true);
  assert.equal(restored.state.runId, state.runId);
  assert.equal(restored.state.hostPlayerId, 'p1');
  assert.equal(restored.state.options.randomizeWild, false);
  assert.equal(restored.state.areas.route.claims.p1.playerId, 'p1');
  assert.equal(restored.state.events[0].playerId, 'p2');
  assert.equal(runs.restore('ABCD2345', 'p1', checkpoint, { token: 'token1' }).reason, 'run_already_exists');
});

test('saved run restore is host-only and rejects ambiguous player names', () => {
  const { runs } = setup();
  const { state } = runs.start('ABCD2345', 'p1', { token: 'token1' });
  assert.equal(runs.restore('ABCD2345', 'p2', { runState: state }, { token: 'token2' }).reason, 'host_required');
  runs.deleteRoom('ABCD2345');
  const ambiguous = structuredClone(state);
  ambiguous.members[1].name = ambiguous.members[0].name;
  assert.equal(runs.restore('ABCD2345', 'p1', { runState: ambiguous }, { token: 'token1' }).reason, 'checkpoint_names_ambiguous');
});

test('only the room host selects run options and restart preserves them with a fresh shared seed', () => {
  const { runs } = setup();
  const guestStart = runs.start('ABCD2345', 'p2', {
    token: 'token2',
    settings: { randomizeWild: false, randomizeTrainers: true },
  });
  assert.equal(guestStart.accepted, false);
  assert.equal(guestStart.reason, 'host_required');

  const settings = {
    randomizeWild: false,
    randomizeTrainers: true,
    randomizeGyms: false,
    randomizeStarters: true,
  };
  const started = runs.start('ABCD2345', 'p1', { token: 'token1', settings });
  assert.deepEqual(
    Object.fromEntries(Object.keys(settings).map((key) => [key, started.state.options[key]])),
    settings,
  );
  assert.equal(started.state.hostPlayerId, 'p1');

  runs.submit('ABCD2345', 'p1', { eventId: 'wipe', type: 'wipe.pending' }, { token: 'token1' });
  runs.submit('ABCD2345', 'p1', { eventId: 'ready-p1', type: 'run.ready' }, { token: 'token1' });
  const prematureRestart = runs.restart('ABCD2345', 'p1', { token: 'token1' });
  assert.equal(prematureRestart.accepted, false);
  assert.equal(prematureRestart.reason, 'players_not_ready');
  const ready = runs.submit('ABCD2345', 'p2', { eventId: 'ready-p2', type: 'run.ready' }, { token: 'token2' });
  assert.equal(ready.accepted, true);
  assert.equal(ready.state.status, 'wipe_pending');
  assert.deepEqual(ready.state.options, started.state.options);
  const guestRestart = runs.restart('ABCD2345', 'p2', { token: 'token2' });
  assert.equal(guestRestart.accepted, false);
  assert.equal(guestRestart.reason, 'host_required');
  const restarted = runs.restart('ABCD2345', 'p1', { token: 'token1' });
  assert.equal(restarted.accepted, true);
  assert.notEqual(restarted.state.seed, started.state.seed);
  assert.deepEqual(restarted.state.options, started.state.options);
  assert.equal(restarted.state.hostPlayerId, 'p1');
  assert.equal(restarted.events.at(-1).seed, restarted.state.seed);
});

test('run events are attributed; only host can restart after all continuing players are ready', () => {
  const { runs } = setup();
  const { state } = runs.start('ABCD2345', 'p1', { token: 'token1' });
  const first = runs.submit('ABCD2345', 'p1', { eventId: 'e1', type: 'wipe.pending', playerId: 'p2' }, { token: 'token1' });
  assert.equal(first.accepted, true);
  assert.equal(first.state.members[0].ready, false);
  const readyOne = runs.submit('ABCD2345', 'p1', { eventId: 'e2', type: 'run.ready' }, { token: 'token1' });
  assert.equal(readyOne.state.runId, state.runId);
  const readyTwo = runs.submit('ABCD2345', 'p2', { eventId: 'e3', type: 'run.ready' }, { token: 'token2' });
  assert.equal(readyTwo.state.status, 'wipe_pending');
  assert.equal(readyTwo.state.members.every((member) => member.ready), true);
  assert.equal(readyTwo.events.length, 1);
  const restarted = runs.restart('ABCD2345', 'p1', { token: 'token1' });
  assert.equal(restarted.state.status, 'active');
  assert.notEqual(restarted.state.runId, state.runId);
});

test('run service rejects a client-authored reset and releases room state on expiry', () => {
  const { runs } = setup();
  runs.start('ABCD2345', 'p1', { token: 'token1' });
  const result = runs.submit('ABCD2345', 'p1', { eventId: 'e1', type: 'run.reset', nextRunId: 'hijack', seed: 1 }, { token: 'token1' });
  assert.equal(result.accepted, false);
  assert.equal(runs.deleteRoom('ABCD2345'), true);
  assert.equal(runs.get('ABCD2345'), null);
});

test('host handoff removes departed members from readiness and lets the successor restart', () => {
  const { rooms, runs } = setup();
  const { state } = runs.start('ABCD2345', 'p1', { token: 'token1' });
  runs.submit('ABCD2345', 'p1', { eventId: 'wipe-handoff', type: 'wipe.pending' }, { token: 'token1' });
  runs.submit('ABCD2345', 'p2', { eventId: 'ready-successor', type: 'run.ready' }, { token: 'token2' });
  rooms.leave('s1');
  const handed = runs.handoffHost('ABCD2345', rooms.inspect('ABCD2345').hostPlayerId);
  assert.equal(handed.hostPlayerId, 'p2');
  assert.equal(handed.members.find((member) => member.playerId === 'p1').active, false);
  const restarted = runs.restart('ABCD2345', 'p2', { token: 'token2' });
  assert.equal(restarted.accepted, true);
  assert.notEqual(restarted.state.runId, state.runId);
  assert.deepEqual(restarted.state.members.map((member) => member.playerId), ['p2']);
});

test('victory state supports host restart after all continuing players ready and checkpoint restore', () => {
  const { runs } = setup();
  const { state } = runs.start('ABCD2345', 'p1', { token: 'token1' });
  const win = runs.submit('ABCD2345', 'p1', {
    eventId: 'win-1',
    type: 'run.victory',
    badgeCount: 8,
    party: [{ species: 260, level: 58, nickname: 'Swampert', pid: 101, moves: [57, 89] }],
  }, { token: 'token1' });
  assert.equal(win.accepted, true);
  assert.equal(win.state.status, 'victory');

  runs.deleteRoom('ABCD2345');
  const restored = runs.restore('ABCD2345', 'p1', { runState: win.state }, { token: 'token1' });
  assert.equal(restored.accepted, true);
  assert.equal(restored.state.status, 'victory');

  runs.submit('ABCD2345', 'p1', { eventId: 'ready-win-1', type: 'run.ready' }, { token: 'token1' });
  runs.submit('ABCD2345', 'p2', { eventId: 'ready-win-2', type: 'run.ready' }, { token: 'token2' });
  const restarted = runs.restart('ABCD2345', 'p1', { token: 'token1' });
  assert.equal(restarted.accepted, true);
  assert.equal(restarted.state.status, 'active');
});

