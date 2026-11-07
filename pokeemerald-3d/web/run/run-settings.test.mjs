import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RUN_SETTINGS,
  defaultRunSettingsForMode,
  normalizeRunSettings,
  parseRunSettings,
  saveSlotForMode,
  serializeRunSettings,
} from './run-settings.mjs';

test('run settings default to standard play and map modes to isolated slots', () => {
  assert.equal(DEFAULT_RUN_SETTINGS.mode, 'standard');
  assert.equal(DEFAULT_RUN_SETTINGS.randomizeStarters, true);
  assert.equal(DEFAULT_RUN_SETTINGS.saveSlot, 'main');
  assert.equal(DEFAULT_RUN_SETTINGS.allowLinkedPcBoxing, false);
  assert.equal(DEFAULT_RUN_SETTINGS.moveRelearner, true);
  assert.equal(DEFAULT_RUN_SETTINGS.rareCandyPartyLevelCeiling, true);
  assert.equal(DEFAULT_RUN_SETTINGS.infiniteMoney, true);
  assert.equal(defaultRunSettingsForMode('soullink').allowLinkedPcBoxing, true);
  assert.equal(defaultRunSettingsForMode('soullink').moveRelearner, true);
  assert.equal(defaultRunSettingsForMode('soullink').rareCandyPartyLevelCeiling, true);
  assert.equal(defaultRunSettingsForMode('soullink').infiniteMoney, true);
  assert.equal(defaultRunSettingsForMode('nuzlocke').infiniteMoney, false);
  assert.equal(saveSlotForMode('standard'), 'main');
  assert.equal(saveSlotForMode('nuzlocke'), 'nuzlocke');
  assert.equal(saveSlotForMode('soullink'), 'soulrun');
});

test('normalization preserves booleans and derives the mode-specific slot', () => {
  const result = normalizeRunSettings({ mode: 'nuzlocke', randomizeWild: false, saveSlot: 'main', unknown: 1 });
  assert.equal(result.mode, 'nuzlocke');
  assert.equal(result.randomizeWild, false);
  assert.equal(result.saveSlot, 'nuzlocke');
  assert.equal(normalizeRunSettings({ mode: 'soullink', saveSlot: 'main' }).saveSlot, 'soulrun');
  assert.equal('unknown' in result, false);
});

test('SoulLink upgrades the old unchecked linked-boxing default but preserves current explicit choices', () => {
  const oldSoulLink = normalizeRunSettings({
    schemaVersion: 1,
    mode: 'soullink',
    allowLinkedPcBoxing: false,
  });
  const currentSoulLinkOff = normalizeRunSettings({
    schemaVersion: 2,
    mode: 'soullink',
    allowLinkedPcBoxing: false,
  });
  assert.equal(oldSoulLink.allowLinkedPcBoxing, true);
  assert.equal(oldSoulLink.schemaVersion, 2);
  assert.equal(currentSoulLinkOff.allowLinkedPcBoxing, false);
});

test('solo Nuzlocke defaults to basic non-randomized rules while SoulLink keeps its randomizer defaults', () => {
  const nuzlocke = normalizeRunSettings({ mode: 'nuzlocke' });
  const soulLink = normalizeRunSettings({ mode: 'soullink' });
  assert.equal(nuzlocke.dupesClause, false);
  assert.equal(nuzlocke.randomizeWild, false);
  assert.equal(nuzlocke.randomizeStarters, false);
  assert.equal(nuzlocke.infiniteRareCandies, false);
  assert.equal(soulLink.randomizeWild, true);
  assert.equal(soulLink.randomizeStarters, true);
  assert.equal(soulLink.saveSlot, 'soulrun');
});

test('parse and serialize tolerate corrupt or partial settings', () => {
  assert.deepEqual(parseRunSettings('{bad'), { ...DEFAULT_RUN_SETTINGS });
  const parsed = parseRunSettings(serializeRunSettings({ mode: 'standard', dupesClause: false }));
  assert.equal(parsed.mode, 'standard');
  assert.equal(parsed.dupesClause, false);
  assert.equal(parsed.saveSlot, 'main');
});

test('power balance options are mutually exclusive with their corresponding true-random options', () => {
  const wildBalanced = normalizeRunSettings({
    mode: 'soullink',
    randomizeWild: true,
    powerBalanceWild: true,
    randomizeTrainers: true,
    powerBalanceTrainers: false,
    randomizeGyms: false,
    powerBalanceGyms: true,
  });
  assert.equal(wildBalanced.powerBalanceWild, true);
  assert.equal(wildBalanced.randomizeWild, false);
  assert.equal(wildBalanced.powerBalanceTrainers, false);
  assert.equal(wildBalanced.randomizeTrainers, true);
  assert.equal(wildBalanced.powerBalanceGyms, true);
  assert.equal(wildBalanced.randomizeGyms, false);

  const neither = normalizeRunSettings({
    mode: 'soullink',
    randomizeWild: false,
    powerBalanceWild: false,
    randomizeTrainers: false,
    powerBalanceTrainers: false,
    randomizeGyms: false,
    powerBalanceGyms: false,
  });
  assert.equal(neither.randomizeWild, false);
  assert.equal(neither.powerBalanceWild, false);
  assert.equal(neither.randomizeTrainers, false);
  assert.equal(neither.powerBalanceTrainers, false);
  assert.equal(neither.randomizeGyms, false);
  assert.equal(neither.powerBalanceGyms, false);
});
