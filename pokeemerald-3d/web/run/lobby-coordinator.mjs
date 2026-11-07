// Multiplayer lobby save replication, slot claim/takeover, backup/import,
// and Standard co-op lobby screen coordinator extracted from app.js.

import { parseLobbyBundle, serializeLobbyBundle } from './lobby-store.mjs';
import { createRoomScopedFloor } from './lobby-broadcast.mjs';
import { createLobbyTransferReceiver } from './lobby-transfer.mjs';
import { canStartLobby, lobbyScreenPolicy } from './lobby-screen-policy.mjs';
import {
  remapSavedLobbyToRoom,
  remapStandardLobbyToRoom as remapStandardLobbyToRoomModel,
  renderSavedSoulLinkLobbiesInto,
  renderSavedStandardLobbiesInto,
} from '../ui/saved-lobbies-view.mjs';
import { saveProfileLabel } from '../save-profiles.mjs';
import { libraryUrl } from '../packs/registry.mjs';
import { base64ToBytes, bytesToBase64, hashBytes } from '../saves/flash-save-controller.mjs';

const SOULLINK_AUTOSAVE_INTERVAL_MS = 60_000;

function equalBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

export function createLobbyCoordinator({
  standardLobbyRequested = false,
  elements = {},
  presence,
  presenceLobby,
  getSelectedGameId = () => '',
  getSaveProfile = () => '',
  getPackManifest = () => null,
  getSaveCodec = () => null,
  getSaveStore = () => null,
  getLobbySaveStore = () => null,
  getRunSettings = () => null,
  getRunRuntime = () => null,
  getRunClient = () => null,
  getInstance = () => null,
  flashBytes = () => new Uint8Array(0),
  setLastSavedFlashHash = () => {},
  saveCurrentGameNow = () => 0,
  boot = async () => {},
  showFatalError = () => {},
  onRenderRunSetup = () => {},
  onFinishSoulLinkPregame = () => {},
  getSelectedSavedSoulLink = () => null,
  setSelectedSavedSoulLink = () => {},
  setSoulLinkNewRunSelected = () => {},
} = {}) {
  const {
    statusEl,
    lobbySaveControls,
    lobbySaveStatus,
    lobbyDownloadButton,
    lobbyImportInput,
    lobbyImportLabel,
    memberSaveSlotButton,
    lobbySlotClaimLabel,
    lobbySlotClaimSelect,
    lobbySlotClaimButton,
    savedSoulLinkPanel,
    savedSoulLinkList,
    soulLinkPregameHeader,
    soulLinkPregameStatus,
    savedStandardPanel,
    savedStandardList,
    standardLobbyHeader,
    standardLobbyStatus,
    standardLobbySettings,
    standardLobbyStartButton,
    standardLobbyBackButton,
    standardLobbyCancelResumeButton,
    presenceDefaultHead,
    presenceFields,
    presenceActions,
  } = elements;

  let lobbyRecordSnapshot = null;
  let lobbyTransferReceiver = null;
  const lobbyTransferWaiters = new Map();
  let lobbySnapshotTimer = null;
  let lobbySnapshotBroadcastPromise = null;
  let lobbySnapshotBroadcastRequested = false;
  let lobbyAutosavePromise = null;
  const lobbySnapshotFloor = createRoomScopedFloor();
  let lobbyStoreReady = false;
  let lobbySyncQueue = Promise.resolve();
  let standardSoloLobbyCode = null;
  let standardSoloMirrorTimer = null;
  let standardSoloMirrorQueue = Promise.resolve();
  let selectedStandardLobby = null;
  let standardResumeBytes = null;
  let standardLobbyResumeReady = true;

  function waitForLobbyTransferAck(transferId, expectedPlayerIds = [], timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        lobbyTransferWaiters.delete(transferId);
        reject(new Error('lobby transfer acknowledgement timed out'));
      }, timeoutMs);
      const expected = new Set(expectedPlayerIds);
      const received = new Set();
      lobbyTransferWaiters.set(transferId, {
        expected,
        received,
        resolve(message) {
          if (!message.accepted) {
            clearTimeout(timer);
            reject(new Error(message.reason || 'lobby transfer was rejected by a recipient'));
            return;
          }
          if (message.recipientPlayerId) received.add(message.recipientPlayerId);
          if ([...expected].every((playerId) => received.has(playerId))) {
            clearTimeout(timer);
            resolve(message);
          }
        },
        reject(error) { clearTimeout(timer); reject(error); },
      });
    });
  }

  async function sendLobbyTransferAndWait(recipientPlayerId, purpose, text, expectedPlayerIds = [recipientPlayerId]) {
    const runClient = getRunClient();
    if (!runClient?.attached) throw new Error('run channel is not attached for lobby save replication');
    const transferId = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const acknowledged = waitForLobbyTransferAck(transferId, expectedPlayerIds);
    try {
      await runClient.sendLobbyTransfer({ transferId, recipientPlayerId, purpose, text });
      const result = await acknowledged;
      if (!result.accepted) throw new Error(result.reason || 'lobby transfer was rejected by the recipient');
      return result;
    } catch (error) {
      lobbyTransferWaiters.get(transferId)?.reject(error);
      lobbyTransferWaiters.delete(transferId);
      await acknowledged.catch(() => {});
      throw error;
    }
  }

  function lobbySaveValidator() {
    return async ({ gameId, formatId, formatVersion, saveBytes }) => {
      const packManifest = getPackManifest();
      if (gameId !== getSelectedGameId() || formatId !== packManifest.saves.formatId
        || formatVersion !== packManifest.saves.formatVersion) return false;
      return getSaveCodec().validate(saveBytes).ok;
    };
  }

  function currentLobbyHostPlayerId() {
    const runHost = getRunSettings()?.mode === 'soullink'
      ? (getRunRuntime()?.peekState?.() ?? getRunRuntime()?.state())?.hostPlayerId
      : null;
    return runHost ?? presence.getSnapshot().members?.[0]?.playerId ?? null;
  }

  function stableLocalLobbyIdentity() {
    const selectedGameId = getSelectedGameId();
    const saveProfile = getSaveProfile();
    const source = `${selectedGameId}/${saveProfile || 'default'}`;
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const suffix = (hash >>> 0).toString(36).toUpperCase().padStart(7, '0').slice(-7);
    return {
      roomCode: `LOCAL-${suffix}`,
      playerId: `local-${selectedGameId}-${suffix}`,
    };
  }

  async function ensureStandardSoloLobby() {
    const lobbySaveStore = getLobbySaveStore();
    const saveStore = getSaveStore();
    const saveCodec = getSaveCodec();
    const packManifest = getPackManifest();
    const selectedGameId = getSelectedGameId();
    const saveProfile = getSaveProfile();
    if (getRunSettings()?.mode !== 'standard' || !lobbySaveStore || !saveStore) return null;
    const identity = stableLocalLobbyIdentity();
    standardSoloLobbyCode = identity.roomCode;
    let record = await lobbySaveStore.load(identity.roomCode);
    if (!record) {
      record = await lobbySaveStore.create({
        roomCode: identity.roomCode,
        hostPlayerId: identity.playerId,
        mode: 'standard',
        members: [{ playerId: identity.playerId, name: saveProfileLabel(saveProfile), slot: 0 }],
        settings: {},
        runState: null,
        slotIds: ['slot-1'],
        slotOwners: { 'slot-1': identity.playerId },
      });
    }
    if (record.mode !== 'standard') throw new Error('local Standard lobby identity conflicts with another lobby');
    const saved = saveStore.load();
    if (saved?.bytes?.length && saveCodec.validate(saved.bytes).ok) {
      const slot = record.slots['slot-1'];
      if (!slot?.saveBytes || !equalBytes(slot.saveBytes, saved.bytes)) {
        record = await lobbySaveStore.commitSlot({
          roomCode: identity.roomCode,
          slotId: 'slot-1',
          playerId: identity.playerId,
          expectedRevision: slot.revision,
          gameId: selectedGameId,
          formatId: packManifest.saves.formatId,
          formatVersion: packManifest.saves.formatVersion,
          saveBytes: saved.bytes,
        });
      }
    }
    return record;
  }

  function queueStandardSoloMirror(saveBytes) {
    if (getRunSettings()?.mode !== 'standard' || !standardSoloLobbyCode || presence.getSnapshot().status === 'joined') return;
    if (standardSoloMirrorTimer) clearTimeout(standardSoloMirrorTimer);
    const image = new Uint8Array(saveBytes);
    standardSoloMirrorTimer = setTimeout(() => {
      standardSoloMirrorTimer = null;
      standardSoloMirrorQueue = standardSoloMirrorQueue.then(async () => {
        const lobbySaveStore = getLobbySaveStore();
        const saveCodec = getSaveCodec();
        const packManifest = getPackManifest();
        const identity = stableLocalLobbyIdentity();
        const record = await lobbySaveStore?.load(identity.roomCode);
        const slot = record?.slots?.['slot-1'];
        if (!record || record.mode !== 'standard' || !slot || !saveCodec.validate(image).ok) return;
        await lobbySaveStore.commitSlot({
          roomCode: identity.roomCode,
          slotId: 'slot-1',
          playerId: identity.playerId,
          expectedRevision: slot.revision,
          gameId: getSelectedGameId(),
          formatId: packManifest.saves.formatId,
          formatVersion: packManifest.saves.formatVersion,
          saveBytes: image,
        });
      }).catch((error) => console.warn('Standard local lobby save mirror failed', error));
    }, 1000);
  }

  async function applyLobbyReplica(record) {
    const credentials = presence.getRunCredentials?.();
    const priorSlotId = Object.entries(lobbyRecordSnapshot?.slots ?? {})
      .find(([, slot]) => slot.ownerPlayerId === credentials?.playerId)?.[0] ?? null;
    try {
      lobbyRecordSnapshot = await getLobbySaveStore().applyReplica(record);
    } catch (error) {
      console.warn('lobby replica apply failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
    const nextOwned = Object.entries(lobbyRecordSnapshot.slots)
      .find(([, slot]) => slot.ownerPlayerId === credentials?.playerId) ?? null;
    updateLobbySaveControls();
    if (priorSlotId && nextOwned && priorSlotId !== nextOwned[0] && nextOwned[1].saveBytes) {
      const nextBytes = new Uint8Array(nextOwned[1].saveBytes);
      if (!getSaveCodec().validate(nextBytes).ok || !getSaveStore().save(nextBytes)) {
        throw new Error('newly assigned slot save could not be validated in the local game slot');
      }
      setLastSavedFlashHash(hashBytes(nextBytes));
      if (getRunSettings()?.mode === 'standard' && document.body.dataset.standardLobby === 'true') {
        standardResumeBytes = nextBytes;
      } else {
        await boot(nextBytes, { continueSavedGame: true });
      }
    }
    return lobbyRecordSnapshot;
  }

  function remapStandardLobbyToRoom(checkpoint, room) {
    return remapStandardLobbyToRoomModel(checkpoint, room, lobbyRecordSnapshot);
  }

  async function restoreStandardLobbyOwnSlot(record, room) {
    const ownedSlot = Object.values(record.slots).find((slot) => slot.ownerPlayerId === room.playerId);
    if (!ownedSlot?.saveBytes) throw new Error('your Standard lobby save is missing from this browser');
    const image = new Uint8Array(ownedSlot.saveBytes);
    if (!getSaveCodec().validate(image).ok || !getSaveStore().save(image)) {
      throw new Error('your Standard lobby save could not be validated or stored locally');
    }
    setLastSavedFlashHash(hashBytes(image));
    standardResumeBytes = image;
    if (!standardLobbyRequested) await boot(image, { continueSavedGame: true });
  }

  async function restoreOwnSavedLobbySlot(checkpoint, runState, credentials) {
    const mapped = remapSavedLobbyToRoom(checkpoint, runState, credentials.room);
    lobbyRecordSnapshot = await getLobbySaveStore().applyReplica(mapped);
    const ownedSlot = Object.values(lobbyRecordSnapshot.slots)
      .find((slot) => slot.ownerPlayerId === credentials.playerId);
    const fallbackBytes = !ownedSlot?.saveBytes ? getSaveStore()?.load?.()?.bytes : null;
    const sourceBytes = ownedSlot?.saveBytes ?? fallbackBytes;
    if (!sourceBytes) throw new Error('your save is missing from this saved lobby on this browser');
    const bytes = new Uint8Array(sourceBytes);
    if (!getSaveCodec().validate(bytes).ok || !getSaveStore().save(bytes)) {
      throw new Error('your saved lobby slot could not be validated or stored locally');
    }
    setLastSavedFlashHash(hashBytes(bytes));
    await boot(bytes, { continueSavedGame: true });
    setSelectedSavedSoulLink(null);
    onFinishSoulLinkPregame();
    updateLobbySaveControls();
    if (!ownedSlot?.saveBytes) {
      void saveLobbySlot(true).catch(() => {});
    }
    if (runState.hostPlayerId === credentials.playerId) {
      await broadcastLobbySnapshotImmediate();
    }
  }

  function ensureLobbyTransferReceiver() {
    lobbyTransferReceiver ??= createLobbyTransferReceiver({
      async onComplete({ senderPlayerId, purpose, text }) {
        const credentials = presence.getRunCredentials?.();
        const state = getRunRuntime()?.peekState?.() ?? getRunRuntime()?.state();
        const lobbySaveStore = getLobbySaveStore();
        const runSettings = getRunSettings();
        if (!credentials?.room || !lobbySaveStore) throw new Error('lobby is unavailable');
        const hostPlayerId = currentLobbyHostPlayerId();
        if (purpose === 'slot-save') {
          if (hostPlayerId !== credentials.playerId) throw new Error('slot uploads are only accepted by the host');
          const upload = JSON.parse(text);
          if (upload?.format !== 'poketech-lobby-slot-save'
            || upload.schemaVersion !== 1
            || upload.roomCode !== credentials.room
            || upload.ownerPlayerId !== senderPlayerId) throw new Error('lobby slot upload identity is invalid');
          const record = await lobbySaveStore.load(credentials.room);
          if (record?.mode !== runSettings?.mode) throw new Error('lobby save mode does not match the active play mode');
          const slot = record?.slots?.[upload.slotId];
          if (!slot || slot.ownerPlayerId !== senderPlayerId) throw new Error('sender does not own the uploaded slot');
          lobbyRecordSnapshot = await lobbySaveStore.commitSlot({
            roomCode: credentials.room,
            slotId: upload.slotId,
            playerId: senderPlayerId,
            expectedRevision: slot.revision,
            gameId: upload.gameId,
            formatId: upload.formatId,
            formatVersion: upload.formatVersion,
            saveBytes: base64ToBytes(upload.saveBytes),
            authoritative: true,
          });
          updateLobbySaveControls();
          const assignedSlots = Object.values(lobbyRecordSnapshot.slots).filter((slot) => slot.ownerPlayerId);
          if (assignedSlots.length && assignedSlots.every((slot) => slot.saveBytes)) queueLobbySnapshotBroadcast();
          return { revision: lobbyRecordSnapshot.revision };
        }
        if (purpose === 'slot-claim-request') {
          if (hostPlayerId !== credentials.playerId) throw new Error('slot claims must be handled by the current host');
          if (lobbySaveStatus) lobbySaveStatus.textContent = 'Host is requesting latest slot commits before takeover.';
          const request = JSON.parse(text);
          if (request?.format !== 'poketech-lobby-slot-claim'
            || request.schemaVersion !== 1 || request.roomCode !== credentials.room
            || request.claimantPlayerId !== senderPlayerId || typeof request.slotId !== 'string') {
            throw new Error('slot claim request identity is invalid');
          }
          const current = await lobbySaveStore.load(credentials.room);
          const target = current?.slots?.[request.slotId];
          if (!target || target.ownerPlayerId === senderPlayerId) throw new Error('selected slot is not available for takeover');
          const claimedRecord = await lobbySaveStore.claimSlot({
            roomCode: credentials.room,
            slotId: request.slotId,
            playerId: senderPlayerId,
            expectedRevision: current.revision,
            flushPrevious: async ({ slot, previousOwnerPlayerId }) => {
              const latest = await lobbySaveStore.load(credentials.room);
              const latestSlot = latest?.slots?.[slot.slotId];
              if (!latestSlot?.saveBytes || latestSlot.ownerPlayerId !== previousOwnerPlayerId) {
                throw new Error('prior owner has no committed save in the host lobby; takeover is blocked');
              }
              return {
                gameId: latestSlot.gameId,
                formatId: latestSlot.formatId,
                formatVersion: latestSlot.formatVersion,
                saveBytes: latestSlot.saveBytes,
              };
            },
          });
          await applyLobbyReplica(claimedRecord);
          await broadcastLobbySnapshotImmediate();
          return { revision: lobbyRecordSnapshot.revision };
        }
        if (purpose === 'lobby-snapshot') {
          if (senderPlayerId !== hostPlayerId) throw new Error('lobby snapshot is not from the current host');
          const record = await parseLobbyBundle(text, { validateSave: lobbySaveValidator() });
          if (record.roomCode !== credentials.room || record.hostPlayerId !== senderPlayerId) {
            throw new Error('lobby snapshot room or host does not match this client');
          }
          if (record.mode !== runSettings?.mode) throw new Error('lobby snapshot mode does not match the active play mode');
          await applyLobbyReplica(record);
          const ownSlot = Object.values(lobbyRecordSnapshot.slots)
            .find((slot) => slot.ownerPlayerId === credentials.playerId);
          const fallbackBytes = !ownSlot?.saveBytes ? getSaveStore()?.load?.()?.bytes : null;
          const sourceBytes = ownSlot?.saveBytes ?? fallbackBytes;
          if (sourceBytes && state?.status === 'active'
            && document.body.dataset.soulLinkPregame === 'true') {
            const bytes = new Uint8Array(sourceBytes);
            if (!getSaveCodec().validate(bytes).ok || !getSaveStore().save(bytes)) {
              throw new Error('your saved lobby slot could not be validated or stored locally');
            }
            setLastSavedFlashHash(hashBytes(bytes));
            await boot(bytes, { continueSavedGame: true });
            onFinishSoulLinkPregame();
            updateLobbySaveControls();
            if (!ownSlot?.saveBytes) {
              void saveLobbySlot(true).catch(() => {});
            }
          }
          return { revision: lobbyRecordSnapshot.revision };
        }
        throw new Error('lobby transfer purpose is unsupported');
      },
      acknowledge(message) {
        if (message.transferId) getRunClient()?.sendLobbyMessage({ type: 'lobby.transfer.ack', ...message });
      },
    });
    return lobbyTransferReceiver;
  }

  async function handleLobbyMessage(message) {
    if (message.type === 'lobby.transfer.ack') {
      const waiter = lobbyTransferWaiters.get(message.transferId);
      if (!waiter) return;
      waiter.resolve(message);
      if ([...waiter.expected].every((playerId) => waiter.received.has(playerId))) {
        lobbyTransferWaiters.delete(message.transferId);
      }
      return;
    }
    await ensureLobbyTransferReceiver().handle(message);
  }

  async function broadcastLobbySnapshot() {
    if (lobbySnapshotBroadcastPromise) {
      lobbySnapshotBroadcastRequested = true;
      return await lobbySnapshotBroadcastPromise;
    }
    if (lobbySnapshotTimer) {
      clearTimeout(lobbySnapshotTimer);
      lobbySnapshotTimer = null;
    }
    lobbySnapshotBroadcastPromise = (async () => {
      let didSend = false;
      do {
        lobbySnapshotBroadcastRequested = false;
        const credentials = presence.getRunCredentials?.();
        const lobbySaveStore = getLobbySaveStore();
        if (!credentials || !lobbySaveStore) return didSend;
        const record = await lobbySaveStore.load(credentials.room);
        const room = presence.getSnapshot();
        const hostPlayerId = getRunSettings()?.mode === 'soullink'
          ? getRunRuntime()?.state()?.hostPlayerId
          : room.members?.[0]?.playerId;
        if (record?.hostPlayerId !== hostPlayerId || hostPlayerId !== credentials.playerId) return didSend;
        if (!record || !lobbySnapshotFloor.shouldBroadcast(credentials.room, record.authorityRevision)) return didSend;
        const text = await lobbySaveStore.exportBundle(credentials.room);
        const recipients = (room.members ?? [])
          .filter((member) => member.playerId !== credentials.playerId && member.connection === 'connected')
          .map((member) => member.playerId);
        if (!recipients.length) return didSend;
        try {
          await sendLobbyTransferAndWait('*', 'lobby-snapshot', text, recipients);
        } catch (error) {
          if (!getRunClient()?.attached) return didSend;
          throw error;
        }
        lobbySnapshotFloor.commit(credentials.room, record.authorityRevision);
        didSend = true;
      } while (lobbySnapshotBroadcastRequested);
      return didSend;
    })().finally(() => {
      lobbySnapshotBroadcastPromise = null;
      if (lobbySnapshotBroadcastRequested) queueLobbySnapshotBroadcast();
    });
    return await lobbySnapshotBroadcastPromise;
  }

  function queueLobbySnapshotBroadcast() {
    if (lobbySnapshotTimer) clearTimeout(lobbySnapshotTimer);
    lobbySnapshotTimer = setTimeout(() => {
      lobbySnapshotTimer = null;
      void broadcastLobbySnapshot().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (getRunClient()?.attached && !message.includes('stopped=true')) console.warn('lobby snapshot broadcast failed', error);
      });
    }, 300);
  }

  function clearLobbySnapshotQueue() {
    if (lobbySnapshotTimer) clearTimeout(lobbySnapshotTimer);
    lobbySnapshotTimer = null;
    lobbySnapshotBroadcastRequested = false;
  }

  async function broadcastLobbySnapshotImmediate() {
    if (lobbySnapshotTimer) {
      clearTimeout(lobbySnapshotTimer);
      lobbySnapshotTimer = null;
    }
    lobbySnapshotBroadcastRequested = true;
    return await broadcastLobbySnapshot();
  }

  function syncLobbyPersistence(runState, credentials = presence.getRunCredentials?.()) {
    const lobbySaveStore = getLobbySaveStore();
    if (!lobbySaveStore || !runState || !credentials?.room || !credentials.playerId) return;
    const snapshot = structuredClone(runState);
    const task = lobbySyncQueue.then(async () => {
      const room = presence.getSnapshot();
      const members = (snapshot.members ?? []).map((member) => ({
        playerId: member.playerId,
        name: member.name,
        connected: room.members?.find((candidate) => candidate.playerId === member.playerId)?.connection === 'connected',
        ready: member.ready === true,
        slot: member.slot,
      }));
      lobbyRecordSnapshot = await lobbySaveStore.syncRunSnapshot({
        roomCode: credentials.room,
        playerId: credentials.playerId,
        hostPlayerId: snapshot.hostPlayerId,
        members,
        settings: snapshot.options,
        runState: snapshot,
      });
      lobbyStoreReady = true;
      updateLobbySaveControls();
      if (!savedSoulLinkPanel?.hidden) void renderSavedSoulLinkLobbies();
    }).catch((error) => {
      lobbyStoreReady = false;
      if (lobbySaveStatus) lobbySaveStatus.textContent = `Lobby save is not ready: ${error.message}`;
      console.error('lobby save sync failed', error);
    });
    lobbySyncQueue = task;
    return task;
  }

  async function syncStandardLobbyRoom() {
    const lobbySaveStore = getLobbySaveStore();
    if (getRunSettings()?.mode !== 'standard' || !lobbySaveStore) return null;
    const room = presence.getSnapshot();
    const credentials = presence.getRunCredentials?.();
    if (room.status !== 'joined' || !credentials?.room || !credentials.playerId || !room.members?.length) return null;
    const hostPlayerId = room.members[0]?.playerId;
    const members = room.members.map((member, index) => ({
      playerId: member.playerId,
      name: member.name,
      connected: member.connection === 'connected',
      slot: index,
    }));
    let record = await lobbySaveStore.syncStandardRoom({
      roomCode: credentials.room,
      playerId: credentials.playerId,
      hostPlayerId,
      members,
    });
    lobbyRecordSnapshot = record;
    if (selectedStandardLobby) {
      const expectedNames = selectedStandardLobby.members.map((member) => member.name);
      const currentNames = room.members.map((member) => member.name);
      const subsetMatches = currentNames.every((name) => expectedNames.includes(name));
      if (subsetMatches && currentNames.length < expectedNames.length) {
        if (lobbySaveStatus) {
          lobbySaveStatus.textContent = `Waiting for all saved players to join (${currentNames.length}/${expectedNames.length}) before restoring Standard co-op.`;
        }
        lobbyRecordSnapshot = record;
        updateLobbySaveControls();
        return record;
      }
      if (currentNames.length !== expectedNames.length || !subsetMatches) {
        throw new Error('Standard lobby resume needs the same unique player names as the saved lobby');
      }
      const mapped = remapStandardLobbyToRoom(selectedStandardLobby, room);
      record = await lobbySaveStore.applyReplica(mapped);
      lobbyRecordSnapshot = record;
      await restoreStandardLobbyOwnSlot(record, room);
      selectedStandardLobby = null;
    }
    lobbyRecordSnapshot = record;
    lobbyStoreReady = true;
    updateLobbySaveControls();
    void renderSavedStandardLobbies().catch((error) => console.warn('saved Standard lobbies could not be refreshed', error));
    if (hostPlayerId === credentials.playerId) queueLobbySnapshotBroadcast();
    return record;
  }

  function updateLobbySaveControls() {
    if (!lobbySaveControls) return;
    const state = getRunRuntime()?.peekState?.() ?? getRunRuntime()?.state();
    const room = presence.getSnapshot();
    const runSettings = getRunSettings();
    const runClient = getRunClient();
    const hostPlayerId = state?.hostPlayerId ?? room.members?.[0]?.playerId ?? null;
    const isHost = Boolean(hostPlayerId && hostPlayerId === room.playerId);
    const pregame = document.body.dataset.soulLinkPregame === 'true'
      || document.body.dataset.standardLobby === 'true';
    const standardJoined = runSettings?.mode === 'standard' && room.status === 'joined' && !pregame;
    const soulLinkJoined = runSettings?.mode === 'soullink' && room.status === 'joined' && Boolean(state) && !pregame;
    lobbySaveControls.hidden = !standardJoined && !soulLinkJoined;
    if (lobbySaveStatus) {
      const record = lobbyRecordSnapshot;
      const assigned = record ? Object.values(record.slots).filter((slot) => slot.ownerPlayerId).length : (room.members?.length ?? 0);
      const saved = record ? Object.values(record.slots).filter((slot) => slot.ownerPlayerId && slot.saveBytes).length : 0;
      lobbySaveStatus.textContent = record
        ? `Saved on this browser: ${saved} of ${assigned} player saves${saved < assigned ? ' · waiting for the others' : ' · ready to back up'}`
        : 'Setting up autosave on this browser…';
      const readyToArchive = Boolean(record && assigned > 0 && saved === assigned);
      if (lobbyDownloadButton) lobbyDownloadButton.disabled = !isHost || !readyToArchive || !runClient?.attached;
    }
    if (memberSaveSlotButton) {
      const credentials = presence.getRunCredentials?.();
      const slotId = lobbyRecordSnapshot
        ? Object.entries(lobbyRecordSnapshot.slots).find(([, slot]) => slot.ownerPlayerId === credentials?.playerId)?.[0] ?? null
        : null;
      memberSaveSlotButton.hidden = !slotId;
      memberSaveSlotButton.disabled = !slotId || !lobbyRecordSnapshot?.slots?.[slotId]
        || lobbyRecordSnapshot.slots[slotId].ownerPlayerId !== credentials?.playerId
        || !runClient?.attached;
    }
    if (lobbySlotClaimSelect && lobbyRecordSnapshot) {
      const credentials = presence.getRunCredentials?.();
      const owned = Object.entries(lobbyRecordSnapshot.slots)
        .find(([, slot]) => slot.ownerPlayerId === credentials?.playerId)?.[0] ?? null;
      const candidates = Object.entries(lobbyRecordSnapshot.slots)
        .filter(([slotId, slot]) => slotId !== owned && slot.ownerPlayerId && slot.saveBytes);
      lobbySlotClaimLabel.hidden = !candidates.length;
      lobbySlotClaimSelect.replaceChildren();
      for (const [slotId, slot] of candidates) {
        const owner = lobbyRecordSnapshot.members.find((member) => member.playerId === slot.ownerPlayerId);
        const option = document.createElement('option');
        option.value = slotId;
        option.textContent = `${slotId} · ${owner?.name ?? 'Player'}${slot.saveBytes ? ' · saved' : ' · no save'}`;
        lobbySlotClaimSelect.append(option);
      }
      lobbySlotClaimButton.disabled = !candidates.length || !runClient?.attached;
    } else if (lobbySlotClaimLabel) {
      lobbySlotClaimLabel.hidden = true;
    }
    if (lobbyDownloadButton) lobbyDownloadButton.hidden = !isHost;
    if (lobbyImportLabel) lobbyImportLabel.hidden = !isHost;
    if (lobbyImportInput) lobbyImportInput.disabled = !isHost;
  }

  async function renderSavedSoulLinkLobbies() {
    const lobbySaveStore = getLobbySaveStore();
    if (!savedSoulLinkList || !lobbySaveStore) return;
    const records = (await lobbySaveStore.list()).filter((record) => record.mode === 'soullink');
    renderSavedSoulLinkLobbiesInto({
      listEl: savedSoulLinkList,
      records,
      selectedRoomCode: getSelectedSavedSoulLink()?.roomCode ?? null,
      onSelectRecord: (record) => {
        setSelectedSavedSoulLink(record);
        setSoulLinkNewRunSelected(false);
        if (soulLinkPregameStatus) {
          soulLinkPregameStatus.textContent = 'Run selected. Create a room to host it, or enter the host’s room code and join. Everyone must use the same player names as this saved run.';
        }
        onRenderRunSetup();
      },
      onDeleteRecord: async (record, names) => {
        if (!confirm(`Delete the saved run for ${names}? This removes its local checkpoint.`)) return;
        await lobbySaveStore.remove(record.roomCode);
        if (getSelectedSavedSoulLink()?.roomCode === record.roomCode) {
          setSelectedSavedSoulLink(null);
          setSoulLinkNewRunSelected(true);
          onRenderRunSetup();
        }
        await renderSavedSoulLinkLobbies();
      },
    });
  }

  async function renderSavedStandardLobbies() {
    const lobbySaveStore = getLobbySaveStore();
    if (!savedStandardList || !lobbySaveStore) return;
    const records = (await lobbySaveStore.list()).filter((record) => record.mode === 'standard'
      && !record.roomCode.startsWith('LOCAL-') && Object.values(record.slots).some((slot) => slot.saveBytes));
    renderSavedStandardLobbiesInto({
      listEl: savedStandardList,
      records,
      selectedRoomCode: selectedStandardLobby?.roomCode ?? null,
      onSelectRecord: (record) => {
        selectedStandardLobby = record;
        if (lobbySaveStatus) lobbySaveStatus.textContent = 'Lobby selected. Create or join a room with the same player names to restore each player’s save.';
        renderStandardLobbyScreen();
      },
    });
  }

  async function saveLobbySlot(automatic = false, { allowExistingFlashWhenBusy = false } = {}) {
    const credentials = presence.getRunCredentials?.();
    const state = getRunRuntime()?.peekState?.() ?? getRunRuntime()?.state();
    const lobbySaveStore = getLobbySaveStore();
    const runSettings = getRunSettings();
    const packManifest = getPackManifest();
    const selectedGameId = getSelectedGameId();
    if (!credentials || !lobbySaveStore || !['standard', 'soullink'].includes(runSettings?.mode)) {
      if (automatic && (Boolean(getInstance()?.exports?.WasmPresenceValid?.())
        || (runSettings?.mode === 'soullink' && ['active', 'wipe_pending'].includes(state?.status)))) {
        saveCurrentGameNow(true);
      }
      throw new Error('join a Standard or SoulLink lobby before saving a slot');
    }
    if (runSettings.mode === 'soullink' && !state) throw new Error('the SoulLink run has not started');
    if (runSettings.mode === 'standard') await syncStandardLobbyRoom();
    if (saveCurrentGameNow(automatic) !== 1) {
      const canUseExistingFlash = (allowExistingFlashWhenBusy || state?.status === 'wipe_pending')
        && Boolean(getSaveCodec()?.validate?.(flashBytes())?.ok);
      if (!canUseExistingFlash) throw new Error('the game could not save right now');
    }
    if (runSettings.mode === 'soullink') await syncLobbyPersistence(state, credentials);
    const isMember = runSettings.mode === 'soullink'
      ? state.members.some((candidate) => candidate.playerId === credentials.playerId && candidate.active !== false)
      : presence.getSnapshot().members?.some((candidate) => candidate.playerId === credentials.playerId);
    if (!isMember) throw new Error('this player is not a member of the active lobby');
    let record = null;
    let slotId = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      record = await lobbySaveStore.load(credentials.room);
      if (record?.mode !== runSettings.mode && record) throw new Error('lobby save mode does not match the active play mode');
      slotId = Object.entries(record?.slots ?? {}).find(([, slot]) => slot.ownerPlayerId === credentials.playerId)?.[0] ?? null;
      if (record && slotId) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!slotId) throw new Error('claim a lobby slot before saving');
    const slot = record?.slots?.[slotId];
    if (!slot || slot.ownerPlayerId !== credentials.playerId) throw new Error('claim your assigned lobby slot before saving');
    const image = flashBytes();
    lobbyRecordSnapshot = await lobbySaveStore.commitSlot({
      roomCode: credentials.room,
      slotId,
      playerId: credentials.playerId,
      expectedRevision: slot.revision,
      gameId: selectedGameId,
      formatId: packManifest.saves.formatId,
      formatVersion: packManifest.saves.formatVersion,
      saveBytes: image,
    });
    const hostPlayerId = currentLobbyHostPlayerId();
    if (credentials.playerId !== hostPlayerId) {
      await sendLobbyTransferAndWait(hostPlayerId, 'slot-save', JSON.stringify({
        format: 'poketech-lobby-slot-save',
        schemaVersion: 1,
        roomCode: credentials.room,
        ownerPlayerId: credentials.playerId,
        slotId,
        gameId: selectedGameId,
        formatId: packManifest.saves.formatId,
        formatVersion: packManifest.saves.formatVersion,
        saveBytes: bytesToBase64(image),
      }));
    } else {
      const assignedSlots = Object.values(lobbyRecordSnapshot.slots).filter((slot) => slot.ownerPlayerId);
      if (assignedSlots.length && assignedSlots.every((slot) => slot.saveBytes)) queueLobbySnapshotBroadcast();
    }
    updateLobbySaveControls();
    void renderSavedStandardLobbies().catch((error) => console.warn('saved Standard lobbies could not be refreshed', error));
    return lobbyRecordSnapshot;
  }

  async function requestLobbySlotTakeover(slotId) {
    const credentials = presence.getRunCredentials?.();
    if (!credentials || !lobbyRecordSnapshot?.slots?.[slotId]) throw new Error('selected lobby slot is unavailable');
    const hostPlayerId = currentLobbyHostPlayerId();
    if (!hostPlayerId) throw new Error('the lobby host is unavailable');
    if (lobbyRecordSnapshot.slots[slotId].ownerPlayerId === credentials.playerId) throw new Error('you already own that lobby slot');
    if (lobbySaveStatus) lobbySaveStatus.textContent = 'Committing your current slot before takeover…';
    statusEl.textContent = 'Committing your current slot before takeover…';
    await saveLobbySlot();
    if (lobbySaveStatus) lobbySaveStatus.textContent = `Requesting host takeover of ${slotId}…`;
    statusEl.textContent = `Requesting host takeover of ${slotId}…`;
    await sendLobbyTransferAndWait(hostPlayerId, 'slot-claim-request', JSON.stringify({
      format: 'poketech-lobby-slot-claim',
      schemaVersion: 1,
      roomCode: credentials.room,
      claimantPlayerId: credentials.playerId,
      slotId,
    }), [hostPlayerId]);
    if (lobbySaveStatus) lobbySaveStatus.textContent = 'Slot takeover committed; assigned save is loading locally.';
    statusEl.textContent = 'Slot takeover committed; assigned save is loading locally.';
  }

  async function downloadLobbyBackup() {
    const room = presence.getSnapshot();
    const lobbySaveStore = getLobbySaveStore();
    if (!lobbySaveStore || !room.room) throw new Error('join a lobby before downloading a backup');
    const current = await lobbySaveStore.load(room.room);
    const assigned = Object.values(current?.slots ?? {}).filter((slot) => slot.ownerPlayerId);
    if (!assigned.length || assigned.some((slot) => !slot.saveBytes)) {
      throw new Error('Save each active member’s assigned slot before downloading the lobby backup.');
    }
    await broadcastLobbySnapshotImmediate();
    const text = await lobbySaveStore.exportBundle(room.room);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `poketech-${room.room}.ptlobby`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importLobbyBackup(file) {
    const lobbySaveStore = getLobbySaveStore();
    if (!file || !lobbySaveStore) return;
    const room = presence.getSnapshot();
    const runState = getRunRuntime()?.state();
    const runSettings = getRunSettings();
    const isHost = runState?.hostPlayerId
      ? runState.hostPlayerId === room.playerId
      : room.isRoomCreator === true || room.members?.[0]?.playerId === room.playerId;
    if (!room.room || !room.playerId || !isHost) throw new Error('only the host can import a lobby backup');
    const current = await lobbySaveStore.load(room.room);
    if (current && !confirm('Replace this browser’s lobby container with the selected backup?')) return;
    const text = await file.text();
    const parsed = await parseLobbyBundle(text, { validateSave: lobbySaveValidator() });
    if (parsed.mode !== runSettings?.mode) throw new Error('the selected lobby backup belongs to a different play mode');
    let bundleText = text;
    if (runSettings.mode === 'standard' && parsed.roomCode !== room.room) {
      lobbyRecordSnapshot = current;
      bundleText = serializeLobbyBundle(remapStandardLobbyToRoom(parsed, room));
    }
    lobbyRecordSnapshot = await lobbySaveStore.importBundle(bundleText, {
      expectedRevision: current?.revision ?? null,
    });
    const assignedSlots = Object.values(lobbyRecordSnapshot.slots).filter((slot) => slot.ownerPlayerId);
    if (assignedSlots.length && assignedSlots.every((slot) => slot.saveBytes)) queueLobbySnapshotBroadcast();
    updateLobbySaveControls();
    if (lobbySaveStatus) lobbySaveStatus.textContent += ' · imported locally; server replication pending';
  }

  function renderStandardLobbyScreen() {
    if (document.body.dataset.standardLobby !== 'true') return;
    const policy = lobbyScreenPolicy('standard');
    const room = presence.getSnapshot();
    const joined = room.status === 'joined';
    const joining = ['connecting', 'handshaking', 'reconnecting'].includes(room.status);
    const members = joined ? (room.members ?? []) : [];
    const playerCount = joined ? members.length : 1;
    let resumeReady = true;
    if (selectedStandardLobby) {
      const savedNames = selectedStandardLobby.members.map((member) => member.name);
      const liveNames = members.map((member) => member.name);
      resumeReady = liveNames.length === savedNames.length
        && new Set(liveNames).size === liveNames.length
        && new Set(savedNames).size === savedNames.length
        && savedNames.every((name) => liveNames.includes(name));
    }
    standardLobbyResumeReady = resumeReady;
    const mayStart = canStartLobby(policy, {
      playerCount,
      roomJoined: joined,
      isHost: joined && room.members?.[0]?.playerId === room.playerId,
    }) && resumeReady && !joining;

    if (standardLobbyHeader) standardLobbyHeader.hidden = false;
    if (standardLobbySettings) standardLobbySettings.hidden = !policy.showSettings;
    if (soulLinkPregameHeader) soulLinkPregameHeader.hidden = true;
    if (presenceDefaultHead) presenceDefaultHead.hidden = true;
    if (savedSoulLinkPanel) savedSoulLinkPanel.hidden = true;
    if (savedStandardPanel) savedStandardPanel.hidden = joined;
    if (presenceFields) presenceFields.hidden = joined;
    if (presenceActions) presenceActions.hidden = false;
    const createButton = document.querySelector('#presence-create');
    const joinButton = document.querySelector('#presence-join');
    const leaveButton = document.querySelector('#presence-leave');
    if (createButton) createButton.hidden = joined;
    if (joinButton) joinButton.hidden = joined;
    if (leaveButton) leaveButton.hidden = !joined;
    if (standardLobbyBackButton) standardLobbyBackButton.hidden = false;
    if (standardLobbyCancelResumeButton) standardLobbyCancelResumeButton.hidden = !selectedStandardLobby;
    const toggle = document.querySelector('#presence-toggle');
    if (toggle) toggle.hidden = true;
    if (standardLobbyStatus) {
      const roomLabel = joined ? `Room ${room.room} · ${playerCount}/4 players. ` : '';
      standardLobbyStatus.textContent = !resumeReady
        ? `${roomLabel}Join with the saved player names before restoring this co-op lobby.`
        : joined
          ? `${roomLabel}Each player keeps a separate Emerald save. Start when you are ready.`
          : selectedStandardLobby
            ? 'Saved co-op lobby selected. Join all saved players to restore their individual saves, or deselect it to start solo.'
            : 'Your offline solo lobby is ready. Start alone, or create/join a room to invite friends.';
    }
    if (standardLobbyStartButton) {
      standardLobbyStartButton.disabled = !mayStart;
      standardLobbyStartButton.textContent = selectedStandardLobby ? 'Resume Standard Play' : 'Start Standard Play';
    }
    updateLobbySaveControls();
  }

  async function startStandardFromLobby() {
    if (document.body.dataset.standardLobby !== 'true') return;
    const room = presence.getSnapshot();
    const policy = lobbyScreenPolicy('standard');
    if (['connecting', 'handshaking', 'reconnecting'].includes(room.status)) return;
    const playerCount = room.status === 'joined' ? room.members?.length ?? 0 : 1;
    const ready = canStartLobby(policy, {
      playerCount,
      roomJoined: room.status === 'joined',
      isHost: room.status === 'joined' && room.members?.[0]?.playerId === room.playerId,
    });
    if (!ready || !standardLobbyResumeReady) return;

    if (standardLobbyStartButton) standardLobbyStartButton.disabled = true;
    finishStandardLobby();
    const resumeBytes = standardResumeBytes;
    standardResumeBytes = null;
    selectedStandardLobby = null;
    try {
      await boot(resumeBytes ?? undefined, { continueSavedGame: Boolean(resumeBytes) });
    } catch (error) {
      showFatalError(error, 'Unable to start Standard Play');
    }
  }

  function enterStandardLobby() {
    if (!standardLobbyRequested) return;
    document.body.dataset.standardLobby = 'true';
    if (standardLobbyHeader) standardLobbyHeader.hidden = false;
    if (standardLobbyBackButton) standardLobbyBackButton.hidden = false;
    if (savedStandardPanel) savedStandardPanel.hidden = false;
    if (presenceFields) presenceFields.hidden = false;
    if (presenceActions) presenceActions.hidden = false;
    presenceLobby.open();
    renderStandardLobbyScreen();
  }

  function finishStandardLobby() {
    if (document.body.dataset.standardLobby !== 'true') return;
    document.body.dataset.standardLobby = 'false';
    if (standardLobbyHeader) standardLobbyHeader.hidden = true;
    if (standardLobbyBackButton) standardLobbyBackButton.hidden = true;
    if (presenceDefaultHead) presenceDefaultHead.hidden = false;
    const toggle = document.querySelector('#presence-toggle');
    if (toggle) toggle.hidden = false;
    presenceLobby.close();
    const url = new URL(location.href);
    url.searchParams.delete('lobby');
    history.replaceState(history.state, '', url);
    updateLobbySaveControls();
  }

  function leaveStandardLobby() {
    if (document.body.dataset.standardLobby !== 'true') return;
    presence.leave();
    selectedStandardLobby = null;
    standardResumeBytes = null;
    location.assign(libraryUrl(location.href));
  }

  async function handleLobbySaveAction(action) {
    try {
      await saveLobbySlot();
      if (action === 'download') {
        await downloadLobbyBackup();
        statusEl.textContent = getRunSettings()?.mode === 'standard'
          ? 'Lobby backup downloaded. Keep it somewhere safe to move these player saves to another browser.'
          : 'Run backup downloaded. Keep the file somewhere safe to move the run to another browser.';
      } else {
        statusEl.textContent = 'Your game was saved in this browser.';
      }
      onRenderRunSetup();
    } catch (error) {
      statusEl.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  function init() {
    setInterval(() => {
      const state = getRunRuntime()?.peekState?.() ?? getRunRuntime()?.state();
      const runSettings = getRunSettings();
      const instance = getInstance();
      const standardJoined = runSettings?.mode === 'standard' && presence.getSnapshot().status === 'joined';
      const soulLinkActive = runSettings?.mode === 'soullink' && ['active', 'wipe_pending'].includes(state?.status);
      const inActiveWorld = Boolean(instance?.exports?.WasmPresenceValid?.()) || soulLinkActive;
      if (!inActiveWorld || lobbyAutosavePromise) return;
      if (typeof instance?.exports?.WasmCanSaveGame === 'function' && !instance.exports.WasmCanSaveGame()) return;
      if ((!standardJoined && !soulLinkActive) || !presence.getRunCredentials?.()) {
        saveCurrentGameNow(true);
        return;
      }
      if (document.hidden) {
        saveCurrentGameNow(true);
        return;
      }
      lobbyAutosavePromise = saveLobbySlot(true)
        .then(() => {
          if (lobbySaveStatus) lobbySaveStatus.textContent = `Autosaved your ${runSettings.mode === 'standard' ? 'Standard' : 'SoulLink'} save on this browser.`;
        })
        .catch((error) => {
          console.warn('SoulLink autosave failed', error);
          if (lobbySaveStatus) lobbySaveStatus.textContent = `Autosave failed: ${error.message || 'try Save my game now'}`;
        })
        .finally(() => { lobbyAutosavePromise = null; });
    }, SOULLINK_AUTOSAVE_INTERVAL_MS);

    standardLobbyCancelResumeButton?.addEventListener('click', () => {
      selectedStandardLobby = null;
      standardResumeBytes = null;
      void renderSavedStandardLobbies();
      renderStandardLobbyScreen();
    });

    standardLobbyStartButton?.addEventListener('click', () => { void startStandardFromLobby(); });
    standardLobbyBackButton?.addEventListener('click', leaveStandardLobby);

    memberSaveSlotButton?.addEventListener('click', () => { void handleLobbySaveAction('slot'); });
    lobbySlotClaimButton?.addEventListener('click', () => {
      const slotId = lobbySlotClaimSelect?.value;
      if (!slotId) return;
      statusEl.textContent = `Requesting host takeover of ${slotId}…`;
      lobbySlotClaimButton.disabled = true;
      void requestLobbySlotTakeover(slotId).catch((error) => {
        statusEl.textContent = error instanceof Error ? error.message : String(error);
      }).finally(() => updateLobbySaveControls());
    });
    lobbyDownloadButton?.addEventListener('click', async () => {
      await handleLobbySaveAction('download');
    });
    lobbyImportInput?.addEventListener('change', async () => {
      try {
        await importLobbyBackup(lobbyImportInput.files?.[0]);
        statusEl.textContent = getRunSettings()?.mode === 'standard'
          ? 'Lobby backup restored in this browser. It will sync with the other players in this room.'
          : 'Run backup restored in this browser. It will sync with other players when the run reconnects.';
      } catch (error) {
        statusEl.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        lobbyImportInput.value = '';
      }
    });
  }

  function handlePresenceUpdate() {
    renderStandardLobbyScreen();
    updateLobbySaveControls();
    if (getRunSettings()?.mode === 'standard') {
      void syncStandardLobbyRoom().catch((error) => {
        lobbyStoreReady = false;
        if (lobbySaveStatus) lobbySaveStatus.textContent = `Lobby save setup failed: ${error.message}`;
        console.warn('Standard lobby sync failed', error);
      }).finally(() => renderStandardLobbyScreen());
    }
  }

  return {
    get lobbyRecordSnapshot() { return lobbyRecordSnapshot; },
    get lobbyStoreReady() { return lobbyStoreReady; },
    init,
    handlePresenceUpdate,
    lobbySaveValidator,
    currentLobbyHostPlayerId,
    ensureStandardSoloLobby,
    queueStandardSoloMirror,
    applyLobbyReplica,
    restoreOwnSavedLobbySlot,
    handleLobbyMessage,
    queueLobbySnapshotBroadcast,
    clearLobbySnapshotQueue,
    broadcastLobbySnapshotImmediate,
    syncLobbyPersistence,
    syncStandardLobbyRoom,
    updateLobbySaveControls,
    renderSavedSoulLinkLobbies,
    renderSavedStandardLobbies,
    saveLobbySlot,
    renderStandardLobbyScreen,
    enterStandardLobby,
    finishStandardLobby,
    leaveStandardLobby,
  };
}
