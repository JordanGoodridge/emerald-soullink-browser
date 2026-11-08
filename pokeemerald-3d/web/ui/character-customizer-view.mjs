// Main Menu Character Customizer view controller.
//
// Renders clothing slots and color aspects dynamically from the active game's
// resolved character schema, drives the live animated 16x32 sprite preview,
// and persists changes via character-store.mjs.

import {
  normalizeHexColor,
  resolveCharacterSchema,
} from '../customization/character-catalog.mjs';
import {
  compileCharacterCustomization,
} from '../customization/character-compositor.mjs';
import {
  createCharacterStore,
  isDefaultCustomization,
} from '../customization/character-store.mjs';

const DIRECTION_ORDER = Object.freeze(['down', 'left', 'up', 'right']);
const DIRECTION_LABELS = Object.freeze({
  down: 'Front',
  left: 'Left',
  up: 'Back',
  right: 'Right',
});

// GBA 9-frame overworld sheet frame indices per direction:
// 0: down idle, 1: up idle, 2: side idle
// 3,4: down step L/R, 5,6: up step L/R, 7,8: side step L/R
const DIRECTION_CYCLES = Object.freeze({
  down: Object.freeze({ frames: [0, 3, 0, 4], hFlip: false }),
  up: Object.freeze({ frames: [1, 5, 1, 6], hFlip: false }),
  left: Object.freeze({ frames: [2, 7, 2, 8], hFlip: false }),
  right: Object.freeze({ frames: [2, 7, 2, 8], hFlip: true }),
});

function drawFrameToCanvas(canvas, sheetRgba, {
  frameIndex = 0,
  hFlip = false,
  frameWidth = 16,
  frameHeight = 32,
  frameCount = 9,
} = {}) {
  if (!canvas || !sheetRgba) return;
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return;

  const sheetWidth = frameWidth * frameCount;
  const clampedFrame = Math.max(0, Math.min(frameCount - 1, frameIndex | 0));
  const frameRgba = new Uint8ClampedArray(frameWidth * frameHeight * 4);

  for (let y = 0; y < frameHeight; y++) {
    for (let x = 0; x < frameWidth; x++) {
      const srcX = hFlip ? (frameWidth - 1 - x) : x;
      const srcIdx = (y * sheetWidth + clampedFrame * frameWidth + srcX) * 4;
      const dstIdx = (y * frameWidth + x) * 4;
      frameRgba[dstIdx] = sheetRgba[srcIdx];
      frameRgba[dstIdx + 1] = sheetRgba[srcIdx + 1];
      frameRgba[dstIdx + 2] = sheetRgba[srcIdx + 2];
      frameRgba[dstIdx + 3] = sheetRgba[srcIdx + 3];
    }
  }

  ctx.clearRect?.(0, 0, frameWidth, frameHeight);
  if (typeof ctx.putImageData === 'function') {
    if (typeof ImageData !== 'undefined') {
      ctx.putImageData(new ImageData(frameRgba, frameWidth, frameHeight), 0, 0);
    } else {
      ctx.putImageData({ data: frameRgba, width: frameWidth, height: frameHeight }, 0, 0);
    }
  }
}

export function createCharacterCustomizerView({
  document: doc = globalThis.document,
  store = createCharacterStore(),
  gameId: initialGameId = 'emerald',
  manifest: initialManifest = null,
  onChange = null,
  animationIntervalMs = 180,
} = {}) {
  const openButton = doc?.querySelector?.('#library-customize');
  const openButtonIcon = doc?.querySelector?.('#library-customize-icon');
  const dialog = doc?.querySelector?.('#character-customizer-dialog');
  const closeButton = doc?.querySelector?.('#customizer-close');
  const doneButton = doc?.querySelector?.('#customizer-done');
  const resetButton = doc?.querySelector?.('#customizer-reset');
  const previewCanvas = doc?.querySelector?.('#customizer-preview-canvas');
  const directionLabelEl = doc?.querySelector?.('#customizer-direction-label');
  const rotateLeftButton = doc?.querySelector?.('#customizer-rotate-left');
  const rotateRightButton = doc?.querySelector?.('#customizer-rotate-right');
  const motionWalkButton = doc?.querySelector?.('#customizer-motion-walk');
  const motionRunButton = doc?.querySelector?.('#customizer-motion-run');
  const slotsContainer = doc?.querySelector?.('#customizer-clothing-slots');
  const aspectTabsContainer = doc?.querySelector?.('#customizer-color-tabs');
  const swatchesContainer = doc?.querySelector?.('#customizer-color-swatches');
  const colorPickerInput = doc?.querySelector?.('#customizer-color-picker');
  const colorHexValueEl = doc?.querySelector?.('#customizer-color-hex');

  let activeGameId = initialGameId;
  let activeManifest = initialManifest;
  let schema = resolveCharacterSchema({ gameId: activeGameId, manifest: activeManifest });
  let customization = store.load({ gameId: activeGameId, rigId: schema.id, manifest: activeManifest });
  let compiled = compileCharacterCustomization(customization, {
    gameId: activeGameId,
    rigId: schema.id,
    manifest: activeManifest,
    schema,
  });

  let activeAspectId = schema.colorAspects?.[0]?.id ?? 'top';
  let directionIndex = 0;
  let motion = 'walk';
  let animTick = 0;
  let animTimer = null;

  function currentDirection() {
    return DIRECTION_ORDER[directionIndex % DIRECTION_ORDER.length] ?? 'down';
  }

  function renderPreview() {
    const dir = currentDirection();
    const cycle = DIRECTION_CYCLES[dir] ?? DIRECTION_CYCLES.down;
    const frameIndex = cycle.frames[animTick % cycle.frames.length] ?? 0;
    const sheetRgba = motion === 'run' ? compiled.runningRgba : compiled.walkingRgba;

    drawFrameToCanvas(previewCanvas, sheetRgba, {
      frameIndex,
      hFlip: cycle.hFlip,
      frameWidth: compiled.frameWidth,
      frameHeight: compiled.frameHeight,
      frameCount: compiled.frameCount,
    });

    drawFrameToCanvas(openButtonIcon, compiled.walkingRgba, {
      frameIndex: 0,
      hFlip: false,
      frameWidth: compiled.frameWidth,
      frameHeight: compiled.frameHeight,
      frameCount: compiled.frameCount,
    });

    if (directionLabelEl) {
      directionLabelEl.textContent = DIRECTION_LABELS[dir] ?? 'Front';
    }
    if (motionWalkButton) {
      motionWalkButton.setAttribute('aria-pressed', String(motion === 'walk'));
      motionWalkButton.classList?.toggle?.('is-active', motion === 'walk');
    }
    if (motionRunButton) {
      motionRunButton.setAttribute('aria-pressed', String(motion === 'run'));
      motionRunButton.classList?.toggle?.('is-active', motion === 'run');
    }
    if (resetButton) {
      resetButton.disabled = isDefaultCustomization(customization, schema);
    }
  }

  function renderSlots() {
    if (!slotsContainer) return;
    slotsContainer.replaceChildren();

    for (const slot of schema.clothingSlots ?? []) {
      const group = doc.createElement('div');
      group.className = 'customizer-slot-group';

      const heading = doc.createElement('h4');
      heading.className = 'customizer-slot-heading';
      heading.textContent = slot.label;
      group.append(heading);

      const optionsRow = doc.createElement('div');
      optionsRow.className = 'customizer-slot-options';
      optionsRow.setAttribute('role', 'group');
      optionsRow.setAttribute('aria-label', slot.label);

      const equippedId = customization.equipped?.[slot.id] ?? slot.defaultItemId;
      for (const item of slot.items ?? []) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        const isSelected = item.id === equippedId;
        btn.className = `customizer-item-btn${isSelected ? ' is-selected' : ''}`;
        btn.dataset.clothingSlot = slot.id;
        btn.dataset.clothingItem = item.id;
        btn.setAttribute('aria-pressed', String(isSelected));

        const title = doc.createElement('strong');
        title.textContent = item.label;
        btn.append(title);

        if (item.description) {
          const desc = doc.createElement('span');
          desc.textContent = item.description;
          btn.append(desc);
        }

        btn.addEventListener('click', () => {
          selectClothingItem(slot.id, item.id);
        });
        optionsRow.append(btn);
      }

      group.append(optionsRow);
      slotsContainer.append(group);
    }
  }

  function renderColorControls() {
    const aspects = schema.colorAspects ?? [];
    if (!aspects.some((entry) => entry.id === activeAspectId)) {
      activeAspectId = aspects[0]?.id ?? '';
    }
    const activeAspect = aspects.find((entry) => entry.id === activeAspectId) ?? aspects[0];

    if (aspectTabsContainer) {
      aspectTabsContainer.replaceChildren();
      for (const aspect of aspects) {
        const tab = doc.createElement('button');
        tab.type = 'button';
        const isSelected = aspect.id === activeAspect?.id;
        tab.className = `customizer-aspect-tab${isSelected ? ' is-active' : ''}`;
        tab.dataset.colorAspect = aspect.id;
        tab.setAttribute('aria-pressed', String(isSelected));

        const dot = doc.createElement('span');
        dot.className = 'customizer-aspect-dot';
        const currentHex = normalizeHexColor(customization.colors?.[aspect.id], aspect.defaultHex);
        dot.style?.setProperty?.('--swatch-color', currentHex);
        if (dot.style) dot.style.backgroundColor = currentHex;

        const label = doc.createElement('span');
        label.textContent = aspect.label;

        tab.append(dot, label);
        tab.addEventListener('click', () => {
          activeAspectId = aspect.id;
          renderColorControls();
        });
        aspectTabsContainer.append(tab);
      }
    }

    if (!activeAspect) return;
    const activeHex = normalizeHexColor(customization.colors?.[activeAspect.id], activeAspect.defaultHex);

    if (swatchesContainer) {
      swatchesContainer.replaceChildren();
      for (const swatch of activeAspect.swatches ?? []) {
        const swatchHex = normalizeHexColor(swatch.hex);
        const isSelected = swatchHex === activeHex;
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = `customizer-swatch-btn${isSelected ? ' is-selected' : ''}`;
        btn.dataset.colorSwatch = swatchHex;
        btn.dataset.swatchId = swatch.id;
        btn.setAttribute('aria-label', `${activeAspect.label}: ${swatch.label}`);
        btn.setAttribute('aria-pressed', String(isSelected));
        btn.title = swatch.label;

        const chip = doc.createElement('span');
        chip.className = 'customizer-swatch-chip';
        if (chip.style) chip.style.backgroundColor = swatchHex;

        const name = doc.createElement('span');
        name.className = 'customizer-swatch-label';
        name.textContent = swatch.label;

        btn.append(chip, name);
        btn.addEventListener('click', () => {
          selectColor(activeAspect.id, swatchHex);
        });
        swatchesContainer.append(btn);
      }
    }

    if (colorPickerInput) {
      colorPickerInput.value = activeHex;
    }
    if (colorHexValueEl) {
      colorHexValueEl.textContent = activeHex.toUpperCase();
    }
  }

  function renderAll() {
    renderSlots();
    renderColorControls();
    renderPreview();
  }

  function commitCustomization(nextCustomization) {
    customization = store.save(nextCustomization, {
      gameId: activeGameId,
      rigId: schema.id,
      manifest: activeManifest,
    });
    compiled = compileCharacterCustomization(customization, {
      gameId: activeGameId,
      rigId: schema.id,
      manifest: activeManifest,
      schema,
    });
    renderAll();
    onChange?.(compiled);
    return compiled;
  }

  function selectClothingItem(slotId, itemId) {
    return commitCustomization({
      ...customization,
      equipped: {
        ...(customization.equipped ?? {}),
        [slotId]: itemId,
      },
    });
  }

  function selectColor(aspectId, hexColor) {
    return commitCustomization({
      ...customization,
      colors: {
        ...(customization.colors ?? {}),
        [aspectId]: normalizeHexColor(hexColor),
      },
    });
  }

  function resetToDefault() {
    customization = store.reset({
      gameId: activeGameId,
      rigId: schema.id,
      manifest: activeManifest,
    });
    compiled = compileCharacterCustomization(customization, {
      gameId: activeGameId,
      rigId: schema.id,
      manifest: activeManifest,
      schema,
    });
    renderAll();
    onChange?.(compiled);
    return compiled;
  }

  function startAnimation() {
    stopAnimation();
    if (animationIntervalMs > 0 && typeof globalThis.setInterval === 'function') {
      animTimer = globalThis.setInterval(() => {
        stepPreview();
      }, animationIntervalMs);
    }
  }

  function stopAnimation() {
    if (animTimer !== null) {
      globalThis.clearInterval?.(animTimer);
      animTimer = null;
    }
  }

  function stepPreview() {
    animTick = (animTick + 1) % 4;
    renderPreview();
  }

  function open({ gameId: nextGameId, manifest: nextManifest } = {}) {
    if (nextGameId || nextManifest) {
      setGameContext({ gameId: nextGameId ?? activeGameId, manifest: nextManifest ?? activeManifest });
    }
    renderAll();
    if (dialog) {
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
      } else {
        dialog.open = true;
        dialog.removeAttribute?.('hidden');
      }
    }
    startAnimation();
  }

  function close() {
    stopAnimation();
    animTick = 0;
    renderPreview();
    if (dialog) {
      if (typeof dialog.close === 'function' && dialog.open) {
        dialog.close();
      } else {
        dialog.open = false;
      }
    }
  }

  function setGameContext({ gameId: nextGameId = activeGameId, manifest: nextManifest = null } = {}) {
    activeGameId = nextGameId || 'emerald';
    activeManifest = nextManifest;
    schema = resolveCharacterSchema({ gameId: activeGameId, manifest: activeManifest });
    customization = store.load({ gameId: activeGameId, rigId: schema.id, manifest: activeManifest });
    compiled = compileCharacterCustomization(customization, {
      gameId: activeGameId,
      rigId: schema.id,
      manifest: activeManifest,
      schema,
    });
    renderAll();
    return compiled;
  }

  openButton?.addEventListener('click', () => open());
  closeButton?.addEventListener('click', () => close());
  doneButton?.addEventListener('click', () => close());
  dialog?.addEventListener('close', () => stopAnimation());
  resetButton?.addEventListener('click', () => resetToDefault());

  rotateLeftButton?.addEventListener('click', () => {
    directionIndex = (directionIndex + DIRECTION_ORDER.length - 1) % DIRECTION_ORDER.length;
    renderPreview();
  });
  rotateRightButton?.addEventListener('click', () => {
    directionIndex = (directionIndex + 1) % DIRECTION_ORDER.length;
    renderPreview();
  });
  motionWalkButton?.addEventListener('click', () => {
    motion = 'walk';
    animTick = 0;
    renderPreview();
  });
  motionRunButton?.addEventListener('click', () => {
    motion = 'run';
    animTick = 0;
    renderPreview();
  });
  colorPickerInput?.addEventListener('input', (event) => {
    const val = event?.target?.value;
    if (val && activeAspectId) {
      selectColor(activeAspectId, val);
    }
  });

  renderAll();

  return {
    open,
    close,
    setGameContext,
    selectClothingItem,
    selectColor,
    resetToDefault,
    stepPreview,
    getCompiled: () => compiled,
    getCustomization: () => customization,
    getSchema: () => schema,
    destroy() {
      stopAnimation();
    },
  };
}
