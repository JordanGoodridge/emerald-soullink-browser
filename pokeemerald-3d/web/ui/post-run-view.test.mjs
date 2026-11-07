import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunState, reduceRunEvent } from '../run/run-state.mjs';
import { buildPostRunSummary } from '../run/post-run-model.mjs';
import { renderPostRunSummaryInto, renderPostRunPosterCanvas } from './post-run-view.mjs';

function createFakeDoc() {
  function makeEl(tagName) {
    const children = [];
    const attributes = new Map();
    return {
      tagName: tagName.toUpperCase(),
      className: '',
      textContent: '',
      src: '',
      alt: '',
      width: 0,
      height: 0,
      dataset: {},
      children,
      append(...nodes) {
        for (const node of nodes) {
          if (node) children.push(node);
        }
      },
      replaceChildren(...nodes) {
        children.length = 0;
        for (const node of nodes) {
          if (node) children.push(node);
        }
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
      getAttribute(name) {
        return attributes.get(name) ?? null;
      },
      getContext() {
        return {
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 1,
          font: '',
          fillRect() {},
          strokeRect() {},
          fillText() {},
        };
      },
      toDataURL() {
        return 'data:image/png;base64,AA==';
      },
    };
  }
  return {
    createElement: makeEl,
  };
}

function findAll(root, predicate, out = []) {
  if (!root) return out;
  if (predicate(root)) out.push(root);
  for (const child of root.children ?? []) {
    findAll(child, predicate, out);
  }
  return out;
}

test('renderPostRunSummaryInto renders wipe stats, superlatives, graveyard epitaphs, and split timeline', () => {
  const doc = createFakeDoc();
  const container = doc.createElement('div');
  let state = createRunState({
    runId: 'ui-wipe',
    seed: 1234,
    mode: 'soullink',
    members: [{ playerId: 'p1', name: 'Ash' }, { playerId: 'p2', name: 'Misty' }],
  });
  state = reduceRunEvent(state, {
    eventId: 'c1', type: 'encounter.claim', playerId: 'p1',
    areaKey: 'emerald:section:18', sectionId: 18, species: 258, pid: 11, level: 5, nickname: 'Kip', badgeCount: 2,
  }).state;
  state = reduceRunEvent(state, {
    eventId: 'c2', type: 'encounter.claim', playerId: 'p2',
    areaKey: 'emerald:section:18', sectionId: 18, species: 280, pid: 22, level: 5, nickname: 'Ralts', badgeCount: 2,
  }).state;
  state = reduceRunEvent(state, { eventId: 'r1', type: 'encounter.resolve', playerId: 'p1', areaKey: 'emerald:section:18', result: 'caught', badgeCount: 2 }).state;
  state = reduceRunEvent(state, { eventId: 'r2', type: 'encounter.resolve', playerId: 'p2', areaKey: 'emerald:section:18', result: 'caught', badgeCount: 2 }).state;
  state = reduceRunEvent(state, {
    eventId: 'd1', type: 'death', playerId: 'p1',
    linkId: 'link:emerald:section:18', pid: 11, level: 24, nickname: 'Marshtomp', badgeCount: 2,
  }).state;
  state = reduceRunEvent(state, {
    eventId: 'w1', type: 'wipe.pending', playerId: 'p1', badgeCount: 2,
  }).state;

  const summary = buildPostRunSummary({
    run: state,
    localPlayerId: 'p1',
    speciesInfoFor: (id) => ({ name: `Species#${id}`, spriteUrl: `/sprites/${id}.png`, nationalDex: id }),
  });

  renderPostRunSummaryInto(container, summary, doc);
  assert.equal(container.dataset.outcome, 'wipe');

  const statCards = findAll(container, (n) => n.className === 'post-run-stat-card');
  assert.equal(statCards.length, 6);

  const awardCards = findAll(container, (n) => n.className === 'post-run-award-card');
  assert.ok(awardCards.length >= 3);

  const epitaphCards = findAll(container, (n) => n.className === 'post-run-epitaph-card');
  assert.equal(epitaphCards.length, 2);

  const canvas = renderPostRunPosterCanvas(summary, { doc });
  assert.equal(canvas.width, 800);
  assert.equal(canvas.height, 500);
});

test('renderPostRunSummaryInto renders Hall of Fame victory roster and champion cards', () => {
  const doc = createFakeDoc();
  const container = doc.createElement('div');
  let state = createRunState({
    runId: 'ui-win',
    seed: 9999,
    mode: 'soullink',
    members: [{ playerId: 'p1', name: 'Ash' }, { playerId: 'p2', name: 'Misty' }],
  });
  state = reduceRunEvent(state, {
    eventId: 'v1',
    type: 'run.victory',
    playerId: 'p1',
    badgeCount: 8,
    party: [{ species: 260, level: 62, nickname: 'Titan', pid: 101, moves: [57, 89] }],
  }).state;

  const summary = buildPostRunSummary({
    run: state,
    localPlayerId: 'p1',
    speciesInfoFor: (id) => ({ name: `Species#${id}`, spriteUrl: `/sprites/${id}.png`, nationalDex: id }),
  });

  renderPostRunSummaryInto(container, summary, doc);
  assert.equal(container.dataset.outcome, 'victory');

  const monCards = findAll(container, (n) => n.className === 'post-run-mon-card');
  assert.equal(monCards.length, 1);
  assert.equal(monCards[0].dataset.status, 'champion');
});
