import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunState, reduceRunEvent } from './run-state.mjs';
import { buildPostRunSummary, formatRunDuration, HOENN_GYM_SPLITS } from './post-run-model.mjs';

const SPECIES_FIXTURES = {
  258: { name: 'Mudkip', nationalDex: 258, spriteUrl: '/sprites/258.png' },
  260: { name: 'Swampert', nationalDex: 260, spriteUrl: '/sprites/260.png' },
  280: { name: 'Ralts', nationalDex: 280, spriteUrl: '/sprites/280.png' },
  282: { name: 'Gardevoir', nationalDex: 282, spriteUrl: '/sprites/282.png' },
  270: { name: 'Lotad', nationalDex: 270, spriteUrl: '/sprites/270.png' },
  285: { name: 'Shroomish', nationalDex: 285, spriteUrl: '/sprites/285.png' },
};

function speciesInfoFor(species) {
  return SPECIES_FIXTURES[species] ?? { name: `Mon#${species}`, nationalDex: species, spriteUrl: `/sprites/${species}.png` };
}

test('formatRunDuration formats hours, minutes, and seconds cleanly', () => {
  assert.equal(formatRunDuration(null), '—');
  assert.equal(formatRunDuration(45_000), '45s');
  assert.equal(formatRunDuration(15 * 60_000 + 5_000), '15m 05s');
  assert.equal(formatRunDuration(2 * 3600_000 + 14 * 60_000), '2h 14m');
});

test('buildPostRunSummary computes SoulLink wipe stats, collateral Heartbreaker award, and graveyard epitaphs', () => {
  let state = createRunState({
    runId: 'sl-wipe',
    seed: 777,
    mode: 'soullink',
    options: { gymLevelCap: true, dupesClause: true, randomizeWild: true },
    members: [
      { playerId: 'p1', name: 'Ash' },
      { playerId: 'p2', name: 'Misty' },
    ],
    startedAt: 1000,
  });

  // Starter link (survives until wipe)
  state = reduceRunEvent(state, {
    eventId: 's1', type: 'encounter.claim', playerId: 'p1',
    areaKey: 'emerald:gift:starter', species: 258, pid: 101, level: 5, nickname: 'Kip', isGift: true, badgeCount: 0, at: 2000,
  }).state;
  state = reduceRunEvent(state, {
    eventId: 's2', type: 'encounter.claim', playerId: 'p2',
    areaKey: 'emerald:gift:starter', species: 280, pid: 202, level: 5, nickname: 'Psy', isGift: true, badgeCount: 0, at: 2100,
  }).state;
  state = reduceRunEvent(state, { eventId: 'sr1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'emerald:gift:starter', result: 'caught', badgeCount: 0, at: 2200 }).state;
  state = reduceRunEvent(state, { eventId: 'sr2', type: 'encounter.resolve', playerId: 'p2', areaKey: 'emerald:gift:starter', result: 'caught', badgeCount: 0, at: 2300 }).state;

  // Route 102 link that dies in Norman split (badgeCount = 4)
  state = reduceRunEvent(state, {
    eventId: 'c1', type: 'encounter.claim', playerId: 'p1',
    areaKey: 'emerald:section:19', sectionId: 19, species: 270, pid: 303, level: 4, nickname: 'Lily', badgeCount: 1, at: 10_000,
  }).state;
  state = reduceRunEvent(state, {
    eventId: 'c2', type: 'encounter.claim', playerId: 'p2',
    areaKey: 'emerald:section:19', sectionId: 19, species: 285, pid: 404, level: 34, nickname: 'Spore', badgeCount: 1, at: 11_000,
  }).state;
  state = reduceRunEvent(state, { eventId: 'cr1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'emerald:section:19', result: 'caught', badgeCount: 1, at: 12_000 }).state;
  state = reduceRunEvent(state, { eventId: 'cr2', type: 'encounter.resolve', playerId: 'p2', areaKey: 'emerald:section:19', result: 'caught', badgeCount: 1, at: 13_000 }).state;

  // Dupes skip + missed route
  state = reduceRunEvent(state, {
    eventId: 'skip1', type: 'encounter.skip', playerId: 'p1',
    areaKey: 'emerald:section:20', sectionId: 20, species: 270, reason: 'dupes_clause', badgeCount: 2, at: 20_000,
  }).state;
  state = reduceRunEvent(state, {
    eventId: 'lost1', type: 'encounter.resolve', playerId: 'p2',
    areaKey: 'emerald:section:20', sectionId: 20, result: 'lost', badgeCount: 2, at: 25_000,
  }).state;

  // Ash's Lily faints at Badge 4, dragging down Misty's Lv 34 Spore
  state = reduceRunEvent(state, {
    eventId: 'd1', type: 'death', playerId: 'p1',
    linkId: 'link:emerald:section:19', pid: 303, level: 31, nickname: 'Lombre', badgeCount: 4, at: 120_000,
  }).state;

  // Wipe at Badge 4
  state = reduceRunEvent(state, {
    eventId: 'w1', type: 'wipe.pending', playerId: 'p1',
    areaKey: 'emerald:section:19', sectionId: 19, badgeCount: 4, at: 121_000,
  }).state;

  const summary = buildPostRunSummary({
    run: state,
    localPlayerId: 'p1',
    speciesInfoFor,
    regionMap: { sections: [{ id: 19, name: 'Petalburg City' }, { id: 20, name: 'Route 104' }] },
  });

  assert.equal(summary.outcome, 'wipe');
  assert.equal(summary.badgeCount, 4);
  assert.equal(summary.durationLabel, '2m 00s');
  assert.equal(summary.metrics.totalDeaths, 2);
  assert.equal(summary.metrics.directDeaths, 1);
  assert.equal(summary.metrics.collateralDeaths, 1);
  assert.equal(summary.metrics.missedEncounters, 1);
  assert.equal(summary.metrics.clauseRerolls, 1);
  assert.ok(summary.wipeDetail.reason.includes('Ash'));
  assert.ok(summary.wipeDetail.reason.includes('Petalburg City'));

  const awardIds = summary.awards.map((a) => a.id);
  assert.ok(awardIds.includes('mvp'));
  assert.ok(awardIds.includes('iron-link'));
  assert.ok(awardIds.includes('heartbreaker'));
  assert.ok(awardIds.includes('deadliest-split'));
  assert.ok(awardIds.includes('butterfingers'));
  assert.ok(awardIds.includes('clause-magnet'));

  const collateralEntry = summary.graveyard.find((g) => g.playerId === 'p2');
  assert.equal(collateralEntry.isCollateral, true);
  assert.ok(collateralEntry.causeLabel.includes('Ash'));
});

test('buildPostRunSummary builds Hall of Fame victory roster and 8-badge timeline', () => {
  assert.equal(HOENN_GYM_SPLITS.length, 9);
  let state = createRunState({
    runId: 'hof-win',
    seed: 2026,
    mode: 'soullink',
    members: [
      { playerId: 'p1', name: 'Ash' },
      { playerId: 'p2', name: 'Misty' },
    ],
    startedAt: 10_000,
  });
  state = reduceRunEvent(state, {
    eventId: 'win-1',
    type: 'run.victory',
    playerId: 'p1',
    badgeCount: 8,
    at: 3_610_000,
    party: [
      { species: 260, level: 60, nickname: 'Muddy', pid: 101, moves: [57, 89] },
      { species: 282, level: 58, nickname: 'Oracle', pid: 202, moves: [94, 85] },
    ],
  }).state;

  const summary = buildPostRunSummary({
    run: state,
    localPlayerId: 'p1',
    speciesInfoFor,
  });

  assert.equal(summary.outcome, 'victory');
  assert.equal(summary.badgeCount, 8);
  assert.equal(summary.durationLabel, '1h 00m');
  assert.equal(summary.title, 'Hall of Fame Champions');
  assert.equal(summary.champions[0].members.length, 2);
  assert.equal(summary.champions[0].members[0].displayName, 'Muddy');
  assert.equal(summary.champions[0].members[0].status, 'champion');
  assert.equal(summary.splits.every((s) => s.reached), true);
});

test('buildPostRunSummary excludes uncaught voided claims from totalCatches and deduplicates 3P award sprites', () => {
  let state = createRunState({
    runId: 'sl-3p-wipe',
    seed: 365572647,
    mode: 'soullink',
    members: [
      { playerId: 'p1', name: 'Jordan' },
      { playerId: 'p2', name: 'jordy2shoes' },
      { playerId: 'p3', name: 'Leontsu' },
    ],
    startedAt: 5000,
  });

  // 3 Starters caught
  state = reduceRunEvent(state, { eventId: 's1', type: 'encounter.claim', playerId: 'p1', areaKey: 'emerald:gift:starter', species: 9, pid: 1, level: 5, isGift: true, at: 6000 }).state;
  state = reduceRunEvent(state, { eventId: 's2', type: 'encounter.claim', playerId: 'p2', areaKey: 'emerald:gift:starter', species: 91, pid: 2, level: 5, isGift: true, at: 6100 }).state;
  state = reduceRunEvent(state, { eventId: 's3', type: 'encounter.claim', playerId: 'p3', areaKey: 'emerald:gift:starter', species: 239, pid: 3, level: 5, isGift: true, at: 6200 }).state;
  state = reduceRunEvent(state, { eventId: 'sr1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'emerald:gift:starter', result: 'caught', at: 6300 }).state;
  state = reduceRunEvent(state, { eventId: 'sr2', type: 'encounter.resolve', playerId: 'p2', areaKey: 'emerald:gift:starter', result: 'caught', at: 6400 }).state;
  state = reduceRunEvent(state, { eventId: 'sr3', type: 'encounter.resolve', playerId: 'p3', areaKey: 'emerald:gift:starter', result: 'caught', at: 6500 }).state;

  // Route 101 encounter claimed then KO'd (not caught)
  state = reduceRunEvent(state, { eventId: 'w1', type: 'encounter.claim', playerId: 'p1', areaKey: 'emerald:section:16', sectionId: 16, species: 263, pid: 10, level: 3, at: 10_000 }).state;
  state = reduceRunEvent(state, { eventId: 'wr1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'emerald:section:16', sectionId: 16, result: 'lost', at: 12_000 }).state;

  // p2 faints, dragging down p1 and p3
  state = reduceRunEvent(state, { eventId: 'd1', type: 'death', playerId: 'p2', linkId: 'link:emerald:gift:starter', pid: 2, level: 5, at: 35_000 }).state;
  state = reduceRunEvent(state, { eventId: 'wipe1', type: 'wipe.pending', playerId: 'p2', areaKey: 'emerald:section:16', sectionId: 16, at: 35_000 }).state;

  const summary = buildPostRunSummary({
    run: state,
    localPlayerId: 'p1',
    speciesInfoFor,
  });

  // Uncaught wild claim that became void must not be counted as caught
  assert.equal(summary.metrics.encountersCaught, 3);
  const catchStat = summary.stats.find((s) => s.id === 'catches');
  assert.equal(catchStat.detail, '0 wild caught · 3 starters');

  // MVP, Iron Link, and Heartbreaker awards feature distinct species sprites across the 3-player link
  const mvpAward = summary.awards.find((a) => a.id === 'mvp');
  const linkAward = summary.awards.find((a) => a.id === 'iron-link');
  const heartbreakerAward = summary.awards.find((a) => a.id === 'heartbreaker');
  assert.equal(mvpAward.species, 9);
  assert.equal(linkAward.species, 91);
  assert.equal(heartbreakerAward.species, 239);
  assert.match(heartbreakerAward.headline, /Jordan.*&.*Leontsu/);
});
