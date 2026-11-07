// In-game hamburger menu. The game keeps running while this panel is open.

export function createGameMenu({
  document: doc = globalThis.document,
  onAction = null,
} = {}) {
  const dialog = doc?.querySelector?.('#game-menu');
  const toggle = doc?.querySelector?.('#menu-toggle');
  const closeButton = doc?.querySelector?.('#game-menu-close');
  const titleEl = doc?.querySelector?.('#game-menu-game');
  const actions = {
    resume: doc?.querySelector?.('#game-menu-resume'),
    party: doc?.querySelector?.('#game-menu-party'),
    runTracker: doc?.querySelector?.('#game-menu-run-tracker'),
    save: doc?.querySelector?.('#game-menu-save'),
    friends: doc?.querySelector?.('#game-menu-friends'),
    settings: doc?.querySelector?.('#game-menu-settings'),
    change: doc?.querySelector?.('#game-menu-change'),
  };

  if (!dialog || !toggle) {
    return { open() {}, close() {}, setGameTitle() {}, destroy() {} };
  }

  let previousFocus = null;

  function setExpanded(expanded) {
    toggle.setAttribute('aria-expanded', String(expanded));
  }

  function open() {
    if (dialog.open) return;
    previousFocus = toggle;
    const rect = toggle.getBoundingClientRect();
    dialog.style.left = 'auto';
    dialog.style.top = `${Math.round(rect.bottom + 8)}px`;
    dialog.style.right = `${Math.max(8, Math.round(globalThis.innerWidth - rect.right))}px`;
    if (typeof dialog.show === 'function') dialog.show();
    else dialog.setAttribute('open', '');
    const panel = dialog.getBoundingClientRect();
    const viewportHeight = doc.documentElement?.clientHeight || globalThis.innerHeight;
    if (panel.bottom > viewportHeight - 8) {
      dialog.style.top = `${Math.max(8, Math.round(viewportHeight - panel.height - 8))}px`;
    }
    if (panel.left < 8) dialog.style.right = '8px';
    setExpanded(true);
    actions.resume?.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!dialog.open) return;
    dialog.close();
    setExpanded(false);
    if (restoreFocus) {
      const target = previousFocus && typeof previousFocus.focus === 'function' ? previousFocus : toggle;
      target.focus();
    }
  }

  function run(action) {
    close();
    if (typeof onAction === 'function') onAction(action);
  }

  toggle.addEventListener('click', () => {
    if (dialog.open) close();
    else open();
  });
  closeButton?.addEventListener('click', () => close());
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dialog.open) {
      event.preventDefault();
      close();
    }
  });
  for (const [name, button] of Object.entries(actions)) {
    button?.addEventListener('click', () => run(name === 'runTracker' ? 'run-tracker' : name));
  }

  return {
    open,
    close,
    setGameTitle(title) {
      if (titleEl) titleEl.textContent = title;
    },
    destroy() {
      close({ restoreFocus: false });
    },
  };
}
