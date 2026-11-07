import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPartyPanel } from '../presence/party-panel-model.mjs';
import { renderPartyPanelInto } from './party-panel.mjs';

function createFakeDoc() {
  const makeEl = (tag) => ({
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    dataset: {},
    attributes: {},
    children: [],
    listeners: {},
    classList: {
      classes: new Set(),
      toggle(cls, force) {
        const shouldHave = force === undefined ? !this.classes.has(cls) : Boolean(force);
        if (shouldHave) this.classes.add(cls);
        else this.classes.delete(cls);
      },
      contains(cls) {
        return this.classes.has(cls);
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
    addEventListener(event, fn) {
      this.listeners[event] = fn;
    },
  });
  return { createElement: makeEl };
}

function findAll(root, predicate, out = []) {
  if (!root) return out;
  if (predicate(root)) out.push(root);
  for (const child of root.children ?? []) {
    findAll(child, predicate, out);
  }
  return out;
}

function collectText(node) {
  if (!node) return '';
  if (!node.children || !node.children.length) return node.textContent || '';
  return node.children.map(collectText).join(' ');
}

test('renderPartyPanelInto renders side-by-side player cards, inline SoulLink badges, and structured bond rows without route log duplication', () => {
  const doc = createFakeDoc();
  const container = doc.createElement('div');
  let relearnedIndex = null;
  let openedTracker = false;

  const model = buildPartyPanel({
    self: {
      playerId: 'p1',
      party: {
        availability: 'available',
        members: [{ species: 258, nickname: 'Kip', level: 14, hp: 38 }],
        revision: 1,
      },
    },
    members: [
      { playerId: 'p1', name: 'Ash' },
      { playerId: 'p2', name: 'Misty' },
    ],
    parties: {
      p2: {
        availability: 'available',
        members: [{ species: 255, nickname: 'Flare', level: 14, hp: 36 }],
        revision: 1,
      },
    },
    areas: {
      'emerald:section:1': { label: 'Route 101' },
    },
    links: {
      'link:emerald:section:1': {
        linkId: 'link:emerald:section:1',
        areaKey: 'emerald:section:1',
        status: 'active',
        members: [
          { playerId: 'p1', species: 258, nickname: 'Kip', level: 14, status: 'alive' },
          { playerId: 'p2', species: 255, nickname: 'Flare', level: 14, status: 'alive' },
        ],
      },
    },
    speciesNameFor: (id) => ({ 258: 'MUDKIP', 255: 'TORCHIC' })[id] ?? null,
  });

  model.runTracker = {
    status: 'active',
    summary: { visited: 3, linked: 1, pending: 1, dead: 0, void: 0 },
    sections: [
      {
        id: 1,
        label: 'Route 101',
        visited: true,
        areas: [{ areaKey: 'emerald:section:1', label: 'Route 101', status: 'linked', members: [] }],
      },
    ],
    graveyard: [],
    events: [{ type: 'capture', playerId: 'p1', areaKey: 'emerald:section:1' }],
  };

  renderPartyPanelInto(container, model, doc, {
    moveRelearnerEnabled: true,
    onOpenMoveRelearner: (idx) => { relearnedIndex = idx; },
    onOpenRunTracker: () => { openedTracker = true; },
  });

  // 1. Side-by-side player grid
  const grids = findAll(container, (el) => el.className === 'party-players-grid');
  assert.equal(grids.length, 1);
  assert.equal(grids[0].dataset.playerCount, '2');

  const playerCards = findAll(grids[0], (el) => el.className === 'party-player');
  assert.equal(playerCards.length, 2);

  // 2. Inline SoulLink tag on slot
  const inlineLinks = findAll(grids[0], (el) => el.className === 'party-slot-link');
  assert.equal(inlineLinks.length, 2);
  assert.match(collectText(inlineLinks[0]), /Misty’s Flare/);
  assert.match(collectText(inlineLinks[0]), /Route 101/);

  // 3. Move relearner button triggers callback for self
  const relearnBtns = findAll(grids[0], (el) => el.className === 'party-slot-relearn');
  assert.equal(relearnBtns.length, 1);
  relearnBtns[0].listeners.click();
  assert.equal(relearnedIndex, 0);

  // 4. Structured SoulLink bond row
  const bondRows = findAll(container, (el) => el.className === 'party-link');
  assert.equal(bondRows.length, 1);
  assert.equal(bondRows[0].dataset.placement, 'party');
  assert.match(collectText(bondRows[0]), /Route 101/);
  assert.match(collectText(bondRows[0]), /In party/);

  // 5. Run overview uses stat pills + Open Run Tracker button without dumping duplicated route areas
  const duplicatedRouteAreas = findAll(container, (el) => el.className === 'run-area');
  assert.equal(duplicatedRouteAreas.length, 0);

  const openTrackerBtns = findAll(container, (el) => el.className === 'party-open-tracker');
  assert.equal(openTrackerBtns.length, 1);
  openTrackerBtns[0].listeners.click();
  assert.equal(openedTracker, true);
});
