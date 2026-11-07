import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_NAMES, mapNameFor } from './map-names.mjs';

test('resolves readable names for known map identities', () => {
  assert.equal(mapNameFor({ mapGroup: 0, mapNum: 18 }), 'Route 103');
  assert.equal(mapNameFor({ mapGroup: 0, mapNum: 9 }), 'Littleroot Town');
  assert.equal(mapNameFor({ mapGroup: 0, mapNum: 10 }), 'Oldale Town');
  assert.equal(mapNameFor({ mapGroup: 1, mapNum: 4 }), 'Littleroot Town Professor Birchs Lab');
});

test('unknown or missing worlds resolve to null', () => {
  assert.equal(mapNameFor({ mapGroup: 0, mapNum: 250 }), null);
  assert.equal(mapNameFor({ mapGroup: 99, mapNum: 1 }), null);
  assert.equal(mapNameFor(null), null);
  assert.equal(mapNameFor(undefined), null);
});

test('the generated table covers the full map list', () => {
  assert.ok(Object.keys(MAP_NAMES).length >= 500, Object.keys(MAP_NAMES).length);
  for (const [key, label] of Object.entries(MAP_NAMES)) {
    assert.match(key, /^\d+:\d+$/);
    assert.ok(label.length > 0 && !label.includes('_'), `${key} -> ${label}`);
  }
});
