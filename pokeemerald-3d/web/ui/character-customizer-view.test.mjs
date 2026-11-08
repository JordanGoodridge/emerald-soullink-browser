import test from 'node:test';
import assert from 'node:assert/strict';

import { createCharacterStore } from '../customization/character-store.mjs';
import { createCharacterCustomizerView } from './character-customizer-view.mjs';

function createMockElement(tagName = 'div', id = '') {
  const listeners = new Map();
  const children = [];
  const attributes = new Map();
  const classes = new Set();
  let lastImageData = null;

  return {
    tagName: tagName.toUpperCase(),
    id,
    dataset: {},
    style: {
      setProperty(k, v) { this[k] = v; },
    },
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      },
      contains: (name) => classes.has(name),
    },
    get className() { return [...classes].join(' '); },
    set className(val) {
      classes.clear();
      String(val || '').split(/\s+/).filter(Boolean).forEach((n) => classes.add(n));
    },
    textContent: '',
    value: '',
    disabled: false,
    open: false,
    children,
    append(...nodes) { children.push(...nodes); },
    replaceChildren(...nodes) {
      children.length = 0;
      children.push(...nodes);
    },
    setAttribute(name, val) { attributes.set(name, String(val)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    click() {
      for (const fn of listeners.get('click') ?? []) fn({ target: this });
    },
    showModal() { this.open = true; },
    close() {
      this.open = false;
      for (const fn of listeners.get('close') ?? []) fn({ target: this });
    },
    getContext() {
      return {
        clearRect() {},
        putImageData(img) { lastImageData = img; },
      };
    },
    get lastImageData() { return lastImageData; },
  };
}

function createMockDom() {
  const bySelector = new Map([
    ['#library-customize', createMockElement('button', 'library-customize')],
    ['#library-customize-icon', createMockElement('canvas', 'library-customize-icon')],
    ['#character-customizer-dialog', createMockElement('dialog', 'character-customizer-dialog')],
    ['#customizer-close', createMockElement('button', 'customizer-close')],
    ['#customizer-done', createMockElement('button', 'customizer-done')],
    ['#customizer-reset', createMockElement('button', 'customizer-reset')],
    ['#customizer-preview-canvas', createMockElement('canvas', 'customizer-preview-canvas')],
    ['#customizer-direction-label', createMockElement('span', 'customizer-direction-label')],
    ['#customizer-rotate-left', createMockElement('button', 'customizer-rotate-left')],
    ['#customizer-rotate-right', createMockElement('button', 'customizer-rotate-right')],
    ['#customizer-motion-walk', createMockElement('button', 'customizer-motion-walk')],
    ['#customizer-motion-run', createMockElement('button', 'customizer-motion-run')],
    ['#customizer-slot-tabs', createMockElement('div', 'customizer-slot-tabs')],
    ['#customizer-clothing-slots', createMockElement('div', 'customizer-clothing-slots')],
    ['#customizer-color-tabs', createMockElement('div', 'customizer-color-tabs')],
    ['#customizer-color-swatches', createMockElement('div', 'customizer-color-swatches')],
    ['#customizer-color-picker', createMockElement('input', 'customizer-color-picker')],
    ['#customizer-color-hex', createMockElement('code', 'customizer-color-hex')],
  ]);

  return {
    bySelector,
    document: {
      querySelector: (sel) => bySelector.get(sel) ?? null,
      createElement: (tag) => createMockElement(tag),
    },
  };
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

test('character customizer view opens from Main Menu, switches clothing & colors, and resets', () => {
  const { document, bySelector } = createMockDom();
  const storage = createMemoryStorage();
  const store = createCharacterStore({ storage });
  const events = [];

  const view = createCharacterCustomizerView({
    document,
    store,
    gameId: 'emerald',
    animationIntervalMs: 0,
    onChange: (compiled) => events.push(compiled),
  });

  // Main Menu mini-preview canvas and dialog preview canvas are drawn immediately:
  assert.ok(bySelector.get('#library-customize-icon').lastImageData);
  assert.ok(bySelector.get('#customizer-preview-canvas').lastImageData);
  assert.equal(bySelector.get('#customizer-reset').disabled, true);

  // Clicking #library-customize opens the modal:
  bySelector.get('#library-customize').click();
  assert.equal(bySelector.get('#character-customizer-dialog').open, true);

  // Select R/S Jacket in the 'top' slot via UI button:
  const topSlotGroup = bySelector.get('#customizer-clothing-slots').children[1];
  const topButtons = topSlotGroup.children[1].children;
  const rsJacketBtn = topButtons.find((btn) => btn.dataset.clothingItem === 'rs-jacket');
  assert.ok(rsJacketBtn);
  rsJacketBtn.click();

  assert.equal(view.getCustomization().equipped.top, 'rs-jacket');
  assert.equal(events.length, 1);
  assert.equal(bySelector.get('#customizer-reset').disabled, false);

  // Select Kitten Ears in the 'head' slot and Kitty Nose & Whiskers in the 'accessory' slot:
  const headSlotGroup = bySelector.get('#customizer-clothing-slots').children[0];
  const kittenEarsBtn = headSlotGroup.children[1].children.find(
    (btn) => btn.dataset.clothingItem === 'kitten-ears',
  );
  assert.ok(kittenEarsBtn);
  kittenEarsBtn.click();
  assert.equal(view.getCustomization().equipped.head, 'kitten-ears');

  const accessorySlotGroup = bySelector.get('#customizer-clothing-slots').children[3];
  const whiskersBtn = accessorySlotGroup.children[1].children.find(
    (btn) => btn.dataset.clothingItem === 'cat-whiskers',
  );
  assert.ok(whiskersBtn);
  whiskersBtn.click();
  assert.equal(view.getCustomization().equipped.accessory, 'cat-whiskers');

  // Verify only the active slot group ('accessory') is visible while others are collapsed:
  const slotGroups = bySelector.get('#customizer-clothing-slots').children;
  assert.equal(slotGroups[3].getAttribute('hidden'), null);
  assert.equal(slotGroups[0].getAttribute('hidden'), 'hidden');

  // Clicking the next stepper button (▶) on 'accessory' cycles to 'cool-shades':
  const accStepperNext = slotGroups[3].children[0].children[1].children[2];
  accStepperNext.click();
  assert.equal(view.getCustomization().equipped.accessory, 'cool-shades');

  // Switch color tab to 'accent' (Bandana & Bag) and click Ruby Gold swatch:
  const accentTab = bySelector.get('#customizer-color-tabs').children.find(
    (tab) => tab.dataset.colorAspect === 'accent',
  );
  assert.ok(accentTab);
  accentTab.click();

  const goldSwatch = bySelector.get('#customizer-color-swatches').children.find(
    (sw) => sw.dataset.swatchId === 'rs-gold',
  );
  assert.ok(goldSwatch);
  goldSwatch.click();
  assert.equal(view.getCustomization().colors.accent, '#ffc55a');
  assert.equal(bySelector.get('#customizer-color-hex').textContent, '#FFC55A');

  // Rotate character preview and toggle Run motion:
  bySelector.get('#customizer-rotate-right').click();
  assert.equal(bySelector.get('#customizer-direction-label').textContent, 'Left');
  bySelector.get('#customizer-motion-run').click();
  view.stepPreview();
  assert.equal(bySelector.get('#customizer-motion-run').getAttribute('aria-pressed'), 'true');

  // Reset returns to vanilla Emerald defaults:
  bySelector.get('#customizer-reset').click();
  assert.equal(view.getCustomization().equipped.top, 'emerald-tunic');
  assert.equal(view.getCustomization().colors.accent, '#73cd73');
  assert.equal(bySelector.get('#customizer-reset').disabled, true);

  bySelector.get('#customizer-done').click();
  assert.equal(bySelector.get('#character-customizer-dialog').open, false);
  view.destroy();
});
