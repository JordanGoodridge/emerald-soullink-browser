import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionFor,
  bindingsFor,
  describeBindings,
  isGameButton,
  normalizeScheme,
  shouldIgnoreKeyEvent,
} from './keymap.mjs';

test('schemes differ only in movement bindings', () => {
  const arrows = bindingsFor('arrows');
  const wasd = bindingsFor('wasd');

  assert.equal(arrows.get('ArrowUp'), 'up');
  assert.equal(wasd.get('KeyW'), 'up');
  assert.equal(wasd.get('KeyA'), 'left');
  assert.equal(wasd.get('KeyS'), 'down');
  assert.equal(wasd.get('KeyD'), 'right');
  assert.equal(arrows.has('KeyW'), false);
  assert.equal(wasd.has('ArrowUp'), false);

  for (const [code, action] of arrows) {
    if (code.startsWith('Arrow')) continue;
    assert.equal(wasd.get(code), action, `${code} should not differ between schemes`);
  }
});

test('shoulder buttons are Q/E and A/S are not bound', () => {
  for (const scheme of ['arrows', 'wasd']) {
    assert.equal(actionFor(scheme, 'KeyQ'), 'l');
    assert.equal(actionFor(scheme, 'KeyE'), 'r');
    assert.equal(actionFor(scheme, 'KeyA') === 'l', false);
    assert.equal(actionFor(scheme, 'KeyS') === 'r', false);
  }
  assert.equal(actionFor('arrows', 'KeyA'), null);
  assert.equal(actionFor('arrows', 'KeyS'), null);
});

test('shared buttons and map key resolve in both schemes', () => {
  for (const scheme of ['arrows', 'wasd']) {
    assert.equal(actionFor(scheme, 'KeyZ'), 'a');
    assert.equal(actionFor(scheme, 'KeyX'), 'b');
    assert.equal(actionFor(scheme, 'Enter'), 'start');
    assert.equal(actionFor(scheme, 'ShiftLeft'), 'select');
    assert.equal(actionFor(scheme, 'ShiftRight'), 'select');
    assert.equal(actionFor(scheme, 'KeyM'), 'map');
  }
});

test('unknown scheme normalizes to arrows', () => {
  assert.equal(normalizeScheme('gamepad'), 'arrows');
  assert.equal(normalizeScheme(undefined), 'arrows');
  assert.equal(normalizeScheme('wasd'), 'wasd');
  assert.equal(actionFor('gamepad', 'KeyW'), null);
  assert.equal(actionFor('gamepad', 'ArrowUp'), 'up');
});

test('game button classification excludes the map action', () => {
  assert.equal(isGameButton('a'), true);
  assert.equal(isGameButton('r'), true);
  assert.equal(isGameButton('map'), false);
  assert.equal(isGameButton('close'), false);
});

test('bindings table lists every action for the active scheme', () => {
  const arrows = describeBindings('arrows');
  const wasd = describeBindings('wasd');
  assert.equal(arrows.length, wasd.length);
  assert.deepEqual(arrows.map((row) => row.action), wasd.map((row) => row.action));
  assert.equal(arrows[0].keys, 'Arrow keys');
  assert.equal(wasd[0].keys, 'W A S D');
  assert.equal(arrows.find((row) => row.action === 'L').keys, 'Q');
  assert.equal(arrows.find((row) => row.action === 'Find people').keys, 'M');
  assert.equal(arrows.find((row) => row.action === 'Close overlay').keys, 'Esc');
});

function fakeTarget(tag, extra = {}) {
  return {
    tagName: tag,
    isContentEditable: false,
    closest: () => null,
    ...extra,
  };
}

test('typing fields and open dialogs are ignored', () => {
  assert.equal(shouldIgnoreKeyEvent({ target: fakeTarget('INPUT') }), true);
  assert.equal(shouldIgnoreKeyEvent({ target: fakeTarget('TEXTAREA') }), true);
  assert.equal(shouldIgnoreKeyEvent({ target: fakeTarget('SELECT') }), true);
  assert.equal(shouldIgnoreKeyEvent({
    target: fakeTarget('DIV', { isContentEditable: true }),
  }), true);
  assert.equal(shouldIgnoreKeyEvent({
    target: fakeTarget('SPAN', { closest: (selector) => (selector === 'dialog[open]' ? {} : null) }),
  }), true);
  assert.equal(shouldIgnoreKeyEvent({ target: fakeTarget('BUTTON') }), false);
  assert.equal(shouldIgnoreKeyEvent({ target: fakeTarget('CANVAS') }), false);
});

test('modifier combinations are ignored so browser shortcuts work', () => {
  assert.equal(shouldIgnoreKeyEvent({ ctrlKey: true, target: fakeTarget('CANVAS') }), true);
  assert.equal(shouldIgnoreKeyEvent({ metaKey: true, target: fakeTarget('CANVAS') }), true);
  assert.equal(shouldIgnoreKeyEvent({ altKey: true, target: fakeTarget('CANVAS') }), true);
  assert.equal(shouldIgnoreKeyEvent({ shiftKey: true, target: fakeTarget('CANVAS') }), false);
});

test('missing event or target does not throw', () => {
  assert.equal(shouldIgnoreKeyEvent(undefined), false);
  assert.equal(shouldIgnoreKeyEvent({}), false);
  assert.equal(shouldIgnoreKeyEvent({ target: null }), false);
});
