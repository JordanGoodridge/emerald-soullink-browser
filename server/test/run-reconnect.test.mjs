import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { CONTENT_VERSION, PROTOCOL_VERSION } from '../../pokeemerald-3d/web/presence/protocol.mjs';
import { RUN_PROTOCOL_VERSION } from '../../pokeemerald-3d/web/run/run-protocol.mjs';
import { startServer } from '../src/server.mjs';

const silentLog = { log() {}, error() {} };

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function client(socket) {
  const queue = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString('utf8'));
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex < 0) queue.push(message);
    else waiters.splice(waiterIndex, 1)[0].resolve(message);
  });
  return {
    send(message) { socket.send(JSON.stringify(message)); },
    next(predicate, timeout = 3000) {
      const queuedIndex = queue.findIndex(predicate);
      if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timed out waiting for WebSocket message'));
        }, timeout).unref?.();
      });
    },
    close() { socket.close(); },
  };
}

test('reconnecting to /run with the room token restores the authoritative snapshot', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: silentLog });
  t.after(() => server.close());

  const presenceA = client(await connect(server.url));
  presenceA.send({ v: PROTOCOL_VERSION, type: 'create', contentVersion: CONTENT_VERSION, name: 'Ash' });
  const welcomeA = await presenceA.next((message) => message.type === 'welcome');
  const presenceB = client(await connect(server.url));
  presenceB.send({ v: PROTOCOL_VERSION, type: 'join', room: welcomeA.room, contentVersion: CONTENT_VERSION, name: 'Misty' });
  await presenceB.next((message) => message.type === 'welcome');

  const firstRunClient = client(await connect(server.runUrl));
  firstRunClient.send({
    v: RUN_PROTOCOL_VERSION,
    type: 'run.attach',
    room: welcomeA.room,
    playerId: welcomeA.playerId,
    token: welcomeA.token,
  });
  await firstRunClient.next((message) => message.type === 'run.welcome');
  firstRunClient.send({ v: RUN_PROTOCOL_VERSION, type: 'run.start' });
  const initial = await firstRunClient.next((message) => message.type === 'run.state');
  firstRunClient.send({
    v: RUN_PROTOCOL_VERSION,
    type: 'run.event',
    event: { eventId: 'claim-before-reconnect', type: 'encounter.claim', areaKey: 'emerald:section:18', sectionId: 18, species: 25, level: 3 },
  });
  const claimed = await firstRunClient.next((message) => message.type === 'run.state');
  assert.equal(claimed.state.areas['emerald:section:18'].claims[welcomeA.playerId].species, 25);
  firstRunClient.close();

  const replacement = client(await connect(server.runUrl));
  replacement.send({
    v: RUN_PROTOCOL_VERSION,
    type: 'run.attach',
    room: welcomeA.room,
    playerId: welcomeA.playerId,
    token: welcomeA.token,
  });
  const resumed = await replacement.next((message) => message.type === 'run.welcome');
  assert.equal(resumed.state.runId, initial.state.runId);
  assert.equal(resumed.state.revision, claimed.state.revision);
  assert.equal(resumed.state.areas['emerald:section:18'].claims[welcomeA.playerId].species, 25);
  replacement.close();
  presenceA.close();
  presenceB.close();
});
