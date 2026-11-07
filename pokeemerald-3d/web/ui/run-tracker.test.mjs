import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRunTrackerInto } from './run-tracker.mjs';

function createFakeDoc() {
  const makeEl = (tag) => ({
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
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

test('renderRunTrackerInto renders summary pills, route status badges, and graveyard chips', () => {
  const doc = createFakeDoc();
  const container = doc.createElement('div');

  const tracker = {
    status: 'active',
    summary: { visited: 2, linked: 1, pending: 1, void: 0, dead: 1 },
    players: [
      { playerId: 'p1', name: 'Ash' },
      { playerId: 'p2', name: 'Misty' },
    ],
    sections: [
      {
        id: 1,
        label: 'Route 101',
        status: 'linked',
        areas: [
          {
            areaKey: 'emerald:section:1',
            label: 'Route 101',
            status: 'linked',
            members: [
              { playerId: 'p1', name: 'Ash', species: 263, nickname: 'Ziggy', status: 'caught' },
              { playerId: 'p2', name: 'Misty', species: 265, nickname: null, status: 'caught' },
            ],
          },
        ],
      },
    ],
    gifts: [
      {
        areaKey: 'emerald:gift:starter',
        label: 'Starter',
        status: 'linked',
        members: [
          { playerId: 'p1', name: 'Ash', species: 258, nickname: 'Kip', status: 'caught' },
        ],
      },
    ],
    graveyard: [
      { playerId: 'p1', species: 261, nickname: 'Pooch', cause: 'fainted' },
    ],
  };

  renderRunTrackerInto(container, tracker, doc, {
    speciesNameFor: (id) => ({ 263: 'ZIGZAGOON', 265: 'WURMPLE', 258: 'MUDKIP', 261: 'POOCHYENA' })[id] ?? null,
    currentArea: { label: 'Route 101', status: 'encounter claimed' },
  });

  const statPills = findAll(container, (el) => el.className === 'party-stat-pill');
  assert.equal(statPills.length, 5);

  const badges = findAll(container, (el) => el.className === 'run-status-badge');
  assert.equal(badges.length, 2);
  assert.equal(badges[0].textContent, 'Linked');

  const claimChips = findAll(container, (el) => el.className === 'run-claim-chip');
  assert.equal(claimChips.length, 3);
  assert.equal(claimChips[0].textContent, 'Ash: Ziggy');
  assert.equal(claimChips[1].textContent, 'Misty: WURMPLE');

  const graveyardChips = findAll(container, (el) => el.className === 'party-graveyard-chip');
  assert.equal(graveyardChips.length, 1);
  assert.match(collectText(graveyardChips[0]), /Ash’s Pooch · fainted/);
});

test('renderRunTrackerInto prioritizes active/visited routes and collapses unvisited areas into details', () => {
  const doc = createFakeDoc();
  const container = doc.createElement('div');

  const tracker = {
    status: 'active',
    summary: { visited: 2, linked: 0, pending: 0, void: 0, dead: 0 },
    players: [{ playerId: 'p1', name: 'Jordan' }],
    sections: [
      { id: 0, label: 'LITTLEROOT TOWN', status: 'available', visited: true, areas: [] },
      { id: 1, label: 'OLDALE TOWN', status: 'unvisited', visited: false, areas: [] },
      { id: 2, label: 'DEWFORD TOWN', status: 'unvisited', visited: false, areas: [] },
      { id: 16, label: 'ROUTE 101', status: 'available', visited: true, areas: [] },
    ],
    gifts: [],
    graveyard: [],
  };

  renderRunTrackerInto(container, tracker, doc, {
    currentArea: { label: 'ROUTE 101', status: 'encounter available' },
  });

  const lists = findAll(container, (el) => el.className === 'run-tracker-list');
  // Primary list has active/visited routes with current area sorted first
  const primaryRows = lists[0].children;
  assert.equal(primaryRows.length, 2);
  assert.match(collectText(primaryRows[0]), /ROUTE 101/);
  assert.match(collectText(primaryRows[1]), /LITTLEROOT TOWN/);

  // Unvisited areas are grouped into collapsible details
  const unvisitedDetails = findAll(container, (el) => el.className === 'run-tracker-unvisited');
  assert.equal(unvisitedDetails.length, 1);
  const summaryEl = unvisitedDetails[0].children[0];
  assert.equal(summaryEl.textContent, 'Unvisited areas (2)');
});
