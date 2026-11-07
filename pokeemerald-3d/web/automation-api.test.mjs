import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationApi } from './automation-api.mjs';

const apiKeys = [
  'ready', 'loadSave', 'setEncounters', 'setRunningShoes', 'mapGrid', 'hd2dCourses',
  'worldAtlas', 'heightMap', 'setButton', 'setAvatar', 'setWeather', 'setVisualMode',
  'startNewGame', 'quickStart', 'runParty', 'canBoxRunPartyMon', 'tryBoxRunPartyMon',
  'runGymCaps', 'setRunBadgeCount', 'runSpeciesProbe', 'createWildParty',
  'createTrainerParty', 'runSaveInfo', 'seedMainSaveFromSoulrun', 'mainSaveInfo',
  'debugFaintRunPartySlot', 'addRunPartyMon', 'queueRunRelease', 'queueRunReleasePid',
  'debugBoxMon', 'runBoxHasPid', 'useRunRareCandy', 'consumeAndRefillRunCandy',
  'applyRunExpGain', 'runCaptureProbe', 'acceptRunWildCapture', 'processRunSafePoint',
  'warp', 'startBattleTransition', 'presenceCutscene', 'startWildBattle', 'saveGame',
  'saveInfo', 'runToFrame', 'screenshot', 'benchmarkPresentation', 'objectDescriptors',
  'objectEvents', 'hblankDmaWin0HProbe', 'simulateDeviceLoss', 'state', 'frame',
];

test('automation facade retains its established public surface and forwards callbacks', () => {
  const handlers = Object.fromEntries(apiKeys.map((key) => [key, () => key]));
  const api = createAutomationApi(handlers);
  assert.deepEqual(Object.keys(api), apiKeys);
  for (const key of apiKeys) assert.equal(api[key], handlers[key]);
  assert.equal(api.runParty(), 'runParty');
  assert.equal(api.saveGame(), 'saveGame');
});
