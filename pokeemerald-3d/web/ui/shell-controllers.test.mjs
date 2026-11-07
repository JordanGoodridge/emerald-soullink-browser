import test from 'node:test';
import assert from 'node:assert/strict';

import {
  base64ToBytes,
  bytesToBase64,
  createFlashSaveController,
  formatSpeed,
  hashBytes,
} from '../saves/flash-save-controller.mjs';
import { createVisualModeController } from '../settings/visual-mode-controller.mjs';
import { createGameplaySheetsController } from './gameplay-sheets-controller.mjs';
import { createLobbyCoordinator } from '../run/lobby-coordinator.mjs';
import { createRunSetupCoordinator } from '../run/run-setup-coordinator.mjs';

test('flash-save-controller encodes, hashes, and manages flash save + speed state', () => {
  const sample = new Uint8Array([1, 2, 3, 250, 255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(sample)), sample);
  assert.equal(hashBytes(sample), hashBytes(new Uint8Array([1, 2, 3, 250, 255])));
  assert.equal(formatSpeed(Infinity), 'unlimited');
  assert.equal(formatSpeed(2), '2.0x');

  const backing = new Uint8Array(16);
  let savedBytes = null;
  let mirroredBytes = null;
  const controller = createFlashSaveController({
    speedParam: '4',
    getMemoryReady: () => true,
    getRuntimeAdapter: () => ({
      saveView: (len) => backing.subarray(0, len),
      saveGame: () => {
        backing[0] = 42;
        return 1;
      },
    }),
    getSaveCodec: () => ({
      bytes: 16,
      normalize: (b) => b,
      validate: () => ({ ok: true }),
    }),
    getSaveStore: () => ({
      key: 'test-slot',
      load: () => (savedBytes ? { bytes: savedBytes, updatedAt: 1000 } : null),
      save: (b) => {
        savedBytes = new Uint8Array(b);
        return true;
      },
    }),
    onQueueStandardSoloMirror: (b) => {
      mirroredBytes = new Uint8Array(b);
    },
  });

  assert.equal(controller.initialSpeed(), 4);
  controller.setSpeed(8);
  assert.equal(controller.speed, 8);
  controller.toggleUnlimitedSpeed();
  assert.equal(controller.speed, Infinity);
  controller.toggleUnlimitedSpeed();
  assert.equal(controller.speed, 8);

  controller.loadFlashSave(new Uint8Array(16).fill(7));
  assert.equal(backing[0], 7);
  assert.equal(controller.saveCurrentGameNow(false), 1);
  assert.equal(savedBytes[0], 42);
  assert.equal(mirroredBytes[0], 42);
});

test('visual-mode-controller transitions between hd2d and classic modes', () => {
  const modeCalls = [];
  let frame = 0;
  const controller = createVisualModeController({
    automate: true,
    reducedMotionQuery: { matches: true },
    settings: {
      get: () => ({
        controlScheme: 'arrows',
        peerNameTags: true,
        peerIndicators: true,
        peerIcons: true,
        peopleMap: true,
        partyShared: true,
      }),
      set: () => {},
      subscribe: () => {},
    },
    getInstance: () => ({ exports: {} }),
    getSceneAdapter: () => ({
      setMode: (_inst, mode) => modeCalls.push(mode),
    }),
    getCurrentFrame: () => frame,
  });

  controller.setVisualSettings({ mode: 'classic', shading: 0.4, perspective: 0.5, zoom: 0.8, optics: 0.3 }, false, true);
  assert.equal(controller.visualMode, 'classic');
  assert.equal(controller.activeVisualMode, 'classic');
  assert.equal(controller.renderedShadingStrength, 0);
  assert.deepEqual(modeCalls, ['classic']);

  frame = 60;
  controller.setVisualSettings({ mode: 'hd2d', shading: 0.6, perspective: 0.5, zoom: 0.8, optics: 0.4 }, false, true);
  assert.equal(controller.visualMode, 'hd2d');
  assert.equal(controller.activeVisualMode, 'hd2d');
  assert.equal(controller.renderedShadingStrength, 0.6);
  assert.deepEqual(modeCalls, ['classic', 'hd2d']);
});

test('lobby-coordinator and run-setup-coordinator initialize and expose clean state', () => {
  const presence = {
    url: 'ws://localhost:8787/presence',
    getSnapshot: () => ({ status: 'disconnected', members: [] }),
    getRunCredentials: () => null,
    leave: () => {},
  };
  const presenceLobby = { open: () => {}, close: () => {} };
  const lobbyCoordinator = createLobbyCoordinator({
    presence,
    presenceLobby,
  });
  const runSetupCoordinator = createRunSetupCoordinator({
    presence,
    presenceLobby,
    lobbyCoordinator,
  });

  assert.equal(lobbyCoordinator.lobbyRecordSnapshot, null);
  assert.equal(runSetupCoordinator.runConnectionStatus, 'disconnected');
  runSetupCoordinator.updateRunConnection();
  assert.equal(runSetupCoordinator.runClient, null);
});

test('lobby-coordinator automatic saveLobbySlot still saves local game progress when room session is disconnected', async () => {
  let localSaves = 0;
  const lobbyCoordinator = createLobbyCoordinator({
    presence: {
      getSnapshot: () => ({ status: 'closed', members: [] }),
      getRunCredentials: () => null,
    },
    presenceLobby: { open: () => {}, close: () => {} },
    getRunSettings: () => ({ mode: 'standard' }),
    getInstance: () => ({ exports: { WasmPresenceValid: () => 1 } }),
    saveCurrentGameNow: (automatic) => {
      if (automatic) localSaves++;
      return 1;
    },
  });

  await assert.rejects(() => lobbyCoordinator.saveLobbySlot(true), /join a Standard or SoulLink lobby/);
  assert.equal(localSaves, 1);
});

test('gameplay-sheets-controller toggles people map when enabled in settings', () => {
  const sheets = createGameplaySheetsController({
    settings: { get: () => ({ peopleMap: false }) },
    presence: { getSnapshot: () => ({ members: [] }) },
  });
  assert.equal(sheets.togglePeopleMap(true), false);
});
