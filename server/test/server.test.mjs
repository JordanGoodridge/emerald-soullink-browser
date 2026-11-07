import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { CONTENT_VERSION, DEFAULT_LIMITS, PROTOCOL_VERSION } from '../../pokeemerald-3d/web/presence/protocol.mjs';
import { RUN_PROTOCOL_VERSION } from '../../pokeemerald-3d/web/run/run-protocol.mjs';
import { createPresenceClient } from '../../pokeemerald-3d/web/presence/presence-client.mjs';
import { startServer } from '../src/server.mjs';

const silentLog = { log() {}, error() {} };

class Client {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8'));
      const waiter = this.waiters.find((entry) => entry.predicate(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        this.queue.push(message);
      }
    });
  }

  send(message) {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message }));
  }

  sendEnvelope(message) {
    this.ws.send(JSON.stringify(message));
  }

  next(type, timeoutMs = 2000) {
    const index = this.queue.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(entry), 1);
        reject(new Error(`timed out waiting for ${type}; queued: ${this.queue.map((m) => m.type).join(',')}`));
      }, timeoutMs);
      const entry = {
        predicate: (message) => message.type === type,
        resolve: (message) => { clearTimeout(timer); resolve(message); },
      };
      this.waiters.push(entry);
    });
  }

  nextWhere(predicate, timeoutMs = 2000) {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(entry), 1);
        reject(new Error('timed out waiting for matching message'));
      }, timeoutMs);
      const entry = {
        predicate,
        resolve: (message) => { clearTimeout(timer); resolve(message); },
      };
      this.waiters.push(entry);
    });
  }
}

async function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(new Client(ws)));
    ws.once('error', reject);
  });
}

async function handshake(client, message) {
  client.send(message);
  return client.next('welcome');
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not reached');
}

test('server health endpoint reports membership', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, rooms: 0, members: 0, runs: 0 });
});

test('run endpoint authenticates room members and requires all continuing players ready before restart', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());

  const a = await connect(server.url);
  const aRoom = await handshake(a, { type: 'create', contentVersion: CONTENT_VERSION, name: 'Ash' });
  const b = await connect(server.url);
  const bRoom = await handshake(b, { type: 'join', room: aRoom.room, contentVersion: CONTENT_VERSION, name: 'Misty' });

  const runA = await connect(server.runUrl);
  runA.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: aRoom.room, playerId: aRoom.playerId, token: aRoom.token });
  const welcomeA = await runA.next('run.welcome');
  assert.equal(welcomeA.state, null);
  const runB = await connect(server.runUrl);
  runB.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: aRoom.room, playerId: bRoom.playerId, token: bRoom.token });
  assert.equal((await runB.next('run.welcome')).state, null);

  const attacker = await connect(server.runUrl);
  attacker.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: aRoom.room, playerId: aRoom.playerId, token: 'wrong-token' });
  assert.equal((await attacker.next('run.error')).reason, 'room_membership_invalid');

  runA.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.start' });
  const initialA = await runA.nextWhere((message) => message.type === 'run.state' || message.type === 'run.error');
  assert.equal(initialA.type, 'run.state', initialA.reason);
  const initialB = await runB.next('run.state');
  assert.equal(initialA.state.runId, initialB.state.runId);
  assert.equal(initialA.state.members.length, 2);

  runB.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.begin', transferId: 'slot-upload-1',
    recipientPlayerId: '*', purpose: 'lobby-snapshot', totalBytes: 5, chunkCount: 1 });
  assert.equal((await runB.next('run.error')).reason, 'host_required');
  runB.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.begin', transferId: 'slot-upload-1',
    recipientPlayerId: aRoom.playerId, purpose: 'slot-save', totalBytes: 5, chunkCount: 1 });
  assert.equal((await runA.next('lobby.transfer.begin')).senderPlayerId, bRoom.playerId);
  runB.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.chunk', transferId: 'slot-upload-1', index: 0, data: 'YWJjZGU=' });
  assert.equal((await runA.next('lobby.transfer.chunk')).data, 'YWJjZGU=');
  runB.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.end', transferId: 'slot-upload-1' });
  assert.equal((await runA.next('lobby.transfer.end')).transferId, 'slot-upload-1');
  runA.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.ack', transferId: 'slot-upload-1', accepted: true, revision: 2 });
  const ack = await runB.next('lobby.transfer.ack');
  assert.equal(ack.accepted, true);
  assert.equal(ack.recipientPlayerId, aRoom.playerId);

  runA.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.event', event: { eventId: 'wipe', type: 'wipe.pending' } });
  assert.equal((await runA.next('run.state')).state.status, 'wipe_pending');
  await runB.next('run.state');

  runA.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.event', event: { eventId: 'ready-a', type: 'run.ready' } });
  assert.equal((await runA.next('run.state')).state.status, 'wipe_pending');
  await runB.next('run.state');
  runA.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.restart' });
  assert.equal((await runA.next('run.error')).reason, 'players_not_ready');

  runB.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.event', event: { eventId: 'ready-b', type: 'run.ready' } });
  const readyA = await runA.next('run.state');
  const readyB = await runB.next('run.state');
  assert.equal(readyA.state.status, 'wipe_pending');
  assert.equal(readyA.state.members.every((member) => member.ready), true);
  assert.equal(readyA.state.revision, readyB.state.revision);

  runB.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.restart' });
  assert.equal((await runB.next('run.error')).reason, 'host_required');
  runA.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.restart' });
  const resetA = await runA.next('run.state');
  const resetB = await runB.next('run.state');
  assert.equal(resetA.state.status, 'active');
  assert.notEqual(resetA.state.runId, initialA.state.runId);
  assert.equal(resetA.state.runId, resetB.state.runId);
});

test('lobby save transfers work in a Standard room without creating shared run state', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());
  const host = await connect(server.url);
  const hostRoom = await handshake(host, { type: 'create', contentVersion: CONTENT_VERSION, name: 'Standard Host' });
  const guest = await connect(server.url);
  const guestRoom = await handshake(guest, { type: 'join', room: hostRoom.room, contentVersion: CONTENT_VERSION, name: 'Standard Guest' });
  const hostRun = await connect(server.runUrl);
  hostRun.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: hostRoom.room, playerId: hostRoom.playerId, token: hostRoom.token });
  assert.equal((await hostRun.next('run.welcome')).state, null);
  const guestRun = await connect(server.runUrl);
  guestRun.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: hostRoom.room, playerId: guestRoom.playerId, token: guestRoom.token });
  assert.equal((await guestRun.next('run.welcome')).state, null);

  hostRun.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.begin', transferId: 'standard-snapshot',
    recipientPlayerId: '*', purpose: 'lobby-snapshot', totalBytes: 2, chunkCount: 1 });
  assert.equal((await guestRun.next('lobby.transfer.begin')).senderPlayerId, hostRoom.playerId);
  hostRun.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.chunk', transferId: 'standard-snapshot', index: 0, data: 'e30=' });
  assert.equal((await guestRun.next('lobby.transfer.chunk')).data, 'e30=');
  hostRun.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.end', transferId: 'standard-snapshot' });
  await guestRun.next('lobby.transfer.end');
  guestRun.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.ack', transferId: 'standard-snapshot', accepted: true, revision: 1 });
  assert.equal((await hostRun.next('lobby.transfer.ack')).accepted, true);
  const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((response) => response.json());
  assert.equal(health.runs, 0);
});

test('run endpoint restores a host checkpoint into a newly created room', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());
  const a = await connect(server.url);
  const aRoom = await handshake(a, { type: 'create', contentVersion: CONTENT_VERSION, name: 'Ash' });
  const b = await connect(server.url);
  const bRoom = await handshake(b, { type: 'join', room: aRoom.room, contentVersion: CONTENT_VERSION, name: 'Misty' });
  const runA = await connect(server.runUrl);
  runA.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: aRoom.room, playerId: aRoom.playerId, token: aRoom.token });
  await runA.next('run.welcome');
  const runB = await connect(server.runUrl);
  runB.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: aRoom.room, playerId: bRoom.playerId, token: bRoom.token });
  await runB.next('run.welcome');
  const checkpoint = { runState: {
    runId: 'saved-run', seed: 42, mode: 'soullink', status: 'active', revision: 3,
    contentVersion: CONTENT_VERSION, hostPlayerId: 'old-host',
    options: { randomizeWild: false },
    members: [
      { playerId: 'old-host', name: 'Ash', slot: 0, active: true, ready: false },
      { playerId: 'old-guest', name: 'Misty', slot: 1, active: true, ready: false },
    ],
    areas: {}, links: {}, deaths: [], events: [], ownedSpecies: { 'old-host': [], 'old-guest': [] },
  } };
  runA.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.restore', checkpoint });
  const restored = await runA.next('run.state');
  const peer = await runB.next('run.state');
  assert.equal(restored.state.runId, 'saved-run');
  assert.equal(restored.state.options.randomizeWild, false);
  assert.deepEqual(restored.state.members.map((member) => member.name), ['Ash', 'Misty']);
  assert.equal(restored.state.members[0].playerId, aRoom.playerId);
  assert.equal(restored.state.members[1].playerId, bRoom.playerId);
  assert.equal(peer.state.runId, 'saved-run');
});

test('a room stops accepting new code joins after the host starts a run', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());
  const hostSocket = await connect(server.url);
  const host = await handshake(hostSocket, { type: 'create', contentVersion: CONTENT_VERSION, name: 'Ash' });
  const guestSocket = await connect(server.url);
  const guest = await handshake(guestSocket, { type: 'join', room: host.room, contentVersion: CONTENT_VERSION, name: 'Misty' });
  const run = await connect(server.runUrl);
  run.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: host.room, playerId: host.playerId, token: host.token });
  await run.next('run.welcome');
  run.sendEnvelope({ v: RUN_PROTOCOL_VERSION, type: 'run.start' });
  assert.equal((await run.next('run.state')).state.status, 'active');

  const lateSocket = await connect(server.url);
  lateSocket.send({ v: PROTOCOL_VERSION, type: 'join', room: host.room, contentVersion: CONTENT_VERSION, name: 'Late player' });
  const rejected = await lateSocket.next('error');
  assert.equal(rejected.code, 'run_in_progress');
  assert.equal(server.service.inspect(host.room).memberCount, 2);
  assert.equal(guest.playerId !== host.playerId, true);
});

test('two real clients create and join, and a fifth is rejected', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());

  const first = await connect(server.url);
  const welcome = await handshake(first, {
    type: 'create', contentVersion: CONTENT_VERSION, name: 'Jordan',
  });
  assert.equal(welcome.members.length, 1);
  assert.match(welcome.room, /^[A-Z2-9]{8}$/);

  const rest = [];
  for (let index = 0; index < 3; index++) {
    const client = await connect(server.url);
    rest.push(client);
    const joined = await handshake(client, {
      type: 'join', room: welcome.room, contentVersion: CONTENT_VERSION, name: `P${index + 2}`,
    });
    assert.equal(joined.members.length, index + 2);
    const roster = await first.next('roster');
    assert.equal(roster.members.length, index + 2);
  }

  const fifth = await connect(server.url);
  fifth.send({
    type: 'join', room: welcome.room, contentVersion: CONTENT_VERSION, name: 'Fifth',
  });
  const error = await fifth.next('error');
  assert.equal(error.code, 'room_full');
  const closed = await fifth.closed;
  assert.equal(closed.code, 4000);
  assert.equal(server.service.inspect(welcome.room).memberCount, 4);
});

test('presence is forwarded to the other member and not back to the sender', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());
  const a = await connect(server.url);
  const welcome = await handshake(a, { type: 'create', contentVersion: CONTENT_VERSION, name: 'A' });
  const b = await connect(server.url);
  await handshake(b, { type: 'join', room: welcome.room, contentVersion: CONTENT_VERSION, name: 'B' });

  a.send({
    type: 'presence', generation: 1, seq: 1, sampleMs: 100,
    state: {
      epoch: 1, activity: 'overworld',
      world: { mapGroup: 0, mapNum: 9, layoutId: 'littleroot', variant: 'base' },
      pose: {
        xPx: 168, yPx: 176, elevation: 3, jumpPx: 0,
        facing: 'down', appearance: 'brendan.on-foot', motion: 'idle', frame: 0,
      },
    },
  });
  const forwarded = await b.next('presence');
  assert.equal(forwarded.snapshot.playerId, welcome.playerId);
  assert.equal(forwarded.snapshot.state.pose.xPx, 168);
  assert.equal(forwarded.snapshot.receivedMs > 0, true);
  assert.equal(a.queue.some((message) => message.type === 'presence'), false);
});

test('malformed JSON is fatal and rooms stay isolated', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());
  const a = await connect(server.url);
  const first = await handshake(a, { type: 'create', contentVersion: CONTENT_VERSION, name: 'A' });
  const b = await connect(server.url);
  const second = await handshake(b, { type: 'create', contentVersion: CONTENT_VERSION, name: 'B' });
  assert.notEqual(first.room, second.room);

  const bad = await connect(server.url);
  bad.ws.send('{not json');
  const error = await bad.next('error');
  assert.equal(error.code, 'invalid_message');
  const closed = await bad.closed;
  assert.equal(closed.code, 4000);
});

test('a dropped socket reserves the identity and resume rotates the generation', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());
  const a = await connect(server.url);
  const welcome = await handshake(a, { type: 'create', contentVersion: CONTENT_VERSION, name: 'A' });
  a.ws.close();
  await waitFor(() => server.service.inspect(welcome.room)?.members[0]?.connection === 'reconnecting');

  const resumed = await connect(server.url);
  const nextWelcome = await handshake(resumed, {
    type: 'resume', room: welcome.room, contentVersion: CONTENT_VERSION,
    playerId: welcome.playerId, token: welcome.token,
  });
  assert.equal(nextWelcome.generation, 2);
  assert.notEqual(nextWelcome.token, welcome.token);
  assert.equal(nextWelcome.members[0].latest, null);
});

test('explicit leave removes the member and closes the socket', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());
  const a = await connect(server.url);
  const welcome = await handshake(a, { type: 'create', contentVersion: CONTENT_VERSION, name: 'A' });
  a.send({ type: 'leave' });
  const closed = await a.closed;
  assert.equal(closed.code, 4000);
  await waitFor(() => server.service.inspect(welcome.room)?.memberCount === 0);
});

test('handshake timeout closes a silent socket', async (t) => {
  const limits = { ...DEFAULT_LIMITS, handshakeTimeoutMs: 50 };
  const server = await startServer({ port: 0, host: '127.0.0.1', limits, log: silentLog });
  t.after(() => server.close());
  const silent = await connect(server.url);
  const error = await silent.next('error');
  assert.equal(error.code, 'handshake_timeout');
  const closed = await silent.closed;
  assert.equal(closed.code, 4000);
});

test('party snapshots relay to room members over the presence channel', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());

  const a = await connect(server.url);
  const aWelcome = await handshake(a, { type: 'create', contentVersion: CONTENT_VERSION, name: 'Ash' });
  const b = await connect(server.url);
  const bWelcome = await handshake(b, { type: 'join', room: aWelcome.room, contentVersion: CONTENT_VERSION, name: 'Misty' });

  const party = { availability: 'available', members: [{ species: 25, level: 18 }], revision: 1 };
  a.send({ type: 'party', party });
  const relayed = await b.next('party');
  assert.equal(relayed.playerId, aWelcome.playerId);
  assert.deepEqual(relayed.party, party);

  // A later joiner receives the stored snapshot without waiting for a change.
  const c = await connect(server.url);
  await handshake(c, { type: 'join', room: aWelcome.room, contentVersion: CONTENT_VERSION, name: 'Brock' });
  const toNewJoiner = await c.nextWhere((message) => message.type === 'party' && message.playerId === aWelcome.playerId);
  assert.deepEqual(toNewJoiner.party, party);

  // Hidden (opt-out) relays without members.
  a.send({ type: 'party', party: { availability: 'hidden', members: [], revision: 2 } });
  const hidden = await b.nextWhere((message) => message.type === 'party' && message.party?.revision === 2);
  assert.equal(hidden.party.availability, 'hidden');
  assert.deepEqual(hidden.party.members, []);
});

test('presence client publishes and receives party snapshots through the relay', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());

  function makeClient(name) {
    const state = { welcome: null, parties: [] };
    const client = createPresenceClient({
      url: server.url,
      name,
      contentVersion: CONTENT_VERSION,
      transportFactory: (url) => new WebSocket(url),
      onWelcome: (welcome) => { state.welcome = welcome; },
      onParty: (playerId, party) => state.parties.push({ playerId, party }),
    });
    return { client, state };
  }

  const a = makeClient('Ash');
  a.client.create();
  await waitFor(() => a.state.welcome !== null);
  const b = makeClient('Misty');
  b.client.join(a.state.welcome.room);
  await waitFor(() => b.state.welcome !== null);

  const party = { availability: 'available', members: [{ species: 25, level: 18 }], revision: 1 };
  assert.equal(a.client.publishParty(party), true);
  await waitFor(() => b.state.parties.length > 0);
  assert.equal(b.state.parties[0].playerId, a.state.welcome.playerId);
  assert.deepEqual(b.state.parties[0].party, party);

  // Opt-out publishes hidden and clears the peer's copy.
  a.client.publishParty({ availability: 'hidden', members: [], revision: 2 });
  await waitFor(() => b.state.parties.some((entry) => entry.party?.revision === 2));
  const hidden = b.state.parties.find((entry) => entry.party?.revision === 2).party;
  assert.equal(hidden.availability, 'hidden');
  assert.deepEqual(hidden.members, []);

  a.client.stop();
  b.client.stop();
});
