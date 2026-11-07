import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunClient } from './client.mjs';
import { RUN_PROTOCOL_VERSION } from './run-protocol.mjs';

class FakeSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.fire('close', {}); }
  fire(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  open() { this.readyState = 1; this.fire('open', {}); }
  receive(message) { this.fire('message', { data: JSON.stringify(message) }); }
}

test('run client attaches with room token, restores state and flushes queued commands', () => {
  FakeSocket.instances = [];
  let current = null;
  const client = createRunClient({
    url: 'ws://example.test/run', room: 'ABCD2345', playerId: 'p1', token: 'resume-secret',
    WebSocketImpl: FakeSocket,
    onState: (state) => { current = state; },
  });
  client.start();
  client.startRun({ mode: 'soullink' });
  const socket = FakeSocket.instances[0];
  socket.open();
  assert.deepEqual(socket.sent[0], {
    v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: 'ABCD2345', playerId: 'p1', token: 'resume-secret',
  });
  socket.receive({ v: RUN_PROTOCOL_VERSION, type: 'run.welcome', state: { runId: 'r1' } });
  assert.equal(current.runId, 'r1');
  assert.equal(socket.sent[1].type, 'run.start');
});

test('run client reconnects with the same room token and replaces state from server snapshot', () => {
  FakeSocket.instances = [];
  let reconnect = null;
  const snapshots = [];
  const client = createRunClient({
    url: 'ws://example.test/run', room: 'ABCD2345', playerId: 'p1', token: 'resume-secret',
    WebSocketImpl: FakeSocket,
    schedule(callback) { reconnect = callback; return 1; },
    onState: (state) => snapshots.push(state),
  });
  client.start();
  const firstSocket = FakeSocket.instances[0];
  firstSocket.open();
  firstSocket.receive({ v: RUN_PROTOCOL_VERSION, type: 'run.welcome', state: { runId: 'r1', revision: 3 } });
  firstSocket.close();
  assert.equal(typeof reconnect, 'function');
  reconnect();

  const resumedSocket = FakeSocket.instances[1];
  resumedSocket.open();
  assert.deepEqual(resumedSocket.sent[0], {
    v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: 'ABCD2345', playerId: 'p1', token: 'resume-secret',
  });
  resumedSocket.receive({ v: RUN_PROTOCOL_VERSION, type: 'run.welcome', state: { runId: 'r1', revision: 5 } });
  assert.equal(client.state().revision, 5);
  assert.deepEqual(snapshots.map((state) => state.revision), [3, 5]);
  client.stop();
});
