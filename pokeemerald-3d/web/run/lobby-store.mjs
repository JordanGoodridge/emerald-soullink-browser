export const LOBBY_DATABASE_NAME = 'poketech-lobbies-v1';
export const LOBBY_DATABASE_VERSION = 1;
export const LOBBY_OBJECT_STORE = 'lobbies';
export const LOBBY_BUNDLE_FORMAT = 'poketech-lobby-save';
export const LOBBY_BUNDLE_VERSION = 1;
export const LOBBY_MODES = Object.freeze(['standard', 'soullink']);

const SLOT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ROOM_CODE_RE = /^[A-Za-z0-9_-]{4,16}$/;
const MAX_SLOT_SAVE_BYTES = 16 * 1024 * 1024;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function bytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  return null;
}

function bytesToBase64(value) {
  const input = bytes(value);
  if (!input?.length) throw new Error('lobby slot save must contain bytes');
  let binary = '';
  for (let offset = 0; offset < input.length; offset += 0x8000) {
    binary += String.fromCharCode(...input.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('lobby slot save data is not valid base64');
  }
  if (value.length > Math.ceil(MAX_SLOT_SAVE_BYTES / 3) * 4) throw new Error('lobby slot save exceeds the supported size limit');
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) output[index] = binary.charCodeAt(index);
  return output;
}

function normalizeMembers(value) {
  if (!Array.isArray(value) || value.length > 4) throw new Error('lobby must have at most four members');
  const seen = new Set();
  return value.map((member) => {
    if (typeof member?.playerId !== 'string' || !member.playerId || member.playerId.length > 64 || seen.has(member.playerId)) {
      throw new Error('lobby members need unique player IDs');
    }
    seen.add(member.playerId);
    return {
      playerId: member.playerId,
      name: typeof member.name === 'string' ? member.name.slice(0, 24) : 'Player',
      connected: member.connected !== false,
      ready: member.ready === true,
      ...(Number.isInteger(member.slot) && member.slot >= 0 && member.slot < 4 ? { slot: member.slot } : {}),
    };
  });
}

function normalizeSlot(slotId, value = {}) {
  if (!SLOT_ID_RE.test(slotId)) throw new Error('invalid lobby slot ID');
  if (value.ownerPlayerId !== null && value.ownerPlayerId !== undefined
    && (typeof value.ownerPlayerId !== 'string' || !value.ownerPlayerId || value.ownerPlayerId.length > 64)) {
    throw new Error(`invalid owner for lobby slot ${slotId}`);
  }
  if (!Number.isSafeInteger(value.revision ?? 0) || (value.revision ?? 0) < 0) {
    throw new Error(`invalid revision for lobby slot ${slotId}`);
  }
  const saveBytes = value.saveBytes === null || value.saveBytes === undefined ? null : bytes(value.saveBytes);
  if (value.saveBytes !== null && value.saveBytes !== undefined && !saveBytes?.length) {
    throw new Error(`invalid saved image for lobby slot ${slotId}`);
  }
  if (saveBytes && (saveBytes.length > MAX_SLOT_SAVE_BYTES
    || typeof value.gameId !== 'string' || !value.gameId
    || typeof value.formatId !== 'string' || !value.formatId
    || !Number.isSafeInteger(value.formatVersion) || value.formatVersion < 1)) {
    throw new Error(`saved image metadata is invalid for lobby slot ${slotId}`);
  }
  return {
    slotId,
    ownerPlayerId: value.ownerPlayerId ?? null,
    revision: value.revision ?? 0,
    gameId: value.gameId ?? null,
    formatId: value.formatId ?? null,
    formatVersion: value.formatVersion ?? null,
    savedAt: Number.isFinite(value.savedAt) ? value.savedAt : null,
    saveBytes,
  };
}

export function validateLobbyRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('lobby record must be an object');
  if (value.format !== LOBBY_BUNDLE_FORMAT || value.schemaVersion !== LOBBY_BUNDLE_VERSION) {
    throw new Error('lobby record format or version is unsupported');
  }
  if (!ROOM_CODE_RE.test(value.roomCode)) throw new Error('lobby room code is invalid');
  if (typeof value.hostPlayerId !== 'string' || !value.hostPlayerId || value.hostPlayerId.length > 64) {
    throw new Error('lobby host identity is invalid');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('lobby revision is invalid');
  const runStateRevision = value.runStateRevision ?? 0;
  if (!Number.isSafeInteger(runStateRevision) || runStateRevision < 0) throw new Error('shared run-state revision is invalid');
  const authorityRevision = value.authorityRevision ?? 0;
  if (!Number.isSafeInteger(authorityRevision) || authorityRevision < 0) throw new Error('lobby authority revision is invalid');
  const members = normalizeMembers(value.members);
  const mode = value.mode ?? 'soullink'; // v1 records predate explicit mode identity.
  if (!LOBBY_MODES.includes(mode)) throw new Error('lobby mode is unsupported');
  if (mode === 'standard' && value.runState != null) {
    throw new Error('Standard lobbies cannot contain shared Nuzlocke/SoulLink run state');
  }
  if (!members.some((member) => member.playerId === value.hostPlayerId)) {
    throw new Error('lobby host must be an active replica member');
  }
  const slots = {};
  if (!value.slots || typeof value.slots !== 'object' || Array.isArray(value.slots)) throw new Error('lobby slots are invalid');
  const entries = Object.entries(value.slots);
  if (entries.length < 1 || entries.length > 4) throw new Error('lobby must contain one to four player slots');
  for (const [slotId, slot] of entries) slots[slotId] = normalizeSlot(slotId, slot);
  const assignedOwners = Object.values(slots).map((slot) => slot.ownerPlayerId).filter(Boolean);
  if (new Set(assignedOwners).size !== assignedOwners.length) {
    throw new Error(`a member cannot own more than one lobby slot (${Object.entries(slots).map(([slotId, slot]) => `${slotId}:${slot.ownerPlayerId ?? '-'}`).join(',')})`);
  }
  return {
    format: LOBBY_BUNDLE_FORMAT,
    schemaVersion: LOBBY_BUNDLE_VERSION,
    roomCode: value.roomCode,
    hostPlayerId: value.hostPlayerId,
    revision: value.revision,
    runStateRevision,
    authorityRevision,
    mode,
    members,
    settings: clone(value.settings ?? {}),
    runState: value.runState === null || value.runState === undefined ? null : clone(value.runState),
    slots,
    savedAt: Number.isFinite(value.savedAt) ? value.savedAt : null,
  };
}

export function serializeLobbyBundle(value) {
  const record = validateLobbyRecord(value);
  const slots = Object.fromEntries(Object.entries(record.slots).map(([slotId, slot]) => [slotId, {
    slotId,
    ownerPlayerId: slot.ownerPlayerId,
    revision: slot.revision,
    gameId: slot.gameId,
    formatId: slot.formatId,
    formatVersion: slot.formatVersion,
    savedAt: slot.savedAt,
    saveBytes: slot.saveBytes ? bytesToBase64(slot.saveBytes) : null,
  }]));
  return JSON.stringify({ ...record, slots });
}

export async function parseLobbyBundle(text, { validateSave = null } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('lobby backup is not valid JSON');
  }
  if (parsed?.format !== LOBBY_BUNDLE_FORMAT || parsed?.schemaVersion !== LOBBY_BUNDLE_VERSION) {
    throw new Error('lobby backup format or version is unsupported');
  }
  if (!parsed?.slots || typeof parsed.slots !== 'object' || Array.isArray(parsed.slots)) {
    throw new Error('lobby backup slots are invalid');
  }
  const decoded = { ...parsed, slots: {} };
  for (const [slotId, slot] of Object.entries(parsed.slots)) {
    const saveBytes = slot.saveBytes === null ? null : base64ToBytes(slot.saveBytes);
    if (saveBytes && !validateSave) throw new Error('a game save validator is required to import lobby slot data');
    if (saveBytes && validateSave) {
      const validated = await validateSave({
        slotId,
        gameId: slot.gameId,
        formatId: slot.formatId,
        formatVersion: slot.formatVersion,
        saveBytes,
      });
      if (!validated) throw new Error(`slot ${slotId} save failed game validation`);
    }
    decoded.slots[slotId] = { ...slot, saveBytes };
  }
  return validateLobbyRecord(decoded);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

export function lobbyDatabaseName(namespace = '') {
  const normalized = typeof namespace === 'string' && namespace ? encodeURIComponent(namespace) : 'default';
  return `${LOBBY_DATABASE_NAME}-${normalized}`;
}

export function openLobbyDatabase(indexedDB = globalThis.indexedDB, databaseName = LOBBY_DATABASE_NAME) {
  if (!indexedDB?.open) return Promise.reject(new Error('IndexedDB is required for local lobby saves'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, LOBBY_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LOBBY_OBJECT_STORE)) {
        database.createObjectStore(LOBBY_OBJECT_STORE, { keyPath: 'roomCode' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open lobby IndexedDB'));
    request.onblocked = () => reject(new Error('lobby IndexedDB upgrade is blocked by another tab'));
  });
}

export function createLobbySaveStore({
  database = null,
  indexedDB = globalThis.indexedDB,
  namespace = '',
  now = () => Date.now(),
  validateSave = null,
} = {}) {
  let databasePromise = database ? Promise.resolve(database) : openLobbyDatabase(indexedDB, lobbyDatabaseName(namespace));

  async function withStore(mode, work) {
    const db = await databasePromise;
    const tx = db.transaction(LOBBY_OBJECT_STORE, mode);
    const store = tx.objectStore(LOBBY_OBJECT_STORE);
    const result = await work(store, tx);
    await transactionDone(tx);
    return result;
  }

  async function load(roomCode) {
    const record = await withStore('readonly', (store) => requestResult(store.get(roomCode)));
    return record ? validateLobbyRecord(record) : null;
  }

  async function list() {
    const records = await withStore('readonly', (store) => requestResult(store.getAll()));
    return records.map(validateLobbyRecord).sort((left, right) => (right.savedAt ?? 0) - (left.savedAt ?? 0));
  }

  async function remove(roomCode) {
    if (typeof roomCode !== 'string' || !ROOM_CODE_RE.test(roomCode)) throw new Error('lobby room code is invalid');
    await withStore('readwrite', (store) => requestResult(store.delete(roomCode)));
    return true;
  }

  async function applyReplica(snapshot) {
    const incoming = validateLobbyRecord(snapshot);
    return await withStore('readwrite', async (store) => {
      const prior = await requestResult(store.get(incoming.roomCode));
      if (prior) {
        const current = validateLobbyRecord(prior);
        if (incoming.authorityRevision < current.authorityRevision) throw new Error('stale lobby authority revision');
        if (incoming.authorityRevision === current.authorityRevision) return current;
        const mergedSlots = { ...incoming.slots };
        for (const [slotId, localSlot] of Object.entries(current.slots)) {
          const remoteSlot = mergedSlots[slotId];
          // Keep a newer local-only image until that member's save has been
          // acknowledged and incorporated by the host.
          if (remoteSlot && localSlot.ownerPlayerId === remoteSlot.ownerPlayerId
            && localSlot.revision > remoteSlot.revision) mergedSlots[slotId] = localSlot;
        }
        const merged = validateLobbyRecord({ ...incoming, slots: mergedSlots, revision: current.revision + 1 });
        store.put(merged);
        return merged;
      }
      store.put(incoming);
      return incoming;
    });
  }

  async function create({ roomCode, hostPlayerId, members = [], settings = {}, mode = 'soullink', runState = null, runStateRevision = 0,
    slotIds = ['slot-1', 'slot-2', 'slot-3', 'slot-4'], slotOwners = {} } = {}) {
    if (!Array.isArray(slotIds) || slotIds.length < 1 || slotIds.length > 4) throw new Error('lobby requires one to four slots');
    const slots = Object.fromEntries(slotIds.map((slotId) => [slotId, normalizeSlot(slotId, {
      ownerPlayerId: slotOwners[slotId] ?? null,
    })]));
    const record = validateLobbyRecord({
      format: LOBBY_BUNDLE_FORMAT,
      schemaVersion: LOBBY_BUNDLE_VERSION,
      roomCode,
      hostPlayerId,
      revision: 1,
      runStateRevision,
      mode,
      members,
      settings,
      runState,
      slots,
      savedAt: now(),
    });
    await withStore('readwrite', async (store) => {
      const existing = await requestResult(store.get(record.roomCode));
      if (existing) throw new Error('lobby save already exists; import or resume it explicitly');
      store.add(record);
    });
    return record;
  }

  async function updateShared({ roomCode, actorPlayerId, expectedRevision, members, settings, runState, runStateRevision, hostPlayerId } = {}) {
    return await withStore('readwrite', async (store) => {
      const prior = await requestResult(store.get(roomCode));
      if (!prior) throw new Error('lobby save does not exist');
      const current = validateLobbyRecord(prior);
      if (current.hostPlayerId !== actorPlayerId) throw new Error('only the lobby host can update shared state');
      if (current.revision !== expectedRevision) throw new Error('lobby revision conflict');
      const nextRunState = runState === undefined ? current.runState : runState;
      if (nextRunState?.runId === current.runState?.runId
        && runStateRevision !== undefined && runStateRevision < current.runStateRevision) {
        throw new Error('stale shared run-state revision');
      }
      const next = validateLobbyRecord({
        ...current,
        hostPlayerId: hostPlayerId ?? current.hostPlayerId,
        members: members ?? current.members,
        settings: settings ?? current.settings,
        runState: nextRunState,
        runStateRevision: runStateRevision ?? nextRunState?.revision ?? current.runStateRevision,
        authorityRevision: current.authorityRevision + 1,
        revision: current.revision + 1,
        savedAt: now(),
      });
      store.put(next);
      return next;
    });
  }

  async function syncRunSnapshot({ roomCode, playerId, hostPlayerId, members, settings, runState } = {}) {
    if (!Number.isSafeInteger(runState?.revision) || runState.revision < 0) throw new Error('run snapshot revision is invalid');
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await load(roomCode);
      if (!current) {
        const slotOwners = Object.fromEntries((members ?? []).map((member, index) => [
          `slot-${Number.isInteger(member.slot) ? member.slot + 1 : index + 1}`,
          member.active === false ? null : member.playerId,
        ]));
        try {
          return await create({
            roomCode, hostPlayerId, members, settings, runState, runStateRevision: runState.revision, slotOwners,
          });
        } catch (error) {
          if (!/already exists/.test(error.message)) throw error;
          continue;
        }
      }
      const sameRun = current.runState?.runId === runState.runId;
      if (sameRun && runState.revision < current.runStateRevision) throw new Error('stale shared run-state revision');
      if (sameRun && runState.revision === current.runStateRevision) return current;
      if (playerId === current.hostPlayerId) {
        try {
          return await updateShared({
            roomCode,
            actorPlayerId: playerId,
            expectedRevision: current.revision,
            hostPlayerId,
            members,
            settings,
            runState,
            runStateRevision: runState.revision,
          });
        } catch (error) {
          if (!/revision conflict/.test(error.message)) throw error;
          continue;
        }
      }
      return await withStore('readwrite', async (store) => {
        const prior = await requestResult(store.get(roomCode));
        if (!prior) throw new Error('lobby replica disappeared during run-state sync');
        const latest = validateLobbyRecord(prior);
        const sameLatestRun = latest.runState?.runId === runState.runId;
        if (sameLatestRun && runState.revision < latest.runStateRevision) throw new Error('stale shared run-state revision');
        if (sameLatestRun && runState.revision === latest.runStateRevision) return latest;
        const next = validateLobbyRecord({
          ...latest,
          hostPlayerId,
          members,
          settings,
          runState,
          runStateRevision: runState.revision,
          authorityRevision: hostPlayerId === latest.hostPlayerId
            ? latest.authorityRevision
            : latest.authorityRevision + 1,
          revision: latest.revision + 1,
          savedAt: now(),
        });
        store.put(next);
        return next;
      });
    }
    throw new Error('lobby replica remained busy during run-state sync');
  }

  async function syncStandardRoom({ roomCode, playerId, hostPlayerId, members = [] } = {}) {
    const normalizedMembers = normalizeMembers(members);
    if (!normalizedMembers.some((member) => member.playerId === hostPlayerId)) {
      throw new Error('Standard lobby host must be a current member');
    }
    if (!normalizedMembers.some((member) => member.playerId === playerId)) throw new Error('Standard lobby actor must be a current member');
    return await withStore('readwrite', async (store) => {
      const prior = await requestResult(store.get(roomCode));
      if (!prior) {
        if (playerId !== hostPlayerId) return null;
        const owners = Object.fromEntries(normalizedMembers.map((member, index) => [
          `slot-${Number.isInteger(member.slot) ? member.slot + 1 : index + 1}`, member.playerId,
        ]));
        const record = validateLobbyRecord({
          format: LOBBY_BUNDLE_FORMAT,
          schemaVersion: LOBBY_BUNDLE_VERSION,
          roomCode,
          hostPlayerId,
          revision: 1,
          authorityRevision: 1,
          mode: 'standard',
          members: normalizedMembers,
          settings: {},
          runState: null,
          slots: Object.fromEntries(['slot-1', 'slot-2', 'slot-3', 'slot-4'].map((slotId) => [slotId,
            normalizeSlot(slotId, { ownerPlayerId: owners[slotId] ?? null })])),
          savedAt: now(),
        });
        store.add(record);
        return record;
      }
      const current = validateLobbyRecord(prior);
      if (current.mode !== 'standard') throw new Error('lobby mode does not match Standard play');
      if (current.hostPlayerId === hostPlayerId
        && JSON.stringify(current.members) === JSON.stringify(normalizedMembers)) return current;
      const slots = { ...current.slots };
      const owners = new Set(Object.values(slots).map((slot) => slot.ownerPlayerId).filter(Boolean));
      for (const member of normalizedMembers) {
        if (owners.has(member.playerId)) continue;
        const available = Object.values(slots).find((slot) => slot.ownerPlayerId === null);
        if (!available) continue;
        slots[available.slotId] = normalizeSlot(available.slotId, { ...available, ownerPlayerId: member.playerId });
        owners.add(member.playerId);
      }
      const membersWithSlots = normalizedMembers.map((member) => {
        const owned = Object.values(slots).find((slot) => slot.ownerPlayerId === member.playerId);
        const slotIndex = owned ? Number(owned.slotId.slice('slot-'.length)) - 1 : member.slot;
        return { ...member, ...(Number.isInteger(slotIndex) ? { slot: slotIndex } : {}) };
      });
      const next = validateLobbyRecord({
        ...current,
        hostPlayerId,
        members: membersWithSlots,
        settings: {},
        runState: null,
        slots,
        revision: current.revision + 1,
        authorityRevision: current.authorityRevision + (playerId === hostPlayerId ? 1 : 0),
        savedAt: now(),
      });
      store.put(next);
      return next;
    });
  }

  async function commitSlot({ roomCode, slotId, playerId, expectedRevision, gameId, formatId, formatVersion, saveBytes, authoritative = false } = {}) {
    if (!SLOT_ID_RE.test(slotId ?? '')) throw new Error('invalid lobby slot ID');
    const image = bytes(saveBytes);
    if (!image?.length) throw new Error('slot save is empty');
    if (typeof validateSave !== 'function') throw new Error('a game save validator is required before committing lobby slot data');
    if (validateSave && !(await validateSave({ gameId, formatId, formatVersion, saveBytes: image }))) {
      throw new Error('slot save failed game validation');
    }
    return await withStore('readwrite', async (store) => {
      const prior = await requestResult(store.get(roomCode));
      if (!prior) throw new Error('lobby save does not exist');
      const current = validateLobbyRecord(prior);
      if (!current.members.some((member) => member.playerId === playerId)) throw new Error('player is not a lobby member');
      const slot = current.slots[slotId];
      if (!slot) throw new Error('lobby slot does not exist');
      if (slot.ownerPlayerId !== playerId) throw new Error('player does not own this lobby slot');
      if (slot.revision !== expectedRevision) throw new Error('slot revision conflict');
      current.slots[slotId] = normalizeSlot(slotId, {
        ...slot,
        revision: slot.revision + 1,
        gameId,
        formatId,
        formatVersion,
        savedAt: now(),
        saveBytes: image,
      });
      current.revision++;
      if (authoritative || current.hostPlayerId === playerId) current.authorityRevision++;
      current.savedAt = now();
      store.put(current);
      return validateLobbyRecord(current);
    });
  }

  async function claimSlot({ roomCode, slotId, playerId, expectedRevision, flushPrevious = null } = {}) {
    const before = await load(roomCode);
    if (!before) throw new Error('lobby save does not exist');
    if (!before.members.some((member) => member.playerId === playerId)) throw new Error('player is not a lobby member');
    const slot = before.slots[slotId];
    if (!slot) throw new Error('lobby slot does not exist');
    if (before.revision !== expectedRevision) throw new Error('lobby revision conflict');

    const currentOwnerSlot = Object.values(before.slots).find((candidate) =>
      candidate.slotId !== slotId && candidate.ownerPlayerId === playerId) ?? null;
    const needsPriorFlush = new Set();
    if (slot.ownerPlayerId && slot.ownerPlayerId !== playerId) needsPriorFlush.add(slot.slotId);
    if (currentOwnerSlot) needsPriorFlush.add(currentOwnerSlot.slotId);
    if (needsPriorFlush.size && typeof flushPrevious !== 'function') {
      throw new Error('affected slot owners must flush their latest saves before takeover');
    }
    const committedImages = new Map();
    for (const affectedSlotId of needsPriorFlush) {
      const affectedSlot = before.slots[affectedSlotId];
      const previousOwnerPlayerId = affectedSlot.ownerPlayerId;
      const result = await flushPrevious({ slot: clone(affectedSlot), previousOwnerPlayerId });
      if (!result) throw new Error(`slot owner ${previousOwnerPlayerId} save was not committed`);
      const committedImage = bytes(result.saveBytes);
      if (!committedImage?.length) throw new Error(`slot owner ${previousOwnerPlayerId} returned an empty save`);
      if (typeof validateSave !== 'function') throw new Error('a game save validator is required before slot takeover');
      const metadata = {
        gameId: result.gameId ?? affectedSlot.gameId,
        formatId: result.formatId ?? affectedSlot.formatId,
        formatVersion: result.formatVersion ?? affectedSlot.formatVersion,
        saveBytes: committedImage,
      };
      if (!(await validateSave(metadata))) throw new Error(`slot owner ${previousOwnerPlayerId} save failed game validation`);
      committedImages.set(affectedSlotId, { ...metadata, savedAt: now() });
    }
    /*
     * If the claimant already holds another slot, swap owners in one
     * transaction. Save images remain attached to their slot IDs, and both
     * current owners' latest images are flushed before the ownership change.
     * An empty target simply releases the claimant's former slot.
     */
    const flushOnTarget = committedImages.get(slotId) ?? null;
    if (slot.ownerPlayerId && slot.ownerPlayerId !== playerId) {
      // The latest target-owner image is required before reassignment.
      if (!flushOnTarget) throw new Error('prior slot owner image was not flushed');
    }

    return await withStore('readwrite', async (store) => {
      const prior = await requestResult(store.get(roomCode));
      if (!prior) throw new Error('lobby save does not exist');
      const current = validateLobbyRecord(prior);
      if (!current.members.some((member) => member.playerId === playerId)) throw new Error('player is not a lobby member');
      const latest = current.slots[slotId];
      const latestClaimantSlot = currentOwnerSlot ? current.slots[currentOwnerSlot.slotId] : null;
      if (current.revision !== expectedRevision || latest.revision !== slot.revision
        || latest.ownerPlayerId !== slot.ownerPlayerId
        || (currentOwnerSlot && (!latestClaimantSlot
          || latestClaimantSlot.revision !== currentOwnerSlot.revision
          || latestClaimantSlot.ownerPlayerId !== playerId))) throw new Error('lobby slot changed during takeover');

      const priorOwner = latest.ownerPlayerId;
      const targetImage = committedImages.get(slotId);
      current.slots[slotId] = normalizeSlot(slotId, {
        ...latest,
        ...(targetImage ?? {}),
        ownerPlayerId: playerId,
        revision: latest.revision + (targetImage ? 1 : 0),
        savedAt: targetImage?.savedAt ?? latest.savedAt,
      });

      if (currentOwnerSlot) {
        const oldClaimantSlot = current.slots[currentOwnerSlot.slotId];
        const claimantImage = committedImages.get(currentOwnerSlot.slotId);
        current.slots[currentOwnerSlot.slotId] = normalizeSlot(currentOwnerSlot.slotId, {
          ...oldClaimantSlot,
          ...(claimantImage ?? {}),
          ownerPlayerId: priorOwner ?? null,
          revision: oldClaimantSlot.revision + (claimantImage || priorOwner ? 1 : 0),
          savedAt: claimantImage?.savedAt ?? oldClaimantSlot.savedAt,
        });
      }

      current.revision++;
      current.authorityRevision++;
      current.savedAt = now();
      store.put(current);
      return validateLobbyRecord(current);
    });
  }

  async function exportBundle(roomCode) {
    const record = await load(roomCode);
    if (!record) throw new Error('lobby save does not exist');
    return serializeLobbyBundle(record);
  }

  async function importBundle(text, { expectedRevision = null } = {}) {
    const imported = await parseLobbyBundle(text, { validateSave });
    return await withStore('readwrite', async (store) => {
      const prior = await requestResult(store.get(imported.roomCode));
      if (prior && prior.revision !== expectedRevision) throw new Error('existing lobby needs an explicit matching revision to import over');
      store.put(imported);
      return imported;
    });
  }

  async function close() {
    const db = await databasePromise;
    db.close?.();
  }

  return Object.freeze({ list, load, remove, create, applyReplica, syncRunSnapshot, syncStandardRoom, updateShared, commitSlot, claimSlot, exportBundle, importBundle, close });
}
