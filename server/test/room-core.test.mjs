import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_VERSION, DEFAULT_LIMITS } from '../../pokeemerald-3d/web/presence/protocol.mjs';
import { createRoomService } from '../src/room-core.mjs';

function harness(options = {}) {
  let time = 1000;
  let player = 0;
  let token = 0;
  const codes = [...(options.codes ?? ['ABCD2345', 'EFGH6789', 'JKLM2345'])];
  const service = createRoomService({
    now: () => time,
    createRoomCode: () => codes.shift() ?? `ROOM${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    createPlayerId: () => `p${++player}`,
    createToken: () => `t${++token}`,
    limits: options.limits ?? DEFAULT_LIMITS,
  });
  return {
    service,
    at(value) { time = value; },
    create(socket = 's1', name = 'A') {
      return service.create(socket, { type: 'create', contentVersion: CONTENT_VERSION, name });
    },
    join(socket, room, name = socket) {
      return service.join(socket, { type: 'join', room, contentVersion: CONTENT_VERSION, name });
    },
    presence(socket, generation, seq, state, sampleMs = seq * 100) {
      return service.presence(socket, {
        type: 'presence', generation, seq, sampleMs, state,
      });
    },
    disconnect(socket) {
      return service.disconnect(socket);
    },
  };
}

function messageOf(effects, type) {
  return effects.find((effect) => effect.type === 'send' && effect.message?.type === type)?.message;
}

function sent(effects, socketId) {
  return effects.filter((effect) => effect.type === 'send' && effect.socketId === socketId).map((e) => e.message);
}

function state(epoch = 1, overrides = {}) {
  return {
    epoch,
    activity: 'overworld',
    world: { mapGroup: 0, mapNum: 9, layoutId: 'littleroot', variant: 'base' },
    pose: {
      xPx: 168, yPx: 176, elevation: 3, jumpPx: 0,
      facing: 'down', appearance: 'brendan.on-foot', motion: 'idle', frame: 0,
    },
    ...overrides,
  };
}

test('create returns a welcome without exposing the token in the roster', () => {
  const h = harness();
  const effects = h.create();
  const welcome = messageOf(effects, 'welcome');
  assert.equal(welcome.room, 'ABCD2345');
  assert.equal(welcome.playerId, 'p1');
  assert.equal(welcome.token, 't1');
  assert.equal(welcome.generation, 1);
  assert.equal(welcome.revision, 1);
  assert.equal(welcome.members.length, 1);
  assert.equal(welcome.members[0].playerId, 'p1');
  assert.equal(welcome.members[0].connection, 'connected');
  assert.equal(welcome.members[0].token, undefined);
});

test('four players join and a fifth is rejected', () => {
  const h = harness();
  h.create('s1');
  for (const socket of ['s2', 's3', 's4']) {
    const effects = h.join(socket, 'ABCD2345');
    assert.equal(messageOf(effects, 'welcome').members.length, Number(socket.slice(1)));
  }
  const fifth = h.join('s5', 'ABCD2345');
  assert.equal(messageOf(fifth, 'error').code, 'room_full');
  assert.equal(h.service.inspect('ABCD2345').memberCount, 4);
});

test('roster updates go to other connected members only', () => {
  const h = harness();
  h.create('s1');
  const effects = h.join('s2', 'ABCD2345', 'B');
  const roster = messageOf(effects, 'roster');
  assert.equal(roster.revision, 2);
  assert.equal(roster.members.length, 2);
  assert.deepEqual(sent(effects, 's2').map((m) => m.type), ['welcome']);
});

test('rooms are isolated', () => {
  const h = harness();
  h.create('s1');
  h.create('s9');
  h.join('s2', 'ABCD2345');
  h.join('s8', 'EFGH6789');
  const effects = h.presence('s1', 1, 1, state());
  assert.equal(sent(effects, 's2').length, 1);
  assert.equal(sent(effects, 's8').length, 0);
});

test('join requires an existing room and matching content version', () => {
  const h = harness();
  const missing = h.service.join('s1', {
    type: 'join', room: 'ZZZZ2345', contentVersion: CONTENT_VERSION, name: 'A',
  });
  assert.equal(messageOf(missing, 'error').code, 'room_not_found');

  h.create('s2');
  const mismatch = h.service.join('s1', {
    type: 'join', room: 'ABCD2345', contentVersion: 'other-version', name: 'A',
  });
  assert.equal(messageOf(mismatch, 'error').code, 'incompatible_version');
});

test('a late generation cannot publish or replace a resuming socket', () => {
  const h = harness();
  h.create('s1');
  h.join('s2', 'ABCD2345', 'B');
  h.presence('s1', 1, 1, state());

  const resume = h.service.resume('s3', {
    type: 'resume', room: 'ABCD2345', contentVersion: CONTENT_VERSION, playerId: 'p1', token: 't1',
  });
  const welcome = messageOf(resume, 'welcome');
  assert.equal(welcome.generation, 2);
  assert.equal(welcome.token, 't3');
  assert.equal(welcome.members.find((m) => m.playerId === 'p1').latest, null);
  assert.ok(resume.some((effect) => effect.type === 'close' && effect.socketId === 's1'));

  assert.equal(h.presence('s1', 1, 2, state()).length, 0, 'fenced socket is ignored');
  assert.equal(sent(h.presence('s3', 2, 1, state()), 's2').length, 1);
});

test('a rotated token cannot be reused', () => {
  const h = harness();
  h.create('s1');
  h.service.disconnect('s1');
  h.service.resume('s2', {
    type: 'resume', room: 'ABCD2345', contentVersion: CONTENT_VERSION, playerId: 'p1', token: 't1',
  });
  const stale = h.service.resume('s3', {
    type: 'resume', room: 'ABCD2345', contentVersion: CONTENT_VERSION, playerId: 'p1', token: 't1',
  });
  assert.equal(messageOf(stale, 'error').code, 'invalid_resume');
});

test('disconnect reserves the slot and hides presence until resume', () => {
  const h = harness();
  h.create('s1');
  h.join('s2', 'ABCD2345', 'B');
  const disconnectEffects = h.disconnect('s1');
  const roster = messageOf(disconnectEffects, 'roster');
  assert.equal(roster.members.find((m) => m.playerId === 'p1').connection, 'reconnecting');

  const member = h.service.inspect('ABCD2345').members.find((m) => m.playerId === 'p1');
  assert.equal(member.connection, 'reconnecting');
  assert.equal(member.socketId, null);

  h.at(1000 + DEFAULT_LIMITS.reservationMs - 1);
  h.service.tick();
  assert.equal(h.service.inspect('ABCD2345').memberCount, 2);

  h.at(1000 + DEFAULT_LIMITS.reservationMs);
  h.service.tick();
  assert.equal(h.service.inspect('ABCD2345').memberCount, 1);
});

test('explicit leave removes immediately and empty rooms expire after the timeout', () => {
  const h = harness();
  h.create('s1');
  const effects = h.service.leave('s1');
  assert.ok(effects.some((effect) => effect.type === 'close'));
  assert.equal(h.service.inspect('ABCD2345').memberCount, 0);

  h.at(1000 + DEFAULT_LIMITS.emptyRoomMs - 1);
  h.service.tick();
  assert.ok(h.service.inspect('ABCD2345'));

  h.at(1000 + DEFAULT_LIMITS.emptyRoomMs);
  h.service.tick();
  assert.equal(h.service.inspect('ABCD2345'), null);
});

test('room host identity hands off to the first remaining member on leave or reservation expiry', () => {
  const h = harness();
  h.create('s1');
  h.join('s2', 'ABCD2345', 'B');
  assert.equal(h.service.inspect('ABCD2345').hostPlayerId, 'p1');
  h.service.leave('s1');
  assert.equal(h.service.inspect('ABCD2345').hostPlayerId, 'p2');

  const secondRoom = harness();
  secondRoom.create('s1');
  secondRoom.join('s2', 'ABCD2345', 'B');
  secondRoom.service.disconnect('s1');
  secondRoom.at(1000 + DEFAULT_LIMITS.reservationMs);
  secondRoom.service.tick();
  assert.equal(secondRoom.service.inspect('ABCD2345').hostPlayerId, 'p2');
});

test('a room can be joined during its empty timeout', () => {
  const h = harness();
  h.create('s1');
  h.service.leave('s1');
  h.at(1000 + DEFAULT_LIMITS.emptyRoomMs - 1);
  const welcome = messageOf(h.join('s2', 'ABCD2345', 'B'), 'welcome');
  assert.equal(welcome.members.length, 1);
  h.at(1000 + DEFAULT_LIMITS.emptyRoomMs + 1);
  h.service.tick();
  assert.ok(h.service.inspect('ABCD2345'));
});

test('presence sequencing, clock and epoch rules', () => {
  const h = harness();
  h.create('s1');
  h.join('s2', 'ABCD2345', 'B');

  assert.equal(sent(h.presence('s1', 1, 1, state(), 100), 's2').length, 1);
  const snapshot = messageOf(h.presence('s1', 1, 2, state(), 200), 'presence').snapshot;
  assert.equal(snapshot.playerId, 'p1');
  assert.equal(snapshot.receivedMs, 1000);

  assert.equal(h.presence('s1', 1, 2, state(), 200).length, 0, 'duplicate seq ignored');
  assert.equal(h.presence('s1', 1, 1, state(), 100).length, 0, 'older seq ignored');
  assert.equal(h.presence('s1', 1, 3, state(), 50).length, 0, 'older sample ignored');
  assert.equal(h.presence('s1', 1, 3, state(0), 300).length, 0, 'older epoch ignored');
  assert.equal(
    h.presence('s1', 1, 3, state(1, { world: { mapGroup: 0, mapNum: 10, layoutId: 'littleroot', variant: 'base' } }), 300).length,
    0,
    'world change requires a new epoch',
  );
  assert.equal(h.presence('s1', 2, 3, state(1), 300).length, 0, 'wrong generation ignored');
  assert.equal(h.presence('s1', 1, 3, state(2), 300).length, 1, 'new epoch accepted');
});

test('off-map members still receive presence for roster status', () => {
  const h = harness();
  h.create('s1');
  h.join('s2', 'ABCD2345', 'B');
  h.presence('s2', 1, 1, state(1, {
    world: { mapGroup: 0, mapNum: 10, layoutId: 'littleroot', variant: 'base' },
  }));
  const effects = h.presence('s1', 1, 1, state());
  assert.equal(sent(effects, 's2').length, 1);
});

test('presence from an unbound socket cannot publish', () => {
  const h = harness();
  h.create('s1');
  h.join('s2', 'ABCD2345', 'B');
  assert.equal(h.presence('unknown', 1, 1, state()).length, 0);
});

test('roster revisions increase on joins, disconnects and resumes', () => {
  const h = harness();
  h.create('s1');
  const join = messageOf(h.join('s2', 'ABCD2345', 'B'), 'roster');
  h.disconnect('s2');
  const afterDisconnect = h.service.inspect('ABCD2345');
  assert.ok(afterDisconnect.revision > join.revision);
  const resume = messageOf(h.service.resume('s3', {
    type: 'resume', room: 'ABCD2345', contentVersion: CONTENT_VERSION, playerId: 'p2', token: 't2',
  }), 'welcome');
  assert.ok(resume.revision > afterDisconnect.revision);
});

test('room membership validator reuses resume credentials without exposing tokens', () => {
  const h = harness();
  h.create('s1', 'Ash');
  const validated = h.service.validateMember({ roomCode: 'ABCD2345', playerId: 'p1', token: 't1' });
  assert.deepEqual(validated, {
    roomCode: 'ABCD2345',
    contentVersion: CONTENT_VERSION,
    playerId: 'p1',
    name: 'Ash',
    connection: 'connected',
  });
  assert.equal('token' in validated, false);
  assert.equal(h.service.validateMember({ roomCode: 'ABCD2345', playerId: 'p1', token: 'wrong' }), null);
});

test('party snapshots broadcast to members and to later joiners', () => {
  const h = harness();
  h.create('s1', 'A');
  const party = { availability: 'available', members: [{ species: 25, level: 18 }], revision: 1 };
  // No other members yet, so the publish has no broadcast effects.
  assert.equal(h.service.party('s1', { type: 'party', party }).length, 0);

  // A later joiner receives the stored party with the sender's player id.
  const joined = h.join('s2', 'ABCD2345', 'B');
  const toNewJoiner = messageOf(joined, 'party');
  assert.equal(toNewJoiner.playerId, 'p1');
  assert.deepEqual(toNewJoiner.party, party);

  // Publishes from an existing member broadcast to the other member.
  const party2 = { availability: 'available', members: [{ species: 6 }], revision: 1 };
  const relayed = h.service.party('s2', { type: 'party', party: party2 });
  const broadcast = messageOf(relayed, 'party');
  assert.equal(broadcast.playerId, 'p2');
  assert.deepEqual(broadcast.party, party2);
});

test('party relay drops stale revisions and passes hidden state through', () => {
  const h = harness();
  h.create('s1', 'A');
  h.join('s2', 'ABCD2345', 'B');
  const fresh = { availability: 'available', members: [{ species: 25 }], revision: 3 };
  assert.equal(messageOf(h.service.party('s1', { type: 'party', party: fresh }), 'party').party.revision, 3);

  // Same or older revision is ignored.
  assert.equal(h.service.party('s1', { type: 'party', party: { ...fresh, revision: 3 } }).length, 0);
  assert.equal(h.service.party('s1', { type: 'party', party: { ...fresh, revision: 2 } }).length, 0);

  // Hidden (opt-out) is display-only and relays without members.
  const hidden = { availability: 'hidden', members: [], revision: 4 };
  const relayed = messageOf(h.service.party('s1', { type: 'party', party: hidden }), 'party');
  assert.equal(relayed.party.availability, 'hidden');
  assert.deepEqual(relayed.party.members, []);
});
