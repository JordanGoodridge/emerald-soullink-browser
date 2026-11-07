import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmeraldRunAdapter } from '../../../game-packs/emerald/adapter/run.mjs';
import { createRunRuntime } from './runtime.mjs';
import { DEFAULT_RUN_SETTINGS } from './run-settings.mjs';

const members = [{ playerId: 'p1', name: 'A' }, { playerId: 'p2', name: 'B' }];
const exports = {
  WasmRunSpeciesCount: () => 3,
  WasmRunSpeciesAt: (index) => [1, 25, 382][index],
  WasmRunGymBadgeCount: () => 0,
  WasmRunGymAceLevel: () => 15,
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('runtime wires true random hooks to the local run and tracks encounter/capture', () => {
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'soullink' },
    saveSlot: 'soulrun',
  });
  runtime.start({ runId: 'r', seed: 'seed', members, playerId: 'p1' });
  runtime.setTransport({ isReady: () => true });
  runtime.bindExports(exports);
  const species = runtime.hooks.WasmRunRandomSpecies(0, 25, 18, 0);
  assert.ok([1, 25, 382].includes(species));
  runtime.hooks.WasmRunOnEncounter(18, 18, species, 3, 7, 0, 0);
  assert.equal(runtime.state().areas['emerald:section:18'].status, 'pending');
  assert.equal(runtime.hooks.WasmRunAllowCapture(18, species, 7, 0), 1);
  runtime.hooks.WasmRunOnCapture(18, 18, species, 3, 7, 0);
  assert.equal(runtime.state().areas['emerald:section:18'].claims.p1.status, 'caught');
  assert.deepEqual(runtime.state().ownedSpecies.p1, [species]);
});

test('runtime records map entry separately and reports catch decisions', () => {
  const notices = [];
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter({ regionMap: { sections: [{ id: 18, name: 'Route 101' }] } }),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'nuzlocke' }, saveSlot: 'nuzlocke', storage: memoryStorage(),
  });
  runtime.setNoticeHandler((notice) => notices.push(notice));
  runtime.start({ runId: 'visit-test', seed: 4, members: [{ playerId: 'solo' }], playerId: 'solo' });
  runtime.visitArea({ sectionId: 18 });
  assert.equal(runtime.state().areas['emerald:section:18'].status, 'available');
  assert.equal(runtime.state().areas['emerald:section:18'].claims.solo, undefined);
  runtime.hooks.WasmRunOnEncounter(18, 18, 25, 3, 7, 0, 0);
  assert.equal(runtime.hooks.WasmRunAllowCapture(18, 25, 7, 0), 1);
  assert.equal(notices.at(-1).type, 'catch-allowed');
});

test('runtime emits no banner notice for a blocked capture', () => {
  const notices = [];
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'nuzlocke' }, saveSlot: 'nuzlocke', storage: memoryStorage(),
  });
  runtime.setNoticeHandler((notice) => notices.push(notice));
  runtime.start({ runId: 'blocked-notice-test', seed: 5, members: [{ playerId: 'solo' }], playerId: 'solo' });
  assert.equal(runtime.hooks.WasmRunAllowCapture(18, 25, 1, 0), 0);
  assert.deepEqual(notices, []);
});

test('solo Nuzlocke starts without a room and enforces the local encounter/capture gates', () => {
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'nuzlocke' },
    saveSlot: 'nuzlocke',
    storage: memoryStorage(),
  });
  const started = runtime.start({
    runId: 'solo-run', seed: 41,
    members: [{ playerId: 'solo', name: 'Solo Trainer' }],
    playerId: 'solo',
  });
  assert.equal(started.mode, 'nuzlocke');
  assert.equal(started.members.length, 1);
  assert.equal(runtime.hooks.WasmRunOnEncounter(18, 18, 25, 5, 7, 0, 0), undefined);
  assert.equal(runtime.state().areas['emerald:section:18'].claims.solo.status, 'claimed');
  assert.equal(runtime.hooks.WasmRunAllowCapture(18, 25, 7, 0), 1);
  runtime.hooks.WasmRunOnCapture(18, 18, 25, 5, 7, 0);
  assert.equal(runtime.state().areas['emerald:section:18'].claims.solo.status, 'caught');
});

test('solo Nuzlocke state restores its area history after a reload', () => {
  const storage = memoryStorage();
  const options = { ...DEFAULT_RUN_SETTINGS, mode: 'nuzlocke' };
  const first = createRunRuntime({
    adapter: createEmeraldRunAdapter(), initialSettings: options, saveSlot: 'nuzlocke',
    storage, storageKey: 'nuzlocke:test-profile',
  });
  first.start({ runId: 'solo-persistent', seed: 52, members: [{ playerId: 'solo' }], playerId: 'solo' });
  first.emit('encounter.claim', { areaKey: 'emerald:section:7', sectionId: 7, species: 133, level: 4, pid: 88 });

  const resumed = createRunRuntime({
    adapter: createEmeraldRunAdapter(), initialSettings: options, saveSlot: 'nuzlocke',
    storage, storageKey: 'nuzlocke:test-profile',
  });
  assert.equal(resumed.restoreLocalState(), true);
  assert.equal(resumed.state().runId, 'solo-persistent');
  assert.equal(resumed.state().areas['emerald:section:7'].claims.solo.species, 133);
});

test('solo Nuzlocke loss consumes the area and faint permanently releases that Pokémon', () => {
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'nuzlocke' },
    saveSlot: 'nuzlocke',
    storage: memoryStorage(),
  });
  runtime.start({ runId: 'solo-rules', seed: 11, members: [{ playerId: 'solo' }], playerId: 'solo' });
  runtime.hooks.WasmRunOnEncounter(5, 5, 25, 4, 0x5678, 0x1234, 0);
  runtime.hooks.WasmRunAtSafePoint(0);
  assert.equal(runtime.state().areas['emerald:section:5'].status, 'void');

  runtime.hooks.WasmRunOnEncounter(6, 6, 133, 5, 0x1111, 0x2222, 0);
  runtime.hooks.WasmRunOnCapture(6, 6, 133, 5, 0x1111, 0x2222);
  assert.equal(runtime.state().areas['emerald:section:6'].status, 'caught');
  assert.equal(runtime.hooks.WasmRunOnFaint(0x1111, 0x2222, 1), 1);
  assert.equal(runtime.state().areas['emerald:section:6'].status, 'dead');
  assert.equal(runtime.state().deaths[0].species, 133);
  assert.equal(runtime.hooks.WasmRunShouldRelease(0x1111, 0x2222), 1);
  assert.equal(runtime.hooks.WasmRunAllowItemEffect(133, 0x1111, 0x2222, 24, 0, 5, 5, 15, 0), 0);
});

test('runtime queues linked releases for the next safe point and creates party-only wipe-pending', () => {
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'soullink' },
    saveSlot: 'soulrun',
  });
  runtime.start({ runId: 'r', seed: 4, members, playerId: 'p1' });
  runtime.setTransport({ isReady: () => true });
  runtime.applyEvent({ eventId: 'c1', type: 'encounter.claim', playerId: 'p1', areaKey: 'emerald:section:18', sectionId: 18, species: 25, pid: 7 });
  runtime.applyEvent({ eventId: 'r1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'emerald:section:18', result: 'caught' });
  runtime.applyEvent({ eventId: 'c2', type: 'encounter.claim', playerId: 'p2', areaKey: 'emerald:section:18', sectionId: 18, species: 382, pid: 8 });
  runtime.applyEvent({ eventId: 'r2', type: 'encounter.resolve', playerId: 'p2', areaKey: 'emerald:section:18', result: 'caught' });
  runtime.applyEvent({ eventId: 'death', type: 'death', playerId: 'p2', linkId: 'link:emerald:section:18' });
  assert.equal(runtime.hooks.WasmRunShouldRelease(7, 0), 1);
  assert.equal(runtime.hooks.WasmRunShouldRelease(7, 0), 0);
  runtime.hooks.WasmRunOnPartyWipe(1);
  assert.equal(runtime.state().status, 'wipe_pending');
});

test('runtime applies area void release effects and rejects revival of a linked-dead mon', () => {
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'soullink' },
    saveSlot: 'soulrun',
  });
  runtime.start({ runId: 'r', seed: 4, members, playerId: 'p1' });
  runtime.applyEvent({ eventId: 'claim-local', type: 'encounter.claim', playerId: 'p1', areaKey: 'route:10', species: 25, pid: 0x11111111 });
  runtime.applyEvent({ eventId: 'catch-local', type: 'encounter.resolve', playerId: 'p1', areaKey: 'route:10', result: 'caught' });
  runtime.applyEvent({ eventId: 'claim-partner', type: 'encounter.claim', playerId: 'p2', areaKey: 'route:10', species: 133, pid: 0x22222222 });
  runtime.applyEvent({ eventId: 'lost-partner', type: 'encounter.resolve', playerId: 'p2', areaKey: 'route:10', result: 'lost' });
  assert.equal(runtime.state().areas['route:10'].status, 'void');
  assert.equal(runtime.hooks.WasmRunShouldRelease(0x1111, 0x1111), 1);
  assert.equal(runtime.hooks.WasmRunShouldRelease(0x1111, 0x1111), 0);

  runtime.start({ runId: 'r-death', seed: 5, members, playerId: 'p1' });
  runtime.applyEvent({ eventId: 'claim-a', type: 'encounter.claim', playerId: 'p1', areaKey: 'route:11', species: 25, pid: 0x12345678 });
  runtime.applyEvent({ eventId: 'catch-a', type: 'encounter.resolve', playerId: 'p1', areaKey: 'route:11', result: 'caught' });
  runtime.applyEvent({ eventId: 'claim-b', type: 'encounter.claim', playerId: 'p2', areaKey: 'route:11', species: 133, pid: 0x87654321 });
  runtime.applyEvent({ eventId: 'catch-b', type: 'encounter.resolve', playerId: 'p2', areaKey: 'route:11', result: 'caught' });
  runtime.applyEvent({ eventId: 'linked-death', type: 'death', playerId: 'p1', linkId: 'link:route:11', pid: 0x12345678 });
  assert.equal(runtime.hooks.WasmRunAllowItemEffect(25, 0x5678, 0x1234, 24, 0, 1, 1, 15, 0), 0);
});

test('restoring a server snapshot reconstructs missed-encounter releases for caught partners', () => {
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'soullink' },
    saveSlot: 'soulrun',
    storage: memoryStorage(),
  });
  runtime.start({ runId: 'void-resume', seed: 13, members, playerId: 'p1' });
  runtime.setTransport({ isReady: () => true });
  runtime.bindExports(exports);
  const snapshot = runtime.state();
  snapshot.areas['emerald:section:18'] = {
    areaKey: 'emerald:section:18',
    status: 'void',
    claims: {
      p1: { playerId: 'p1', species: 25, pid: 991, status: 'void' },
      p2: { playerId: 'p2', species: 133, pid: 992, status: 'void' },
    },
  };
  runtime.syncSnapshot(snapshot, 'p1');
  assert.equal(runtime.hooks.WasmRunShouldRelease(991 & 0xffff, 991 >>> 16), 1);
  assert.equal(runtime.hooks.WasmRunShouldRelease(991 & 0xffff, 991 >>> 16), 0);
});

test('run snapshot resync preserves an unresolved wild encounter for the next lost safe point', () => {
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'soullink' },
    saveSlot: 'soulrun',
    storage: memoryStorage(),
  });
  runtime.start({ runId: 'pending-wild-resume', seed: 14, members, playerId: 'p1' });
  const sent = [];
  runtime.setTransport({ send: (event) => sent.push(event), isReady: () => true });
  runtime.bindExports(exports);
  const snapshot = runtime.state();
  snapshot.areas['emerald:section:18'] = {
    areaKey: 'emerald:section:18', status: 'pending',
    claims: { p1: { playerId: 'p1', species: 25, pid: 33, status: 'claimed', at: 1 } },
  };
  runtime.syncSnapshot(snapshot, 'p1');
  runtime.hooks.WasmRunAtSafePoint(0);
  assert.equal(runtime.state().areas['emerald:section:18'].status, 'void');
  assert.equal(sent.at(-1)?.type, 'encounter.resolve');
  assert.equal(sent.at(-1)?.result, 'lost');
});

test('battle-faint import records linked death immediately before safe-point release', () => {
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'soullink' },
    saveSlot: 'soulrun',
  });
  runtime.start({ runId: 'battle-faint', seed: 1, members, playerId: 'p1' });
  runtime.applyEvent({ eventId: 'claim-1', type: 'encounter.claim', playerId: 'p1', areaKey: 'area:1', species: 25, pid: 0x12345678 });
  runtime.applyEvent({ eventId: 'caught-1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'area:1', result: 'caught' });
  runtime.applyEvent({ eventId: 'claim-2', type: 'encounter.claim', playerId: 'p2', areaKey: 'area:1', species: 133, pid: 0x87654321 });
  runtime.applyEvent({ eventId: 'caught-2', type: 'encounter.resolve', playerId: 'p2', areaKey: 'area:1', result: 'caught' });

  assert.equal(runtime.hooks.WasmRunOnFaint(0x5678, 0x1234, 85), 1);
  assert.equal(runtime.state().links['link:area:1'].status, 'dead');
  assert.equal(runtime.hooks.WasmRunAllowItemEffect(25, 0x5678, 0x1234, 24, 0, 5, 5, 15, 0), 0);
  assert.equal(runtime.hooks.WasmRunShouldRelease(0x5678, 0x1234), 1);
});

test('runtime enforces Candy ceiling and supplies current gym cap through hooks', () => {
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'soullink' },
    saveSlot: 'soulrun',
  });
  runtime.start({ runId: 'r', seed: 4, members, playerId: 'p1' });
  runtime.setTransport({ isReady: () => true });
  runtime.bindExports(exports);
  assert.equal(runtime.gymCap(), 15);
  assert.equal(runtime.hooks.WasmRunAllowItemEffect(1, 0, 0, 68, 10, 11, 12, 15, 1), 1);
  assert.equal(runtime.hooks.WasmRunAllowItemEffect(1, 0, 0, 68, 10, 12, 12, 15, 1), 0);
});

test('an in-flight local claim survives a stale snapshot and still resolves at the safe point', () => {
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'soullink' },
    saveSlot: 'soulrun',
    storage: memoryStorage(),
  });
  runtime.start({ runId: 'inflight-claim', seed: 15, members, playerId: 'p1' });
  const sent = [];
  runtime.setTransport({ send: (event) => sent.push(event), isReady: () => true });
  runtime.bindExports(exports);
  const base = runtime.state();
  runtime.syncSnapshot(base, 'p1');
  runtime.hooks.WasmRunOnEncounter(0, 18, 25, 4, 33, 0, 0);
  assert.equal(runtime.state().areas['emerald:section:18']?.claims?.p1?.status, 'claimed');
  runtime.syncSnapshot(base, 'p1');
  assert.equal(runtime.state().areas['emerald:section:18']?.claims?.p1?.status, 'claimed');
  runtime.hooks.WasmRunAtSafePoint(0);
  assert.equal(runtime.state().areas['emerald:section:18'].status, 'void');
  assert.equal(sent.at(-1)?.result, 'lost');
});

test('starter gift claims label their area as Gift: starter instead of Littleroot Town', () => {
  const adapter = createEmeraldRunAdapter({
    regionMap: { sections: [{ id: 0, name: 'LITTLEROOT TOWN' }] },
  });
  assert.equal(adapter.areaLabel('emerald:gift:starter', { sectionId: 0 }), 'Gift: starter');
  assert.equal(adapter.areaLabel('emerald:section:0', { sectionId: 0 }), 'LITTLEROOT TOWN');
});

test('runtime enriches deaths with live party level and badgeCount and records champion victory at safe point', () => {
  let badgeCount = 4;
  let isChampion = 0;
  const championExports = {
    ...exports,
    WasmRunGymBadgeCount: () => badgeCount,
    WasmRunIsChampion: () => isChampion,
    WasmRunMapSection: () => 42,
    WasmRunPartyCount: () => 2,
    WasmRunPartySpecies: (i) => [260, 282][i] ?? 0,
    WasmRunPartyLevel: (i) => [38, 55][i] ?? 0,
    WasmRunPartyPidLo: (i) => [0x5678, 0x2222][i] ?? 0,
    WasmRunPartyPidHi: (i) => [0x1234, 0x1111][i] ?? 0,
    WasmRunPartyMove: (i, m) => (i === 1 && m < 2 ? [94, 85][m] : 0),
  };
  const runtime = createRunRuntime({
    adapter: createEmeraldRunAdapter(),
    initialSettings: { ...DEFAULT_RUN_SETTINGS, mode: 'soullink' },
    saveSlot: 'soulrun',
  });
  runtime.start({ runId: 'champ-run', seed: 99, members, playerId: 'p1' });
  runtime.setTransport({ isReady: () => true });
  runtime.bindExports(championExports);

  runtime.applyEvent({ eventId: 'c1', type: 'encounter.claim', playerId: 'p1', areaKey: 'emerald:section:18', species: 258, level: 5, pid: 0x12345678 });
  runtime.applyEvent({ eventId: 'r1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'emerald:section:18', result: 'caught' });
  runtime.applyEvent({ eventId: 'c2', type: 'encounter.claim', playerId: 'p2', areaKey: 'emerald:section:18', species: 252, level: 5, pid: 0x87654321 });
  runtime.applyEvent({ eventId: 'r2', type: 'encounter.resolve', playerId: 'p2', areaKey: 'emerald:section:18', result: 'caught' });

  assert.equal(runtime.hooks.WasmRunOnFaint(0x5678, 0x1234, 0), 1);
  const p1Death = runtime.state().deaths.find((d) => d.playerId === 'p1');
  assert.equal(p1Death.level, 38);
  assert.equal(p1Death.badgeCount, 4);

  badgeCount = 8;
  isChampion = 1;
  runtime.hooks.WasmRunAtSafePoint(1);
  assert.equal(runtime.state().status, 'victory');
  assert.equal(runtime.state().champions.p1.party.length, 2);
  assert.equal(runtime.state().champions.p1.party[1].species, 282);
  assert.equal(runtime.state().champions.p1.party[1].level, 55);
  assert.deepEqual(runtime.state().champions.p1.party[1].moves, [94, 85]);
});


