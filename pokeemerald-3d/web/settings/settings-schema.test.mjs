import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  normalizeSettings,
  parseSettings,
  serializeSettings,
  settingsEqual,
} from './settings-schema.mjs';

test('defaults are stable and cover every setting', () => {
  assert.equal(DEFAULT_SETTINGS.schemaVersion, SETTINGS_VERSION);
  assert.equal(DEFAULT_SETTINGS.controlScheme, 'arrows');
  assert.equal(DEFAULT_SETTINGS.peerNameTags, true);
  assert.equal(DEFAULT_SETTINGS.peerIndicators, true);
  assert.equal(DEFAULT_SETTINGS.peerIcons, true);
  assert.equal(DEFAULT_SETTINGS.peopleMap, true);
  assert.equal(DEFAULT_SETTINGS.partyShared, true);
  assert.equal('moveRelearner' in DEFAULT_SETTINGS, false);
});

test('normalize keeps valid values and replaces invalid ones', () => {
  const settings = normalizeSettings({
    controlScheme: 'wasd',
    peerNameTags: false,
    peerIcons: 'yes',
    peopleMap: 0,
    moveRelearner: true,
    unknown: 'ignored',
  });
  assert.equal(settings.controlScheme, 'wasd');
  assert.equal(settings.peerNameTags, false);
  assert.equal(settings.peerIcons, true);
  assert.equal(settings.peopleMap, true);
  assert.equal('moveRelearner' in settings, false);
  assert.equal('unknown' in settings, false);
  assert.equal(settings.schemaVersion, SETTINGS_VERSION);
});

test('unknown control scheme falls back without dropping other settings', () => {
  const settings = normalizeSettings({ controlScheme: 'gamepad', peerIndicators: false });
  assert.equal(settings.controlScheme, 'arrows');
  assert.equal(settings.peerIndicators, false);
});

test('non-object input yields defaults', () => {
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings('wasd'), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings([]), { ...DEFAULT_SETTINGS });
});

test('parse handles empty, corrupt and partial JSON', () => {
  assert.deepEqual(parseSettings(''), { ...DEFAULT_SETTINGS });
  assert.deepEqual(parseSettings('   '), { ...DEFAULT_SETTINGS });
  assert.deepEqual(parseSettings('{not json'), { ...DEFAULT_SETTINGS });
  const partial = parseSettings('{"controlScheme":"wasd"}');
  assert.equal(partial.controlScheme, 'wasd');
  assert.equal(partial.peerNameTags, true);
});

test('serialize round-trips through parse', () => {
  const settings = normalizeSettings({ controlScheme: 'wasd', peerIcons: false });
  assert.deepEqual(parseSettings(serializeSettings(settings)), settings);
});

test('settingsEqual compares normalized values, not key order', () => {
  const a = normalizeSettings({ controlScheme: 'wasd' });
  const b = normalizeSettings({ controlScheme: 'wasd', peerNameTags: true });
  assert.equal(settingsEqual(a, b), true);
  assert.equal(settingsEqual(a, normalizeSettings({ controlScheme: 'arrows' })), false);
});
