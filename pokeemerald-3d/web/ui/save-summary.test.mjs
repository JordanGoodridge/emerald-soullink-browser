import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readSaveSummary } from './save-summary.mjs';

test('reads player, play time and map from a real Kaizo save', async () => {
  const bytes = new Uint8Array(await readFile(new URL(
    '../../../game-packs/emerald-kaizo/fixtures/kaizo-route103.sav',
    import.meta.url,
  )));
  const summary = readSaveSummary(bytes);
  assert.equal(summary.valid, true);
  assert.equal(summary.player.map.group, 0);
  assert.equal(summary.player.map.num, 18);
  assert.equal(summary.player.playTimeHours, 0);
  assert.equal(summary.player.playTimeMinutes, 0);
});

test('rejects empty and wrong-sized images', () => {
  assert.equal(readSaveSummary(new Uint8Array(128 * 1024)).valid, false);
  assert.equal(readSaveSummary(new Uint8Array(10)).valid, false);
});
