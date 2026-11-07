import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLibraryModel, formatRelativeTime } from './library-model.mjs';

test('chooses the newest local save and formats labels', () => {
  const now = 10_000_000_000;
  const games = [
    { id: 'a', title: 'Alpha', hidden: false, cover: 'a.png' },
    { id: 'b', title: 'Beta', hidden: false, cover: 'b.png' },
    { id: 'hidden', title: 'Hidden', hidden: true },
  ];
  const records = [
    { key: 'record-a', gameId: 'a', profile: '', slot: 'main', updatedAt: now - 120_000 },
    { key: 'record-b', gameId: 'b', profile: 'run', slot: 'main', updatedAt: now - 60_000 },
  ];
  const summaries = {
    'record-a': { valid: true, player: { playTimeTotalMinutes: 65, map: { group: 0, num: 10 } } },
    'record-b': { valid: true, player: { playTimeTotalMinutes: 5, map: { group: 0, num: 18 } } },
  };
  const model = buildLibraryModel({
    games,
    records,
    summaries,
    mapNames: { a: { '0:10': 'Oldale Town' }, b: { '0:18': 'Route 103' } },
    now,
  });

  assert.equal(model.games.length, 2);
  assert.deepEqual(model.games.map((game) => game.id), ['a', 'b']);
  assert.equal(model.hero.id, 'b');
  assert.equal(model.hero.saveName, 'run');
  assert.equal(model.hero.location, 'Route 103');
  assert.equal(model.hero.playTime, '5m');
  assert.equal(model.hero.actionLabel, 'Continue');
  assert.equal(formatRelativeTime(now - 120_000, now), '2m ago');
  assert.equal(formatRelativeTime(now - 26 * 60 * 60 * 1000, now), 'yesterday');
});

test('Standard Continue ignores a more recently written SoulLink slot', () => {
  const model = buildLibraryModel({
    games: [{ id: 'emerald', title: 'Emerald' }],
    records: [
      { key: 'main', gameId: 'emerald', profile: '', slot: 'main', updatedAt: 10 },
      { key: 'soulrun', gameId: 'emerald', profile: '', slot: 'soulrun', updatedAt: 20 },
    ],
    summaries: {
      main: { valid: true, player: { map: { group: 1, num: 4 } } },
      soulrun: { valid: true, player: { map: { group: 1, num: 8 } } },
    },
  });
  assert.equal(model.hero.record.key, 'main');
  assert.equal(model.hero.location, 'Map 1:4');
});
