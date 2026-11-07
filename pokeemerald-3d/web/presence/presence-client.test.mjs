import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_VERSION, PROTOCOL_VERSION } from './protocol.mjs';
import { createPresenceClient } from './presence-client.mjs';
import { presence } from './fixtures.mjs';

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.closeCalls = [];
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  send(text) {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(JSON.parse(text));
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify({ v: PROTOCOL_VERSION, ...message }) });
  }

  close(code = 4000, reason = '') {
    if (this.readyState === 3) return;
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function harness() {
  let time = 1000;
  const sockets = [];
  const statuses = [];
  const welcomes = [];
  const rosters = [];
  const snapshots = [];
  const parties = [];
  const errors = [];
  const clocks = [];
  const client = createPresenceClient({
    url: 'ws://test/presence',
    name: 'Jordan',
    contentVersion: CONTENT_VERSION,
    transportFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => time,
    onStatus: (value) => statuses.push(value),
    onWelcome: (value) => welcomes.push(value),
    onRoster: (value) => rosters.push(value),
    onPresence: (value) => snapshots.push(value),
    onParty: (playerId, party) => parties.push({ playerId, party }),
    onError: (value) => errors.push(value),
    onClock: (value) => clocks.push(value),
  });
  return {
    client,
    sockets,
    statuses,
    welcomes,
    rosters,
    snapshots,
    parties,
    errors,
    clocks,
    at(value) { time = value; },
    advance(ms) { time += ms; },
    latestSocket() { return sockets.at(-1); },
  };
}

function welcome(overrides = {}) {
  return {
    type: 'welcome',
    room: 'ABCD2345',
    contentVersion: CONTENT_VERSION,
    playerId: 'p1',
    token: 't1',
    generation: 1,
    revision: 1,
    serverMs: 5000,
    members: [{
      playerId: 'p1', name: 'Jordan', generation: 1, connection: 'connected', latest: null,
    }],
    ...overrides,
  };
}

test('create handshake joins and publishes the first state immediately', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  assert.equal(h.client.status, 'connecting');
  socket.open();
  assert.equal(socket.sent[0].type, 'create');
  assert.equal(socket.sent[0].name, 'Jordan');

  socket.receive(welcome());
  assert.equal(h.client.status, 'joined');
  assert.equal(h.client.room, 'ABCD2345');

  h.client.publish(presence(), 1234);
  const sent = socket.sent.find((message) => message.type === 'presence');
  assert.equal(sent.seq, 1);
  assert.equal(sent.generation, 1);
  assert.equal(sent.sampleMs, 1234);
  assert.equal(sent.state.epoch, 1);
});

test('run credentials are available only to joined client internals and never appear in metrics', () => {
  const h = harness();
  assert.equal(h.client.getRunCredentials(), null);
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(welcome());
  assert.deepEqual(h.client.getRunCredentials(), { room: 'ABCD2345', playerId: 'p1', token: 't1' });
  assert.equal(Object.hasOwn(h.client.getMetrics(), 'token'), false);
  socket.close(1006, 'network lost');
  assert.equal(h.client.status, 'reconnecting');
  assert.deepEqual(h.client.getRunCredentials(), { room: 'ABCD2345', playerId: 'p1', token: 't1' });
  h.client.stop();
  assert.equal(h.client.getRunCredentials(), null);
});

test('moving state is capped at 15 Hz and coalesces the newest pose', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(welcome());
  h.client.publish(presence({ pose: { ...presence().pose, motion: 'walk' } }), 1000);

  h.advance(40);
  h.client.publish(presence({ pose: { ...presence().pose, xPx: 176, motion: 'walk' } }), 1040);
  h.advance(20);
  h.client.publish(presence({ pose: { ...presence().pose, xPx: 184, motion: 'walk' } }), 1060);
  assert.equal(socket.sent.filter((message) => message.type === 'presence').length, 1);

  h.advance(10);
  h.client.publish(presence({ pose: { ...presence().pose, xPx: 192, motion: 'walk' } }), 1070);
  const presences = socket.sent.filter((message) => message.type === 'presence');
  assert.equal(presences.length, 2);
  assert.equal(presences[1].state.pose.xPx, 192);
  assert.equal(presences[1].seq, 2);
});

test('world and activity transitions bypass the movement interval', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(welcome());
  h.client.publish(presence(), 1000);
  h.advance(10);
  h.client.publish(presence({ activity: 'battle', pose: null }), 1010);
  const presences = socket.sent.filter((message) => message.type === 'presence');
  assert.equal(presences.length, 2);
  assert.equal(presences[1].state.activity, 'battle');
});

test('clock estimation uses ping/pong midpoints', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(welcome());
  h.at(6000);
  h.client.tick();
  const ping = socket.sent.filter((message) => message.type === 'ping').at(-1);
  assert.ok(ping);

  h.at(6100);
  socket.receive({ type: 'pong', id: ping.id, clientMs: ping.clientMs, serverMs: 15000 });
  const clock = h.clocks.at(-1);
  assert.equal(clock.ready, true);
  assert.equal(clock.rttMs, 100);
  assert.equal(clock.offsetMs, 15000 - (6000 + 6100) / 2);
  assert.equal(h.client.serverNow(), 6100 + clock.offsetMs);
});

test('network loss reconnects with resume and a fresh sequence', () => {
  const h = harness();
  h.client.create();
  const first = h.sockets[0];
  first.open();
  first.receive(welcome());
  h.client.publish(presence(), 1000);

  first.close(1006, 'network lost');
  assert.equal(h.client.status, 'reconnecting');

  h.advance(700);
  h.client.tick();
  const second = h.sockets[1];
  assert.ok(second, 'retry opens a new socket');
  second.open();
  const resume = second.sent[0];
  assert.equal(resume.type, 'resume');
  assert.equal(resume.playerId, 'p1');
  assert.equal(resume.token, 't1');

  second.receive(welcome({ generation: 2, token: 't2', revision: 3 }));
  assert.equal(h.client.status, 'joined');
  h.client.publish(presence(), 2000);
  const sent = second.sent.filter((message) => message.type === 'presence');
  assert.equal(sent[0].generation, 2);
  assert.equal(sent[0].seq, 1);
});

test('flush sends a pending state without waiting for the rate limiter', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(welcome());
  h.client.publish(presence(), 1000);
  assert.equal(socket.sent.filter((message) => message.type === 'presence').length, 1);

  h.advance(10);
  const moved = presence({ pose: { ...presence().pose, xPx: 999 } });
  h.client.publish(moved, 1010);
  assert.equal(socket.sent.filter((message) => message.type === 'presence').length, 1);
  assert.equal(h.client.flush(), true);
  const presences = socket.sent.filter((message) => message.type === 'presence');
  assert.equal(presences.length, 2);
  assert.equal(presences[1].state.pose.xPx, 999);
});

test('simulateDrop closes the socket and resumes the same session', () => {
  const h = harness();
  h.client.create();
  const first = h.sockets[0];
  first.open();
  first.receive(welcome());

  assert.equal(h.client.simulateDrop(), true);
  assert.equal(first.closeCalls.at(-1).reason, 'simulated drop');
  assert.equal(h.client.status, 'reconnecting');

  h.advance(700);
  h.client.tick();
  const second = h.sockets[1];
  assert.ok(second);
  second.open();
  assert.equal(second.sent[0].type, 'resume');
  assert.equal(second.sent[0].playerId, 'p1');
});

test('simulateDrop is a no-op without a socket', () => {
  const h = harness();
  assert.equal(h.client.simulateDrop(), false);
});

test('terminal handshake errors stop retries', () => {
  const h = harness();
  h.client.join('ABCD2345');
  const socket = h.sockets[0];
  socket.open();
  socket.receive({ type: 'error', code: 'room_full', fatal: true });
  assert.equal(h.client.status, 'closed');
  h.advance(10000);
  h.client.tick();
  assert.equal(h.sockets.length, 1);
});

test('stale roster revisions are ignored', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(welcome({ revision: 4, members: [welcome().members[0]] }));

  socket.receive({
    type: 'roster', revision: 5,
    members: [welcome().members[0], {
      playerId: 'p2', name: 'May', generation: 1, connection: 'connected', latest: null,
    }],
    serverMs: 1,
  });
  assert.equal(h.rosters.at(-1).members.length, 2);

  socket.receive({
    type: 'roster', revision: 3, members: [], serverMs: 1,
  });
  assert.equal(h.rosters.at(-1).revision, 5);
  assert.equal(h.rosters.length, 1);
});

test('handshake timeout closes and retries', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  h.advance(5001);
  h.client.tick();
  assert.ok(socket.closeCalls.length > 0);
  assert.equal(h.client.status, 'reconnecting');
});

test('congestion closes the socket for a clean reconnect', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(welcome());
  socket.bufferedAmount = 70000;
  h.client.tick();
  assert.equal(socket.closeCalls.at(-1).reason, 'congested');
});

test('explicit stop leaves the room and disables retries', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(welcome());
  h.client.stop();
  assert.ok(socket.sent.some((message) => message.type === 'leave'));
  assert.equal(h.client.status, 'disconnected');
  h.advance(5000);
  h.client.tick();
  assert.equal(h.sockets.length, 1);
});

test('a suspended page keeps its socket instead of declaring it dead', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(welcome());
  h.client.tick();
  h.client.tick();

  // The page stops ticking for longer than the socket-dead threshold while the
  // connection itself is fine.
  h.advance(20000);
  h.client.tick();

  assert.equal(h.client.status, 'joined');
  assert.equal(socket.closeCalls.length, 0);
  assert.equal(h.errors.length, 0);
});

test('throttled background ticks and wake from suspension retry resume instead of expiring immediately', () => {
  const h = harness();
  h.client.create();
  const first = h.sockets[0];
  first.open();
  first.receive(welcome());
  h.client.tick();

  // Simulate background timer throttling at 6-second intervals (< 10s, > 2.5s):
  // the client must rebase pong liveness and keep the healthy socket open.
  h.advance(6000);
  h.client.tick();
  h.advance(6000);
  h.client.tick();
  h.advance(6000);
  h.client.tick();
  assert.equal(h.client.status, 'joined');
  assert.equal(first.closeCalls.length, 0);

  // Now drop the socket while backgrounded, suspend past reservationMs, and wake:
  first.close(1006, 'network lost');
  assert.equal(h.client.status, 'reconnecting');
  h.advance(2_000_000);
  assert.equal(h.client.noteActive(), true);
  assert.equal(h.errors.length, 0);
  const second = h.sockets[1];
  assert.ok(second, 'waking from suspension opens a resume socket before declaring expiry');
  second.open();
  assert.equal(second.sent[0].type, 'resume');
  second.receive(welcome({ generation: 2, token: 't2', revision: 2 }));
  assert.equal(h.client.status, 'joined');
});

test('party snapshots publish on change and relay inbound snapshots', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(welcome());

  const party = { availability: 'available', members: [{ species: 25, level: 18 }], revision: 1 };
  assert.equal(h.client.publishParty(party), true);
  const sent = socket.sent.filter((message) => message.type === 'party');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].party, party);

  // Same revision is a no-op, a new revision publishes again.
  assert.equal(h.client.publishParty(party), false);
  assert.equal(socket.sent.filter((message) => message.type === 'party').length, 1);
  assert.equal(h.client.publishParty({ ...party, revision: 2 }), true);
  assert.equal(socket.sent.filter((message) => message.type === 'party').length, 2);

  // Inbound broadcast reaches the shell with the sender's player id.
  socket.receive({ type: 'party', playerId: 'p2', party: { availability: 'available', members: [{ species: 6 }], revision: 1 } });
  assert.equal(h.parties.length, 1);
  assert.equal(h.parties[0].playerId, 'p2');
  assert.deepEqual(h.parties[0].party.members, [{ species: 6 }]);
});

test('stopping motion publishes the resting tile immediately', () => {
  const h = harness();
  h.client.create();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(welcome());
  h.client.publish(presence({ pose: { ...presence().pose, motion: 'walk' } }), 1000);
  const initial = socket.sent.filter((message) => message.type === 'presence').length;

  h.advance(20);
  h.client.publish(presence({ pose: { ...presence().pose, xPx: 176, motion: 'walk' } }), 1020);
  assert.equal(socket.sent.filter((message) => message.type === 'presence').length, initial);

  h.advance(20);
  h.client.publish(presence({ pose: { ...presence().pose, xPx: 184, motion: 'idle' } }), 1040);
  const presences = socket.sent.filter((message) => message.type === 'presence');
  assert.equal(presences.length, initial + 1);
  assert.equal(presences.at(-1).state.pose.motion, 'idle');
  assert.equal(presences.at(-1).state.pose.xPx, 184);
});
