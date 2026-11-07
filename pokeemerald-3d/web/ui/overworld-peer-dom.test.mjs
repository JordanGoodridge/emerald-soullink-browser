import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverworldPeerDom } from './overworld-peer-dom.mjs';

function createFakeDoc() {
  function makeElement(tag) {
    const children = [];
    const classes = new Set();
    const styles = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      hidden: false,
      textContent: '',
      dataset: {},
      children,
      style: {
        left: '',
        top: '',
        setProperty(k, v) { styles.set(k, v); },
        getPropertyValue(k) { return styles.get(k) ?? ''; },
        removeProperty(k) { styles.delete(k); },
      },
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (classes.has(c)) classes.delete(c);
            else classes.add(c);
          } else if (force) {
            classes.add(c);
          } else {
            classes.delete(c);
          }
        },
        contains(c) { return classes.has(c); },
      },
      append(...nodes) {
        for (const n of nodes) {
          n.parentElement = el;
          children.push(n);
        }
      },
      replaceChildren(...nodes) {
        children.length = 0;
        el.append(...nodes);
      },
      remove() {
        if (!el.parentElement) return;
        const idx = el.parentElement.children.indexOf(el);
        if (idx >= 0) el.parentElement.children.splice(idx, 1);
      },
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 240, height: 160 };
      },
    };
    return el;
  }

  return {
    createElement: makeElement,
    addEventListener() {},
  };
}

test('updateBattleHud anchors player and opponent type pills inside their healthbox bounds', () => {
  const doc = createFakeDoc();
  const panel = doc.createElement('div');
  const canvas = {
    width: 240,
    height: 160,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 240, height: 160 };
    },
  };

  const dom = createOverworldPeerDom({ canvas, panel, doc });

  // Battler 0: Player singles healthbox at (158, 88), bounds x=[134, 232], y=[76, 110]
  // Battler 1: Opponent singles healthbox at (44, 30), bounds x=[16, 108], y=[18, 43]
  const battlers = [
    { x: 158, y: 88, side: 0, type1: 10, type2: 1 }, // FIR / FGT
    { x: 44, y: 30, side: 1, type1: 11, type2: 11 }, // WTR
  ];

  dom.updateBattleHud({
    WasmBattleHudCount: () => battlers.length,
    WasmBattleHudVisible: (b) => b < battlers.length ? 1 : 0,
    WasmBattleHudX: (b) => battlers[b].x,
    WasmBattleHudY: (b) => battlers[b].y,
    WasmBattleHudSide: (b) => battlers[b].side,
    WasmBattleHudType1: (b) => battlers[b].type1,
    WasmBattleHudType2: (b) => battlers[b].type2,
  });

  assert.equal(dom.battleHudLayer.hidden, false);
  assert.equal(dom.battleHudElements.size, 2);

  const playerContainer = dom.battleHudElements.get(0);
  const opponentContainer = dom.battleHudElements.get(1);

  assert.equal(playerContainer.dataset.side, 'player');
  assert.equal(playerContainer.children.length, 2);
  assert.equal(playerContainer.children[0].textContent, 'FIR');
  assert.equal(playerContainer.children[1].textContent, 'FGT');
  // Player anchor: (158 + 38, 88 - 5) = (196px, 83px) inside player healthbox [134..232, 76..110]
  assert.equal(playerContainer.style.left, '196px');
  assert.equal(playerContainer.style.top, '83px');

  assert.equal(opponentContainer.dataset.side, 'opponent');
  assert.equal(opponentContainer.children.length, 1);
  assert.equal(opponentContainer.children[0].textContent, 'WTR');
  // Opponent anchor: (44 + 30, 30 - 5) = (74px, 25px) inside opponent healthbox [16..108, 18..43]
  assert.equal(opponentContainer.style.left, '74px');
  assert.equal(opponentContainer.style.top, '25px');
});
