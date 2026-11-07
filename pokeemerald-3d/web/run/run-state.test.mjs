import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunState, reduceRunEvent } from './run-state.mjs';

function run() {
  return createRunState({
    runId: 'r1', seed: 'seed1',
    members: [{ playerId: 'p1', name: 'Ash' }, { playerId: 'p2', name: 'Misty' }],
  });
}

function send(state, event) {
  return reduceRunEvent(state, event);
}

test('run validates two to four unique players', () => {
  assert.throws(() => createRunState({ runId: 'r', seed: 1, members: [{ playerId: 'p1' }] }), /2-4/);
  assert.throws(() => createRunState({ runId: 'r', seed: 1, members: [{ playerId: 'p1' }, { playerId: 'p1' }] }), /unique/);
  assert.equal(createRunState({ runId: 'r', seed: 1, members: ['a', 'b', 'c', 'd'].map((playerId) => ({ playerId })) }).members.length, 4);
});

test('area visits are recorded once and do not consume the encounter', () => {
  let state = run();
  state = send(state, { eventId: 'visit-1', type: 'area.visit', playerId: 'p1', areaKey: 'route101', sectionId: 3, label: 'Route 101' }).state;
  state = send(state, { eventId: 'visit-2', type: 'area.visit', playerId: 'p1', areaKey: 'route101', sectionId: 3 }).state;
  assert.equal(state.areas.route101.status, 'available');
  assert.equal(state.areas.route101.visits.length, 1);
  assert.equal(state.areas.route101.claims.p1, undefined);
  const claimed = send(state, { eventId: 'claim-after-visit', type: 'encounter.claim', playerId: 'p1', areaKey: 'route101', sectionId: 3, species: 25 });
  assert.equal(claimed.accepted, true);
  assert.equal(claimed.state.areas.route101.claims.p1.status, 'claimed');
});

test('encounter claims stay pending until all players catch, then become a shared N-way link', () => {
  let state = run();
  let result = send(state, { eventId: 'e1', type: 'encounter.claim', playerId: 'p1', areaKey: 'route101:land', sectionId: 3, species: 382, level: 3 });
  assert.equal(result.accepted, true);
  state = result.state;
  assert.equal(state.areas['route101:land'].status, 'pending');
  result = send(state, { eventId: 'e2', type: 'encounter.claim', playerId: 'p2', areaKey: 'route101:land', sectionId: 3, species: 25, level: 3 });
  state = result.state;
  assert.equal(state.areas['route101:land'].status, 'pending');
  state = send(state, { eventId: 'e3', type: 'encounter.resolve', playerId: 'p1', areaKey: 'route101:land', result: 'caught' }).state;
  assert.equal(state.areas['route101:land'].status, 'pending');
  state = send(state, { eventId: 'e4', type: 'encounter.resolve', playerId: 'p2', areaKey: 'route101:land', result: 'caught' }).state;
  assert.equal(state.areas['route101:land'].status, 'linked');
  assert.equal(state.links['link:route101:land'].members.length, 2);
});

test('two catches create a usable partial link while a third player can catch up later', () => {
  let state = createRunState({
    runId: 'three-player', seed: 1,
    members: [{ playerId: 'p1' }, { playerId: 'p2' }, { playerId: 'p3' }],
  });
  for (const [playerId, species] of [['p1', 25], ['p2', 133], ['p3', 1]]) {
    state = send(state, {
      eventId: `claim-${playerId}`, type: 'encounter.claim', playerId,
      areaKey: 'route101:land', sectionId: 3, species,
    }).state;
  }
  state = send(state, { eventId: 'catch-p1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'route101:land', result: 'caught' }).state;
  state = send(state, { eventId: 'catch-p2', type: 'encounter.resolve', playerId: 'p2', areaKey: 'route101:land', result: 'caught' }).state;
  assert.equal(state.areas['route101:land'].status, 'pending');
  assert.deepEqual(state.links['link:route101:land'].members.map((member) => member.playerId), ['p1', 'p2']);

  state = send(state, { eventId: 'catch-p3', type: 'encounter.resolve', playerId: 'p3', areaKey: 'route101:land', result: 'caught' }).state;
  assert.equal(state.areas['route101:land'].status, 'linked');
  assert.deepEqual(state.links['link:route101:land'].members.map((member) => member.playerId), ['p1', 'p2', 'p3']);
});

test('death in a partial link affects its caught members, not the player still waiting', () => {
  let state = createRunState({
    runId: 'three-player-death', seed: 1,
    members: [{ playerId: 'p1' }, { playerId: 'p2' }, { playerId: 'p3' }],
  });
  for (const [playerId, species] of [['p1', 25], ['p2', 133], ['p3', 1]]) {
    state = send(state, {
      eventId: `claim-${playerId}`, type: 'encounter.claim', playerId,
      areaKey: 'route101:land', species, pid: species,
    }).state;
  }
  for (const playerId of ['p1', 'p2']) {
    state = send(state, { eventId: `catch-${playerId}`, type: 'encounter.resolve', playerId, areaKey: 'route101:land', result: 'caught' }).state;
  }
  const result = send(state, {
    eventId: 'death-p1', type: 'death', playerId: 'p1',
    linkId: 'link:route101:land', cause: 'fainted',
  });
  assert.deepEqual(result.effects.map((effect) => effect.playerId), ['p1', 'p2']);
  assert.equal(result.state.areas['route101:land'].claims.p3.status, 'claimed');
});

test('event IDs are idempotent and a player cannot claim same area twice', () => {
  let state = run();
  const event = { eventId: 'same', type: 'encounter.claim', playerId: 'p1', areaKey: 'r:land', species: 1 };
  state = send(state, event).state;
  assert.equal(send(state, event).duplicate, true);
  const duplicateClaim = send(state, { ...event, eventId: 'different' });
  assert.equal(duplicateClaim.reason, 'area_already_claimed');
});

test('lost encounter voids area and emits releases for prior catches', () => {
  let state = run();
  state = send(state, { eventId: 'claim1', type: 'encounter.claim', playerId: 'p1', areaKey: 'r:land', species: 382, pid: 7 }).state;
  state = send(state, { eventId: 'caught1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'r:land', result: 'caught' }).state;
  const result = send(state, { eventId: 'lost2', type: 'encounter.resolve', playerId: 'p2', areaKey: 'r:land', result: 'lost' });
  assert.equal(result.state.areas['r:land'].status, 'void');
  assert.equal(result.state.areas['r:land'].claims.p1.status, 'void');
  assert.deepEqual(result.effects[0].members.map((member) => member.playerId), ['p1']);
});

test('dupe skip clears the pending claim but keeps the area available for a reroll', () => {
  let state = run();
  state = send(state, { eventId: 'claim', type: 'encounter.claim', playerId: 'p1', areaKey: 'r:land', species: 25 }).state;
  state = send(state, { eventId: 'skip', type: 'encounter.resolve', playerId: 'p1', areaKey: 'r:land', result: 'skipped' }).state;
  assert.equal(state.areas['r:land'].status, 'open');
  assert.equal(state.areas['r:land'].claims.p1, undefined);
  const reroll = send(state, { eventId: 'reroll', type: 'encounter.claim', playerId: 'p1', areaKey: 'r:land', species: 1 });
  assert.equal(reroll.accepted, true);
});

test('server reducer cannot be bypassed with a client-authored duplicate claim', () => {
  let state = createRunState({
    runId: 'dupes', seed: 1,
    options: { dupesClause: true },
    members: [{ playerId: 'p1' }, { playerId: 'p2' }],
  });
  state.ownedSpecies.p1 = [25];
  const result = send(state, {
    eventId: 'spoof-duplicate', type: 'encounter.claim', playerId: 'p1',
    areaKey: 'route101:land', species: 25,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'dupes_clause');
  assert.equal(result.state, state);
});

test('server reducer enforces the optional partner-owned species clause', () => {
  let state = createRunState({
    runId: 'partner-species', seed: 1,
    options: { partnerSpeciesClause: true },
    members: [{ playerId: 'p1' }, { playerId: 'p2' }],
  });
  state.ownedSpecies.p1 = [25];
  const result = send(state, {
    eventId: 'partner-duplicate', type: 'encounter.claim', playerId: 'p2',
    areaKey: 'route101:land', species: 25,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'partner_species_clause');
});

test('starter and gift links are not blocked by wild encounter species clauses', () => {
  let state = createRunState({
    runId: 'gifts', seed: 1,
    options: { dupesClause: true, partnerSpeciesClause: true },
    members: [{ playerId: 'p1' }, { playerId: 'p2' }],
  });
  state.ownedSpecies.p1 = [25];
  const first = send(state, {
    eventId: 'gift-a', type: 'encounter.claim', playerId: 'p1', areaKey: 'emerald:gift:starter',
    species: 25, isGift: true,
  });
  assert.equal(first.accepted, true);
  state = send(first.state, {
    eventId: 'gift-b', type: 'encounter.claim', playerId: 'p2', areaKey: 'emerald:gift:starter',
    species: 25, isGift: true,
  }).state;
  state = send(state, { eventId: 'gift-caught-a', type: 'encounter.resolve', playerId: 'p1', areaKey: 'emerald:gift:starter', result: 'caught' }).state;
  state = send(state, { eventId: 'gift-caught-b', type: 'encounter.resolve', playerId: 'p2', areaKey: 'emerald:gift:starter', result: 'caught' }).state;
  assert.equal(state.links['link:emerald:gift:starter'].members.length, 2);
});

test('client cannot bypass wild species clauses by labeling a route claim as a gift', () => {
  let state = createRunState({
    runId: 'forged-gift', seed: 1,
    options: { dupesClause: true },
    members: [{ playerId: 'p1' }, { playerId: 'p2' }],
  });
  state.ownedSpecies.p1 = [25];
  const result = send(state, {
    eventId: 'forged', type: 'encounter.claim', playerId: 'p1',
    areaKey: 'emerald:section:18', species: 25, isGift: true,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'dupes_clause');
});

test('linked death marks every link member dead and queues safe-point releases', () => {
  let state = run();
  state = send(state, { eventId: 'a', type: 'encounter.claim', playerId: 'p1', areaKey: 'r:land', species: 382, pid: 7 }).state;
  // Personality IDs are local save data and can match across different players.
  state = send(state, { eventId: 'b', type: 'encounter.claim', playerId: 'p2', areaKey: 'r:land', species: 25, pid: 7 }).state;
  state = send(state, { eventId: 'caught-a', type: 'encounter.resolve', playerId: 'p1', areaKey: 'r:land', result: 'caught' }).state;
  state = send(state, { eventId: 'caught-b', type: 'encounter.resolve', playerId: 'p2', areaKey: 'r:land', result: 'caught' }).state;
  const result = send(state, { eventId: 'death', type: 'death', playerId: 'p1', linkId: 'link:r:land', cause: 'fainted' });
  assert.equal(result.state.links['link:r:land'].status, 'dead');
  assert.deepEqual(result.effects.map((effect) => effect.playerId), ['p1', 'p2']);
  assert.equal(result.state.deaths.length, 2);
  assert.equal(result.effects.every((effect) => effect.safePoint), true);
});

test('death before a partner catches closes the pending area and releases the caught member', () => {
  let state = run();
  state = send(state, { eventId: 'claim', type: 'encounter.claim', playerId: 'p1', areaKey: 'r:land', species: 382, pid: 7 }).state;
  state = send(state, { eventId: 'caught', type: 'encounter.resolve', playerId: 'p1', areaKey: 'r:land', result: 'caught' }).state;
  const result = send(state, { eventId: 'death', type: 'death', playerId: 'p1', areaKey: 'r:land', pid: 7, cause: 'fainted' });
  assert.equal(result.state.areas['r:land'].status, 'dead');
  assert.equal(result.effects.some((effect) => effect.type === 'release-pokemon' && effect.playerId === 'p1'), true);
  assert.equal(send(result.state, { eventId: 'late-claim', type: 'encounter.claim', playerId: 'p2', areaKey: 'r:land', species: 25 }).reason, 'area_dead');
});

test('wipe reset is rejected until every active player is ready; inactive members are excluded', () => {
  let state = run();
  state = send(state, { eventId: 'wipe', type: 'wipe.pending', playerId: 'p1' }).state;
  state = send(state, { eventId: 'exclude', type: 'run.exclude-member', playerId: 'p1', excludedPlayerId: 'p2' }).state;
  assert.equal(send(state, { eventId: 'reset-early', type: 'run.reset', nextRunId: 'r2', seed: 'seed2' }).reason, 'players_not_ready');
});

test('a continuing member can start the next run alone after other members are excluded', () => {
  let state = run();
  state = send(state, { eventId: 'wipe', type: 'wipe.pending', playerId: 'p1', ready: true }).state;
  state = send(state, { eventId: 'exclude', type: 'run.exclude-member', playerId: 'p1', excludedPlayerId: 'p2' }).state;
  const result = send(state, { eventId: 'reset', type: 'run.reset', nextRunId: 'r2', seed: 'seed2' });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.state.members.map((member) => member.playerId), ['p1']);
});

test('all-ready reset creates clean run identity while retaining active members', () => {
  let state = run();
  state = send(state, { eventId: 'wipe', type: 'wipe.pending', playerId: 'p1', ready: true }).state;
  state = send(state, { eventId: 'ready2', type: 'run.ready', playerId: 'p2' }).state;
  const result = send(state, { eventId: 'reset', type: 'run.reset', nextRunId: 'r2', seed: 'seed2' });
  assert.equal(result.accepted, true);
  assert.equal(result.state.runId, 'r2');
  assert.equal(result.state.status, 'active');
  assert.equal(result.state.members.length, 2);
  assert.deepEqual(result.state.areas, {});
});

test('3-player SoulLink missed catch releases both already-caught and mid-battle partners', () => {
  let state = createRunState({
    runId: 'three-man',
    seed: 1,
    members: [
      { playerId: 'p1', name: 'P1' },
      { playerId: 'p2', name: 'P2' },
      { playerId: 'p3', name: 'P3' },
    ],
  });
  state = send(state, { eventId: 'c1', type: 'encounter.claim', playerId: 'p1', areaKey: 'emerald:section:18', species: 25, pid: 101 }).state;
  state = send(state, { eventId: 'r1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'emerald:section:18', result: 'caught' }).state;
  state = send(state, { eventId: 'c2', type: 'encounter.claim', playerId: 'p2', areaKey: 'emerald:section:18', species: 133, pid: 202 }).state;
  state = send(state, { eventId: 'c3', type: 'encounter.claim', playerId: 'p3', areaKey: 'emerald:section:18', species: 252, pid: 303 }).state;

  const lostResult = send(state, { eventId: 'r3', type: 'encounter.resolve', playerId: 'p3', areaKey: 'emerald:section:18', result: 'lost' });
  assert.equal(lostResult.accepted, true);
  assert.equal(lostResult.state.areas['emerald:section:18'].status, 'void');
  const releaseAreaEffect = lostResult.effects.find((effect) => effect.type === 'release-area');
  assert.deepEqual(releaseAreaEffect.members.map((member) => ({ playerId: member.playerId, pid: member.pid })), [
    { playerId: 'p1', pid: 101 },
    { playerId: 'p2', pid: 202 },
  ]);

  const lateCatchResult = send(lostResult.state, { eventId: 'r2', type: 'encounter.resolve', playerId: 'p2', areaKey: 'emerald:section:18', result: 'caught' });
  assert.equal(lateCatchResult.accepted, true);
  assert.deepEqual(lateCatchResult.effects, [{
    type: 'release-area',
    areaKey: 'emerald:section:18',
    members: [{ playerId: 'p2', pid: 202, species: 133 }],
  }]);
});

test('death events record final level, nickname, badgeCount, and triggeredByPlayerId for SoulLink collateral tracking', () => {
  let state = run();
  state = send(state, {
    eventId: 'c1', type: 'encounter.claim', playerId: 'p1',
    areaKey: 'emerald:section:18', sectionId: 18, species: 258, pid: 101, level: 5, nickname: 'Kip', at: 1000,
  }).state;
  state = send(state, {
    eventId: 'c2', type: 'encounter.claim', playerId: 'p2',
    areaKey: 'emerald:section:18', sectionId: 18, species: 280, pid: 202, level: 5, nickname: 'Ralts', at: 1100,
  }).state;
  state = send(state, { eventId: 'r1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'emerald:section:18', result: 'caught' }).state;
  state = send(state, { eventId: 'r2', type: 'encounter.resolve', playerId: 'p2', areaKey: 'emerald:section:18', result: 'caught' }).state;

  const deathRes = send(state, {
    eventId: 'd1', type: 'death', playerId: 'p1',
    linkId: 'link:emerald:section:18', pid: 101, level: 36, nickname: 'Swampert', badgeCount: 5, at: 5000,
  });
  assert.equal(deathRes.accepted, true);
  assert.equal(deathRes.state.startedAt, 1000);
  assert.equal(deathRes.state.progress.gymIndex, 5);
  assert.equal(deathRes.state.deaths.length, 2);
  const triggerDeath = deathRes.state.deaths.find((d) => d.playerId === 'p1');
  const collateralDeath = deathRes.state.deaths.find((d) => d.playerId === 'p2');
  assert.equal(triggerDeath.level, 36);
  assert.equal(triggerDeath.nickname, 'Swampert');
  assert.equal(triggerDeath.badgeCount, 5);
  assert.equal(triggerDeath.triggeredByPlayerId, 'p1');
  assert.equal(collateralDeath.triggeredByPlayerId, 'p1');
  assert.equal(collateralDeath.badgeCount, 5);
});

test('run.victory records Hall of Fame champion teams and supports ready and reset flow', () => {
  let state = run();
  const win1 = send(state, {
    eventId: 'win-p1',
    type: 'run.victory',
    playerId: 'p1',
    badgeCount: 8,
    sectionId: 50,
    at: 9000,
    party: [
      { species: 260, level: 58, nickname: 'Swampert', pid: 101, moves: [57, 89, 58, 249] },
      { species: 282, level: 56, nickname: 'Gardevoir', pid: 202, moves: [94, 85] },
    ],
  });
  assert.equal(win1.accepted, true);
  state = win1.state;
  assert.equal(state.status, 'victory');
  assert.equal(state.endedAt, 9000);
  assert.equal(state.champions.p1.party.length, 2);
  assert.equal(state.champions.p1.party[0].nickname, 'Swampert');

  state = send(state, { eventId: 'ready-p1', type: 'run.ready', playerId: 'p1' }).state;
  state = send(state, { eventId: 'ready-p2', type: 'run.ready', playerId: 'p2' }).state;
  const reset = send(state, { eventId: 'reset-after-win', type: 'run.reset', playerId: 'p1', nextRunId: 'r2', seed: 'seed2' });
  assert.equal(reset.accepted, true);
  assert.equal(reset.state.status, 'active');
  assert.equal(reset.state.runId, 'r2');
});


