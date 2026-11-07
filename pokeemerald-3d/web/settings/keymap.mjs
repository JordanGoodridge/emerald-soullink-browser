// Keyboard schemes and input guards.
//
// Two schemes differ only in movement: arrows or WASD. Every other binding is
// shared so there is one mental model, one help line and one settings table.
//
// Pure: no DOM, no key state. The shell owns listeners and the pressed set.

export const CONTROL_SCHEME_LABELS = Object.freeze({
  arrows: 'Arrow keys',
  wasd: 'WASD',
});

// Shared bindings. L/R moved from A/S because WASD needs A and S for movement,
// and Emerald uses the shoulder buttons far less than movement.
const SHARED_BINDINGS = Object.freeze({
  KeyZ: 'a',
  KeyX: 'b',
  Enter: 'start',
  ShiftLeft: 'select',
  ShiftRight: 'select',
  KeyQ: 'l',
  KeyE: 'r',
  KeyM: 'map',
});

const SCHEME_BINDINGS = Object.freeze({
  arrows: Object.freeze({
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ...SHARED_BINDINGS,
  }),
  wasd: Object.freeze({
    KeyW: 'up',
    KeyS: 'down',
    KeyA: 'left',
    KeyD: 'right',
    ...SHARED_BINDINGS,
  }),
});

const KEY_LABELS = Object.freeze({
  ArrowUp: 'Up arrow',
  ArrowDown: 'Down arrow',
  ArrowLeft: 'Left arrow',
  ArrowRight: 'Right arrow',
  KeyW: 'W',
  KeyA: 'A',
  KeyS: 'S',
  KeyD: 'D',
  KeyZ: 'Z',
  KeyX: 'X',
  KeyQ: 'Q',
  KeyE: 'E',
  KeyM: 'M',
  Enter: 'Enter',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  Escape: 'Esc',
});

export const GAME_BUTTONS = Object.freeze([
  'up', 'down', 'left', 'right', 'a', 'b', 'start', 'select', 'l', 'r',
]);

const GAME_BUTTON_SET = new Set(GAME_BUTTONS);

export const UI_ACTIONS = Object.freeze(['map', 'close']);

export function normalizeScheme(value) {
  return Object.prototype.hasOwnProperty.call(SCHEME_BINDINGS, value) ? value : 'arrows';
}

export function bindingsFor(scheme) {
  return new Map(Object.entries(SCHEME_BINDINGS[normalizeScheme(scheme)]));
}

export function actionFor(scheme, code) {
  return SCHEME_BINDINGS[normalizeScheme(scheme)][code] ?? null;
}

export function isGameButton(action) {
  return GAME_BUTTON_SET.has(action);
}

export function keyLabel(code) {
  return KEY_LABELS[code] ?? code;
}

// Rows for the read-only bindings table in the settings dialog. Movement is a
// single row because it is the only part that varies between schemes.
export function describeBindings(scheme) {
  const normalized = normalizeScheme(scheme);
  const move = normalized === 'wasd' ? 'W A S D' : 'Arrow keys';
  return [
    { action: 'Move', keys: move },
    { action: 'A button', keys: 'Z' },
    { action: 'B button', keys: 'X' },
    { action: 'Start', keys: 'Enter' },
    { action: 'Select', keys: 'Shift' },
    { action: 'L', keys: 'Q' },
    { action: 'R', keys: 'E' },
    { action: 'Find people', keys: 'M' },
    { action: 'Close overlay', keys: 'Esc' },
  ];
}

// True when the event belongs to the page rather than the game: typing in a
// field, interacting with an open dialog, or a browser shortcut with modifiers.
export function shouldIgnoreKeyEvent(event = {}) {
  if (!event || typeof event !== 'object') return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return true;

  const target = event.target;
  if (!target || typeof target !== 'object') return false;

  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable === true) return true;
  if (typeof target.closest === 'function') {
    try {
      if (target.closest('dialog[open]')) return true;
      if (target.closest('[contenteditable="true"]')) return true;
    } catch {
      // Detached or exotic targets: fall through to game handling.
    }
  }
  return false;
}
