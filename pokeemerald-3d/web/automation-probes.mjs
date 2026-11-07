// Browser E2E & Playwright automation probe implementation for the PokeTech shell.
// Extracted from app.js so production shell coordinator stays focused.

import {
  HD2D_SURFACE_DECK,
  HD2D_SURFACE_MASK,
  HD2D_SURFACE_OBSTACLE,
  HD2D_SURFACE_OPEN_DECK,
  HD2D_SURFACE_TERRAIN,
  HD2D_SURFACE_WATER,
} from './presenter.js';
import { createAutomationApi } from './automation-api.mjs';

const HEIGHT = 160;
const REG = 0x04000000;
const BUTTON_IDS = new Set(['a', 'b', 'select', 'start', 'right', 'left', 'up', 'down', 'r', 'l']);
const REG_OFFSET_WIN0H = 0x40;
const REG_OFFSET_WIN0V = 0x44;
const REG_OFFSET_WININ = 0x48;
const REG_OFFSET_WINOUT = 0x4a;
const REG_OFFSET_DMA0 = 0xb0;
const DMA_DEST_FIXED = 0x0040;
const DMA_DEST_RELOAD = 0x0060;
const DMA_REPEAT = 0x0200;
const DMA_START_HBLANK = 0x2000;
const DMA_ENABLE = 0x8000;
const RUNNING_SHOES_FLAG = 0x8c0;
const BATTLE_TRANSITION_COUNT = 42;

export function createShellAutomation(ctx) {
  function setAutomationButton(name, isPressed) {
    if (!BUTTON_IDS.has(name)) throw new Error(`unknown button: ${name}`);
    const { pendingPresses, pressed, writeKeys } = ctx();
    pendingPresses.delete(name);
    if (isPressed) pressed.add(name);
    else pressed.delete(name);
    document.querySelectorAll(`[data-key='${name}']`).forEach((el) => el.classList.toggle('pressed', isPressed));
    writeKeys();
  }

  function runToFrame(targetFrame) {
    const { currentFrame, runFrames, render } = ctx();
    if (!Number.isInteger(targetFrame) || targetFrame < currentFrame) {
      throw new Error(`cannot run from frame ${currentFrame} to ${targetFrame}`);
    }
    runFrames(targetFrame - currentFrame);
    render();
    return ctx().currentFrame;
  }

  function readU32(ptr) {
    const { u16 } = ctx();
    return (u16[ptr >> 1] | (u16[(ptr + 2) >> 1] << 16)) >>> 0;
  }

  function hblankDmaWin0HProbe() {
    const { instance, u16, writeS32 } = ctx();
    const src = 0x0203ff00;
    const dma = REG + REG_OFFSET_DMA0;
    const callDmaStop0 = () => {
      if (typeof instance.exports.WasmDmaStop0 !== 'function') throw new Error('WasmDmaStop0 export unavailable');
      instance.exports.WasmDmaStop0();
    };
    const probeMode = (destMode) => {
      writeS32(dma, src);
      writeS32(dma + 4, REG + REG_OFFSET_WIN0H);
      writeS32(dma + 8, 1 | ((DMA_ENABLE | DMA_START_HBLANK | DMA_REPEAT | destMode) << 16));

      instance.exports.WasmRefreshHblankDmaGpuRegs();
      const activeLine0 = instance.exports.WasmWindowMask(5, 0);
      const activeLine1 = instance.exports.WasmWindowMask(5, 1);
      const activeLine2 = instance.exports.WasmWindowMask(5, 2);
      const activeCached = Boolean(instance.exports.WasmHblankDmaGpuRegActive(REG_OFFSET_WIN0H));

      callDmaStop0();
      const stoppedControl = u16[(dma + 10) >> 1];
      instance.exports.WasmRefreshHblankDmaGpuRegs();
      const stoppedLine0 = instance.exports.WasmWindowMask(5, 0);
      const stoppedLine1 = instance.exports.WasmWindowMask(5, 1);
      const stoppedLine2 = instance.exports.WasmWindowMask(5, 2);

      return {
        activeLine0,
        activeLine1,
        activeLine2,
        activeCached,
        stoppedControl,
        stoppedLine0,
        stoppedLine1,
        stoppedLine2,
        stoppedCached: Boolean(instance.exports.WasmHblankDmaGpuRegActive(REG_OFFSET_WIN0H)),
      };
    };
    const saved = {
      dispcnt: u16[REG >> 1],
      win0h: u16[(REG + REG_OFFSET_WIN0H) >> 1],
      win0v: u16[(REG + REG_OFFSET_WIN0V) >> 1],
      winin: u16[(REG + REG_OFFSET_WININ) >> 1],
      winout: u16[(REG + REG_OFFSET_WINOUT) >> 1],
      src0: u16[src >> 1],
      src1: u16[(src + 2) >> 1],
      dmaSrc: readU32(dma),
      dmaDest: readU32(dma + 4),
      dmaControl: readU32(dma + 8),
    };
    let result;

    try {
      u16[REG >> 1] = 0x2000;
      u16[(REG + REG_OFFSET_WIN0H) >> 1] = (20 << 8) | 30;
      u16[(REG + REG_OFFSET_WIN0V) >> 1] = HEIGHT;
      u16[(REG + REG_OFFSET_WININ) >> 1] = 0x3f;
      u16[(REG + REG_OFFSET_WINOUT) >> 1] = 0;
      u16[src >> 1] = 10;
      u16[(src + 2) >> 1] = (20 << 8) | 30;

      result = {
        fixed: probeMode(DMA_DEST_FIXED),
        reload: probeMode(DMA_DEST_RELOAD),
      };
    } finally {
      u16[REG >> 1] = saved.dispcnt;
      u16[(REG + REG_OFFSET_WIN0H) >> 1] = saved.win0h;
      u16[(REG + REG_OFFSET_WIN0V) >> 1] = saved.win0v;
      u16[(REG + REG_OFFSET_WININ) >> 1] = saved.winin;
      u16[(REG + REG_OFFSET_WINOUT) >> 1] = saved.winout;
      u16[src >> 1] = saved.src0;
      u16[(src + 2) >> 1] = saved.src1;
      writeS32(dma, saved.dmaSrc);
      writeS32(dma + 4, saved.dmaDest);
      writeS32(dma + 8, saved.dmaControl);
      instance.exports.WasmRefreshHblankDmaGpuRegs();
    }

    return result;
  }

  function automationState() {
    const {
      instance, u8, u16, readS16, currentFrame, presenter, presenterRecreationCount,
      presenterRecoveryPromise, runtimeStopped, visualMode, activeVisualMode,
      shadingStrength, perspectiveStrength, zoomStrength, opticsStrength,
      renderedShadingStrength, renderedOpticsStrength, visualModeTransition,
      lastSceneKind, lastFlatRemoteDraws, renderScale, canvas, runAdapter,
      saveStore, presence,
    } = ctx();
    const saveBlock1 = readU32(instance.exports.gSaveBlock1Ptr.value);
    const saveBlock2 = readU32(instance.exports.gSaveBlock2Ptr.value);
    const playerAvatar = instance.exports.gPlayerAvatar.value;
    const objectEventId = u8[playerAvatar + 5];
    const objectEvent = instance.exports.gObjectEvents.value + objectEventId * 0x24;
    return {
      frame: currentFrame,
      presenter: presenter?.kind ?? null,
      presenterRecreations: presenterRecreationCount,
      presenterRecovering: Boolean(presenterRecoveryPromise),
      runtimeStopped,
      visualMode,
      activeVisualMode,
      shadingStrength,
      perspectiveStrength,
      zoomStrength,
      opticsStrength,
      renderedShadingStrength,
      renderedPerspectiveStrength: activeVisualMode === 'hd2d' ? perspectiveStrength : 0,
      renderedZoomStrength: activeVisualMode === 'hd2d' ? zoomStrength : 0,
      renderedOpticsStrength,
      visualModeTransition: visualModeTransition ? 'hd2d' : null,
      sceneKind: lastSceneKind,
      remoteDrawActors: presenter?.lastRemoteActorCount ?? 0,
      flatRemoteDraws: lastFlatRemoteDraws,
      remoteDrawVertices: presenter?.lastRemoteVertexCount ?? 0,
      blendControl: u16[(REG + 0x50) >> 1],
      renderScale,
      outputWidth: canvas.width,
      outputHeight: canvas.height,
      trainerId: runAdapter?.trainerIdFromMemory?.(u16, saveBlock2) ?? 0,
      saveStorageKey: saveStore?.key ?? '',
      runningShoes: Boolean(instance.exports.FlagGet(RUNNING_SHOES_FLAG)),
      avatarFlags: u8[instance.exports.gPlayerAvatar.value],
      avatarTransitionFlags: u8[instance.exports.gPlayerAvatar.value + 1],
      avatarRunningState: u8[instance.exports.gPlayerAvatar.value + 2],
      avatarPreventStep: u8[instance.exports.gPlayerAvatar.value + 6],
      x: readS16(saveBlock1),
      y: readS16(saveBlock1 + 2),
      mapGroup: u8[saveBlock1 + 4],
      mapNum: u8[saveBlock1 + 5],
      layoutId: presence.getSnapshot().world?.layoutId ?? null,
      contentVersion: presence.getSnapshot().contentVersion ?? null,
      elevation: u8[objectEvent + 0x0b] & 0x0f,
      objectX: readS16(objectEvent + 0x10),
      objectY: readS16(objectEvent + 0x12),
      objectEventId,
      littlerootTownState: instance.exports.VarGet(0x4050),
      birchLabState: instance.exports.VarGet(0x4084),
      littlerootRivalState: instance.exports.VarGet(0x408d),
      littlerootIntroState: instance.exports.VarGet(0x4092),
      oldaleRivalState: instance.exports.VarGet(0x40c7),
      starterMon: instance.exports.VarGet(0x4023),
    };
  }

  async function benchmarkPresentation(frameCount = 120) {
    if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 600) {
      throw new Error('benchmark frame count must be between 1 and 600');
    }
    const { presenter, render, renderScale, canvas } = ctx();
    await presenter.ready();
    const start = performance.now();
    for (let i = 0; i < frameCount; i++) render();
    await presenter.ready();
    const elapsedMs = performance.now() - start;
    return { frameCount, elapsedMs, fps: frameCount * 1000 / elapsedMs, renderScale, width: canvas.width, height: canvas.height };
  }

  function automationObjectEvents() {
    const { instance, u8, readS16 } = ctx();
    const base = instance.exports.gObjectEvents.value;
    const events = [];
    for (let id = 0; id < 16; id++) {
      const offset = base + id * 0x24;
      if (!(u8[offset] & 1)) continue;
      events.push({
        id,
        spriteId: u8[offset + 4],
        graphicsId: u8[offset + 5],
        localId: u8[offset + 8],
        mapNum: u8[offset + 9],
        mapGroup: u8[offset + 10],
        x: readS16(offset + 0x10),
        y: readS16(offset + 0x12),
        player: (u8[offset + 2] & 1) !== 0,
      });
    }
    return events;
  }

  function automationObjectDescriptors() {
    const { instance, memory } = ctx();
    const count = instance.exports.WasmDisplayObjectSourceCount();
    const ptr = instance.exports.WasmDisplayObjectDescriptorBuffer();
    const words = new Int32Array(memory.buffer, ptr, count * 16);
    return Array.from({ length: count }, (_, layer) => {
      const o = layer * 16;
      return {
        layer, oamId: words[o], x: words[o + 1], y: words[o + 2],
        anchorX: words[o + 3], anchorY: words[o + 4],
        sourceW: words[o + 5], sourceH: words[o + 6],
        drawW: words[o + 7], drawH: words[o + 8], priority: words[o + 9],
        spriteId: words[o + 10], affine: words[o + 11],
        pa: words[o + 12], pb: words[o + 13], pc: words[o + 14], pd: words[o + 15],
      };
    });
  }

  function automationWeather(weather) {
    if (!Number.isInteger(weather) || weather < 0 || weather > 15) {
      throw new Error(`invalid weather ${weather}`);
    }
    return ctx().instance.exports.WasmSetAutomationWeather(weather) !== 0;
  }

  function automationAvatar(mode) {
    const { instance } = ctx();
    const flags = { 'on-foot': 1, 'mach-bike': 2, 'acro-bike': 4, surfing: 8, underwater: 16 }[mode];
    if (!flags) throw new Error(`unknown avatar mode ${mode}`);
    if (mode === 'mach-bike' || mode === 'acro-bike') {
      instance.exports.SetPlayerAvatarStateMask(1);
      instance.exports.GetOnOffBike(flags);
      return;
    }
    instance.exports.SetPlayerAvatarStateMask(flags);
    instance.exports.SetPlayerAvatarTransitionFlags(flags);
  }

  function automationWarp(mapGroup, mapNum, x, y) {
    for (const value of [mapGroup, mapNum, x, y]) {
      if (!Number.isInteger(value)) throw new Error('warp arguments must be integers');
    }
    const { instance } = ctx();
    instance.exports.SetWarpDestination(mapGroup, mapNum, -1, x, y);
    instance.exports.DoWarp();
    instance.exports.ResetInitialPlayerAvatarState();
  }

  function automationStartWildBattle({ species = 263, level = 3 } = {}) {
    const exports = ctx().instance.exports;
    if (typeof exports.CreateScriptedWildMon !== 'function'
      || typeof exports.BattleSetup_StartScriptedWildBattle !== 'function') {
      throw new Error('wild battle automation is unavailable in this build');
    }
    if ((exports.CalculatePlayerPartyCount?.() ?? 0) === 0) {
      const party = exports.gPlayerParty?.value ?? exports.gPlayerParty;
      if (!Number.isInteger(party)) throw new Error('player party is unavailable');
      exports.CreateMon(party, 263, 5, 0, 0, 0, 0, 0);
      exports.CalculatePlayerPartyCount();
    }
    exports.CreateScriptedWildMon(species, level, 0);
    exports.BattleSetup_StartScriptedWildBattle();
  }

  function automationBattleTransition(transition) {
    if (!Number.isInteger(transition) || transition < 0 || transition >= BATTLE_TRANSITION_COUNT) {
      throw new Error('invalid battle transition');
    }
    ctx().instance.exports.BattleTransition_StartOnField(transition);
  }

  function automationPresenceCutscene(active) {
    const exports = ctx().instance.exports;
    if (typeof exports.SetPlayerInvisibility !== 'function'
      || typeof exports.LockPlayerFieldControls !== 'function'
      || typeof exports.UnlockPlayerFieldControls !== 'function') {
      throw new Error('cutscene automation is unavailable in this build');
    }
    exports.SetPlayerInvisibility(Boolean(active));
    if (active) exports.LockPlayerFieldControls();
    else exports.UnlockPlayerFieldControls();
  }

  function automationSaveGame() {
    return ctx().saveCurrentGameNow();
  }

  function automationQuickStart(species, rivalStarterIndex = 0) {
    if (!Number.isInteger(species) || species < 1 || species > 386) throw new Error('invalid quick-start starter species');
    if (!Number.isInteger(rivalStarterIndex) || rivalStarterIndex < 0 || rivalStarterIndex > 2) throw new Error('invalid rival starter index');
    const { instance, runFrames, saveFlashIfChanged } = ctx();
    if (typeof instance.exports.WasmRunQuickStart !== 'function'
        || typeof instance.exports.WasmRunQuickStartSave !== 'function') {
      throw new Error('Emerald quick-start exports are unavailable');
    }
    if (!instance.exports.WasmRunQuickStart(species, rivalStarterIndex)) throw new Error('Emerald rejected quick-start data');
    runFrames(180);
    const saved = instance.exports.WasmRunQuickStartSave();
    if (!saved) throw new Error('Emerald quick-start save failed');
    saveFlashIfChanged(true);
    return automationState();
  }

  function automationRunParty() {
    const { instance } = ctx();
    const count = instance.exports.WasmRunPartyCount();
    return Array.from({ length: count }, (_, index) => ({
      species: instance.exports.WasmRunPartySpecies(index),
      level: instance.exports.WasmRunPartyLevel(index),
      hp: instance.exports.WasmRunPartyHp(index),
    }));
  }

  function automationCanBoxRunPartyMon(index) {
    if (!Number.isInteger(index) || index < 0 || index >= 6) throw new Error('invalid party slot');
    return ctx().instance.exports.WasmRunDebugCanBoxPartyMon(index) === 1;
  }

  function automationTryBoxRunPartyMon(index) {
    if (!Number.isInteger(index) || index < 0 || index >= 6) throw new Error('invalid party slot');
    return ctx().instance.exports.WasmRunDebugTryBoxPartyMon(index) === 1;
  }

  function automationRunGymCaps() {
    const { instance } = ctx();
    return Array.from({ length: 8 }, (_, gymIndex) => ({
      gymIndex,
      aceLevel: instance.exports.WasmRunGymAceLevel(gymIndex),
    }));
  }

  function automationRunSetBadgeCount(count) {
    if (!Number.isInteger(count) || count < 0 || count > 8) throw new Error('invalid Gym badge count');
    return ctx().instance.exports.WasmRunDebugSetBadgeCount(count);
  }

  function automationRunSpeciesProbe(kind, originalSpecies, contextA, contextB) {
    if (![kind, originalSpecies, contextA, contextB].every(Number.isInteger)) throw new Error('invalid randomizer probe arguments');
    const { instance } = ctx();
    if (typeof instance.exports.WasmRunDebugRandomSpecies !== 'function') throw new Error('run randomizer probe is unavailable');
    return instance.exports.WasmRunDebugRandomSpecies(kind, originalSpecies, contextA, contextB);
  }

  function automationCreateWildParty(originalSpecies, level, slotKey = 0) {
    const { instance } = ctx();
    if (typeof instance.exports.WasmRunTestCreateWildMon !== 'function') throw new Error('wild run probe is unavailable');
    if (!instance.exports.WasmRunTestCreateWildMon(originalSpecies, level, slotKey)) throw new Error('wild run probe rejected its arguments');
    return Array.from({ length: instance.exports.WasmRunEnemyPartyCount() }, (_, index) => ({
      species: instance.exports.WasmRunEnemyPartySpecies(index),
      level: instance.exports.WasmRunEnemyPartyLevel(index),
    }));
  }

  function automationCreateTrainerParty(trainerId) {
    const { instance } = ctx();
    if (typeof instance.exports.WasmRunTestCreateTrainerParty !== 'function') throw new Error('trainer run probe is unavailable');
    if (!instance.exports.WasmRunTestCreateTrainerParty(trainerId)) throw new Error(`trainer ${trainerId} has no party`);
    return Array.from({ length: instance.exports.WasmRunEnemyPartyCount() }, (_, index) => ({
      species: instance.exports.WasmRunEnemyPartySpecies(index),
      level: instance.exports.WasmRunEnemyPartyLevel(index),
    }));
  }

  function automationRunSaveInfo() {
    const { saveStore, saveByteLength } = ctx();
    const loaded = saveStore?.load();
    return {
      key: saveStore?.key ?? null,
      hasRecord: Boolean(saveStore?.hasRecord()),
      valid: Boolean(loaded?.bytes?.length === saveByteLength()),
      lastError: saveStore?.lastError ?? null,
    };
  }

  function automationSeedMainSaveFromSoulrun() {
    const { saveStore, saveFlashIfChanged, hashBytes } = ctx();
    if (!saveStore?.key?.endsWith('/soulrun')) throw new Error('soulrun save slot is not active');
    let soulrunRaw = localStorage.getItem(saveStore.key);
    if (!soulrunRaw) {
      if (!saveFlashIfChanged(true)) throw new Error('could not save the pre-run soulrun fixture');
      soulrunRaw = localStorage.getItem(saveStore.key);
    }
    if (!soulrunRaw) throw new Error('soulrun save record is missing');
    const mainKey = saveStore.key.replace(/\/soulrun$/, '/main');
    if (localStorage.getItem(mainKey)) return { seeded: false, key: mainKey, reason: 'main_save_already_exists' };
    const record = JSON.parse(soulrunRaw);
    record.slot = 'main';
    localStorage.setItem(mainKey, JSON.stringify(record));
    return { seeded: true, key: mainKey, hash: hashBytes(new TextEncoder().encode(localStorage.getItem(mainKey))) };
  }

  function automationMainSaveInfo() {
    const { saveStore, hashBytes } = ctx();
    if (!saveStore?.key) return null;
    const mainKey = saveStore.key.replace(/\/soulrun$/, '/main');
    const raw = localStorage.getItem(mainKey);
    return { key: mainKey, exists: raw !== null, hash: raw === null ? null : hashBytes(new TextEncoder().encode(raw)) };
  }

  function automationDebugFaintRunPartySlot(index) {
    if (!Number.isInteger(index) || index < 0 || index >= 6) throw new Error('invalid party slot');
    const { instance } = ctx();
    if (typeof instance.exports.WasmRunDebugFaintPartySlot !== 'function'
        || typeof instance.exports.WasmRunProcessSafePoint !== 'function') {
      throw new Error('run safe-point automation is unavailable');
    }
    if (!instance.exports.WasmRunDebugFaintPartySlot(index)) throw new Error('party slot is empty');
    instance.exports.WasmRunProcessSafePoint(0);
    return automationRunParty();
  }

  function automationProcessRunSafePoint() {
    const { instance } = ctx();
    if (typeof instance.exports.WasmRunProcessSafePoint !== 'function') throw new Error('run safe point is unavailable');
    instance.exports.WasmRunProcessSafePoint(0);
    return automationRunParty();
  }

  function automationAddRunPartyMon(species, level, personality) {
    const { instance } = ctx();
    if (typeof instance.exports.WasmRunDebugAddPartyMon !== 'function') throw new Error('party test helper is unavailable');
    if (!instance.exports.WasmRunDebugAddPartyMon(species, level, personality)) throw new Error('could not add test party member');
    return automationRunParty();
  }

  function automationQueueRunRelease(index) {
    const { instance, presence, runRuntime } = ctx();
    if (!Number.isInteger(index) || index < 0 || index >= instance.exports.WasmRunPartyCount()) throw new Error('invalid release slot');
    const credentials = presence.getRunCredentials?.();
    if (!credentials || !runRuntime) throw new Error('run identity is unavailable');
    const low = instance.exports.WasmRunPartyPidLo(index);
    const high = instance.exports.WasmRunPartyPidHi(index);
    const pid = ((((high & 0xffff) << 16) | (low & 0xffff)) >>> 0);
    runRuntime.queueRelease(credentials.playerId, pid, { test: true });
    return pid;
  }

  function automationQueueRunReleasePid(pid) {
    if (!Number.isInteger(pid) || pid < 0) throw new Error('invalid personality ID');
    const { presence, runRuntime } = ctx();
    const credentials = presence.getRunCredentials?.();
    if (!credentials || !runRuntime) throw new Error('run identity is unavailable');
    runRuntime.queueRelease(credentials.playerId, pid >>> 0, { test: true });
    return true;
  }

  function automationDebugBoxMon(species, level, pid) {
    if (![species, level, pid].every(Number.isInteger)) throw new Error('invalid boxed Pokémon fixture');
    const { instance } = ctx();
    const added = instance.exports.WasmRunDebugAddBoxMon(species, level, pid & 0xffff, (pid >>> 16) & 0xffff);
    if (!added) throw new Error('could not insert boxed Pokémon fixture');
    return instance.exports.WasmRunDebugBoxHasPid(pid & 0xffff, (pid >>> 16) & 0xffff) !== 0;
  }

  function automationRunBoxHasPid(pid) {
    return ctx().instance.exports.WasmRunDebugBoxHasPid(pid & 0xffff, (pid >>> 16) & 0xffff) !== 0;
  }

  function automationUseRunRareCandy(index) {
    const { instance } = ctx();
    const item = instance.exports.WasmRunRareCandyItemId();
    const before = automationRunParty()[index]?.level;
    const bagBefore = instance.exports.WasmRunRareCandyCount();
    const used = instance.exports.WasmRunDebugUseItemEffect(index, item) !== 0;
    const after = automationRunParty()[index]?.level;
    return { used, before, after, bagBefore, bagAfter: instance.exports.WasmRunRareCandyCount() };
  }

  function automationConsumeAndRefillRunCandy() {
    const { instance } = ctx();
    const before = instance.exports.WasmRunRareCandyCount();
    const refilled = instance.exports.WasmRunDebugConsumeAndRefillRareCandy();
    return { refilled: refilled !== 0, before, after: instance.exports.WasmRunRareCandyCount() };
  }

  function automationApplyRunExpGain(index, expGain) {
    if (!Number.isInteger(index) || !Number.isInteger(expGain) || expGain < 0) throw new Error('invalid EXP probe arguments');
    const level = ctx().instance.exports.WasmRunDebugApplyExpGain(index, expGain);
    return { level, party: automationRunParty()[index] };
  }

  function automationRunCaptureProbe(sectionId, species, pid = 0) {
    if (![sectionId, species, pid].every(Number.isInteger)) throw new Error('invalid capture probe arguments');
    const { instance } = ctx();
    const before = {
      pokeballs: instance.exports.WasmRunPokeballCount(),
      caught: instance.exports.WasmRunIsCaught(species),
    };
    const captureBlocked = instance.exports.WasmRunDebugTryBlockedBallThrow(species, pid & 0xffff, (pid >>> 16) & 0xffff);
    const after = {
      pokeballs: instance.exports.WasmRunPokeballCount(),
      caught: instance.exports.WasmRunIsCaught(species),
    };
    return { captureBlocked, before, after };
  }

  function automationAcceptRunWildCapture() {
    const result = ctx().instance.exports.WasmRunDebugAcceptWildCapture();
    return { result, party: automationRunParty() };
  }

  function automationSaveInfo() {
    const { saveStore, bytesToBase64 } = ctx();
    const loaded = saveStore?.load();
    return {
      key: saveStore?.key ?? null,
      hasRecord: Boolean(saveStore?.hasRecord()),
      bytes: loaded?.bytes ? bytesToBase64(loaded.bytes) : null,
      lastError: saveStore?.lastError ?? null,
    };
  }

  async function automationLoadSave(encoded) {
    const { base64ToBytes, saveStore, restartWithSave } = ctx();
    const bytes = base64ToBytes(encoded);
    const imported = saveStore?.importBytes(bytes);
    if (!imported) throw new Error('automation save is not valid for the selected game');
    await restartWithSave(imported);
  }

  async function automationSimulateDeviceLoss() {
    const { presenter, presenterRecoveryPromise, render } = ctx();
    if (!presenter || presenterRecoveryPromise) throw new Error('WebGPU presenter is not ready for a simulated loss');
    await presenter.simulateDeviceLoss();
    await Promise.resolve();
    if (ctx().presenterRecoveryPromise) await ctx().presenterRecoveryPromise;
    if (ctx().runtimeStopped) throw new Error(ctx().statusEl.textContent);
    render();
    return automationState();
  }

  function automationMapGrid(radius = 14) {
    if (!Number.isInteger(radius) || radius < 1 || radius > 32) throw new Error('invalid map-grid radius');
    const { instance } = ctx();
    const state = automationState();
    const cells = [];
    for (let y = state.y - radius; y <= state.y + radius; y++) {
      const row = [];
      for (let x = state.x - radius; x <= state.x + radius; x++) {
        row.push({
          x,
          y,
          metatileId: instance.exports.MapGridGetMetatileIdAt(x + 7, y + 7),
          collision: instance.exports.MapGridGetCollisionAt(x + 7, y + 7),
          elevation: instance.exports.MapGridGetElevationAt(x + 7, y + 7),
          behavior: instance.exports.MapGridGetMetatileBehaviorAt(x + 7, y + 7),
        });
      }
      cells.push(row);
    }
    return { state, radius, cells };
  }

  function automationHd2dCourses(radius = 12) {
    if (!Number.isInteger(radius) || radius < 1 || radius > 32) throw new Error('invalid HD-2D course radius');
    const { instance, memory } = ctx();
    const worldWidth = instance.exports.WasmWorldWidth();
    const worldHeight = instance.exports.WasmWorldHeight();
    const heights = new Int16Array(memory.buffer, instance.exports.WasmWorldHeightBuffer(), instance.exports.WasmWorldHeightBufferSize() / 2);
    const grounds = new Int16Array(memory.buffer, instance.exports.WasmWorldGroundHeightBuffer(), instance.exports.WasmWorldGroundHeightBufferSize() / 2);
    const geometry = new Uint16Array(memory.buffer, instance.exports.WasmWorldGeometryBuffer(), instance.exports.WasmWorldGeometryBufferSize() / 2);
    const receivers = new Uint16Array(memory.buffer, instance.exports.WasmWorldReceiverBuffer(), instance.exports.WasmWorldReceiverBufferSize() / 2);
    const facades = new Uint32Array(memory.buffer, instance.exports.WasmWorldFacadeBuffer(), instance.exports.WasmWorldFacadeBufferSize() / 4);
    const cx = Math.floor(worldWidth / 2);
    const cy = Math.floor(worldHeight / 2);
    const gridOffsetX = instance.exports.WasmWorldGridOffsetX();
    const gridOffsetY = instance.exports.WasmWorldGridOffsetY();
    const terrainOriginX = gridOffsetX - 8;
    const terrainOriginY = gridOffsetY - 8;
    const anchorX = terrainOriginX + Math.floor((cx - terrainOriginX) / 8) * 8 + 4;
    const anchorY = terrainOriginY + Math.floor((cy - terrainOriginY) / 8) * 8 + 4;
    const worldOriginX = instance.exports.WasmWorldPixelOriginX();
    const worldOriginY = instance.exports.WasmWorldPixelOriginY();
    const rows = [];
    for (let dy = -radius; dy <= radius; dy++) {
      const row = [];
      for (let dx = -radius; dx <= radius; dx++) {
        const px = Math.min(worldWidth - 1, Math.max(0, anchorX + dx * 8));
        const py = Math.min(worldHeight - 1, Math.max(0, anchorY + dy * 8));
        const i = py * worldWidth + px;
        const mapX = Math.floor((worldOriginX + px) / 16);
        const mapY = Math.floor((worldOriginY + py) / 16);
        const metatileId = instance.exports.MapGridGetMetatileIdAt(mapX, mapY);
        row.push({
          mapX,
          mapY,
          metatileId,
          collision: instance.exports.MapGridGetCollisionAt(mapX, mapY),
          h: heights[i],
          g: grounds[i],
          geo: geometry[i],
          receiver: receivers[i],
          facade: facades[i],
          terrace: instance.exports.WasmHdTerraceCellAt?.(mapX, mapY) ?? 0,
        });
      }
      rows.push(row);
    }
    return {
      worldWidth, worldHeight, cx, cy, gridOffsetX, gridOffsetY,
      anchorX, anchorY, worldOriginX, worldOriginY, radius, rows,
    };
  }

  function imageDataUrl(pixels, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return canvas.toDataURL('image/png');
  }

  function automationWorldAtlas() {
    const { instance, memory } = ctx();
    const worldWidth = instance.exports.WasmWorldWidth();
    const worldHeight = instance.exports.WasmWorldHeight();
    const pixels = new Uint8ClampedArray(memory.buffer, instance.exports.WasmWorldBuffer(), worldWidth * worldHeight * 4);
    return { worldWidth, worldHeight, dataUrl: imageDataUrl(pixels.slice(), worldWidth, worldHeight) };
  }

  function automationHeightMap() {
    const { instance, memory } = ctx();
    const worldWidth = instance.exports.WasmWorldWidth();
    const worldHeight = instance.exports.WasmWorldHeight();
    const heights = new Int16Array(memory.buffer, instance.exports.WasmWorldHeightBuffer(), worldWidth * worldHeight);
    const geometry = new Uint16Array(memory.buffer, instance.exports.WasmWorldGeometryBuffer(), worldWidth * worldHeight);
    const pixels = new Uint8ClampedArray(worldWidth * worldHeight * 4);
    for (let i = 0; i < worldWidth * worldHeight; i++) {
      const value = Math.max(0, Math.min(255, Math.round((heights[i] + 8) * 255 / 40)));
      const surface = geometry[i] & HD2D_SURFACE_MASK;
      let red = value;
      let green = value;
      let blue = value;
      if (surface === HD2D_SURFACE_WATER) { red = value * 0.3; green = value * 0.5; blue = 255; }
      else if (surface === HD2D_SURFACE_DECK) { red = 255; green = value * 0.4; blue = value * 0.4; }
      else if (surface === HD2D_SURFACE_TERRAIN) { red = value * 0.3; green = 255; blue = value * 0.3; }
      else if (surface === HD2D_SURFACE_OBSTACLE) { red = 255; green = 255; blue = value * 0.3; }
      else if (surface === HD2D_SURFACE_OPEN_DECK) { red = value * 0.8; green = 255; blue = value * 0.6; }
      pixels[i * 4] = red;
      pixels[i * 4 + 1] = green;
      pixels[i * 4 + 2] = blue;
      pixels[i * 4 + 3] = 255;
    }
    return { worldWidth, worldHeight, dataUrl: imageDataUrl(pixels, worldWidth, worldHeight) };
  }

  function automationEncounters(enabled) {
    ctx().instance.exports.DisableWildEncounters(enabled ? 0 : 1);
  }

  function automationRunningShoes(enabled) {
    const { instance } = ctx();
    if (enabled) instance.exports.FlagSet(RUNNING_SHOES_FLAG);
    else instance.exports.FlagClear(RUNNING_SHOES_FLAG);
  }

  function presenceAutomationApi() {
    const { presence } = ctx();
    return {
      lobbyReplica: () => {
        const { lobbyRecordSnapshot } = ctx();
        return lobbyRecordSnapshot && {
          revision: lobbyRecordSnapshot.revision,
          authority: lobbyRecordSnapshot.authorityRevision,
          saved: Object.values(lobbyRecordSnapshot.slots).filter((slot) => slot.saveBytes).length,
        };
      },
      state: () => presence.getSnapshot(),
      diagnostics: () => presence.getDiagnostics(),
      frameDebug: () => presence.getFrameDebug(),
      frameOptions: (sceneKind = 1) => presence.frameOptions({ enhanced: true, sceneKind }),
      createRoom: () => presence.createRoom(),
      joinRoom: (room) => presence.joinRoom(room),
      leave: () => presence.leave(),
      setName: (name) => presence.setName(name),
      tick: () => presence.tick(),
      setAway: (away) => presence.setAway(away),
      simulateDrop: () => presence.simulateDrop(),
      get name() { return presence.name; },
      get url() { return presence.url; },
      get avatarAtlas() { return presence.avatarAtlas; },
    };
  }

  function automationApi() {
    const { automationReady, setVisualSettings } = ctx();
    return createAutomationApi({
      ready: automationReady,
      loadSave: automationLoadSave,
      setEncounters: automationEncounters,
      setRunningShoes: automationRunningShoes,
      mapGrid: automationMapGrid,
      hd2dCourses: automationHd2dCourses,
      worldAtlas: automationWorldAtlas,
      heightMap: automationHeightMap,
      setButton: setAutomationButton,
      setAvatar: automationAvatar,
      setWeather: automationWeather,
      setVisualMode: (mode, animate = true) => {
        const s = ctx();
        setVisualSettings({
          mode,
          shading: s.shadingStrength,
          perspective: s.perspectiveStrength,
          zoom: s.zoomStrength,
          optics: s.opticsStrength,
        }, false, animate);
      },
      startNewGame: () => ctx().instance.exports.WasmStartNewGameForAutomation(),
      quickStart: automationQuickStart,
      runParty: automationRunParty,
      canBoxRunPartyMon: automationCanBoxRunPartyMon,
      tryBoxRunPartyMon: automationTryBoxRunPartyMon,
      runGymCaps: automationRunGymCaps,
      setRunBadgeCount: automationRunSetBadgeCount,
      runSpeciesProbe: automationRunSpeciesProbe,
      createWildParty: automationCreateWildParty,
      createTrainerParty: automationCreateTrainerParty,
      runSaveInfo: automationRunSaveInfo,
      seedMainSaveFromSoulrun: automationSeedMainSaveFromSoulrun,
      mainSaveInfo: automationMainSaveInfo,
      debugFaintRunPartySlot: automationDebugFaintRunPartySlot,
      addRunPartyMon: automationAddRunPartyMon,
      queueRunRelease: automationQueueRunRelease,
      queueRunReleasePid: automationQueueRunReleasePid,
      debugBoxMon: automationDebugBoxMon,
      runBoxHasPid: automationRunBoxHasPid,
      useRunRareCandy: automationUseRunRareCandy,
      consumeAndRefillRunCandy: automationConsumeAndRefillRunCandy,
      applyRunExpGain: automationApplyRunExpGain,
      runCaptureProbe: automationRunCaptureProbe,
      acceptRunWildCapture: automationAcceptRunWildCapture,
      processRunSafePoint: automationProcessRunSafePoint,
      warp: automationWarp,
      startBattleTransition: automationBattleTransition,
      presenceCutscene: automationPresenceCutscene,
      startWildBattle: automationStartWildBattle,
      saveGame: automationSaveGame,
      saveInfo: automationSaveInfo,
      runToFrame,
      screenshot: async () => {
        const { presenter, canvas } = ctx();
        await presenter.ready();
        return canvas.toDataURL('image/png');
      },
      benchmarkPresentation,
      objectDescriptors: automationObjectDescriptors,
      objectEvents: automationObjectEvents,
      hblankDmaWin0HProbe,
      simulateDeviceLoss: automationSimulateDeviceLoss,
      state: automationState,
      frame: () => ctx().currentFrame,
    });
  }

  return {
    presenceAutomationApi,
    automationApi,
  };
}
