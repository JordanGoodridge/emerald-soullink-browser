import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  gameUrl,
  loadIndex,
  packManifestUrl,
  createPackRegistry,
} from './registry.mjs';

const realIndex = JSON.parse(
  await readFile(new URL('../../../game-packs/index.json', import.meta.url), 'utf8'),
);

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

test('loads and validates the checked-in index', async () => {
  const { index, indexUrl } = await loadIndex({
    indexUrl: 'https://example.test/game-packs/index.json',
    fetchImpl: async () => jsonResponse(realIndex),
  });
  assert.equal(index.default, 'emerald');
  assert.equal(indexUrl, 'https://example.test/game-packs/index.json');
});

test('resolves a pack manifest relative to the index', async () => {
  const url = packManifestUrl(realIndex, 'https://example.test/game-packs/index.json', 'emerald');
  assert.equal(url, 'https://example.test/game-packs/emerald/manifest.json');
});

test('unknown games produce a named error', async () => {
  const registry = createPackRegistry({
    indexUrl: 'https://example.test/game-packs/index.json',
    fetchImpl: async () => jsonResponse(realIndex),
  });
  await assert.rejects(
    () => registry.manifestUrl('does-not-exist'),
    (error) => error.code === 'unknown_game',
  );
});

test('game URLs preserve settings and drop session room state', () => {
  const url = gameUrl(
    'https://example.test/?speed=2&saveProfile=ash&mode=soullink&pregame=1&lobby=1&presence=1&presenceAuto=create&presenceRoom=ABCD2345&presenceUrl=wss%3A%2F%2Frelay',
    'emerald-kaizo',
  );
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('game'), 'emerald-kaizo');
  assert.equal(parsed.searchParams.get('speed'), '2');
  assert.equal(parsed.searchParams.get('saveProfile'), 'ash');
  assert.equal(parsed.searchParams.get('presenceUrl'), 'wss://relay');
  assert.equal(parsed.searchParams.has('presence'), false);
  assert.equal(parsed.searchParams.has('presenceAuto'), false);
  assert.equal(parsed.searchParams.has('presenceRoom'), false);
  assert.equal(parsed.searchParams.has('pregame'), false);
  assert.equal(parsed.searchParams.has('lobby'), false);
});

test('game URL records the selected run mode distinctly', () => {
  const url = new URL(gameUrl('https://example.test/?speed=2&mode=soullink', 'emerald', 'nuzlocke'));
  assert.equal(url.searchParams.get('game'), 'emerald');
  assert.equal(url.searchParams.get('mode'), 'nuzlocke');
  assert.equal(url.searchParams.get('speed'), '2');
  const standard = new URL(gameUrl('https://example.test/?mode=nuzlocke', 'emerald'));
  assert.equal(standard.searchParams.get('mode'), 'standard');
});
