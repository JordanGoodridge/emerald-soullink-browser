import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FLASH_SIZE,
  createEmeraldSaveCodec,
  isValidCurrentBuildSave,
  normalizeSaveForCurrentBuild,
} from './save-codec-emerald.mjs';

test('rejects wrong-sized and empty save images', () => {
  const codec = createEmeraldSaveCodec();
  assert.equal(codec.validate(new Uint8Array(0)).ok, false);
  assert.equal(codec.validate(new Uint8Array(FLASH_SIZE)).ok, false);
  assert.equal(isValidCurrentBuildSave(new Uint8Array(FLASH_SIZE)), false);
  assert.equal(normalizeSaveForCurrentBuild(new Uint8Array(FLASH_SIZE)), null);
});

test('exports a byte-for-byte copy', () => {
  const codec = createEmeraldSaveCodec();
  const bytes = new Uint8Array([1, 2, 3]);
  const exported = codec.exportRaw(bytes);
  assert.notEqual(exported, bytes);
  assert.deepEqual([...exported], [1, 2, 3]);
});

test('codec identity is explicit', () => {
  const codec = createEmeraldSaveCodec({ formatId: 'emerald-kaizo-flash-128k', formatVersion: 1 });
  assert.equal(codec.formatId, 'emerald-kaizo-flash-128k');
  assert.equal(codec.formatVersion, 1);
  assert.equal(codec.bytes, FLASH_SIZE);
});

test('validates a real Kaizo Route 103 save with the Kaizo identity', async () => {
  const bytes = new Uint8Array(await readFile(new URL(
    '../../../../game-packs/emerald-kaizo/fixtures/kaizo-route103.sav',
    import.meta.url,
  )));
  assert.equal(bytes.length, FLASH_SIZE);
  const codec = createEmeraldSaveCodec({ formatId: 'emerald-kaizo-flash-128k' });
  assert.deepEqual(codec.validate(bytes), { ok: true });
  assert.equal(isValidCurrentBuildSave(bytes), true);
  assert.equal(normalizeSaveForCurrentBuild(bytes)?.length, FLASH_SIZE);
});
