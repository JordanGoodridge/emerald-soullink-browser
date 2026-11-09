// Presence runtime: owns the game adapter, client, remote actor store and
// avatar atlas, then exposes a small snapshot API to the lobby and renderer.
//
// Nothing here runs on the game's critical path. When no room is joined the
// runtime only reads the adapter once per tick and performs no network I/O.

import {
  CONTENT_VERSION,
  DEFAULT_LIMITS,
  isRoomCode,
  normalizeName,
} from './protocol.mjs';
import { createPresenceClient } from './presence-client.mjs';
import { createRemoteActorStore } from './remote-actors.mjs';
import { createGameAdapter } from './game-adapter.mjs';
import {
  createAvatarAtlas,
  loadAvatarAtlas,
  playerAppearanceKey,
  replaceAvatarSheetInAtlas,
} from './avatar-manifest.mjs';
import { remotePresenterOptions } from './remote-renderer.mjs';
import { compileCharacterCustomization } from '../customization/character-compositor.mjs';

const NAME_STORAGE_KEY = 'pokeemerald.presence.name.v1';
const RENDERABLE_ACTIVITIES = new Set(['overworld', 'dialogue', 'menu', 'cutscene']);

function readStoredName() {
  try {
    return normalizeName(localStorage.getItem(NAME_STORAGE_KEY) || '');
  } catch {
    return null;
  }
}

function defaultPresenceUrl(search) {
  const explicit = search.get('presenceUrl');
  if (explicit) return explicit;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (location.port === '8000' || location.port === '8787') {
    return `${protocol}//${location.hostname}:8787/presence`;
  }
  return `${protocol}//${location.host}/presence`;
}

export function createPresenceRuntime({
  search = new URLSearchParams(location.search),
  adapter = createGameAdapter(),
  clientFactory = createPresenceClient,
  transportFactory,
  loadAvatars = loadAvatarAtlas,
  url = defaultPresenceUrl(search),
  now = () => performance.now(),
  logger = console,
  contentVersion = CONTENT_VERSION,
  avatarSheets = null,
  mapNameFor = null,
  enabled = true,
  awayGraceMs = 2500,
} = {}) {
  const store = createRemoteActorStore();
  const partyByPlayer = new Map();
  const listeners = new Set();
  let client = null;
  let selfFrame = { state: { epoch: 0, activity: 'loading', world: null, pose: null }, screen: null };
  let avatarAtlas = createAvatarAtlas();
  let avatarStatus = 'loading';
  let avatarError = null;
  let lastError = null;
  let lastClose = null;
  let lastFrameOptions = null;
  let autoJoinAttempted = false;
  let bound = false;
  let away = false;
  let awayTimer = null;
  let activeContentVersion = contentVersion;
  let activeAvatarSheets = avatarSheets;
  let activeMapNameFor = mapNameFor;
  const customAvatarRgbaByAppearance = new Map();
  let selfCustomization = null;
  let selfCustomizationRevision = 0;
  let active = Boolean(enabled);
  let isRoomCreator = false;
  let name = normalizeName(search.get('presenceName') || '') || readStoredName() || 'Player';

  function setName(next) {
    const normalized = normalizeName(next);
    if (!normalized) return false;
    name = normalized;
    try { localStorage.setItem(NAME_STORAGE_KEY, name); } catch { /* optional */ }
    notify();
    return true;
  }

  function snapshot() {
    const metrics = client?.getMetrics?.() ?? null;
    const members = store.getMembers();
    return {
      status: metrics?.state ?? 'disconnected',
      room: metrics?.room ?? null,
      playerId: metrics?.playerId ?? null,
      name,
      generation: metrics?.generation ?? 0,
      revision: metrics?.revision ?? 0,
      self: metrics?.self ?? null,
      members,
      playerCount: members.length,
      isRoomCreator,
      rttMs: metrics?.rttMs ?? null,
      clockReady: Boolean(metrics?.clockReady),
      // Only a ready clock may compare against server snapshot times; otherwise
      // the UI would mark every peer stale.
      serverNowMs: metrics?.clockReady ? client.serverNow() : null,
      visibleSnapshotAgeMs: DEFAULT_LIMITS.visibleSnapshotAgeMs,
      lastError: lastError ?? metrics?.lastError ?? null,
      lastClose,
      avatarStatus,
      avatarError,
      activity: selfFrame.state.activity,
      world: selfFrame.state.world,
      pose: selfFrame.state.pose,
      contentVersion: activeContentVersion,
      url,
    };
  }

  function notify() {
    const value = snapshot();
    for (const listener of listeners) {
      try { listener(value); } catch (error) { logger.error?.(error); }
    }
    return value;
  }

  function subscribe(listener, { immediate = true } = {}) {
    listeners.add(listener);
    if (immediate) listener(snapshot());
    return () => listeners.delete(listener);
  }

  function makeClient() {
    const created = clientFactory({
      url,
      name,
      contentVersion: activeContentVersion,
      transportFactory,
      now,
      onWelcome: ({ members, revision }) => {
        store.replaceRoster(members, revision);
        lastError = null;
        notify();
      },
      onRoster: ({ members, revision }) => {
        store.replaceRoster(members, revision);
        notify();
      },
      onPresence: (presence) => {
        store.ingest(presence);
        notify();
      },
      onParty: (playerId, party) => {
        if (typeof playerId === 'string' && party) partyByPlayer.set(playerId, party);
        notify();
      },
      onAvatar: (playerId, avatar) => {
        if (typeof playerId === 'string' && avatar) {
          applyPeerAvatarCustomization(playerId, avatar);
          notify();
        }
      },
      onStatus: () => notify(),
      onClock: () => notify(),
      onError: (error) => {
        lastError = error;
        if (error.terminal) {
          store.reset();
          partyByPlayer.clear();
          customAvatarRgbaByAppearance.clear();
        }
        notify();
      },
    });
    if (selfCustomization) {
      created.publishAvatar?.(selfCustomization);
    }
    return created;
  }

  function ensureClient() {
    client ??= makeClient();
    return client;
  }

  function createRoom() {
    if (!active) return false;
    lastError = null;
    lastClose = null;
    isRoomCreator = true;
    try {
      ensureClient().create();
      return true;
    } catch (error) {
      isRoomCreator = false;
      lastError = { code: 'client_error', detail: error.message };
      notify();
      return false;
    }
  }

  function joinRoom(roomCode) {
    if (!active) return false;
    const room = String(roomCode || '').trim().toUpperCase();
    if (!isRoomCode(room)) {
      lastError = { code: 'invalid_room', detail: 'Enter an 8-character room code.' };
      notify();
      return false;
    }
    lastError = null;
    lastClose = null;
    isRoomCreator = false;
    try {
      ensureClient().join(room);
      return true;
    } catch (error) {
      lastError = { code: 'client_error', detail: error.message };
      notify();
      return false;
    }
  }

  function leave() {
    isRoomCreator = false;
    if (awayTimer) {
      clearTimeout(awayTimer);
      awayTimer = null;
    }
    if (client) {
      try { client.stop(); } catch { /* ignore */ }
      client = null;
    }
    store.reset();
    customAvatarRgbaByAppearance.clear();
    lastClose = { code: 4000, reason: 'left' };
    notify();
  }

  function tick() {
    if (away) {
      selfFrame = { ...selfFrame, state: awayState() };
    } else {
      selfFrame = adapter.read();
    }
    if (client?.status === 'joined') {
      client.publish(selfFrame.state, now());
    }
    client?.tick();
    return selfFrame;
  }

  function awayState() {
    const state = selfFrame.state;
    return {
      ...state,
      epoch: state.epoch ?? 0,
      activity: 'away',
      world: state.world ?? null,
      pose: null,
      battleAnchor: null,
    };
  }

  function applyAway(nextAway) {
    away = nextAway;
    store.clearInterpolation();
    if (away) {
      selfFrame = { ...selfFrame, state: awayState() };
    } else if (bound) {
      selfFrame = adapter.read();
      client?.noteActive?.();
    }
    if (bound && client?.status === 'joined') {
      client.publish(selfFrame.state, now());
      client.flush?.();
    }
    if (bound) client?.tick();
    notify();
    return true;
  }

  function setAway(nextAway) {
    const next = Boolean(nextAway);
    if (next) {
      // Alt-tabbing is routine. Delay the away transition briefly so a short
      // focus switch never makes the player vanish for everyone else.
      if (away) return false;
      if (awayGraceMs > 0) {
        awayTimer ??= setTimeout(() => {
          awayTimer = null;
          if (!away) applyAway(true);
        }, awayGraceMs);
        return true;
      }
    } else if (awayTimer) {
      clearTimeout(awayTimer);
      awayTimer = null;
    }
    if (away === next) {
      // Returning focus (or visibility) without a state change still means the
      // page may have missed pongs; rebase liveness instead of reconnecting.
      if (!next) client?.noteActive?.();
      return false;
    }
    return applyAway(next);
  }

  function simulateDrop() {
    return client?.simulateDrop?.() ?? false;
  }

  function frameOptions({ enhanced = false, sceneKind = 0, flatField = false } = {}) {
    const state = selfFrame.state;
    const canRender = Boolean(
      state.pose
      && RENDERABLE_ACTIVITIES.has(state.activity)
      && ((enhanced && sceneKind === 1) || flatField),
    );
    let actors = [];
    if (canRender && client?.status === 'joined') {
      const metrics = client.getMetrics();
      actors = store.sample({
        selfId: metrics.playerId,
        world: state.world,
        canRenderWorld: true,
        serverNowMs: client.serverNow(),
        clockReady: metrics.clockReady,
        connections: selfFrame.connections ?? [],
        mapSize: selfFrame.mapSize ?? null,
      });
    } else if (client?.status === 'joined') {
      store.sample({
        selfId: client.getMetrics().playerId,
        world: state.world,
        canRenderWorld: false,
        serverNowMs: null,
        clockReady: false,
        connections: selfFrame.connections ?? [],
        mapSize: selfFrame.mapSize ?? null,
      });
    }
    const options = remotePresenterOptions({
      actors,
      selfPose: state.pose,
      selfScreen: selfFrame.screen,
      avatarAtlas,
      canRender,
    });
    lastFrameOptions = options;
    return options;
  }

  function getFrameDebug() {
    return lastFrameOptions;
  }

  function getRemoteActors() {
    const state = selfFrame.state;
    if (!client || client.status !== 'joined' || !state.world || away) return [];
    const metrics = client.getMetrics();
    return store.sample({
      selfId: metrics.playerId,
      world: state.world,
      canRenderWorld: true,
      serverNowMs: client.serverNow(),
      clockReady: metrics.clockReady,
      connections: selfFrame.connections ?? [],
      mapSize: selfFrame.mapSize ?? null,
    });
  }

  function setAdapter(nextAdapter) {
    if (!nextAdapter || typeof nextAdapter.bind !== 'function') return false;
    adapter = nextAdapter;
    if (bound) {
      selfFrame = adapter.read();
      notify();
    }
    return true;
  }

  function bind(exports) {
    adapter.bind(exports);
    bound = true;
    selfFrame = adapter.read();
    if (away) selfFrame = { ...selfFrame, state: awayState() };
    if (!autoJoinAttempted) {
      autoJoinAttempted = true;
      if (active) {
        const auto = search.get('presenceAuto');
        if (auto === 'create') createRoom();
        else if (auto === 'join' && isRoomCode(search.get('presenceRoom') || '')) {
          joinRoom(search.get('presenceRoom'));
        }
      }
    }
    notify();
  }

  function getDiagnostics() {
    const metrics = client?.getMetrics?.() ?? null;
    return {
      status: metrics?.state ?? 'disconnected',
      room: metrics?.room ?? null,
      playerId: metrics?.playerId ?? null,
      generation: metrics?.generation ?? null,
      revision: metrics?.revision ?? null,
      rttMs: metrics?.rttMs ?? null,
      jitterMs: metrics?.jitterMs ?? null,
      interpolationDelayMs: metrics?.interpolationDelayMs ?? null,
      members: store.getMembers().map((member) => ({
        playerId: member.playerId,
        name: member.name,
        connection: member.connection,
        visible: member.visible,
        activity: member.latest?.state?.activity ?? null,
        epoch: member.latest?.state?.epoch ?? null,
        pose: member.latest?.state?.pose ?? null,
      })),
      self: selfFrame.state,
      selfScreen: selfFrame.screen,
      remoteActors: getRemoteActors(),
      rttMs: metrics?.rttMs ?? null,
      bytesSent: metrics?.bytesSent ?? 0,
      bytesReceived: metrics?.bytesReceived ?? 0,
      lastError: lastError ?? metrics?.lastError ?? null,
      lastClose: lastClose ?? metrics?.lastCloseReason ?? null,
      avatarStatus,
      avatarError,
      url,
      name,
    };
  }

  function reloadAvatars() {
    avatarStatus = 'loading';
    avatarError = null;
    avatarAtlas = createAvatarAtlas();
    const loading = activeAvatarSheets
      ? loadAvatars({ sheets: activeAvatarSheets })
      : loadAvatars();
    loading
      .then((atlas) => {
        for (const [appearance, rgba] of customAvatarRgbaByAppearance.entries()) {
          replaceAvatarSheetInAtlas(atlas, appearance, rgba);
        }
        avatarAtlas = atlas;
        avatarStatus = 'ready';
        notify();
      })
      .catch((error) => {
        avatarStatus = 'error';
        avatarError = error instanceof Error ? error.message : String(error);
        logger.warn?.('Presence avatars unavailable:', error);
        notify();
      });
  }

  function configure({ contentVersion: nextContentVersion, avatarSheets: nextSheets, mapNameFor: nextMapNameFor, enabled: nextEnabled } = {}) {
    if (nextEnabled !== undefined) {
      const next = Boolean(nextEnabled);
      if (active && !next) leave();
      active = next;
      if (!active) autoJoinAttempted = true;
    }
    if (client?.status === 'joined'
      && nextContentVersion
      && nextContentVersion !== activeContentVersion) {
      logger.warn?.('Cannot change presence content version while joined');
      return false;
    }
    if (nextContentVersion) activeContentVersion = nextContentVersion;
    if (nextMapNameFor) activeMapNameFor = nextMapNameFor;
    if (nextSheets) {
      activeAvatarSheets = nextSheets;
      reloadAvatars();
    }
    notify();
    return true;
  }

  function setCustomAvatarSheet(appearance, rgba, playerId = null) {
    if (!appearance) return false;
    const key = playerId ? playerAppearanceKey(playerId, appearance) : appearance;
    if (!rgba) {
      customAvatarRgbaByAppearance.delete(key);
      return false;
    }
    customAvatarRgbaByAppearance.set(key, rgba);
    const updated = replaceAvatarSheetInAtlas(avatarAtlas, key, rgba);
    if (updated) notify();
    return updated;
  }

  function applyPeerAvatarCustomization(playerId, avatar) {
    if (!playerId || !avatar || typeof avatar !== 'object') return false;
    try {
      const compiled = compileCharacterCustomization(avatar, {
        rigId: typeof avatar.rigId === 'string' ? avatar.rigId : null,
      });
      return setCustomAvatarSheet(compiled.appearanceKey ?? 'brendan.on-foot', compiled.walkingRgba, playerId);
    } catch (error) {
      logger.warn?.('Peer avatar customization failed to compile:', error);
      return false;
    }
  }

  function publishAvatar(customization) {
    if (!customization || typeof customization !== 'object') return false;
    const raw = customization.customization && typeof customization.customization === 'object'
      ? customization.customization
      : customization;
    selfCustomizationRevision++;
    selfCustomization = {
      version: 1,
      rigId: typeof raw.rigId === 'string' ? raw.rigId : 'gen3-brendan',
      equipped: { ...(raw.equipped ?? {}) },
      colors: { ...(raw.colors ?? {}) },
      revision: selfCustomizationRevision,
    };
    if (!client) return false;
    return client.publishAvatar?.(selfCustomization) ?? false;
  }

  reloadAvatars();

  return {
    bind,
    configure,
    setAdapter,
    setName,
    setCustomAvatarSheet,
    publishAvatar,
    createRoom,
    joinRoom,
    leave,
    tick,
    setAway,
    simulateDrop,
    frameOptions,
    subscribe,
    getSnapshot: snapshot,
    getRunCredentials: () => client?.getRunCredentials?.() ?? null,
    publishParty: (party) => {
      if (!client && !partyByPlayer.size) return false;
      return ensureClient().publishParty(party);
    },
    getParties: () => Object.fromEntries(partyByPlayer),
    getDiagnostics,
    getFrameDebug,
    getAdapter: () => adapter,
    get avatarAtlas() { return avatarAtlas; },
    get name() { return name; },
    get url() { return url; },
    get contentVersion() { return activeContentVersion; },
    get mapNameFor() { return activeMapNameFor; },
  };
}
