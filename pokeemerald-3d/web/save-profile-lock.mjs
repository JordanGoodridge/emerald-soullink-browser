// Exclusive ownership of one save profile for the lifetime of a browser tab.
//
// Two tabs writing the same flash image can silently overwrite each other's
// progress, so the composition layer acquires a Web Lock before booting. The
// lock is released automatically when the document is destroyed; call release()
// on pagehide for an explicit handoff.
//
// No DOM, storage, socket or WASM dependencies. Tests inject a fake locks API.

export const SAVE_PROFILE_LOCK_PREFIX = 'pokeemerald.save-profile:';

export function createSaveProfileLock({
  profileKey,
  locks = globalThis.navigator?.locks,
  onRelease = () => {},
} = {}) {
  const key = String(profileKey || 'default');
  const name = `${SAVE_PROFILE_LOCK_PREFIX}${key}`;
  let releaseHold = null;
  let released = false;
  let acquired = false;
  let settled = false;
  let resolveAcquired;

  const whenAcquired = new Promise((resolve) => { resolveAcquired = resolve; });

  function settle(value) {
    if (settled) return;
    settled = true;
    acquired = value;
    resolveAcquired(value);
  }

  if (!locks || typeof locks.request !== 'function') {
    settle(false);
    return {
      name,
      supported: false,
      whenAcquired,
      get acquired() { return false; },
      release() {},
    };
  }

  // The callback returns this promise, which keeps the lock held until release.
  const hold = new Promise((resolve) => { releaseHold = resolve; });

  try {
    locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!lock) {
        settle(false);
        return undefined;
      }
      settle(true);
      return hold;
    }).catch(() => settle(false));
  } catch {
    settle(false);
  }

  return {
    name,
    supported: true,
    whenAcquired,
    get acquired() { return acquired; },
    release() {
      if (released) return;
      released = true;
      try { releaseHold?.(); } catch { /* ignore */ }
      onRelease();
    },
  };
}
