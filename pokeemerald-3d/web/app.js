import {
  createPresenter,
} from './presenter.js';
import { createPresenceRuntime } from './presence/runtime.mjs';
import { createLobby } from './presence/lobby.mjs';
import { createSaveProfileLock } from './save-profile-lock.mjs';
import { compositeFlatActors } from './presence/flat-compositor.mjs';
import { buildPeerOverlay } from './presence/peer-overlay-model.mjs';
import { createOverworldPeerDom } from './ui/overworld-peer-dom.mjs';
import { createGameplaySheetsController } from './ui/gameplay-sheets-controller.mjs';
import { createSettingsStore } from './settings/settings-store.mjs';
import { createVisualModeController } from './settings/visual-mode-controller.mjs';
import {
  base64ToBytes,
  bytesToBase64,
  createFlashSaveController,
  hashBytes,
} from './saves/flash-save-controller.mjs';
import { createShellAutomation } from './automation-probes.mjs';
import {
  actionFor,
  isGameButton,
  normalizeScheme,
  shouldIgnoreKeyEvent,
} from './settings/keymap.mjs';
import {
  saveProfileLabel,
  saveProfileUrl,
} from './save-profiles.mjs';
import { fetchVerifiedResource, loadPack } from './packs/loader.mjs';
import { createPackAdapter, createPackAdapters } from './packs/composition.mjs';
import { createEmeraldCompatibilityContext } from './packs/emerald-compat.mjs';
import { gameUrl, libraryUrl } from './packs/registry.mjs';
import { createWasmHelpers, createWasmRuntime } from './packs/shared/runtime-wasm.mjs';
import { createSaveStore } from './save-store.mjs';
import { createRunRuntime } from './run/runtime.mjs';
import { createMoveHistoryStore } from './run/move-history.mjs';
import { createLobbySaveStore } from './run/lobby-store.mjs';
import { createLobbyCoordinator } from './run/lobby-coordinator.mjs';
import { createRunSetupCoordinator } from './run/run-setup-coordinator.mjs';
import {
  defaultRunSettingsForMode,
  parseRunSettings,
  RUN_SETTINGS_STORAGE_KEY,
  saveSlotForMode,
} from './run/run-settings.mjs';
import { createGameLibrary } from './ui/game-library.mjs';
import { createCharacterCustomizerView } from './ui/character-customizer-view.mjs';
import { revealLibrary } from './ui/library-readiness.mjs';
import { createGameMenu } from './ui/game-menu.mjs';
import { createFramePacer } from './frame-pacer.mjs';
import { createAudioController } from './audio/audio-controller.mjs';

const WIDTH = 240;
const HEIGHT = 160;
const searchParams = new URLSearchParams(location.search);
const saveProfileParam = searchParams.get('saveProfile');
const saveProfile = /^[A-Za-z0-9_-]{1,24}$/.test(saveProfileParam || '') ? saveProfileParam : '';
const requestedGameId = searchParams.get('game') || '';
let selectedGameId = requestedGameId;
let runSettingsStorageKey = RUN_SETTINGS_STORAGE_KEY;

function soloNuzlockePlayerId(gameId = selectedGameId, profile = saveProfile) {
  return `solo:${gameId}:${profile || 'default'}`;
}

function createLocalRunIdentity() {
  const bytes = new Uint32Array(2);
  globalThis.crypto?.getRandomValues?.(bytes);
  return {
    runId: globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    seed: (bytes[0] ^ bytes[1] ^ Math.floor(Math.random() * 0x100000000)) >>> 0,
  };
}

function soloNuzlockeStorageKey(gameId = selectedGameId, profile = saveProfile) {
  return `pokeemerald.run.nuzlocke.v1/${gameId}/${profile || '~'}`;
}

function runSettingsKey(gameId = selectedGameId, profile = saveProfile) {
  return `${RUN_SETTINGS_STORAGE_KEY}/${gameId}/${profile || '~'}`;
}

let packManifest = null;
let packManifestUrl = null;
let saveStore = null;
let saveCodec = null;
let sceneAdapter = null;
let runtimeAdapter = null;
let packServices = null;
let selectedMapNameFor = () => null;
const emeraldCompat = createEmeraldCompatibilityContext();
let lobbySaveStore = null;
let runRuntime = null;
let runSettings = null;
let runApi = null;
let runAdapter = null;
let soulLinkBaseSaveBytes = null;
let partyAdapter = null;
let rulesAdapter = null;
let partySnapshot = { availability: 'unavailable', members: [], revision: 0 };
let moveHistoryStore = null;
let partyShared = true;
const PARTY_READ_MS = 1000;
let lastPartyRead = 0;

const speedParam = searchParams.get('speed');
const renderScaleParam = searchParams.get('renderScale');
const visualModeParam = searchParams.get('view');
const shadingParam = searchParams.get('shading');
const perspectiveParam = searchParams.get('perspective');
const zoomParam = searchParams.get('zoom');
const opticsParam = searchParams.get('optics');
const automate = searchParams.get('automate') === '1';
const libraryRequested = searchParams.get('library') === '1';
const libraryMode = !automate && (libraryRequested || !requestedGameId);
const soulLinkPregameRequested = searchParams.get('mode') === 'soullink'
  && searchParams.get('pregame') === '1';
const standardLobbyRequested = searchParams.get('mode') === 'standard'
  && searchParams.get('lobby') === '1';

const canvas = document.querySelector('#screen');
const ambientCanvas = document.querySelector('#ambient');
let ambientContext = null;
let ambientLastUpdate = 0;
const AMBIENT_UPDATE_MS = 250;
const wideViewportQuery = matchMedia('(min-width: 1200px) and (min-aspect-ratio: 16 / 9)');
const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const statusEl = document.querySelector('#status');
const speedButtons = document.querySelectorAll('[data-speed]');
const speedValue = document.querySelector('#speed-value');
const renderScaleSelect = document.querySelector('#render-scale');
const visualModeSelect = document.querySelector('#visual-mode');
const shadingInput = document.querySelector('#shading-strength');
const shadingValue = document.querySelector('#shading-value');
const depthInput = document.querySelector('#depth-strength');
const depthValue = document.querySelector('#depth-value');
const zoomInput = document.querySelector('#zoom-out');
const zoomValue = document.querySelector('#zoom-value');
const opticsInput = document.querySelector('#optics-strength');
const opticsValue = document.querySelector('#optics-value');
const playShell = document.querySelector('#play-shell');
const libraryRoot = document.querySelector('#library');
const libraryLoader = document.querySelector('#library-loader');
const librarySettingsButton = document.querySelector('#library-settings');
const speedSelect = document.querySelector('#speed-select');
const gameSelectButton = document.querySelector('#game-select');
const gameCurrentLabel = document.querySelector('#game-current');
const downloadSaveButton = document.querySelector('#download-save');
const menuDownloadSaveButton = document.querySelector('#menu-download-save');
const uploadSaveInput = document.querySelector('#upload-save');
const uploadSaveLabel = document.querySelector('#upload-save-label');
const starterChoiceDialog = document.querySelector('#starter-choice-dialog');
const starterChoiceList = document.querySelector('#starter-choice-list');
const starterChoiceSeed = document.querySelector('#starter-choice-seed');
const saveProfileButton = document.querySelector('#save-profile');
const saveProfileDialog = document.querySelector('#save-profile-dialog');
const saveProfileCurrent = document.querySelector('#save-profile-current');
const saveProfileHint = document.querySelector('#save-profile-hint');
const saveGameNowButton = document.querySelector('#save-game-now');
const saveLastGameTime = document.querySelector('#save-last-game');
const saveLastAutoTime = document.querySelector('#save-last-auto');
let saveLockHeld = false;
let presenter;
let presenterRecoveryPromise = null;
let presenterRecreationCount = 0;
let runtimeStopped = false;

let image;
let worldPixels;
let worldStructuralAlphaPixels;
let worldHeightPixels;
let worldGroundHeightPixels;
let worldGeometryPixels;
let worldReceiverPixels;
let worldFacadePixels;
let layerPixels;
let objectIds;
let bgPriorities;
let objectSourcePixels;
let objectDescriptors;
let objectPixels;
let objectPriorities;
let screenEffectPixels;
let screenEffectSources;
let lastSceneKind = 0;
const pressed = new Set();
const pendingPresses = new Map();
const objectEventSpriteFlags = new Uint8Array(128);

// Do not load the default Emerald avatar set before the selected pack is known.
// The loaded pack configures its own sheets (or an empty set) during start().
const presence = createPresenceRuntime({ avatarSheets: [] });
const presenceLobby = createLobby({ runtime: presence });
function syncCharacterCustomization(compiled = characterCustomizer?.getCompiled?.()) {
  if (!compiled) return;
  presence.setCustomAvatarSheet?.(compiled.appearanceKey, compiled.walkingRgba);
  if (instance && u8 && u16) {
    if (typeof runtimeAdapter?.applyCharacterCustomization === 'function') {
      runtimeAdapter.applyCharacterCustomization(compiled);
    } else {
      emeraldCompat.applyEmeraldCharacterCustomization?.(instance.exports, { u8, u16, u32 }, compiled);
    }
  }
}
const characterCustomizer = createCharacterCustomizerView({
  gameId: selectedGameId || 'emerald',
  onChange: (compiled) => syncCharacterCustomization(compiled),
});
const gameLibrary = createGameLibrary({
  onOpen: openGame,
  onSettings: () => openSettingsDialog(),
  onCustomize: (gameId) => characterCustomizer.open({ gameId }),
});
const gameMenu = createGameMenu({ onAction: handleGameMenuAction });

const runTrackerDialog = document.querySelector('#run-tracker-dialog');
const runTrackerSummary = document.querySelector('#run-tracker-summary');
const runTrackerBody = document.querySelector('#run-tracker-body');
const runNotice = document.querySelector('#run-notice');
const runNoticeTitle = document.querySelector('#run-notice-title');
const runNoticeDetail = document.querySelector('#run-notice-detail');
const runNoticeDismissButton = document.querySelector('#run-notice-dismiss');
let lastObservedRunArea = null;
let lastObservedRunId = null;
let quickStartInFlight = false;

const runSetupFieldset = document.querySelector('#presence-run-settings');
const runModeNote = document.querySelector('#presence-run-mode-note');
const runStartButton = document.querySelector('#run-start');
const groupWipeDialog = document.querySelector('#group-wipe-dialog');
const groupWipeScreen = document.querySelector('#group-wipe-screen');
const groupWipeReason = document.querySelector('#group-wipe-reason');
const groupWipeMembers = document.querySelector('#group-wipe-members');
const runReadyButton = document.querySelector('#run-ready');
const runRestartButton = document.querySelector('#run-restart');
const presenceDefaultHead = document.querySelector('#presence-default-head');
const soulLinkPregameHeader = document.querySelector('#soul-link-pregame-header');
const soulLinkPregameBackButton = document.querySelector('#soul-link-pregame-back');
const soulLinkPregameStatus = document.querySelector('#soul-link-pregame-status');
const standardLobbyHeader = document.querySelector('#standard-lobby-header');
const standardLobbyStatus = document.querySelector('#standard-lobby-status');
const standardLobbySettings = document.querySelector('#standard-lobby-settings');
const standardLobbyStartButton = document.querySelector('#standard-lobby-start');
const standardLobbyBackButton = document.querySelector('#standard-lobby-back');
const standardLobbyCancelResumeButton = document.querySelector('#standard-lobby-cancel-resume');
const savedSoulLinkPanel = document.querySelector('#soullink-saved-lobbies');
const savedSoulLinkList = document.querySelector('#soullink-saved-lobby-list');
const savedStandardPanel = document.querySelector('#standard-saved-lobbies');
const savedStandardList = document.querySelector('#standard-saved-lobby-list');
const presenceFields = document.querySelector('#presence-fields');
const presenceActions = document.querySelector('#presence-actions');
const runOptionInputs = {
  randomizeWild: document.querySelector('#run-randomize-wild'),
  powerBalanceWild: document.querySelector('#run-power-balance-wild'),
  randomizeTrainers: document.querySelector('#run-randomize-trainers'),
  powerBalanceTrainers: document.querySelector('#run-power-balance-trainers'),
  randomizeGyms: document.querySelector('#run-randomize-gyms'),
  powerBalanceGyms: document.querySelector('#run-power-balance-gyms'),
  randomizeStarters: document.querySelector('#run-randomize-starters'),
  allowLinkedPcBoxing: document.querySelector('#run-allow-linked-pc'),
  moveRelearner: document.querySelector('#run-move-relearner'),
  rareCandyPartyLevelCeiling: document.querySelector('#run-party-level-sync'),
  infiniteMoney: document.querySelector('#run-infinite-money'),
};
const lobbySaveControls = document.querySelector('#lobby-save-controls');
const lobbySaveStatus = document.querySelector('#lobby-save-status');
const lobbyDownloadButton = document.querySelector('#lobby-download');
const lobbyImportInput = document.querySelector('#lobby-import');
const lobbyImportLabel = document.querySelector('#lobby-import-label');
const memberSaveSlotButton = document.querySelector('#member-save-slot');
const lobbySlotClaimLabel = document.querySelector('#lobby-slot-claim-label');
const lobbySlotClaimSelect = document.querySelector('#lobby-slot-claim');
const lobbySlotClaimButton = document.querySelector('#lobby-slot-claim-button');

const settings = createSettingsStore();
const settingsButton = document.querySelector('#settings');
const settingsDialog = document.querySelector('#settings-dialog');
const settingsSchemeSelect = document.querySelector('#settings-scheme');
const settingsNameTags = document.querySelector('#settings-name-tags');
const settingsIndicators = document.querySelector('#settings-indicators');
const settingsIcons = document.querySelector('#settings-icons');
const settingsPeopleMap = document.querySelector('#settings-people-map');
const settingsPartyShared = document.querySelector('#settings-party-shared');
const settingsSoundMuted = document.querySelector('#settings-sound-muted');
const settingsSoundVolume = document.querySelector('#settings-sound-volume');
const settingsSoundVolumeValue = document.querySelector('#settings-sound-volume-value');
const audioMuteToggleButton = document.querySelector('#audio-mute-toggle');
const settingsBindingsBody = document.querySelector('#settings-bindings');
const keysHelp = document.querySelector('#keys-help');
const peopleMapDialog = document.querySelector('#people-map');
const peopleMapSummary = document.querySelector('#people-map-summary');
const peopleMapBody = document.querySelector('#people-map-body');
const partyPanelDialog = document.querySelector('#party-panel');
const partyPanelSummary = document.querySelector('#party-panel-summary');
const partyPanelBody = document.querySelector('#party-panel-body');
const moveRelearnerDialog = document.querySelector('#move-relearner-dialog');
const moveRelearnerPokemon = document.querySelector('#move-relearner-pokemon');
const moveRelearnerChoice = document.querySelector('#move-relearner-choice');
const moveRelearnerSlot = document.querySelector('#move-relearner-slot');
const moveRelearnerStatus = document.querySelector('#move-relearner-status');
const moveRelearnerTeachButton = document.querySelector('#move-relearner-teach');

let instance;
let memory;
let u8;
let u16;
let u32;
let statusText = 'loading wasm…';
let lastFpsUpdate = performance.now();
let lastTick = performance.now();
let renderedFrames = 0;
let emulatedFrames = 0;
const framePacer = createFramePacer();
const audioController = createAudioController({
  getInstance: () => instance,
  initialVolume: settings.get().soundVolume ?? 80,
  initialMuted: settings.get().soundMuted === true,
  automate,
});
let currentFrame = 0;
const {
  createImports,
  readS16,
  readS32,
  writeS16,
  writeS32,
} = createWasmHelpers(() => ({ u8, u16, u32 }));
let bootId = 0;
let automationReady;
let resolveAutomationReady;
if (automate) {
  automationReady = new Promise((resolve) => { resolveAutomationReady = resolve; });
}

function resetFpsCounters() {
  lastFpsUpdate = performance.now();
  renderedFrames = 0;
  emulatedFrames = 0;
  framePacer.reset();
}

async function restartWithSave(bytes) {
  statusText = 'restarting with uploaded save...';
  statusEl.textContent = statusText;
  pressed.clear();
  pendingPresses.clear();
  await boot(bytes);
}

const flashSaveController = createFlashSaveController({
  speedParam,
  elements: {
    statusEl,
    saveProfileDialog,
    saveLastGameTime,
    saveLastAutoTime,
    downloadSaveButton,
    menuDownloadSaveButton,
    uploadSaveLabel,
    uploadSaveInput,
    speedButtons,
    speedValue,
    speedSelect,
  },
  getMemoryReady: () => Boolean(u8 && memory?.buffer),
  getRuntimeAdapter: () => runtimeAdapter,
  getSaveCodec: () => saveCodec,
  getSaveStore: () => saveStore,
  getPackManifest: () => packManifest,
  getSelectedGameId: () => selectedGameId,
  getSaveProfile: () => saveProfile,
  getRunSettings: () => runSettings,
  getRunRuntime: () => runRuntime,
  soloNuzlockePlayerId,
  onQueueStandardSoloMirror: (flash) => lobbyCoordinator.queueStandardSoloMirror(flash),
  onRestartWithSave: restartWithSave,
  onResetFpsCounters: resetFpsCounters,
});

const {
  saveByteLength,
  flashBytes,
  renderSaveTimestamps,
  updateSaveActionLabels,
  loadFlashSave,
  saveFlashIfChanged,
  saveCurrentGameNow,
  setSpeed,
  initialSpeed,
} = flashSaveController;

let runSetupCoordinator = null;

const lobbyCoordinator = createLobbyCoordinator({
  standardLobbyRequested,
  elements: {
    statusEl,
    lobbySaveControls,
    lobbySaveStatus,
    lobbyDownloadButton,
    lobbyImportInput,
    lobbyImportLabel,
    memberSaveSlotButton,
    lobbySlotClaimLabel,
    lobbySlotClaimSelect,
    lobbySlotClaimButton,
    savedSoulLinkPanel,
    savedSoulLinkList,
    soulLinkPregameHeader,
    soulLinkPregameStatus,
    savedStandardPanel,
    savedStandardList,
    standardLobbyHeader,
    standardLobbyStatus,
    standardLobbySettings,
    standardLobbyStartButton,
    standardLobbyBackButton,
    standardLobbyCancelResumeButton,
    presenceDefaultHead,
    presenceFields,
    presenceActions,
  },
  presence,
  presenceLobby,
  getSelectedGameId: () => selectedGameId,
  getSaveProfile: () => saveProfile,
  getPackManifest: () => packManifest,
  getSaveCodec: () => saveCodec,
  getSaveStore: () => saveStore,
  getLobbySaveStore: () => lobbySaveStore,
  getRunSettings: () => runSettings,
  getRunRuntime: () => runRuntime,
  getRunClient: () => runSetupCoordinator?.runClient ?? null,
  getInstance: () => instance,
  flashBytes,
  setLastSavedFlashHash: (hash) => flashSaveController.setLastSavedFlashHash(hash),
  saveCurrentGameNow,
  boot: (...args) => boot(...args),
  showFatalError,
  onRenderRunSetup: () => runSetupCoordinator?.renderRunSetup(),
  onFinishSoulLinkPregame: () => runSetupCoordinator?.finishSoulLinkPregame(),
  getSelectedSavedSoulLink: () => runSetupCoordinator?.selectedSavedSoulLink ?? null,
  setSelectedSavedSoulLink: (record) => runSetupCoordinator?.setSelectedSavedSoulLink(record),
  setSoulLinkNewRunSelected: (val) => runSetupCoordinator?.setSoulLinkNewRunSelected(val),
});

const {
  lobbySaveValidator,
  ensureStandardSoloLobby,
  renderSavedSoulLinkLobbies,
  renderSavedStandardLobbies,
  saveLobbySlot,
  renderStandardLobbyScreen,
  enterStandardLobby,
} = lobbyCoordinator;

runSetupCoordinator = createRunSetupCoordinator({
  automate,
  soulLinkPregameRequested,
  elements: {
    statusEl,
    runSetupFieldset,
    runModeNote,
    runStartButton,
    groupWipeDialog,
    groupWipeScreen,
    groupWipeReason,
    groupWipeMembers,
    runReadyButton,
    runRestartButton,
    presenceDefaultHead,
    soulLinkPregameHeader,
    soulLinkPregameBackButton,
    soulLinkPregameStatus,
    savedSoulLinkPanel,
    presenceFields,
    presenceActions,
    runOptionInputs,
    starterChoiceDialog,
    starterChoiceList,
    starterChoiceSeed,
  },
  presence,
  presenceLobby,
  getPackManifest: () => packManifest,
  getRunSettings: () => runSettings,
  setRunSettings: (next) => { runSettings = next; },
  getRunRuntime: () => runRuntime,
  getRunAdapter: () => runAdapter,
  getRunApi: () => runApi,
  getSaveStore: () => saveStore,
  getLobbySaveStore: () => lobbySaveStore,
  getSoulLinkBaseSaveBytes: () => soulLinkBaseSaveBytes,
  getInstance: () => instance,
  getMemoryReady: () => Boolean(u8 && memory?.buffer),
  setQuickStartInFlight: (val) => { quickStartInFlight = val; },
  clearInputState: () => {
    pressed.clear();
    pendingPresses.clear();
  },
  loadFlashSave,
  saveFlashIfChanged,
  updateSaveActionLabels,
  runFrames: (...args) => runFrames(...args),
  observeRunArea: () => observeRunArea(),
  showFatalError,
  onRenderPartyPanelIfOpen: () => {
    if (partyPanelDialog?.open) renderPartyPanel();
  },
  lobbyCoordinator,
});

const {
  renderRunSetup,
  updateRunConnection,
  enterSoulLinkPregame,
  leaveSoulLinkPregame,
} = runSetupCoordinator;

const gameplaySheetsController = createGameplaySheetsController({
  elements: {
    statusEl,
    peopleMapDialog,
    peopleMapSummary,
    peopleMapBody,
    partyPanelDialog,
    partyPanelSummary,
    partyPanelBody,
    moveRelearnerDialog,
    moveRelearnerPokemon,
    moveRelearnerChoice,
    moveRelearnerSlot,
    moveRelearnerStatus,
    moveRelearnerTeachButton,
    runTrackerDialog,
    runTrackerSummary,
    runTrackerBody,
    runNotice,
    runNoticeTitle,
    runNoticeDetail,
    runNoticeDismissButton,
  },
  settings,
  presence,
  getPartyAdapter: () => partyAdapter,
  getPartySnapshot: () => partySnapshot,
  onRefreshPartySnapshotNow: () => {
    lastPartyRead = 0;
    readPartySnapshot(performance.now());
  },
  getMoveHistoryStore: () => moveHistoryStore,
  getRunAdapter: () => runAdapter,
  getRunRuntime: () => runRuntime,
  getRunSettings: () => runSettings,
  getInstance: () => instance,
  getPackManifestUrl: () => packManifestUrl,
  getSelectedMapNameFor: () => selectedMapNameFor,
  saveFlashIfChanged,
});

const {
  togglePeopleMap,
  renderPartyPanel,
  openPartyPanel,
  openRunTracker,
  handleRunNotice,
} = gameplaySheetsController;

function releaseAllKeys() {
  pendingPresses.clear();
  for (const name of [...pressed]) setPressed(name, false);
}

const visualModeController = createVisualModeController({
  width: WIDTH,
  height: HEIGHT,
  automate,
  params: {
    renderScaleParam,
    visualModeParam,
    shadingParam,
    perspectiveParam,
    zoomParam,
    opticsParam,
  },
  reducedMotionQuery,
  settings,
  elements: {
    canvas,
    renderScaleSelect,
    visualModeSelect,
    shadingInput,
    shadingValue,
    depthInput,
    depthValue,
    zoomInput,
    zoomValue,
    opticsInput,
    opticsValue,
    settingsButton,
    librarySettingsButton,
    settingsDialog,
    settingsSchemeSelect,
    settingsNameTags,
    settingsIndicators,
    settingsIcons,
    settingsPeopleMap,
    settingsPartyShared,
    settingsBindingsBody,
    keysHelp,
  },
  getInstance: () => instance,
  getSceneAdapter: () => sceneAdapter,
  getPresenter: () => presenter,
  isPresenterRecovering: () => Boolean(presenterRecoveryPromise),
  hasImage: () => Boolean(image),
  getCurrentFrame: () => currentFrame,
  onRender: () => render(),
  onReleaseAllKeys: releaseAllKeys,
  onPartySharedChanged: (nextShared, forceRepublish) => {
    partyShared = nextShared;
    if (forceRepublish) lastPartyRead = 0;
  },
  onSettingsChanged: () => {
    if (!settings.get().peopleMap && peopleMapDialog?.open) peopleMapDialog.close();
    updatePeerChrome();
    if (partyPanelDialog?.open) renderPartyPanel();
  },
  onClosePresenceLobby: () => presenceLobby.close(),
});

const {
  openSettingsDialog,
  setVisualSettings,
  updateVisualModeTransition,
  applyCapabilities,
} = visualModeController;

lobbyCoordinator.init();
runSetupCoordinator.init();
gameplaySheetsController.init();
visualModeController.init();
flashSaveController.bindSpeedAndSaveEvents();
audioController.attachUnlockListeners();

function syncAudioControlsFromSettings() {
  const current = settings.get();
  const muted = current.soundMuted === true;
  const volume = Number.isFinite(current.soundVolume) ? current.soundVolume : 80;
  audioController.setMuted(muted);
  audioController.setVolume(volume);
  if (settingsSoundMuted) settingsSoundMuted.checked = muted;
  if (settingsSoundVolume) settingsSoundVolume.value = String(volume);
  if (settingsSoundVolumeValue) settingsSoundVolumeValue.textContent = `${volume}%`;
  if (audioMuteToggleButton) {
    audioMuteToggleButton.setAttribute('aria-pressed', String(muted));
    audioMuteToggleButton.textContent = muted ? 'Sound: Off' : 'Sound: On';
  }
}

syncAudioControlsFromSettings();
settings.subscribe(() => syncAudioControlsFromSettings(), { immediate: false });
settingsSoundMuted?.addEventListener('change', () => {
  settings.set({ soundMuted: Boolean(settingsSoundMuted.checked) });
});
settingsSoundVolume?.addEventListener('input', () => {
  const nextVolume = Number(settingsSoundVolume.value);
  if (settingsSoundVolumeValue) settingsSoundVolumeValue.textContent = `${nextVolume}%`;
  settings.set({ soundVolume: nextVolume, soundMuted: nextVolume === 0 ? true : settings.get().soundMuted });
});
audioMuteToggleButton?.addEventListener('click', () => {
  audioController.unlock();
  const nextMuted = !settings.get().soundMuted;
  settings.set({ soundMuted: nextMuted });
});

presence.subscribe(() => {
  updateRunConnection();
  renderRunSetup();
  lobbyCoordinator.handlePresenceUpdate();
}, { immediate: false });

async function loadMapNameLookup(manifest, manifestUrl) {
  const resource = (manifest?.resources ?? []).find((item) => item.id === 'map-names');
  if (!resource?.url) return null;
  const response = await fetch(new URL(resource.url, manifestUrl), { cache: 'no-store' });
  if (!response.ok) throw new Error(`map names request failed: ${response.status}`);
  const table = await response.json();
  return (world) => (world ? table[`${world.mapGroup}:${world.mapNum}`] ?? null : null);
}

function avatarSheetsFromManifest(manifest, manifestUrl) {
  const resources = new Map((manifest?.resources ?? []).map((resource) => [resource.id, resource]));
  const sheets = (manifest?.multiplayer?.avatars ?? [])
    .map((avatar) => {
      const resource = resources.get(avatar.resource);
      if (!resource?.url) return null;
      return {
        appearance: avatar.appearance,
        url: new URL(resource.url, manifestUrl).href,
        transparent: avatar.transparent,
        cellWidth: avatar.cellWidth,
        cellHeight: avatar.cellHeight,
        frames: avatar.frames,
      };
    })
    .filter(Boolean);
  return sheets.length ? sheets : null;
}

function openGame(gameId, profile = '', mode = 'standard') {
  const base = new URL(gameUrl(location.href, gameId, mode));
  base.searchParams.delete('pregame');
  base.searchParams.delete('lobby');
  if (mode === 'soullink') base.searchParams.set('pregame', '1');
  else if (mode === 'standard') base.searchParams.set('lobby', '1');
  location.assign(saveProfileUrl(base.toString(), profile));
}

function changeToLibrary() {
  if (document.body.dataset.soulLinkPregame === 'true') {
    leaveSoulLinkPregame();
    return;
  }
  const saved = saveFlashIfChanged(true);
  if (!saved && saveStore?.lastError && saveStore.lastError.code !== 'save_invalid') {
    showFatalError(
      new Error('The current save could not be written. Retry, or download the save before switching games.'),
      'Unable to switch games',
    );
    return;
  }
  presence.leave();
  location.assign(libraryUrl(location.href));
}

function handleGameMenuAction(action) {
  if (action === 'party') {
    openPartyPanel();
  } else if (action === 'run-tracker') {
    openRunTracker();
  } else if (action === 'save') {
    openSaveProfileDialog();
  } else if (action === 'friends') {
    presenceLobby.open();
  } else if (action === 'settings') {
    openSettingsDialog();
  } else if (action === 'change') {
    changeToLibrary();
  }
}

async function showLibrary(message = '') {
  playShell.hidden = true;
  gameLibrary.show();
  const dataReady = gameLibrary.load();
  if (document.documentElement.dataset.boot === 'library' && libraryLoader && !libraryLoader.hidden) {
    await revealLibrary({ root: libraryRoot, loader: libraryLoader, dataReady });
  } else {
    await dataReady;
  }
  if (message) gameLibrary.showError(message);
}

gameSelectButton?.addEventListener('click', () => {
  if (libraryMode) return;
  changeToLibrary();
});

function showFatalError(error, prefix) {
  const message = error instanceof Error ? error.message : String(error);
  statusEl.textContent = `${prefix}: ${message}`;
  statusEl.classList.add('error');
  statusEl.setAttribute('role', 'alert');
}

function stopRuntime(error, prefix) {
  if (runtimeStopped) return;
  runtimeStopped = true;
  bootId++;
  presence.leave();
  saveFlashIfChanged(true);
  presenter?.destroy();
  presenter = undefined;
  showFatalError(error, prefix);
}

function openSaveProfileDialog(reason = '') {
  saveProfileCurrent.textContent = `Saving to: ${saveProfileLabel(saveProfile)}`;
  saveProfileHint.hidden = false;
  saveProfileHint.textContent = reason || 'Your current game is saved in this browser.';
  saveGameNowButton.disabled = !saveLockHeld || !u8;
  renderSaveTimestamps();
  if (!saveProfileDialog.open) saveProfileDialog.showModal();
}

function saveCurrentProfileNow() {
  if (!saveLockHeld) {
    saveProfileHint.textContent = 'This save is open in another tab. Close that tab before saving here.';
    return;
  }
  if (!u8) {
    saveProfileHint.textContent = 'The game is still loading. Try again in a moment.';
    return;
  }
  saveGameNowButton.disabled = true;
  (async () => {
    try {
      const state = runRuntime?.peekState?.() ?? runRuntime?.state();
      if (runSettings?.mode === 'soullink' && ['active', 'wipe_pending'].includes(state?.status)) {
        await saveLobbySlot();
        saveProfileHint.textContent = 'Game and player slot saved. This run can be resumed from this browser.';
      } else {
        if (saveCurrentGameNow() !== 1) {
          saveProfileHint.textContent = 'The game could not be saved. Try again in a moment.';
          return;
        }
        saveProfileHint.textContent = 'Game saved in this browser.';
      }
      renderSaveTimestamps();
    } catch (error) {
      saveProfileHint.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      saveGameNowButton.disabled = !saveLockHeld || !u8;
    }
  })();
}

saveProfileButton.textContent = 'Save game';
saveProfileButton.addEventListener('click', () => openSaveProfileDialog());
saveGameNowButton.addEventListener('click', saveCurrentProfileNow);

function refreshViews() {
  u8 = new Uint8Array(memory.buffer);
  u16 = new Uint16Array(memory.buffer);
  u32 = new Uint32Array(memory.buffer);
}

function refreshFrameImage() {
  if (typeof sceneAdapter?.createFrame !== 'function') {
    throw new Error(`Game pack ${selectedGameId} has no scene frame adapter`);
  }
  const frame = sceneAdapter.createFrame(instance, memory, { width: WIDTH, height: HEIGHT });
  image = frame.image;
  worldPixels = frame.worldPixels;
  worldStructuralAlphaPixels = frame.worldStructuralAlphaPixels;
  worldHeightPixels = frame.worldHeightPixels;
  worldGroundHeightPixels = frame.worldGroundHeightPixels;
  worldGeometryPixels = frame.worldGeometryPixels;
  worldReceiverPixels = frame.worldReceiverPixels;
  worldFacadePixels = frame.worldFacadePixels;
  layerPixels = frame.layerPixels;
  objectIds = frame.objectIds;
  bgPriorities = frame.bgPriorities;
  objectSourcePixels = frame.objectSourcePixels;
  objectDescriptors = frame.objectDescriptors;
  objectPixels = frame.objectPixels;
  objectPriorities = frame.objectPriorities;
  screenEffectPixels = frame.screenEffectPixels;
  screenEffectSources = frame.screenEffectSources;
}

function ambientEnabled() {
  if (reducedMotionQuery.matches) return false;
  return Boolean(document.fullscreenElement) || wideViewportQuery.matches;
}

function updateAmbient(now) {
  const active = ambientEnabled();
  ambientCanvas?.classList.toggle('is-on', active);
  if (!active || !image) return;
  if (now - ambientLastUpdate < AMBIENT_UPDATE_MS) return;
  ambientLastUpdate = now;
  ambientContext ??= ambientCanvas?.getContext('2d');
  if (!ambientContext) return;
  ambientContext.putImageData(image, 0, 0);
}

function rememberCurrentPartyMoves() {
  partyAdapter?.rememberMoves?.(moveHistoryStore);
}

function readPartySnapshot(now) {
  if (!partyAdapter || now - lastPartyRead < PARTY_READ_MS) return partySnapshot;
  lastPartyRead = now;
  partySnapshot = partyAdapter.read();
  rememberCurrentPartyMoves();
  const outgoing = partyShared
    ? partySnapshot
    : { availability: 'hidden', members: [], revision: partySnapshot.revision };
  presence.publishParty?.(outgoing);
  return partySnapshot;
}

function render() {
  if (!presenter || presenterRecoveryPromise || runtimeStopped) return;
  updateVisualModeTransition();
  if (typeof sceneAdapter?.renderFrame !== 'function') {
    throw new Error(`Game pack ${selectedGameId} has no scene render adapter`);
  }
  const activeVisualMode = visualModeController.activeVisualMode;
  const frameState = sceneAdapter.renderFrame(instance, {
    mode: activeVisualMode,
    memoryView: u8,
    objectEventSpriteFlags,
  });
  lastSceneKind = frameState.sceneKind;
  const { enhanced, screenEffects, fieldKind } = frameState;
  const flatField = fieldKind === 2;
  const remote = presence.frameOptions({ enhanced, sceneKind: lastSceneKind, flatField });
  if (flatField) {
    lastFlatRemoteDraws = compositeFlatActors({
      pixels: image.data,
      width: WIDTH,
      height: HEIGHT,
      layerPixels,
      bgPriorities: frameState.bgPriorities,
      spritePriority: frameState.spritePriority,
      actors: remote.remoteActors ?? [],
      atlasPixels: presence.avatarAtlas?.pixels ?? null,
    });
  } else {
    lastFlatRemoteDraws = 0;
  }
  presenter.present({
    finalPixels: image.data,
    worldPixels,
    worldStructuralAlphaPixels,
    worldHeightPixels,
    worldGroundHeightPixels,
    worldGeometryPixels,
    worldReceiverPixels,
    worldFacadePixels,
    worldGridOffsetX: frameState.worldGridOffsetX,
    worldGridOffsetY: frameState.worldGridOffsetY,
    worldPixelOriginX: frameState.worldPixelOriginX,
    worldPixelOriginY: frameState.worldPixelOriginY,
    layerPixels,
    objectIds,
    bgPriorities,
    objectSourcePixels,
    objectDescriptors,
    objectEventSpriteFlags,
    objectSourceCount: frameState.objectSourceCount,
    objectPixels,
    objectPriorities,
    screenEffectPixels,
    screenEffectSources,
    enhanced,
    screenEffects,
    shading: visualModeController.renderedShadingStrength,
    perspective: activeVisualMode === 'hd2d' ? visualModeController.perspectiveStrength : 0,
    zoom: activeVisualMode === 'hd2d' ? visualModeController.zoomStrength : 0,
    optics: visualModeController.renderedOpticsStrength,
    ...remote,
  });
  currentRemoteActors = remote.remoteActors ?? [];
  updateRemoteBadges();
  updatePeerChrome();
  updateBattleHud(instance?.exports);
  updateAmbient(performance.now());
}

let currentRemoteActors = [];
let lastFlatRemoteDraws = 0;
const {
  peerOverlayLayer,
  peerTagElements,
  updateRemoteBadges: updateRemoteBadgesDom,
  syncPeerTags,
  syncPeerIcons,
  updateBattleHud,
} = createOverworldPeerDom({
  canvas,
  panel: document.querySelector('.display-panel'),
  getAvatarAtlas: () => presence.avatarAtlas,
});

function updateRemoteBadges() {
  if (!currentRemoteActors.length && !presenter?.lastRemoteBadges?.length) {
    updateRemoteBadgesDom({
      presentedBadges: [],
      remoteActors: [],
      members: [],
      parties: null,
      peerNameTags: settings.get().peerNameTags !== false,
    });
    return;
  }
  const snapshot = presence.getSnapshot();
  updateRemoteBadgesDom({
    presentedBadges: presenter?.lastRemoteBadges ?? [],
    remoteActors: currentRemoteActors,
    members: snapshot.members ?? [],
    parties: snapshot.parties ?? null,
    peerNameTags: settings.get().peerNameTags !== false,
  });
}

function updatePeerChrome() {
  if (!currentRemoteActors.length && peerTagElements.size === 0) {
    peerOverlayLayer.hidden = true;
    gameplaySheetsController.maybeRefreshAll(performance.now());
    return;
  }
  const current = settings.get();
  const snapshot = presence.getSnapshot();
  const members = snapshot.members ?? [];
  const projected = presenter?.lastRemoteActors?.length
    ? new Map(presenter.lastRemoteActors.map((entry) => [entry.playerId, entry]))
    : null;
  const { tags, indicators } = buildPeerOverlay({
    actors: currentRemoteActors,
    members,
    parties: snapshot.parties ?? null,
    settings: current,
    projected,
  });
  syncPeerTags(tags);
  syncPeerIcons(indicators, current);
  peerOverlayLayer.hidden = tags.length === 0;
  gameplaySheetsController.maybeRefreshAll(performance.now());
}

function writeKeys() {
  if (typeof runtimeAdapter?.setButtons !== 'function') return;
  runtimeAdapter.setButtons([...new Set([...pressed, ...pendingPresses.keys()])]);
}

function stepPendingPresses() {
  for (const [key, frames] of pendingPresses) {
    if (frames <= 1) pendingPresses.delete(key);
    else pendingPresses.set(key, frames - 1);
  }
}

function setPressed(name, isPressed) {
  if (isPressed) {
    pressed.add(name);
    pendingPresses.set(name, 1);
  } else {
    pressed.delete(name);
  }
  document.querySelectorAll(`[data-key='${name}']`).forEach((el) => el.classList.toggle('pressed', isPressed));
  if (u16) writeKeys();
}

function currentControlScheme() {
  return normalizeScheme(settings.get().controlScheme);
}

window.addEventListener('keydown', (event) => {
  const action = actionFor(currentControlScheme(), event.code);
  if (!action) return;
  if (shouldIgnoreKeyEvent(event)) return;
  if (action === 'map') {
    event.preventDefault();
    togglePeopleMap();
    return;
  }
  if (!isGameButton(action)) return;
  event.preventDefault();
  setPressed(action, true);
});

window.addEventListener('keyup', (event) => {
  const action = actionFor(currentControlScheme(), event.code);
  if (!action || !isGameButton(action)) return;
  setPressed(action, false);
});

function saveActiveGameProgress(automatic = true) {
  const soulLinkActive = runSettings?.mode === 'soullink'
    && ['active', 'wipe_pending'].includes((runRuntime?.peekState?.() ?? runRuntime?.state?.())?.status);
  const inActiveWorld = Boolean(instance?.exports?.WasmPresenceValid?.()) || soulLinkActive;
  if (!inActiveWorld || saveCurrentGameNow(automatic) !== 1) {
    saveFlashIfChanged(true, automatic);
  }
}

window.addEventListener('blur', () => {
  releaseAllKeys();
  saveActiveGameProgress(true);
});
window.addEventListener('focus', () => {
  presence.setAway(false);
  presence.tick();
});
window.addEventListener('online', () => {
  presence.setAway(document.visibilityState === 'hidden');
  presence.tick();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    releaseAllKeys();
    saveActiveGameProgress(true);
    const standardJoined = runSettings?.mode === 'standard' && presence.getSnapshot().status === 'joined';
    const soulLinkActive = runSettings?.mode === 'soullink' && ['active', 'wipe_pending'].includes((runRuntime?.peekState?.() ?? runRuntime?.state?.())?.status);
    if (standardJoined || soulLinkActive) {
      void saveLobbySlot(true).catch((error) => console.warn('Lobby background save failed', error));
    }
  }
});

window.addEventListener('beforeunload', () => {
  saveActiveGameProgress(true);
});
window.addEventListener('pagehide', (event) => {
  saveActiveGameProgress(true);
  if (!event.persisted) presence.leave();
});
window.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';
  presence.setAway(hidden);
  if (hidden) saveActiveGameProgress(true);
});
setInterval(() => {
  if (runtimeStopped) return;
  if (document.visibilityState === 'hidden' || !instance || libraryMode || performance.now() - lastTick > 250) {
    presence.tick();
  }
}, 1000);

document.querySelectorAll('[data-key]').forEach((button) => {
  const name = button.dataset.key;
  button.addEventListener('pointerdown', (event) => { event.preventDefault(); setPressed(name, true); });
  button.addEventListener('pointerup', () => setPressed(name, false));
  button.addEventListener('pointercancel', () => setPressed(name, false));
  button.addEventListener('pointerleave', () => setPressed(name, false));
});

function fpsStatus(displayFps, gameFps) {
  return `${statusText} — Display FPS: ${displayFps}, Game FPS: ${gameFps} (${(gameFps / 60).toFixed(1)}x)`;
}

function presenterOptions() {
  if (typeof sceneAdapter?.presenterOptions !== 'function') {
    throw new Error(`Game pack ${selectedGameId} has no presenter options adapter`);
  }
  return sceneAdapter.presenterOptions({
    canvas,
    width: WIDTH,
    height: HEIGHT,
    instance,
    scale: visualModeController.renderScale,
    onFailure: handlePresenterFailure,
  });
}

async function recoverPresenter(failedPresenter, error, kind) {
  const previousStatus = statusText;
  statusText = `recovering WebGPU after ${kind}…`;
  statusEl.textContent = statusText;
  failedPresenter.destroy();

  let replacement;
  try {
    replacement = await createPresenter(presenterOptions());
    if (replacement.failure) throw replacement.failure.error;
    if (runtimeStopped) {
      replacement.destroy();
      return;
    }
    presenter = replacement;
    statusText = previousStatus;
    statusEl.classList.remove('error');
    statusEl.removeAttribute('role');
    statusEl.textContent = `${statusText} — WebGPU recovered`;
  } catch (replacementError) {
    replacement?.destroy();
    const detail = replacementError instanceof Error ? replacementError.message : String(replacementError);
    stopRuntime(
      new Error(`${error.message} Presenter recreation failed: ${detail}. Reload the page; if this repeats, update the browser or graphics driver.`),
      'WebGPU recovery failed',
    );
  }
}

function handlePresenterFailure(failedPresenter, error, kind) {
  if (failedPresenter !== presenter || runtimeStopped) return presenterRecoveryPromise;
  console.error(error);
  if (presenterRecoveryPromise) return presenterRecoveryPromise;
  if (kind !== 'device lost') {
    stopRuntime(
      new Error(`${error.message} Reload the page; if this repeats, update the browser or graphics driver.`),
      'WebGPU error',
    );
    return null;
  }
  if (presenterRecreationCount >= 1) {
    stopRuntime(
      new Error(`${error.message} The replacement presenter also failed. Reload the page; if this repeats, update the browser or graphics driver.`),
      'WebGPU stopped',
    );
    return null;
  }

  presenterRecreationCount++;
  const recovery = recoverPresenter(failedPresenter, error, kind);
  presenterRecoveryPromise = recovery;
  void recovery.finally(() => {
    if (presenterRecoveryPromise === recovery) presenterRecoveryPromise = null;
  });
  return recovery;
}

async function boot(saveBytes, { continueSavedGame = false } = {}) {
  const thisBootId = ++bootId;
  const runtime = runtimeAdapter ?? createWasmRuntime({
    manifest: packManifest ?? { runtime: { module: { url: '/build/wasm/pokeemerald.wasm' } } },
    manifestUrl: packManifestUrl,
    importsFor: (module, options) => createImports(module, options),
  });
  const { bytes, instance: bootedInstance } = await runtime.instantiate({
    runHooks: rulesAdapter?.hooks?.() ?? runRuntime?.hooks ?? {},
    validateModule: (loadedModule) => rulesAdapter?.validateImports(WebAssembly.Module.imports(loadedModule)),
  });
  instance = bootedInstance;
  memory = instance.exports.memory;
  if (rulesAdapter) rulesAdapter.bind(instance.exports);
  else runRuntime?.bindExports(instance.exports);
  if (!presenter) {
    presenter = await createPresenter(presenterOptions());
    if (presenter.failure) throw presenter.failure.error;
  }
  runtimeStopped = false;
  window.pokeemerald = { instance, memory, runFrames, run: runApi };
  presence.bind(instance.exports);
  partyAdapter?.bind?.(instance.exports);
  presence.setAway(document.visibilityState === 'hidden');
  window.pokeemerald.presence = presenceAutomationApi();
  window.pokeemerald.party = {
    snapshot: () => partySnapshot,
    read: () => readPartySnapshot(performance.now()),
    setShared: (shared) => {
      partyShared = shared !== false;
      lastPartyRead = 0;
      return partyShared;
    },
    get shared() { return partyShared; },
    peers: () => presence.getParties?.() ?? {},
  };
  sceneAdapter?.setMode?.(instance, visualModeController.activeVisualMode);
  if (automate) window.pokeemerald.automation = automationApi();
  refreshViews();
  syncCharacterCustomization();
  refreshFrameImage();
  loadFlashSave(saveBytes);
  writeKeys();
  if (typeof runtimeAdapter?.start !== 'function') {
    throw new Error(`Game pack ${selectedGameId} has no runtime start method`);
  }
  runtimeAdapter.start();
  if (continueSavedGame) {
    if (!runAdapter?.loadSavedGame?.(instance.exports)) {
      throw new Error('The saved multiplayer game could not be loaded');
    }
  }
  syncCharacterCustomization();
  currentFrame = 0;
  framePacer.reset();
  resetFpsCounters();
  statusText = `running — WebGPU — ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB wasm`;
  setSpeed(initialSpeed());
  statusEl.textContent = fpsStatus(0, 0);
  if (automate) {
    render();
    resolveAutomationReady();
  } else {
    lastTick = performance.now();
    requestAnimationFrame((now) => tick(thisBootId, now));
  }
}

function updateFps(frameCount) {
  renderedFrames++;
  emulatedFrames += frameCount;

  const now = performance.now();
  const elapsed = now - lastFpsUpdate;
  if (elapsed < 1000) return;

  const fps = Math.round(renderedFrames * 1000 / elapsed);
  const gameFps = Math.round(emulatedFrames * 1000 / elapsed);
  statusEl.textContent = fpsStatus(fps, gameFps);
  lastFpsUpdate = now;
  renderedFrames = 0;
  emulatedFrames = 0;
}

function runFrames(frameCount, keyMask = 0) {
  for (let i = 0; i < frameCount; i++) {
    if (keyMask) runtimeAdapter.setInputMask(keyMask);
    else writeKeys();
    if (typeof runtimeAdapter?.step !== 'function') {
      throw new Error(`Game pack ${selectedGameId} has no runtime frame-step method`);
    }
    runtimeAdapter.step();
    if (runRuntime?.hasPendingReleases) {
      instance?.exports?.WasmRunFlushPendingReleases?.();
    }
    observeRunArea();
    currentFrame++;
    stepPendingPresses();
  }
  const currentSpeed = flashSaveController.speed;
  audioController.pullFromWasm({
    speedMultiplier: Number.isFinite(currentSpeed) && currentSpeed > 0 ? currentSpeed : 8,
  });
  runtimeAdapter.setButtons([]);
  if (automate) presence.tick();
  saveFlashIfChanged();
}

function observeRunArea() {
  if (quickStartInFlight) return;
  const runState = runRuntime?.peekState?.() ?? runRuntime?.state?.();
  if (!runRuntime?.active || !runAdapter?.isWorldValid?.(instance?.exports)) {
    if (!runRuntime?.active) { lastObservedRunArea = null; lastObservedRunId = null; }
    return;
  }
  if (runState?.runId !== lastObservedRunId) {
    lastObservedRunId = runState?.runId ?? null;
    lastObservedRunArea = null;
  }
  if (runState?.status === 'active' && instance?.exports?.WasmRunIsChampion?.()) {
    const victoryResult = runRuntime.recordVictory?.({ party: partySnapshot?.members ?? [] });
    if (victoryResult?.accepted) {
      renderRunSetup();
      if (groupWipeDialog && !groupWipeDialog.open) groupWipeDialog.showModal();
    }
  }
  const sectionId = runAdapter?.sectionId?.({}, instance.exports);
  if (!Number.isInteger(sectionId) || sectionId < 0) return;
  const areaKey = runAdapter?.areaKey?.({ sectionId }, { exports: instance.exports });
  if (!areaKey || areaKey === lastObservedRunArea) return;
  lastObservedRunArea = areaKey;
  runRuntime.visitArea({ sectionId, areaKey });
}

const { presenceAutomationApi, automationApi } = createShellAutomation(() => ({
  instance,
  memory,
  u8,
  u16,
  readS16,
  writeS32,
  currentFrame,
  presenter,
  presenterRecreationCount,
  presenterRecoveryPromise,
  runtimeStopped,
  visualMode: visualModeController.visualMode,
  activeVisualMode: visualModeController.activeVisualMode,
  shadingStrength: visualModeController.shadingStrength,
  perspectiveStrength: visualModeController.perspectiveStrength,
  zoomStrength: visualModeController.zoomStrength,
  opticsStrength: visualModeController.opticsStrength,
  renderedShadingStrength: visualModeController.renderedShadingStrength,
  renderedOpticsStrength: visualModeController.renderedOpticsStrength,
  visualModeTransition: visualModeController.visualModeTransition,
  lastSceneKind,
  lastFlatRemoteDraws,
  renderScale: visualModeController.renderScale,
  canvas,
  runAdapter,
  saveStore,
  presence,
  runRuntime,
  lobbyRecordSnapshot: lobbyCoordinator.lobbyRecordSnapshot,
  statusEl,
  automationReady,
  pendingPresses,
  pressed,
  writeKeys,
  runFrames,
  render,
  saveCurrentGameNow,
  saveFlashIfChanged,
  saveByteLength,
  bytesToBase64,
  base64ToBytes,
  hashBytes,
  restartWithSave,
  setVisualSettings,
}));

function runFramesForTick(elapsedMs) {
  const start = performance.now();
  const currentSpeed = flashSaveController.speed;

  if (currentSpeed === Infinity) {
    framePacer.reset();
    let frames = 0;
    while (performance.now() - start < elapsedMs) {
      runFrames(256);
      frames += 256;
    }
    return frames;
  }

  const frameCount = framePacer.advance(elapsedMs, currentSpeed);
  if (frameCount === 0) return 0;
  runFrames(frameCount);
  return frameCount;
}

function tick(thisBootId, now) {
  if (thisBootId !== bootId || runtimeStopped) return;
  try {
    if (presenterRecoveryPromise) {
      lastTick = now;
      requestAnimationFrame((nextNow) => tick(thisBootId, nextNow));
      return;
    }
    const elapsedMs = Math.min(now - lastTick, 100);
    lastTick = now;
    const frames = runFramesForTick(elapsedMs);
    presence.tick();
    readPartySnapshot(now);
    render();
    updateFps(frames);
    if (!runtimeStopped) requestAnimationFrame((nextNow) => tick(thisBootId, nextNow));
  } catch (error) {
    console.error(error);
    stopRuntime(error, 'The game stopped');
  }
}

async function start() {
  try {
    const loaded = await loadPack({
      gameId: requestedGameId || undefined,
      indexUrl: '/game-packs/index.json',
      requireDigests: false,
    });
    selectedGameId = loaded.entry.id;
    packManifest = loaded.manifest;
    packManifestUrl = loaded.manifestUrl;
    packServices = createPackAdapters(loaded, {
      runtime: {
        shared: { ...emeraldCompat, createWasmRuntime },
        manifest: packManifest,
        manifestUrl: packManifestUrl,
        getMemoryView: () => u8,
        getMemoryViews: () => ({ u8, u16, u32 }),
        getInputView: () => u16,
        importsFor: (module, options) => createImports(module, options),
      },
      scene: { shared: emeraldCompat, manifest: packManifest },
      saves: {
        shared: emeraldCompat,
        manifest: packManifest,
        formatId: packManifest.saves.formatId,
        formatVersion: packManifest.saves.formatVersion,
      },
      world: { shared: emeraldCompat, manifest: packManifest },
      party: { shared: emeraldCompat, manifest: packManifest },
    });
    runtimeAdapter = packServices.runtime;
    sceneAdapter = packServices.scene;
    saveCodec = packServices.saves;
    runSettingsStorageKey = runSettingsKey(selectedGameId, saveProfile);
    try {
      const savedSettings = localStorage.getItem(runSettingsStorageKey)
        ?? emeraldCompat.legacyRunSettings(selectedGameId, localStorage, RUN_SETTINGS_STORAGE_KEY);
      runSettings = parseRunSettings(savedSettings ?? '');
    } catch {
      runSettings = parseRunSettings('');
    }
    if (runSettings.mode === 'nuzlocke') runSettings = defaultRunSettingsForMode('standard');
    const requestedRunMode = searchParams.get('mode');
    if ((requestedRunMode === 'soullink' || requestedRunMode === 'standard')
      && requestedRunMode !== runSettings.mode) {
      runSettings = defaultRunSettingsForMode(requestedRunMode);
    }
    updateSaveActionLabels();
    if (loaded.adapters.run) {
      let regionMap = null;
      const mapResourceId = packManifest.run?.regionMapResource;
      const mapResource = packManifest.resources?.find((resource) => resource.id === mapResourceId);
      if (mapResource) {
        const fetched = await fetchVerifiedResource(packManifestUrl, mapResource, { requireDigest: false });
        regionMap = JSON.parse(new TextDecoder().decode(fetched.bytes));
      }
      soulLinkBaseSaveBytes = null;
      if (runSettings.mode === 'soullink') {
        const baseResourceId = packManifest.run?.quickStartBaseResource;
        const baseResource = packManifest.resources?.find((resource) => resource.id === baseResourceId);
        if (!baseResource) throw new Error('the game pack does not declare its SoulLink base save');
        const fetched = await fetchVerifiedResource(packManifestUrl, baseResource, {
          requireDigest: baseResource.sha256 !== 'pending',
        });
        if (!saveCodec?.validate?.(fetched.bytes)?.ok) {
          throw new Error(`the game pack ${packManifest.game.title} SoulLink base save is invalid`);
        }
        soulLinkBaseSaveBytes = fetched.bytes;
      }
      runAdapter = createPackAdapter(loaded, 'run', { manifest: packManifest, regionMap });
      runRuntime = createRunRuntime({
        adapter: runAdapter,
        initialSettings: runSettings,
        settingsStorageKey: runSettingsStorageKey,
        saveSlot: saveSlotForMode(runSettings.mode),
        storageKey: runSettings.mode === 'nuzlocke'
          ? soloNuzlockeStorageKey(selectedGameId, saveProfile)
          : undefined,
        onPcBoxBlocked: () => {
          statusEl.textContent = 'The host rules do not allow boxing an active SoulLink partner.';
        },
      });
      runRuntime.setNoticeHandler(handleRunNotice);
      rulesAdapter = createPackAdapter(loaded, 'rules', {
        manifest: packManifest,
        runAdapter,
        runtime: runRuntime,
      });
      runApi = {
        get settings() { return runRuntime?.settings ?? null; },
        get connection() {
          if (runSettings?.mode === 'nuzlocke') return 'local';
          return runSetupCoordinator.runClient?.attached
            ? 'attached'
            : runSetupCoordinator.runConnectionStatus;
        },
        configure(patch) {
          runSettings = runRuntime.configure(patch);
          updateRunConnection();
          return runSettings;
        },
        start(options = {}) {
          if (runSettings.mode === 'nuzlocke') {
            if (rulesAdapter?.support !== 'enforce' || !rulesAdapter.modes.includes('nuzlocke')) {
              throw new Error('the selected game pack does not yet declare enforced Nuzlocke support');
            }
            const current = runRuntime.state();
            if (current) throw new Error('a Nuzlocke run already exists for this save slot; use the run reset flow instead');
            const playerId = soloNuzlockePlayerId(selectedGameId, saveProfile);
            const identity = createLocalRunIdentity();
            return runRuntime.start({
              ...identity,
              ...options,
              members: [{ playerId, name: saveProfileLabel(saveProfile) }],
              playerId,
            });
          }
          if (!packManifest.run?.modes?.includes('soullink') || packManifest.run.support !== 'enforce') {
            throw new Error('the selected game pack does not yet declare enforced SoulLink support');
          }
          if (runSettings.mode !== 'soullink') {
            throw new Error('open the game with mode=soullink to use the dedicated soulrun save');
          }
          const runClient = runSetupCoordinator.runClient;
          if (!runClient?.attached) throw new Error('join a presence room before starting a shared run');
          runSetupCoordinator.setRunStartPending(true);
          const sent = runClient.startRun({ ...runSettings, ...options });
          if (!sent) runSetupCoordinator.setRunStartPending(false);
          return sent;
        },
        ready() {
          if (runSettings.mode !== 'soullink') return { accepted: false, reason: 'not_a_multiplayer_run' };
          return runRuntime.emit('run.ready', { ready: true });
        },
        restart() {
          if (runSettings.mode !== 'soullink') return { accepted: false, reason: 'not_a_multiplayer_run' };
          const state = runRuntime.state();
          if (!state || state.hostPlayerId !== presence.getRunCredentials?.()?.playerId) {
            return { accepted: false, reason: 'host_required' };
          }
          return runSetupCoordinator.runClient?.restartRun() ?? false;
        },
        exclude(playerId) {
          if (runSettings.mode !== 'soullink') return { accepted: false, reason: 'not_a_multiplayer_run' };
          return runRuntime.emit('run.exclude-member', { excludedPlayerId: playerId });
        },
        testWipe() {
          if (!automate) throw new Error('test-only run wipe is unavailable outside automation');
          return runRuntime.emit('wipe.pending', { ready: false });
        },
        state: () => runRuntime.state(),
        tracker: () => runRuntime.tracker(presence.getSnapshot()),
        events: () => runRuntime.state()?.events ?? [],
        export: () => JSON.stringify(runRuntime.state()),
      };
      updateRunConnection();
    }
    if (gameCurrentLabel) gameCurrentLabel.textContent = packManifest.game.title;
    gameMenu.setGameTitle(packManifest.game.title);
    if (loaded.adapters.world) {
      presence.setAdapter(packServices.world);
    }
    partyAdapter = null;
    partySnapshot = { availability: 'unavailable', members: [], revision: 0 };
    if (loaded.adapters.party) {
      partyAdapter = packServices.party;
    }
    presence.configure({
      contentVersion: packManifest.multiplayer?.contentVersion,
      avatarSheets: packManifest.capabilities?.presence === 'none'
        ? []
        : avatarSheetsFromManifest(packManifest, packManifestUrl) ?? [],
      enabled: packManifest.capabilities?.presence !== 'none',
    });
    const compiledCustomization = characterCustomizer.setGameContext({
      gameId: selectedGameId,
      manifest: packManifest,
    });
    presence.setCustomAvatarSheet?.(compiledCustomization.appearanceKey, compiledCustomization.walkingRgba);
    applyCapabilities(packManifest);
    saveStore = createSaveStore({
      gameId: selectedGameId,
      formatId: packManifest.saves.formatId,
      formatVersion: packManifest.saves.formatVersion,
      profile: saveProfile,
      slot: saveSlotForMode(runSettings?.mode ?? 'standard'),
      codec: saveCodec,
      legacyStorageKeys: saveSlotForMode(runSettings?.mode ?? 'standard') === 'main'
        ? packManifest.saves.legacyStorageKeys ?? []
        : [],
    });
    moveHistoryStore = createMoveHistoryStore({
      key: `${saveStore.key}/move-history.v1`,
      maxMoveId: partyAdapter?.maxMoveId ?? 0,
    });
    lobbySaveStore = createLobbySaveStore({
      namespace: `${selectedGameId}/${saveProfile || 'default'}`,
      validateSave: lobbySaveValidator(),
    });
    if (savedStandardPanel) savedStandardPanel.hidden = runSettings.mode !== 'standard';
    if (savedSoulLinkPanel) savedSoulLinkPanel.hidden = !soulLinkPregameRequested;
    if (runSettings.mode === 'standard') {
      void renderSavedStandardLobbies().catch((error) => console.warn('saved Standard lobbies could not be loaded', error));
    }
    if (soulLinkPregameRequested) {
      void renderSavedSoulLinkLobbies().catch((error) => {
        statusEl.textContent = `Saved lobbies could not be loaded: ${error.message}`;
      });
    }
    const mapNameLookup = await loadMapNameLookup(packManifest, packManifestUrl)
      .catch((error) => {
        console.warn('Map names unavailable; roster will fall back to coordinates', error);
        return null;
      });
    selectedMapNameFor = mapNameLookup ?? (() => null);
    if (mapNameLookup) presenceLobby.setMapNameFor(mapNameLookup);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showLibrary(`Unable to load game: ${message}`);
    return;
  }

  const saveLock = createSaveProfileLock({ profileKey: saveStore.key });
  const acquired = await saveLock.whenAcquired;
  saveLockHeld = acquired;
  if (!acquired) {
    const reason = saveLock.supported
      ? `This game save is already open in another tab. To protect your progress, this tab cannot start the game. Switch to the tab that is already playing, or close it and reload this tab.`
      : 'This browser cannot lock the save profile safely. Use one tab at a time.';
    if (downloadSaveButton) downloadSaveButton.disabled = true;
    if (uploadSaveInput) uploadSaveInput.disabled = true;
    showFatalError(new Error(reason), 'Unable to start');
    if (saveLock.supported) openSaveProfileDialog(reason);
    return;
  }
  if (runSettings.mode === 'nuzlocke') {
    try {
      if (rulesAdapter?.support !== 'enforce' || !rulesAdapter.modes.includes('nuzlocke')) {
        throw new Error('the selected game pack does not declare enforced Nuzlocke support');
      }
      const playerId = soloNuzlockePlayerId(selectedGameId, saveProfile);
      const restored = runRuntime.restoreLocalState({ playerId });
      if (!restored) {
        if (saveStore.hasRecord()) {
          throw new Error('this Nuzlocke save has no matching rule history; restore a run backup or use a new profile');
        }
        runRuntime.start({
          ...createLocalRunIdentity(),
          members: [{ playerId, name: saveProfileLabel(saveProfile) }],
          playerId,
        });
      }
      runSettings = runRuntime.settings;
    } catch (error) {
      saveLock.release();
      saveLockHeld = false;
      showFatalError(error, 'Unable to start Nuzlocke');
      return;
    }
  }
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) saveLock.release();
  });
  if (runSettings.mode === 'standard') {
    try {
      await ensureStandardSoloLobby();
    } catch (error) {
      console.warn('Standard local lobby could not be initialized; ordinary main-save play remains available', error);
    }
  }
  if (standardLobbyRequested) {
    renderStandardLobbyScreen();
    return;
  }
  boot().catch((error) => {
    console.error(error);
    stopRuntime(error, 'Unable to start');
  });
}

async function bootstrap() {
  if (libraryMode) {
    await showLibrary();
    return;
  }
  playShell.hidden = false;
  gameLibrary.hide();
  enterSoulLinkPregame();
  enterStandardLobby();
  await start();
}

bootstrap();
