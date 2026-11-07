import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaveProfileLock, SAVE_PROFILE_LOCK_PREFIX } from './save-profile-lock.mjs';

function fakeLocks() {
  const held = new Set();
  const requests = [];
  return {
    requests,
    held,
    request(name, options, callback) {
      requests.push({ name, options });
      if (held.has(name)) {
        if (options?.ifAvailable) return Promise.resolve(callback(null));
        throw new Error('fake lock would block');
      }
      held.add(name);
      let result;
      try {
        result = callback({ name });
      } catch (error) {
        held.delete(name);
        return Promise.reject(error);
      }
      return Promise.resolve(result).finally(() => held.delete(name));
    },
  };
}

test('acquires a free save profile and names the lock by profile', async () => {
  const locks = fakeLocks();
  const lock = createSaveProfileLock({ profileKey: 'ash', locks });
  assert.equal(await lock.whenAcquired, true);
  assert.equal(lock.acquired, true);
  assert.equal(lock.name, `${SAVE_PROFILE_LOCK_PREFIX}ash`);
  assert.equal(locks.held.has(lock.name), true);
  assert.equal(locks.requests[0].options.ifAvailable, true);
  assert.equal(locks.requests[0].options.mode, 'exclusive');
  lock.release();
  await Promise.resolve();
  assert.equal(locks.held.has(lock.name), false);
});

test('a second tab cannot acquire a profile that is already held', async () => {
  const locks = fakeLocks();
  const first = createSaveProfileLock({ profileKey: 'misty', locks });
  const second = createSaveProfileLock({ profileKey: 'misty', locks });
  assert.equal(await first.whenAcquired, true);
  assert.equal(await second.whenAcquired, false);
  assert.equal(second.acquired, false);
  assert.equal(locks.held.has(first.name), true);

  first.release();
  await Promise.resolve();
  const third = createSaveProfileLock({ profileKey: 'misty', locks });
  assert.equal(await third.whenAcquired, true);
  third.release();
});

test('different save profiles do not block each other', async () => {
  const locks = fakeLocks();
  const a = createSaveProfileLock({ profileKey: 'a', locks });
  const b = createSaveProfileLock({ profileKey: 'b', locks });
  assert.equal(await a.whenAcquired, true);
  assert.equal(await b.whenAcquired, true);
  assert.equal(locks.held.size, 2);
  a.release();
  b.release();
});

test('release is idempotent and notifies once', async () => {
  const locks = fakeLocks();
  let releases = 0;
  const lock = createSaveProfileLock({
    profileKey: 'brock',
    locks,
    onRelease: () => { releases += 1; },
  });
  assert.equal(await lock.whenAcquired, true);
  lock.release();
  lock.release();
  assert.equal(releases, 1);
});

test('fails closed when the Web Locks API is unavailable', async () => {
  const lock = createSaveProfileLock({ profileKey: 'gary', locks: null });
  assert.equal(lock.supported, false);
  assert.equal(await lock.whenAcquired, false);
  assert.equal(lock.acquired, false);
  lock.release();
});

test('fails closed when the locks request throws', async () => {
  const locks = {
    request() { throw new Error('not allowed'); },
  };
  const lock = createSaveProfileLock({ profileKey: 'red', locks });
  assert.equal(await lock.whenAcquired, false);
  assert.equal(lock.acquired, false);
});
