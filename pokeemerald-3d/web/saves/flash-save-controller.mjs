// Flash save persistence, save-timestamp tracking, .sav / .ptnuzlocke import & export,
// and emulation speed controls extracted from app.js.

import { parseNuzlockeBundle, serializeNuzlockeBundle } from '../run/nuzlocke-bundle.mjs';

const SAVE_FLUSH_INTERVAL_MS = 1000;
const MIN_SPEED = 0.1;
const MAX_SPEED = 1000;

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function hashBytes(bytes) {
  let hash = 2166136261;
  const byteOffset = bytes.byteOffset ?? 0;
  const byteLength = bytes.byteLength ?? bytes.length ?? 0;
  if (bytes.buffer && (byteOffset & 3) === 0 && (byteLength & 3) === 0) {
    const words = new Uint32Array(bytes.buffer, byteOffset, byteLength >>> 2);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      hash = Math.imul(hash ^ (w & 0xff), 16777619);
      hash = Math.imul(hash ^ ((w >>> 8) & 0xff), 16777619);
      hash = Math.imul(hash ^ ((w >>> 16) & 0xff), 16777619);
      hash = Math.imul(hash ^ (w >>> 24), 16777619);
    }
    return hash >>> 0;
  }
  for (let i = 0; i < byteLength; i++) {
    hash = Math.imul(hash ^ bytes[i], 16777619);
  }
  return hash >>> 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatSpeed(value) {
  if (value === Infinity) return 'unlimited';
  if (value < 1) return `${value.toFixed(1)}x`;
  if (value < 100) return `${value.toFixed(value < 10 ? 1 : 0)}x`;
  return `${Math.round(value)}x`;
}

export function createFlashSaveController({
  speedParam = null,
  elements = {},
  getMemoryReady = () => false,
  getRuntimeAdapter = () => null,
  getSaveCodec = () => null,
  getSaveStore = () => null,
  getPackManifest = () => null,
  getSelectedGameId = () => '',
  getSaveProfile = () => '',
  getRunSettings = () => null,
  getRunRuntime = () => null,
  soloNuzlockePlayerId = () => '',
  onQueueStandardSoloMirror = () => {},
  onRestartWithSave = async () => {},
  onResetFpsCounters = () => {},
} = {}) {
  const {
    statusEl,
    saveProfileDialog,
    saveLastGameTime,
    saveLastAutoTime,
    downloadSaveButton,
    menuDownloadSaveButton,
    uploadSaveLabel,
    uploadSaveInput,
    speedButtons = [],
    speedValue,
    speedSelect,
  } = elements;

  let lastSavedFlashHash = 0;
  let lastSaveFlushTime = performance.now();
  let lastGameSavedAt = null;
  let lastAutoSavedAt = null;
  let speed = 1;
  let lastFiniteSpeed = 1;

  function saveByteLength() {
    return getSaveCodec()?.bytes ?? getPackManifest()?.saves?.bytes ?? 0;
  }

  function flashBytes() {
    if (!getMemoryReady()) {
      throw new Error('The game is not initialized; save memory is unavailable. Resolve the game startup error and reload.');
    }
    const runtimeAdapter = getRuntimeAdapter();
    if (typeof runtimeAdapter?.saveView !== 'function') {
      throw new Error(`Game pack ${getSelectedGameId()} has no save-memory view adapter`);
    }
    return runtimeAdapter.saveView(saveByteLength());
  }

  function saveTimestampStorageKey() {
    const saveStore = getSaveStore();
    return saveStore?.key ? `pokeemerald.save-times.v1/${encodeURIComponent(saveStore.key)}` : null;
  }

  function loadSaveTimestamps(fallbackUpdatedAt = null) {
    let stored = null;
    try {
      const key = saveTimestampStorageKey();
      stored = key ? JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null') : null;
    } catch {
      stored = null;
    }
    lastGameSavedAt = Number.isFinite(stored?.lastGameSavedAt)
      ? stored.lastGameSavedAt
      : fallbackUpdatedAt;
    lastAutoSavedAt = Number.isFinite(stored?.lastAutoSavedAt)
      ? stored.lastAutoSavedAt
      : fallbackUpdatedAt;
  }

  function persistSaveTimestamps() {
    try {
      const key = saveTimestampStorageKey();
      if (!key) return;
      globalThis.localStorage?.setItem(key, JSON.stringify({ lastGameSavedAt, lastAutoSavedAt }));
    } catch (error) {
      console.warn('save timestamps could not be stored', error);
    }
  }

  function formatSaveTimestamp(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Not recorded';
    return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderSaveTimestamps() {
    if (saveLastGameTime) saveLastGameTime.textContent = formatSaveTimestamp(lastGameSavedAt);
    if (saveLastAutoTime) saveLastAutoTime.textContent = formatSaveTimestamp(lastAutoSavedAt);
  }

  function updateSaveActionLabels() {
    const isNuzlocke = getRunSettings()?.mode === 'nuzlocke';
    const downloadLabel = isNuzlocke ? 'Download Nuzlocke backup' : 'Download save file';
    const uploadLabel = isNuzlocke ? 'Load Nuzlocke backup' : 'Load save file';
    if (downloadSaveButton) downloadSaveButton.textContent = downloadLabel;
    if (menuDownloadSaveButton) menuDownloadSaveButton.textContent = downloadLabel;
    if (uploadSaveLabel) uploadSaveLabel.textContent = uploadLabel;
    if (uploadSaveInput) {
      uploadSaveInput.accept = isNuzlocke
        ? '.ptnuzlocke,application/json'
        : '.sav,.srm,application/octet-stream';
    }
  }

  function loadFlashSave(sourceBytes) {
    const flash = flashBytes();
    flash.fill(0xFF);
    const saveStore = getSaveStore();
    const saveCodec = getSaveCodec();
    const loaded = saveStore?.load() ?? null;
    loadSaveTimestamps(loaded?.updatedAt ?? null);

    if (sourceBytes?.length === saveByteLength()) {
      flash.set(saveCodec?.normalize?.(sourceBytes) ?? sourceBytes);
    } else if (loaded) {
      if (loaded?.bytes?.length === saveByteLength()) {
        flash.set(loaded.bytes);
      } else if (loaded?.legacyKey) {
        console.warn('Legacy save could not be migrated; keeping the game on volatile flash', {
          legacyKey: loaded.legacyKey,
        });
      }
    }

    lastSavedFlashHash = hashBytes(flash);
  }

  function saveFlashIfChanged(force = false, automatic = true) {
    const saveStore = getSaveStore();
    if (!getMemoryReady() || !saveStore) return false;
    const now = performance.now();
    if (!force && now - lastSaveFlushTime < SAVE_FLUSH_INTERVAL_MS) return true;
    lastSaveFlushTime = now;

    const flash = flashBytes();
    const hash = hashBytes(flash);
    const changed = hash !== lastSavedFlashHash;
    if (!force && !changed) return true;

    if (!saveStore.save(flash)) {
      if (saveStore.lastError && saveStore.lastError.code !== 'save_invalid') {
        console.warn('save write failed', saveStore.lastError);
      }
      return false;
    }
    lastSavedFlashHash = hash;
    const savedAt = Date.now();
    if (changed) lastGameSavedAt = savedAt;
    if (automatic) lastAutoSavedAt = savedAt;
    persistSaveTimestamps();
    if (saveProfileDialog?.open) renderSaveTimestamps();
    onQueueStandardSoloMirror(flash);
    return true;
  }

  function saveCurrentGameNow(automatic = false) {
    const runtimeAdapter = getRuntimeAdapter();
    if (typeof runtimeAdapter?.saveGame !== 'function') return 0;
    const result = runtimeAdapter.saveGame();
    if (result !== 1) return result;
    if (!saveFlashIfChanged(true, automatic)) return 0;
    lastGameSavedAt = Date.now();
    persistSaveTimestamps();
    renderSaveTimestamps();
    return result;
  }

  function downloadSave() {
    if (!getMemoryReady()) {
      statusEl.textContent = 'the game is still loading; try again in a moment';
      return;
    }
    const saveCodec = getSaveCodec();
    if (!saveCodec?.validate?.(flashBytes())?.ok) {
      statusEl.textContent = 'no saved game yet — save in-game first (START → SAVE), then download';
      return;
    }
    if (!saveFlashIfChanged(true)) {
      statusEl.textContent = 'the save could not be stored; retry before downloading';
      return;
    }
    const runSettings = getRunSettings();
    const packManifest = getPackManifest();
    const selectedGameId = getSelectedGameId();
    const saveProfile = getSaveProfile();
    let blob;
    let filename;
    if (runSettings?.mode === 'nuzlocke') {
      const runState = getRunRuntime()?.state();
      if (!runState || runState.mode !== 'nuzlocke') {
        statusEl.textContent = 'Nuzlocke run history is unavailable; refusing to export an untracked save';
        return;
      }
      try {
        const bundle = serializeNuzlockeBundle({
          gameId: selectedGameId,
          formatId: packManifest.saves.formatId,
          formatVersion: packManifest.saves.formatVersion,
          profile: saveProfile,
          playerId: soloNuzlockePlayerId(selectedGameId, saveProfile),
          saveBytes: flashBytes(),
          runState,
        });
        blob = new Blob([bundle], { type: 'application/json' });
        filename = `${selectedGameId}-${saveProfile || 'default'}.ptnuzlocke`;
      } catch (error) {
        statusEl.textContent = error instanceof Error ? error.message : String(error);
        return;
      }
    } else {
      blob = new Blob([new Uint8Array(flashBytes())], { type: 'application/octet-stream' });
      filename = packManifest?.saves?.exportName || 'pokeemerald.sav';
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function uploadSave(file) {
    if (!file) return;
    if (!getMemoryReady()) {
      statusEl.textContent = 'the game is still loading; try the upload again in a moment';
      return;
    }
    const runSettings = getRunSettings();
    const packManifest = getPackManifest();
    const selectedGameId = getSelectedGameId();
    const saveProfile = getSaveProfile();
    let bytes;
    let importedRunState = null;
    if (runSettings?.mode === 'nuzlocke') {
      try {
        const imported = parseNuzlockeBundle(await file.text(), {
          gameId: selectedGameId,
          formatId: packManifest.saves.formatId,
          formatVersion: packManifest.saves.formatVersion,
          profile: saveProfile,
          playerId: soloNuzlockePlayerId(selectedGameId, saveProfile),
          saveBytesLength: saveByteLength(),
        });
        bytes = imported.bytes;
        importedRunState = imported.runState;
      } catch (error) {
        statusEl.textContent = error instanceof Error ? error.message : String(error);
        return;
      }
    } else {
      bytes = new Uint8Array(await file.arrayBuffer());
    }
    const title = packManifest?.game?.title ?? 'this game';
    if (bytes.length !== saveByteLength()) {
      statusEl.textContent = `expected a ${saveByteLength()} byte ${title} save, got ${bytes.length} bytes`;
      return;
    }
    const imported = getSaveStore()?.importBytes(bytes);
    if (!imported) {
      statusEl.textContent = `save file contains no valid ${title} save slot; it may be empty or from a different game`;
      return;
    }

    if (importedRunState) {
      try {
        getRunRuntime().restoreLocalState({
          playerId: soloNuzlockePlayerId(selectedGameId, saveProfile),
          runState: importedRunState,
        });
      } catch (error) {
        statusEl.textContent = `save bytes imported but Nuzlocke history could not be restored: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
    }
    lastSavedFlashHash = hashBytes(imported);
    await onRestartWithSave(imported);
  }

  function setSpeed(value) {
    speed = value === Infinity ? Infinity : clamp(value, MIN_SPEED, MAX_SPEED);
    if (speed !== Infinity) lastFiniteSpeed = speed;
    if (speedValue) speedValue.textContent = formatSpeed(speed);
    if (speedSelect) {
      speedSelect.value = speed === Infinity ? 'unlimited' : String(speed);
    }
    speedButtons.forEach((button) => {
      button.classList.toggle('active',
        (button.dataset.speed === 'unlimited' && speed === Infinity) ||
        (button.dataset.speed !== 'unlimited' && Number(button.dataset.speed) === speed));
    });
  }

  function adjustSpeed(multiplier) {
    setSpeed((speed === Infinity ? lastFiniteSpeed : speed) * multiplier);
  }

  function toggleUnlimitedSpeed() {
    setSpeed(speed === Infinity ? lastFiniteSpeed : Infinity);
  }

  function initialSpeed() {
    if (speedParam === '0') return Infinity;
    const parsed = Number(speedParam);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  function bindSpeedAndSaveEvents() {
    speedButtons.forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.speed === 'unlimited') toggleUnlimitedSpeed();
        else if (button.dataset.speed === '1' || button.dataset.speed === '8') setSpeed(Number(button.dataset.speed));
        else adjustSpeed(Number(button.dataset.speed));
        onResetFpsCounters();
      });
    });

    speedSelect?.addEventListener('change', () => {
      setSpeed(speedSelect.value === 'unlimited' ? Infinity : Number(speedSelect.value));
      onResetFpsCounters();
    });

    downloadSaveButton?.addEventListener('click', downloadSave);
    menuDownloadSaveButton?.addEventListener('click', downloadSave);

    uploadSaveInput?.addEventListener('change', async () => {
      try {
        await uploadSave(uploadSaveInput.files[0]);
      } catch (error) {
        console.error(error);
        statusEl.textContent = error.stack || String(error);
      } finally {
        uploadSaveInput.value = '';
      }
    });
  }

  return {
    get speed() { return speed; },
    get lastSavedFlashHash() { return lastSavedFlashHash; },
    setLastSavedFlashHash(hash) { lastSavedFlashHash = hash >>> 0; },
    saveByteLength,
    flashBytes,
    loadSaveTimestamps,
    persistSaveTimestamps,
    renderSaveTimestamps,
    updateSaveActionLabels,
    loadFlashSave,
    saveFlashIfChanged,
    saveCurrentGameNow,
    downloadSave,
    uploadSave,
    setSpeed,
    adjustSpeed,
    toggleUnlimitedSpeed,
    initialSpeed,
    bindSpeedAndSaveEvents,
  };
}
