import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresenceRuntime } from './runtime.mjs';

const atlas = {
  pixels: new Uint8Array(32 * 64 * 64 * 4),
  layerCount: 18,
  revision: 1,
  layers: new Map([['brendan.on-foot', { offset: 0, frames: 9 }]]),
};

const world = { mapGroup: 1, mapNum: 2, layoutId: 'layout_1a', variant: 'base' };

function snapshot(playerId, xPx, seq, receivedMs = 1000) {
  return {
    playerId,
    generation: 1,
    seq,
    sampleMs: receivedMs,
    receivedMs,
    state: {
      epoch: 1,
      activity: 'overworld',
      world,
      pose: {
        xPx,
        yPx: 216,
        elevation: 3,
        jumpPx: 0,
        facing: 'down',
        appearance: 'brendan.on-foot',
        motion: 'idle',
        frame: 0,
      },
    },
  };
}

function fakeAdapter() {
  let exports = {};
  return {
    bind(next) { exports = next; },
    read: () => ({
      state: {
        epoch: 1,
        activity: 'overworld',
        world,
        pose: {
          xPx: 104, yPx: 216, elevation: 3, jumpPx: 0,
          facing: 'down', appearance: 'brendan.on-foot', motion: 'idle', frame: 0,
        },
      },
      screen: { x: 120, y: 112 },
    }),
    get exports() { return exports; },
  };
}

function fakeClientFactory() {
  const calls = [];
  let options;
  const client = {
    status: 'disconnected',
    room: null,
    create() { calls.push('create'); this.status = 'joined'; },
    join(room) { calls.push(`join:${room}`); this.status = 'joined'; },
    stop() { calls.push('stop'); this.status = 'disconnected'; },
    tick() { calls.push('tick'); },
    publish(state) { calls.push(`publish:${state.activity}`); },
    flush() { calls.push('flush'); return true; },
    simulateDrop() { calls.push('drop'); return true; },
    getMetrics: () => ({
      state: client.status,
      room: 'ABCDEFGH',
      playerId: 'self',
      generation: 1,
      revision: 2,
      members: [],
      self: null,
      clockReady: true,
      rttMs: 20,
      bytesSent: 10,
      bytesReceived: 20,
      lastError: null,
    }),
    serverNow: () => 1000,
  };
  const factory = (next) => {
    options = next;
    return client;
  };
  return { factory, client, calls, get options() { return options; } };
}

test('starts offline and only creates a client on an explicit room action', async () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  assert.equal(runtime.getSnapshot().status, 'disconnected');
  assert.equal(fake.calls.length, 0);
  runtime.createRoom();
  assert.deepEqual(fake.calls, ['create']);
  await Promise.resolve();
  assert.equal(runtime.getSnapshot().avatarStatus, 'ready');
});

test('an empty pack avatar set performs no default avatar fetch', async () => {
  let receivedSheets = null;
  let fetchCount = 0;
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    avatarSheets: [],
    loadAvatars: async ({ sheets }) => {
      fetchCount += sheets.length;
      receivedSheets = sheets;
      return atlas;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(receivedSheets, []);
  assert.equal(fetchCount, 0);
  assert.equal(runtime.getSnapshot().avatarStatus, 'ready');
});

test('a pack without presence does not auto-join or create the network client', () => {
  const search = new URLSearchParams('presenceAuto=create');
  let clientCreations = 0;
  const runtime = createPresenceRuntime({
    search,
    url: 'ws://test',
    adapter: fakeAdapter(),
    enabled: false,
    clientFactory: () => { clientCreations++; throw new Error('network client must not be created'); },
    loadAvatars: async () => atlas,
    avatarSheets: [],
  });
  runtime.bind({});
  assert.equal(runtime.createRoom(), false);
  assert.equal(runtime.joinRoom('ABCDEFGH'), false);
  assert.equal(clientCreations, 0);
  assert.equal(runtime.getSnapshot().status, 'disconnected');
});

test('normalizes names, validates room codes and persists a join', () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  assert.equal(runtime.setName('  Misty  '), true);
  assert.equal(runtime.getSnapshot().name, 'Misty');
  assert.equal(runtime.joinRoom('bad'), false);
  assert.equal(runtime.getSnapshot().lastError.code, 'invalid_room');
  assert.equal(runtime.joinRoom('abcdefgh'), true);
  assert.deepEqual(fake.calls, ['join:ABCDEFGH']);
});

test('routes welcome, roster and presence into the remote actor store', async () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  await Promise.resolve();
  runtime.createRoom();
  fake.options.onWelcome({
    members: [
      { playerId: 'self', name: 'Self', generation: 1, connection: 'connected', latest: null },
      { playerId: 'p2', name: 'May', generation: 1, connection: 'connected', latest: snapshot('p2', 120, 1) },
    ],
    revision: 2,
  });
  assert.equal(runtime.getSnapshot().playerCount, 2);
  fake.options.onPresence(snapshot('p2', 136, 2));
  runtime.tick();
  assert.ok(fake.calls.includes('publish:overworld'));
  const options = runtime.frameOptions({ enhanced: true, sceneKind: 1 });
  assert.equal(options.remoteActors.length, 1);
  assert.equal(options.remoteActors[0].screenX, 120 + (136 - 104));
  assert.equal(options.remoteAvatarLayers, 18);
});

test('hides remote actors when the local world is not a clean 3D frame', async () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  runtime.createRoom();
  fake.options.onWelcome({
    members: [
      { playerId: 'self', name: 'Self', generation: 1, connection: 'connected', latest: null },
      { playerId: 'p2', name: 'May', generation: 1, connection: 'connected', latest: snapshot('p2', 120, 1) },
    ],
    revision: 2,
  });
  assert.equal(runtime.frameOptions({ enhanced: false, sceneKind: 0 }).remoteActors.length, 0);
  assert.equal(runtime.frameOptions({ enhanced: true, sceneKind: 2 }).remoteActors.length, 0);
});

test('leave resets the store and drops the client', async () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  runtime.createRoom();
  fake.options.onWelcome({
    members: [{ playerId: 'self', name: 'Self', generation: 1, connection: 'connected', latest: null }],
    revision: 1,
  });
  runtime.leave();
  assert.ok(fake.calls.includes('stop'));
  assert.equal(runtime.getSnapshot().playerCount, 0);
  assert.equal(runtime.getSnapshot().status, 'disconnected');
});

test('auto-joins a room supplied by the URL after bind', async () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams('presenceAuto=join&presenceRoom=ABCDEFGH'),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  runtime.bind({});
  assert.deepEqual(fake.calls, ['join:ABCDEFGH']);
});

test('setAway publishes an away snapshot and restores the engine state', async () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  runtime.bind({});
  runtime.createRoom();
  fake.calls.length = 0;

  assert.equal(runtime.setAway(true), true);
  assert.equal(runtime.getSnapshot().activity, 'away');
  assert.equal(runtime.getSnapshot().pose, null);
  assert.ok(fake.calls.includes('publish:away'));
  assert.ok(fake.calls.includes('flush'));

  runtime.tick();
  assert.equal(runtime.getSnapshot().activity, 'away');
  assert.equal(runtime.setAway(true), false);

  assert.equal(runtime.setAway(false), true);
  assert.equal(runtime.getSnapshot().activity, 'overworld');
  assert.notEqual(runtime.getSnapshot().pose, null);
  assert.ok(fake.calls.includes('publish:overworld'));
});

test('setAway before bind is applied once the game binds', async () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  assert.equal(runtime.setAway(true), true);
  assert.equal(runtime.getSnapshot().activity, 'away');
  runtime.bind({});
  runtime.createRoom();
  runtime.tick();
  assert.equal(runtime.getSnapshot().activity, 'away');
  assert.ok(fake.calls.includes('publish:away'));
});

test('simulateDrop delegates to the presence client', async () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  runtime.bind({});
  runtime.createRoom();
  assert.equal(runtime.simulateDrop(), true);
  assert.ok(fake.calls.includes('drop'));
});

test('away hides remote actors and keeps roster membership', async () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  await Promise.resolve();
  runtime.bind({});
  runtime.createRoom();
  fake.options.onWelcome({
    members: [
      { playerId: 'self', name: 'Self', generation: 1, connection: 'connected', latest: null },
      { playerId: 'p2', name: 'May', generation: 1, connection: 'connected', latest: snapshot('p2', 120, 1) },
    ],
    revision: 2,
  });
  assert.equal(runtime.frameOptions({ enhanced: true, sceneKind: 1 }).remoteActors.length, 1);
  runtime.setAway(true);
  assert.equal(runtime.frameOptions({ enhanced: true, sceneKind: 1 }).remoteActors.length, 0);
  assert.equal(runtime.getDiagnostics().remoteActors.length, 0);
  assert.equal(runtime.getSnapshot().playerCount, 2);
});

test('renders remote actors in flat interiors through explicit field context', async () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  await Promise.resolve();
  runtime.createRoom();
  fake.options.onWelcome({
    members: [
      { playerId: 'self', name: 'Self', generation: 1, connection: 'connected', latest: null },
      { playerId: 'p2', name: 'May', generation: 1, connection: 'connected', latest: snapshot('p2', 136, 1) },
    ],
    revision: 2,
  });
  fake.options.onPresence(snapshot('p2', 136, 2));
  runtime.tick();

  const flat = runtime.frameOptions({ enhanced: false, sceneKind: 0, flatField: true });
  assert.equal(flat.remoteActors.length, 1);
  assert.equal(flat.remoteActors[0].screenX, 120 + (136 - 104));
  assert.equal(flat.remoteActors[0].hFlip, false);

  const classic = runtime.frameOptions({ enhanced: false, sceneKind: 0 });
  assert.equal(classic.remoteActors.length, 0);
});

test('injects a pack content version before a room is joined', () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    contentVersion: 'emerald-presence-v2',
  });
  assert.equal(runtime.getSnapshot().contentVersion, 'emerald-presence-v2');
  assert.equal(runtime.configure({ contentVersion: 'emerald-kaizo-presence-v1' }), true);
  runtime.createRoom();
  assert.equal(fake.options.contentVersion, 'emerald-kaizo-presence-v1');
  assert.equal(runtime.getSnapshot().contentVersion, 'emerald-kaizo-presence-v1');
});

test('a short alt-tab is ignored and a longer one publishes away', async () => {
  const fake = fakeClientFactory();
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 60,
  });
  runtime.bind({});
  runtime.createRoom();
  fake.calls.length = 0;

  assert.equal(runtime.setAway(true), true);
  assert.equal(runtime.getSnapshot().activity, 'overworld', 'not away inside the grace window');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runtime.setAway(false), false, 'returning inside the grace window is a no-op');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runtime.getSnapshot().activity, 'overworld');
  assert.ok(!fake.calls.includes('publish:away'));

  runtime.setAway(true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(runtime.getSnapshot().activity, 'away');
  assert.ok(fake.calls.includes('publish:away'));
});

test('setAway during a battle clears battleAnchor so the relay does not reject the away update', () => {
  let publishedState = null;
  const fake = fakeClientFactory();
  fake.client.publish = (state) => {
    publishedState = state;
    fake.calls.push(`publish:${state.activity}`);
  };
  const battleAdapter = {
    bind() {},
    read: () => ({
      state: {
        epoch: 2,
        activity: 'battle',
        world,
        pose: null,
        battleAnchor: {
          world,
          pose: {
            xPx: 104, yPx: 216, elevation: 3, jumpPx: 0,
            facing: 'down', appearance: 'brendan.on-foot', motion: 'idle', frame: 0,
          },
          epoch: 1,
        },
      },
      screen: null,
    }),
  };
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: battleAdapter,
    clientFactory: fake.factory,
    loadAvatars: async () => atlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  runtime.bind({});
  runtime.createRoom();
  assert.equal(runtime.setAway(true), true);
  assert.equal(publishedState?.activity, 'away');
  assert.equal(publishedState?.pose, null);
  assert.equal(publishedState?.battleAnchor, null);
});

test('compiles per-peer avatar customizations into isolated atlas layers without overwriting local or default sheets', async () => {
  const { createAvatarAtlas, packAvatarSheet, finalizeAvatarAtlas } = await import('./avatar-manifest.mjs');
  const liveAtlas = createAvatarAtlas();
  const baseSheet = new Uint8ClampedArray(144 * 32 * 4);
  packAvatarSheet(liveAtlas, 'brendan.on-foot', baseSheet, [115, 197, 164]);
  finalizeAvatarAtlas(liveAtlas);

  let publishedAvatar = null;
  const fake = fakeClientFactory();
  fake.client.publishAvatar = (avatar) => {
    publishedAvatar = avatar;
    return true;
  };
  const runtime = createPresenceRuntime({
    search: new URLSearchParams(),
    url: 'ws://test',
    adapter: fakeAdapter(),
    clientFactory: fake.factory,
    loadAvatars: async () => liveAtlas,
    now: () => 100,
    awayGraceMs: 0,
  });
  await Promise.resolve();
  runtime.createRoom();

  // Publishing local customization sends it to the client without overwriting default layer 0..8:
  runtime.publishAvatar({
    rigId: 'gen3-brendan',
    equipped: { head: 'wizard-hat' },
    colors: { top: '#4a8cff' },
  });
  assert.equal(publishedAvatar?.equipped?.head, 'wizard-hat');

  // Receiving two peers with different outfits gives each peer distinct atlas layers:
  fake.options.onWelcome({
    members: [
      { playerId: 'self', name: 'Self', generation: 1, connection: 'connected', latest: null },
      { playerId: 'p2', name: 'May', generation: 1, connection: 'connected', latest: snapshot('p2', 120, 1) },
      { playerId: 'p3', name: 'Brendan', generation: 1, connection: 'connected', latest: snapshot('p3', 136, 1) },
    ],
    revision: 2,
  });
  fake.options.onAvatar('p2', {
    version: 1,
    rigId: 'gen3-brendan',
    equipped: { head: 'kitten-ears' },
    colors: { top: '#ff94c2' },
    revision: 1,
  });
  fake.options.onAvatar('p3', {
    version: 1,
    rigId: 'gen3-brendan',
    equipped: { head: 'royal-crown' },
    colors: { top: '#ffc55a' },
    revision: 1,
  });
  runtime.tick();

  const frame = runtime.frameOptions({ enhanced: true, sceneKind: 1 });
  assert.equal(frame.remoteActors.length, 2);
  const p2Actor = frame.remoteActors.find((a) => a.playerId === 'p2');
  const p3Actor = frame.remoteActors.find((a) => a.playerId === 'p3');
  assert.notEqual(p2Actor.layer, p3Actor.layer);
  assert.equal(p2Actor.layer, 9);
  assert.equal(p3Actor.layer, 18);
});
