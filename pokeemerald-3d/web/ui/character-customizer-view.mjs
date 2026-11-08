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
  const slotTabsContainer = doc?.querySelector?.('#customizer-slot-tabs');
  const slotsContainer = doc?.querySelector?.('#customizer-clothing-slots');
  const colorsHeadingEl = doc?.querySelector?.('#customizer-colors-heading');
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

  let activeSlotId = schema.clothingSlots?.[0]?.id ?? 'head';
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
    const slots = schema.clothingSlots ?? [];
    if (!slots.some((entry) => entry.id === activeSlotId)) {
      activeSlotId = slots[0]?.id ?? '';
    }

    if (slotTabsContainer) {
      slotTabsContainer.replaceChildren();
      for (const slot of slots) {
        const items = slot.items ?? [];
        const equippedId = customization.equipped?.[slot.id] ?? slot.defaultItemId;
        const equippedItem = items.find((entry) => entry.id === equippedId) ?? items[0];
        const isActive = slot.id === activeSlotId;

        const tab = doc.createElement('button');
        tab.type = 'button';
        tab.className = `customizer-slot-tab${isActive ? ' is-active' : ''}`;
        tab.dataset.slotTab = slot.id;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(isActive));

        const slotTitle = doc.createElement('span');
        slotTitle.className = 'customizer-slot-tab-label';
        slotTitle.textContent = slot.label;

        const equippedBadge = doc.createElement('small');
        equippedBadge.className = 'customizer-slot-tab-value';
        equippedBadge.textContent = equippedItem?.label ?? '';

        tab.append(slotTitle, equippedBadge);
        tab.addEventListener('click', () => {
          activeSlotId = slot.id;
          renderAll();
        });
        slotTabsContainer.append(tab);
      }
    }

    if (!slotsContainer) return;
    slotsContainer.replaceChildren();

    for (const slot of slots) {
      const items = slot.items ?? [];
      const equippedId = customization.equipped?.[slot.id] ?? slot.defaultItemId;
      const equippedIndex = Math.max(0, items.findIndex((entry) => entry.id === equippedId));
      const equippedItem = items[equippedIndex] ?? items[0];
      const isActiveSlot = slot.id === activeSlotId;

      const group = doc.createElement('div');
      group.className = `customizer-slot-group${isActiveSlot ? ' is-active' : ' is-collapsed'}`;
      group.dataset.slotGroup = slot.id;
      if (!isActiveSlot) {
        group.setAttribute('hidden', 'hidden');
      }

      const heading = doc.createElement('div');
      heading.className = 'customizer-slot-heading';

      const headingMeta = doc.createElement('div');
      headingMeta.className = 'customizer-slot-meta';

      const headingTitle = doc.createElement('strong');
      headingTitle.className = 'customizer-slot-title';
      headingTitle.textContent = `${slot.label}: ${equippedItem?.label ?? ''}`;
      headingMeta.append(headingTitle);

      if (equippedItem?.description) {
        const headingDesc = doc.createElement('span');
        headingDesc.className = 'customizer-slot-active-desc';
        headingDesc.textContent = equippedItem.description;
        headingMeta.append(headingDesc);
      }

      const stepper = doc.createElement('div');
      stepper.className = 'customizer-slot-stepper';

      const prevBtn = doc.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'customizer-stepper-btn';
      prevBtn.dataset.slotCycle = 'prev';
      prevBtn.setAttribute('aria-label', `Previous ${slot.label}`);
      prevBtn.textContent = '◀';
      prevBtn.addEventListener('click', () => {
        if (!items.length) return;
        const prevIdx = (equippedIndex + items.length - 1) % items.length;
        selectClothingItem(slot.id, items[prevIdx].id);
      });

      const countBadge = doc.createElement('span');
      countBadge.className = 'customizer-stepper-count';
      countBadge.textContent = `${equippedIndex + 1} / ${items.length}`;

      const nextBtn = doc.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'customizer-stepper-btn';
      nextBtn.dataset.slotCycle = 'next';
      nextBtn.setAttribute('aria-label', `Next ${slot.label}`);
      nextBtn.textContent = '▶';
      nextBtn.addEventListener('click', () => {
        if (!items.length) return;
        const nextIdx = (equippedIndex + 1) % items.length;
        selectClothingItem(slot.id, items[nextIdx].id);
      });

      stepper.append(prevBtn, countBadge, nextBtn);
      heading.append(headingMeta, stepper);
      group.append(heading);

      const optionsRow = doc.createElement('div');
      optionsRow.className = 'customizer-slot-options';
      optionsRow.setAttribute('role', 'group');
      optionsRow.setAttribute('aria-label', slot.label);

      for (const item of items) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        const isSelected = item.id === equippedId;
        btn.className = `customizer-item-btn${isSelected ? ' is-selected' : ''}`;
        btn.dataset.clothingSlot = slot.id;
        btn.dataset.clothingItem = item.id;
        btn.setAttribute('aria-pressed', String(isSelected));
        if (item.description) {
          btn.title = item.description;
        }

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

  function getActiveSlotColorContext() {
    const slots = schema.clothingSlots ?? [];
    const activeSlot = slots.find((entry) => entry.id === activeSlotId) ?? slots[0];
    const items = activeSlot?.items ?? [];
    const equippedId = customization.equipped?.[activeSlot?.id] ?? activeSlot?.defaultItemId;
    const equippedItem = items.find((entry) => entry.id === equippedId) ?? items[0];
    const channels = Array.isArray(equippedItem?.colorChannels) && equippedItem.colorChannels.length > 0
      ? equippedItem.colorChannels
      : (schema.colorAspects ?? []).map((aspect) => ({ aspectId: aspect.id, label: aspect.label }));
    return { activeSlot, equippedItem, channels };
  }

  function renderColorControls({ preserveAspect = false } = {}) {
    const aspects = schema.colorAspects ?? [];
    const { equippedItem, channels } = getActiveSlotColorContext();
    const channelMap = new Map(channels.map((ch) => [ch.aspectId, ch.label]));

    if (!preserveAspect && channels.length > 0 && !channelMap.has(activeAspectId)) {
      activeAspectId = channels[0].aspectId;
    }
    if (!aspects.some((entry) => entry.id === activeAspectId)) {
      activeAspectId = channels[0]?.aspectId ?? aspects[0]?.id ?? '';
    }
    const activeAspect = aspects.find((entry) => entry.id === activeAspectId) ?? aspects[0];
    const activeChannelLabel = channelMap.get(activeAspect?.id) ?? activeAspect?.label ?? 'Colors';

    if (colorsHeadingEl) {
      colorsHeadingEl.textContent = equippedItem?.label && equippedItem.id !== 'none'
        ? `${equippedItem.label} — ${activeChannelLabel}`
        : activeChannelLabel;
    }

    if (aspectTabsContainer) {
      aspectTabsContainer.replaceChildren();
      // Order contextual channels for the selected item first, followed by hidden fallback tabs:
      const orderedAspects = [
        ...channels.map((ch) => aspects.find((a) => a.id === ch.aspectId)).filter(Boolean),
        ...aspects.filter((a) => !channelMap.has(a.id)),
      ];
      for (const aspect of orderedAspects) {
        const isContextual = channelMap.has(aspect.id);
        const tab = doc.createElement('button');
        tab.type = 'button';
        const isSelected = aspect.id === activeAspect?.id;
        tab.className = `customizer-aspect-tab${isSelected ? ' is-active' : ''}${isContextual ? '' : ' is-contextual-hidden'}`;
        tab.dataset.colorAspect = aspect.id;
        tab.setAttribute('aria-pressed', String(isSelected));
        if (!isContextual) {
          tab.setAttribute('hidden', 'hidden');
        }

        const dot = doc.createElement('span');
        dot.className = 'customizer-aspect-dot';
        const currentHex = normalizeHexColor(customization.colors?.[aspect.id], aspect.defaultHex);
        dot.style?.setProperty?.('--swatch-color', currentHex);
        if (dot.style) dot.style.backgroundColor = currentHex;

        const label = doc.createElement('span');
        label.textContent = channelMap.get(aspect.id) ?? aspect.label;

        tab.append(dot, label);
        tab.addEventListener('click', () => {
          activeAspectId = aspect.id;
          renderColorControls({ preserveAspect: true });
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
        btn.setAttribute('aria-label', `${activeChannelLabel}: ${swatch.label}`);
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

  function renderAll({ preserveAspect = false } = {}) {
    renderSlots();
    renderColorControls({ preserveAspect });
    renderPreview();
  }

  function commitCustomization(nextCustomization, { preserveAspect = false } = {}) {
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
    renderAll({ preserveAspect });
    onChange?.(compiled);
    return compiled;
  }

  function selectClothingItem(slotId, itemId) {
    activeSlotId = slotId;
    return commitCustomization({
      ...customization,
      equipped: {
        ...(customization.equipped ?? {}),
        [slotId]: itemId,
      },
    }, { preserveAspect: false });
  }

  function selectColor(aspectId, hexColor) {
    activeAspectId = aspectId;
    return commitCustomization({
      ...customization,
      colors: {
        ...(customization.colors ?? {}),
        [aspectId]: normalizeHexColor(hexColor),
      },
    }, { preserveAspect: true });
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
