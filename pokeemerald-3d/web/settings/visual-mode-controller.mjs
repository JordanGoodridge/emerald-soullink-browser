// Visual mode (HD-2D vs Classic), smooth shader transition, render scale,
// and settings dialog bindings extracted from app.js.

import { describeBindings } from './keymap.mjs';

const RENDER_SCALE_STORAGE_KEY = 'pokeemerald.wasm.renderScale.v1';
const VISUAL_SETTINGS_STORAGE_KEY = 'pokeemerald.wasm.visualSettings.v1';
const DEFAULT_RENDER_SCALE = 4;
const DEFAULT_SHADING_STRENGTH = 0.50;
const DEFAULT_PERSPECTIVE_STRENGTH = 0.50;
const DEFAULT_ZOOM_STRENGTH = 1.00;
const DEFAULT_OPTICS_STRENGTH = 0.50;
const RENDER_SCALES = [1, 2, 3, 4, 6, 8];
const VISUAL_MODE_TRANSITION_MS = 4000;

function clampSetting(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

export function createVisualModeController({
  width = 240,
  height = 160,
  automate = false,
  params = {},
  reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)'),
  settings,
  elements = {},
  getInstance = () => null,
  getSceneAdapter = () => null,
  getPresenter = () => null,
  isPresenterRecovering = () => false,
  hasImage = () => false,
  getCurrentFrame = () => 0,
  onRender = () => {},
  onReleaseAllKeys = () => {},
  onPartySharedChanged = () => {},
  onSettingsChanged = () => {},
  onClosePresenceLobby = () => {},
} = {}) {
  const {
    renderScaleParam = null,
    visualModeParam = null,
    shadingParam = null,
    perspectiveParam = null,
    zoomParam = null,
    opticsParam = null,
  } = params;

  const {
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
  } = elements;

  let renderScale = DEFAULT_RENDER_SCALE;
  let visualMode = 'hd2d';
  let activeVisualMode = 'hd2d';
  let shadingStrength = DEFAULT_SHADING_STRENGTH;
  let perspectiveStrength = DEFAULT_PERSPECTIVE_STRENGTH;
  let zoomStrength = DEFAULT_ZOOM_STRENGTH;
  let opticsStrength = DEFAULT_OPTICS_STRENGTH;
  let renderedShadingStrength = shadingStrength;
  let renderedOpticsStrength = opticsStrength;
  let visualModeTransition = null;

  function renderBindingsTable(scheme) {
    if (!settingsBindingsBody) return;
    settingsBindingsBody.replaceChildren(...describeBindings(scheme).map((row) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = row.action;
      const td = document.createElement('td');
      td.textContent = row.keys;
      tr.append(th, td);
      return tr;
    }));
  }

  function renderSettingsUi() {
    const current = settings.get();
    onPartySharedChanged(current.partyShared !== false, false);
    if (settingsSchemeSelect) settingsSchemeSelect.value = current.controlScheme;
    if (settingsNameTags) settingsNameTags.checked = current.peerNameTags;
    if (settingsIndicators) settingsIndicators.checked = current.peerIndicators;
    if (settingsIcons) settingsIcons.checked = current.peerIcons;
    if (settingsPeopleMap) settingsPeopleMap.checked = current.peopleMap;
    if (settingsPartyShared) settingsPartyShared.checked = current.partyShared;
    renderBindingsTable(current.controlScheme);
    if (keysHelp) {
      const move = current.controlScheme === 'wasd' ? 'WASD' : 'arrows';
      keysHelp.textContent = `Keyboard (${move}): Z=A, X=B, Q/E=L/R, Enter=Start, Shift=Select, M=world map.`;
    }
  }

  function openSettingsDialog() {
    renderSettingsUi();
    if (settingsDialog && !settingsDialog.open && typeof settingsDialog.showModal === 'function') {
      settingsDialog.showModal();
    }
  }

  function storedRenderScale() {
    const requested = Number(renderScaleParam);
    if (RENDER_SCALES.includes(requested)) return requested;

    try {
      const stored = Number(localStorage.getItem(RENDER_SCALE_STORAGE_KEY));
      if (RENDER_SCALES.includes(stored)) return stored;
    } catch {
      // Storage may be disabled; use the default render scale.
    }
    return DEFAULT_RENDER_SCALE;
  }

  function setRenderScale(value, persist = true) {
    const parsed = Number(value);
    renderScale = RENDER_SCALES.includes(parsed) ? parsed : DEFAULT_RENDER_SCALE;
    if (canvas) {
      canvas.width = width * renderScale;
      canvas.height = height * renderScale;
    }
    if (!isPresenterRecovering()) getPresenter()?.resize(renderScale);
    if (renderScaleSelect) renderScaleSelect.value = String(renderScale);

    if (persist) {
      try {
        localStorage.setItem(RENDER_SCALE_STORAGE_KEY, String(renderScale));
      } catch {
        // Keep the setting for this session when storage is unavailable.
      }
    }
    if (hasImage()) onRender();
  }

  function storedVisualSettings() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(VISUAL_SETTINGS_STORAGE_KEY) || '{}');
    } catch {
      // Ignore corrupt or unavailable browser storage.
    }
    return {
      mode: visualModeParam === 'classic' || visualModeParam === 'hd2d'
        ? visualModeParam
        : (stored.mode === 'classic' ? 'classic' : 'hd2d'),
      shading: clampSetting(shadingParam ?? stored.shading, DEFAULT_SHADING_STRENGTH),
      perspective: clampSetting(perspectiveParam ?? stored.perspective, DEFAULT_PERSPECTIVE_STRENGTH),
      zoom: clampSetting(zoomParam ?? stored.zoom, DEFAULT_ZOOM_STRENGTH),
      optics: clampSetting(opticsParam ?? stored.optics, DEFAULT_OPTICS_STRENGTH),
    };
  }

  function setActiveVisualMode(mode) {
    if (activeVisualMode === mode) return;
    activeVisualMode = mode;
    const instance = getInstance();
    if (!instance) return;
    getSceneAdapter()?.setMode?.(instance, activeVisualMode);
  }

  function visualModeTransitionNow() {
    return automate ? getCurrentFrame() * 1000 / 60 : performance.now();
  }

  function updateVisualModeTransition(now = visualModeTransitionNow()) {
    if (!visualModeTransition) return;
    if (visualModeTransition.startedAt === null) {
      visualModeTransition.startedAt = now;
    }
    const durationMs = visualModeTransition.durationMs;
    const progress = durationMs <= 0 ? 1 : Math.min(1, Math.max(0,
      (now - visualModeTransition.startedAt) / durationMs));
    const blend = progress * progress * (3 - 2 * progress);
    renderedShadingStrength = visualModeTransition.fromShading
      + (visualModeTransition.toShading - visualModeTransition.fromShading) * blend;
    renderedOpticsStrength = visualModeTransition.fromOptics
      + (visualModeTransition.toOptics - visualModeTransition.fromOptics) * blend;
    if (progress < 1) return;

    renderedShadingStrength = visualModeTransition.toShading;
    renderedOpticsStrength = visualModeTransition.toOptics;
    visualModeTransition = null;
  }

  function beginVisualModeTransition(mode, now = visualModeTransitionNow()) {
    updateVisualModeTransition(now);
    if (mode === 'classic') {
      visualModeTransition = null;
      renderedShadingStrength = 0;
      renderedOpticsStrength = 0;
      setActiveVisualMode('classic');
      return;
    }
    if (activeVisualMode === 'classic') {
      renderedShadingStrength = 0;
      renderedOpticsStrength = 0;
      setActiveVisualMode('hd2d');
    }
    if (reducedMotionQuery.matches) {
      visualModeTransition = null;
      renderedShadingStrength = shadingStrength;
      renderedOpticsStrength = opticsStrength;
      return;
    }
    visualModeTransition = {
      startedAt: null,
      durationMs: VISUAL_MODE_TRANSITION_MS,
      fromShading: renderedShadingStrength,
      fromOptics: renderedOpticsStrength,
      toShading: shadingStrength,
      toOptics: opticsStrength,
    };
  }

  function setVisualSettings(nextSettings, persist = true, animate = true) {
    const now = visualModeTransitionNow();
    updateVisualModeTransition(now);
    const nextVisualMode = nextSettings.mode === 'classic' ? 'classic' : 'hd2d';
    const modeChanged = visualMode !== nextVisualMode;
    visualMode = nextVisualMode;
    shadingStrength = clampSetting(nextSettings.shading, shadingStrength);
    perspectiveStrength = clampSetting(nextSettings.perspective, perspectiveStrength);
    zoomStrength = clampSetting(nextSettings.zoom, zoomStrength);
    opticsStrength = clampSetting(nextSettings.optics, opticsStrength);

    const instance = getInstance();
    if (!instance) {
      activeVisualMode = visualMode;
      visualModeTransition = null;
      renderedShadingStrength = visualMode === 'hd2d' ? shadingStrength : 0;
      renderedOpticsStrength = visualMode === 'hd2d' ? opticsStrength : 0;
    } else if (modeChanged && animate) {
      beginVisualModeTransition(visualMode, now);
    } else if (modeChanged) {
      visualModeTransition = null;
      if (visualMode === 'hd2d' && activeVisualMode === 'classic') {
        renderedShadingStrength = 0;
        renderedOpticsStrength = 0;
        setActiveVisualMode('hd2d');
      }
      renderedShadingStrength = visualMode === 'hd2d' ? shadingStrength : 0;
      renderedOpticsStrength = visualMode === 'hd2d' ? opticsStrength : 0;
      setActiveVisualMode(visualMode);
    } else if (!visualModeTransition && activeVisualMode === 'hd2d') {
      renderedShadingStrength = shadingStrength;
      renderedOpticsStrength = opticsStrength;
    } else if (visualModeTransition) {
      const previousTransition = visualModeTransition;
      const endsAt = previousTransition.startedAt === null
        ? now + previousTransition.durationMs
        : previousTransition.startedAt + previousTransition.durationMs;
      visualModeTransition = {
        startedAt: now,
        durationMs: Math.max(0, endsAt - now),
        fromShading: renderedShadingStrength,
        fromOptics: renderedOpticsStrength,
        toShading: shadingStrength,
        toOptics: opticsStrength,
      };
    } else if (activeVisualMode === 'classic') {
      renderedShadingStrength = 0;
      renderedOpticsStrength = 0;
    }

    if (visualModeSelect) visualModeSelect.value = visualMode;
    if (shadingInput) shadingInput.value = String(Math.round(shadingStrength * 100));
    if (depthInput) depthInput.value = String(Math.round(perspectiveStrength * 100));
    if (zoomInput) zoomInput.value = String(Math.round(zoomStrength * 100));
    if (opticsInput) opticsInput.value = String(Math.round(opticsStrength * 100));
    if (shadingValue) shadingValue.textContent = `${Math.round(shadingStrength * 100)}%`;
    if (depthValue) depthValue.textContent = `${Math.round(perspectiveStrength * 100)}%`;
    if (zoomValue) zoomValue.textContent = `${Math.round(zoomStrength * 100)}%`;
    if (opticsValue) opticsValue.textContent = `${Math.round(opticsStrength * 100)}%`;
    if (persist) {
      try {
        localStorage.setItem(VISUAL_SETTINGS_STORAGE_KEY, JSON.stringify({
          mode: visualMode,
          shading: shadingStrength,
          perspective: perspectiveStrength,
          zoom: zoomStrength,
          optics: opticsStrength,
        }));
      } catch {
        // Keep settings for this session when storage is unavailable.
      }
    }
    if (hasImage() && getPresenter()) onRender();
  }

  function applyCapabilities(manifest) {
    const modes = manifest?.rendering?.modes ?? ['classic'];
    if (visualModeSelect) {
      for (const option of visualModeSelect.querySelectorAll('option')) {
        if (!modes.includes(option.value)) option.remove();
      }
      if (!modes.includes(visualMode)) {
        setVisualSettings({
          mode: modes[0],
          shading: shadingStrength,
          perspective: perspectiveStrength,
          zoom: zoomStrength,
          optics: opticsStrength,
        }, false, false);
      }
    }
    if (manifest?.capabilities?.presence === 'none') {
      const presenceToggle = document.querySelector('#presence-toggle');
      if (presenceToggle) presenceToggle.hidden = true;
      onClosePresenceLobby();
    }
  }

  function bindSettingToggle(element, key) {
    if (!element) return;
    element.addEventListener('change', () => settings.set({ [key]: element.checked }));
  }

  function init() {
    librarySettingsButton?.addEventListener('click', () => openSettingsDialog());
    if (settingsButton) settingsButton.addEventListener('click', openSettingsDialog);

    if (settingsSchemeSelect) {
      settingsSchemeSelect.addEventListener('change', () => {
        onReleaseAllKeys();
        settings.set({ controlScheme: settingsSchemeSelect.value });
      });
    }

    bindSettingToggle(settingsNameTags, 'peerNameTags');
    bindSettingToggle(settingsIndicators, 'peerIndicators');
    bindSettingToggle(settingsIcons, 'peerIcons');
    bindSettingToggle(settingsPeopleMap, 'peopleMap');
    settingsPartyShared?.addEventListener('change', () => {
      const nextShared = settingsPartyShared.checked;
      onPartySharedChanged(nextShared, true);
      settings.set({ partyShared: nextShared });
    });

    settings.subscribe(() => {
      renderSettingsUi();
      onSettingsChanged();
    }, { immediate: false });

    renderSettingsUi();
    setRenderScale(storedRenderScale(), false);
    setVisualSettings(storedVisualSettings(), false);

    renderScaleSelect?.addEventListener('change', () => setRenderScale(renderScaleSelect.value));
    visualModeSelect?.addEventListener('change', () => setVisualSettings({
      mode: visualModeSelect.value,
      shading: shadingStrength,
      perspective: perspectiveStrength,
      zoom: zoomStrength,
      optics: opticsStrength,
    }));
    shadingInput?.addEventListener('input', () => setVisualSettings({
      mode: visualMode,
      shading: Number(shadingInput.value) / 100,
      perspective: perspectiveStrength,
      zoom: zoomStrength,
      optics: opticsStrength,
    }));
    depthInput?.addEventListener('input', () => setVisualSettings({
      mode: visualMode,
      shading: shadingStrength,
      perspective: Number(depthInput.value) / 100,
      zoom: zoomStrength,
      optics: opticsStrength,
    }));
    zoomInput?.addEventListener('input', () => setVisualSettings({
      mode: visualMode,
      shading: shadingStrength,
      perspective: perspectiveStrength,
      zoom: Number(zoomInput.value) / 100,
      optics: opticsStrength,
    }));
    opticsInput?.addEventListener('input', () => setVisualSettings({
      mode: visualMode,
      shading: shadingStrength,
      perspective: perspectiveStrength,
      zoom: zoomStrength,
      optics: Number(opticsInput.value) / 100,
    }));
  }

  return {
    get renderScale() { return renderScale; },
    get visualMode() { return visualMode; },
    get activeVisualMode() { return activeVisualMode; },
    get shadingStrength() { return shadingStrength; },
    get perspectiveStrength() { return perspectiveStrength; },
    get zoomStrength() { return zoomStrength; },
    get opticsStrength() { return opticsStrength; },
    get renderedShadingStrength() { return renderedShadingStrength; },
    get renderedOpticsStrength() { return renderedOpticsStrength; },
    get visualModeTransition() { return visualModeTransition; },
    init,
    renderSettingsUi,
    openSettingsDialog,
    setRenderScale,
    setVisualSettings,
    updateVisualModeTransition,
    applyCapabilities,
  };
}
