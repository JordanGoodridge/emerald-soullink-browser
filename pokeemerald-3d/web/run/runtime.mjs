import {
  normalizeRunSettings,
  serializeRunSettings,
  DEFAULT_RUN_SETTINGS,
  RUN_MODES,
  RUN_SETTINGS_STORAGE_KEY,
  defaultRunSettingsForMode,
  saveSlotForMode,
} from './run-settings.mjs';
import { createRunState, reduceRunEvent } from './run-state.mjs';
import { createRunEngineHooks } from './engine-adapter.mjs';
import { buildRunTracker } from './tracker-model.mjs';

function clone(value) {
  return value ? structuredClone(value) : value;
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createRunRuntime({
  adapter,
  initialSettings = DEFAULT_RUN_SETTINGS,
  storage = globalThis.localStorage,
  storageKey = 'pokeemerald.run.state.v1',
  settingsStorageKey = RUN_SETTINGS_STORAGE_KEY,
  saveSlot = 'main',
  onPcBoxBlocked = () => {},
  now = () => Date.now(),
} = {}) {
  let settings = normalizeRunSettings(initialSettings);
  let state = null;
  let localPlayerId = null;
  let exportsRef = null;
  let transport = null;
  let localSeq = 0;
  let pendingReleases = new Map();
  let pendingWildAreaKey = null;
  const unconfirmedEvents = new Map();
  let cachedRunId = null;
  let persistenceError = null;
  let onNotice = () => {};
  try {
    const cached = JSON.parse(storage?.getItem?.(storageKey) ?? 'null');
    if (typeof cached?.runId === 'string') cachedRunId = cached.runId;
  } catch {
    cachedRunId = null;
  }

  function persist() {
    try {
      if (state?.mode === 'nuzlocke' && typeof storage?.setItem !== 'function') {
        throw new Error('persistent browser storage is unavailable');
      }
      if (state) storage?.setItem?.(storageKey, JSON.stringify(state));
      else storage?.removeItem?.(storageKey);
      persistenceError = null;
    } catch (error) {
      persistenceError = error;
      // Run state remains live in memory if browser storage is unavailable.
    }
  }

  function setState(next) {
    state = next;
    if (typeof state?.runId === 'string') cachedRunId = state.runId;
    persist();
    return snapshot();
  }

  function snapshot() {
    return clone(state);
  }

  function peekState() {
    return state;
  }

  function syncSnapshot(nextState, nextLocalPlayerId = localPlayerId) {
    localPlayerId = nextLocalPlayerId;
    state = clone(nextState);
    if (typeof state?.runId === 'string') cachedRunId = state.runId;
    replayUnconfirmed();
    pendingReleases = new Map();
    pendingWildAreaKey = null;
    if (state && localPlayerId) {
      pendingWildAreaKey = Object.values(state.areas ?? {})
        .filter((area) => area.status === 'pending' && area.claims?.[localPlayerId]?.status === 'claimed')
        .sort((left, right) => (right.claims[localPlayerId].at ?? 0) - (left.claims[localPlayerId].at ?? 0))[0]?.areaKey ?? null;
      if (state.mode === 'nuzlocke') {
        for (const death of state.deaths ?? []) {
          if (death.playerId === localPlayerId && Number.isInteger(death.pid)) {
            pendingReleases.set(death.pid >>> 0, death);
          }
        }
      }
      for (const area of Object.values(state.areas ?? {})) {
        if (area.status !== 'void' && area.status !== 'dead') continue;
        for (const claim of Object.values(area.claims ?? {})) {
          if (claim.playerId === localPlayerId
              && ['void', 'dead', 'caught', 'claimed'].includes(claim.status)
              && Number.isInteger(claim.pid)) {
            pendingReleases.set(claim.pid >>> 0, claim);
          }
        }
      }
      for (const link of Object.values(state.links ?? {})) {
        if (link.status !== 'dead') continue;
        for (const member of link.members ?? []) {
          if (member.playerId === localPlayerId && Number.isInteger(member.pid)) {
            pendingReleases.set(member.pid >>> 0, member);
          }
        }
      }
    }
    localSeq = Math.max(localSeq, state?.events?.filter((event) => event.playerId === localPlayerId)
      .reduce((max, event) => Math.max(max, event.seq ?? 0), 0) ?? 0);
    persist();
    return snapshot();
  }

  function processEffects(effects = []) {
    for (const effect of effects) {
      if (effect.type === 'release-area') {
        for (const member of effect.members) {
          if (member.playerId === localPlayerId && member.pid !== null && member.pid !== undefined) {
            pendingReleases.set(member.pid >>> 0, member);
          }
        }
      } else if (effect.type === 'release-pokemon' && effect.playerId === localPlayerId
          && effect.pid !== null && effect.pid !== undefined) {
        pendingReleases.set(effect.pid >>> 0, effect);
      } else if (effect.type === 'reset-run' && effect.playerIds.includes(localPlayerId)) {
        transport?.onReset?.(effect);
      }
    }
  }

  function applyEvent(event, { broadcast = false } = {}) {
    if (!state) return { accepted: false, reason: 'run_not_started', state: null, effects: [] };
    const result = reduceRunEvent(state, event);
    if (result.accepted) {
      setState(result.state);
      processEffects(result.effects);
      if (broadcast) {
        unconfirmedEvents.set(event.eventId, { event, runId: state.runId });
        transport?.send?.(event);
      }
    }
    return result;
  }

  // Local events are optimistic. A server snapshot that does not yet contain
  // them must not erase them, otherwise a safe point can miss a pending claim.
  // Replay until the authoritative state applies the event id.
  function replayUnconfirmed() {
    for (const [eventId, entry] of unconfirmedEvents) {
      if (!state || entry.runId !== state.runId || state.appliedEventIds?.includes(eventId)) {
        unconfirmedEvents.delete(eventId);
        continue;
      }
      const result = reduceRunEvent(state, entry.event);
      if (!result.accepted) {
        unconfirmedEvents.delete(eventId);
        continue;
      }
      setState(result.state);
      transport?.send?.(entry.event);
    }
  }

  function emit(type, fields = {}) {
    if (!localPlayerId) return { accepted: false, reason: 'player_not_configured', effects: [] };
    localSeq++;
    return applyEvent({
      eventId: `${state?.runId ?? 'no-run'}:${localPlayerId}:${localSeq}:${randomId()}`,
      seq: localSeq,
      playerId: localPlayerId,
      type,
      at: now(),
      ...fields,
    }, { broadcast: true });
  }

  function start({ runId = randomId(), seed, members, playerId } = {}) {
    if (settings.mode !== 'soullink' && settings.mode !== 'nuzlocke') {
      throw new Error('select a run mode before starting a run');
    }
    const requiredSlot = saveSlotForMode(settings.mode);
    if (saveSlot !== requiredSlot) throw new Error(`reload with the ${requiredSlot} save slot before starting a run`);
    if (settings.mode === 'nuzlocke' && (!Array.isArray(members) || members.length !== 1)) {
      throw new Error('a solo Nuzlocke run requires exactly one player');
    }
    if (!Number.isSafeInteger(seed) && typeof seed !== 'string') throw new Error('run start requires a seed');
    if (!Array.isArray(members)) throw new Error('run start requires room members');
    if (!members.some((member) => member.playerId === playerId && member.active !== false)) {
      throw new Error('local player must be an active run member');
    }
    localPlayerId = playerId;
    localSeq = 0;
    pendingReleases = new Map();
    pendingWildAreaKey = null;
    const started = setState(createRunState({
      runId,
      gameId: adapter?.id ?? 'emerald',
      contentVersion: `emerald-${settings.mode}-v1`,
      seed,
      mode: settings.mode,
      options: settings,
      members,
      allowSolo: settings.mode === 'nuzlocke',
      startedAt: now(),
    }));
    if (settings.mode === 'nuzlocke' && persistenceError) {
      throw new Error(`Nuzlocke run history could not be saved: ${persistenceError.message || 'storage unavailable'}`);
    }
    return started;
  }

  function restoreLocalState({ playerId = null, runState: suppliedState = null } = {}) {
    if (settings.mode !== 'nuzlocke' || saveSlot !== 'nuzlocke') {
      throw new Error('local run restoration is only available for a solo Nuzlocke slot');
    }
    let cached = suppliedState;
    if (cached === null) {
      try {
        cached = JSON.parse(storage?.getItem?.(storageKey) ?? 'null');
      } catch {
        throw new Error('Nuzlocke run history is corrupt; do not continue this save as a new run');
      }
    }
    if (cached === null) return false;
    const member = Array.isArray(cached?.members) && cached.members.length === 1 ? cached.members[0] : null;
    if (typeof cached?.runId !== 'string'
      || cached.mode !== 'nuzlocke'
      || cached.gameId !== (adapter?.id ?? 'emerald')
      || !member?.playerId
      || (playerId && member.playerId !== playerId)
      || !cached.areas || typeof cached.areas !== 'object'
      || !cached.links || typeof cached.links !== 'object'
      || !Array.isArray(cached.deaths)
      || !Array.isArray(cached.events)) {
      throw new Error('Nuzlocke save history does not match this game/profile');
    }
    settings = normalizeRunSettings({ ...settings, ...(cached.options ?? {}), mode: 'nuzlocke' });
    syncSnapshot(cached, member.playerId);
    if (persistenceError) {
      throw new Error(`Nuzlocke run history could not be restored safely: ${persistenceError.message || 'storage unavailable'}`);
    }
    try {
      storage?.setItem?.(settingsStorageKey, serializeRunSettings(settings));
    } catch {
      // The restored run remains playable if settings cannot be rewritten.
    }
    return true;
  }

  function configure(patch = {}) {
    if (state && state.status !== 'closed') {
      throw new Error('run settings are frozen until this run closes');
    }
    const changingMode = RUN_MODES.includes(patch.mode) && patch.mode !== settings.mode;
    const base = changingMode ? defaultRunSettingsForMode(patch.mode) : settings;
    const next = normalizeRunSettings({ ...base, ...patch });
    const requiredSlot = saveSlotForMode(next.mode);
    if (saveSlot !== requiredSlot) {
      throw new Error(`reload with the ${requiredSlot} save slot before changing run mode`);
    }
    settings = next;
    try {
      storage?.setItem?.(settingsStorageKey, serializeRunSettings(settings));
    } catch {
      // Keep updated settings in memory when persistence is unavailable.
    }
    return { ...settings };
  }

  function bindExports(exports) {
    exportsRef = exports ?? null;
  }

  function currentBadgeCount() {
    const raw = Number(exportsRef?.WasmRunGymBadgeCount?.() ?? state?.progress?.gymIndex ?? 0);
    if (!Number.isInteger(raw) || raw < 0) return 0;
    return Math.min(8, raw);
  }

  function currentSectionId() {
    const raw = Number(adapter?.sectionId?.({}, exportsRef) ?? exportsRef?.WasmRunMapSection?.());
    return Number.isInteger(raw) && raw >= 0 ? raw : null;
  }

  function readLivePartyFromExports() {
    if (typeof exportsRef?.WasmRunPartyCount !== 'function') return [];
    const count = Math.min(6, Math.max(0, Number(exportsRef.WasmRunPartyCount()) || 0));
    const party = [];
    for (let i = 0; i < count; i++) {
      const species = Number(exportsRef.WasmRunPartySpecies?.(i) ?? 0);
      if (!Number.isInteger(species) || species <= 0) continue;
      const level = Number(exportsRef.WasmRunPartyLevel?.(i) ?? 0);
      const pidLo = Number(exportsRef.WasmRunPartyPidLo?.(i) ?? 0) & 0xffff;
      const pidHi = Number(exportsRef.WasmRunPartyPidHi?.(i) ?? 0) & 0xffff;
      const pid = ((pidHi << 16) | pidLo) >>> 0;
      const moves = [];
      for (let m = 0; m < 4; m++) {
        const move = Number(exportsRef.WasmRunPartyMove?.(i, m) ?? 0);
        if (Number.isInteger(move) && move > 0) moves.push(move);
      }
      party.push({
        species,
        level: Number.isInteger(level) && level > 0 ? level : null,
        pid,
        moves,
      });
    }
    return party;
  }

  function livePartyLevelForPid(pid) {
    const target = pid >>> 0;
    for (const mon of readLivePartyFromExports()) {
      if ((mon.pid >>> 0) === target && Number.isInteger(mon.level)) return mon.level;
    }
    return null;
  }

  function gymCap() {
    if (!state || !settings.gymLevelCap) return 0;
    const badgeCount = currentBadgeCount();
    return adapter?.gymAceLevel?.(badgeCount, exportsRef) ?? 0;
  }

  function deathForPid(pid) {
    const badgeCount = currentBadgeCount();
    const sectionId = currentSectionId();
    const liveLevel = livePartyLevelForPid(pid);
    for (const link of Object.values(state?.links ?? {})) {
      const member = link.members.find((candidate) => candidate.playerId === localPlayerId && candidate.pid === pid);
      if (member && member.status === 'alive' && link.status === 'active') {
        const payload = { linkId: link.linkId, pid, cause: 'fainted', badgeCount };
        if (sectionId !== null) payload.sectionId = sectionId;
        if (liveLevel !== null) payload.level = liveLevel;
        emit('death', payload);
        return true;
      }
    }
    for (const area of Object.values(state?.areas ?? {})) {
      const claim = area.claims?.[localPlayerId];
      if (claim?.pid === pid && claim.status === 'caught') {
        const payload = { areaKey: area.areaKey, pid, cause: 'fainted', badgeCount };
        if (sectionId !== null) payload.sectionId = sectionId;
        if (liveLevel !== null) payload.level = liveLevel;
        emit('death', payload);
        return true;
      }
    }
    return false;
  }

  function recordVictory({ party = null } = {}) {
    if (!state || !localPlayerId) return { accepted: false, reason: 'run_not_started', effects: [] };
    if (state.status !== 'active' && state.status !== 'victory') {
      return { accepted: false, reason: 'run_not_active', effects: [] };
    }
    if (state.champions?.[localPlayerId]) {
      return { accepted: false, duplicate: true, reason: 'already_recorded', state: snapshot(), effects: [] };
    }
    const resolvedParty = Array.isArray(party) && party.length > 0
      ? party.map((mon) => ({
          species: Number(mon?.species ?? 0),
          level: Number.isInteger(mon?.level) ? mon.level : null,
          nickname: typeof mon?.nickname === 'string' && mon.nickname ? mon.nickname : null,
          pid: Number.isInteger(mon?.pid ?? mon?.personality) ? ((mon.pid ?? mon.personality) >>> 0) : null,
          moves: Array.isArray(mon?.moves) ? mon.moves.filter((m) => Number.isInteger(m) && m > 0).slice(0, 4) : [],
        })).filter((mon) => mon.species > 0)
      : readLivePartyFromExports();
    const payload = {
      badgeCount: 8,
      party: resolvedParty,
    };
    const sectionId = currentSectionId();
    if (sectionId !== null) payload.sectionId = sectionId;
    return emit('run.victory', payload);
  }

  function createHooks() {
    return createRunEngineHooks({
      enabled: () => Boolean(state
        && state.members.some((member) => member.playerId === localPlayerId && member.active !== false)
        && ['active', 'wipe_pending', 'victory'].includes(state.status)
        && (settings.mode === 'nuzlocke' || settings.mode === 'soullink')),
      getSeed: () => state?.seed ?? null,
      adapter,
      getExports: () => exportsRef,
      getOptions: () => state?.options ?? settings,
      getState: () => state ? { ...state, localPlayerId } : null,
      isSynchronized: () => settings.mode === 'nuzlocke'
        ? !persistenceError
        : Boolean(transport?.isReady?.()),
      getGymCap: gymCap,
      onEncounter(event) {
        const result = emit('encounter.claim', {
          areaKey: event.areaKey,
          sectionId: event.sectionId,
          species: event.species,
          level: event.level,
          pid: (((event.pidHi & 0xffff) << 16) | (event.pidLo & 0xffff)) >>> 0,
          badgeCount: currentBadgeCount(),
        });
        if (result.accepted) {
          pendingWildAreaKey = event.areaKey;
          onNotice({
            type: 'encounter-claimed', areaKey: event.areaKey, sectionId: event.sectionId, species: event.species,
            label: adapter?.areaLabel?.(event.areaKey, { sectionId: event.sectionId }, exportsRef),
          });
        }
      },
      onEncounterSkipped(event) {
        pendingWildAreaKey = null;
        emit('encounter.skip', {
          areaKey: event.areaKey,
          sectionId: event.sectionId,
          species: event.species,
          reason: event.reason,
          badgeCount: currentBadgeCount(),
        });
        onNotice({ type: 'encounter-skipped', ...event, label: adapter?.areaLabel?.(event.areaKey, { sectionId: event.sectionId }, exportsRef) });
      },
      onCapture(event) {
        emit('encounter.resolve', {
          areaKey: event.areaKey,
          sectionId: event.sectionId,
          result: 'caught',
          badgeCount: currentBadgeCount(),
        });
        if (pendingWildAreaKey === event.areaKey) pendingWildAreaKey = null;
        onNotice({ type: 'capture-complete', areaKey: event.areaKey, species: event.species,
          label: adapter?.areaLabel?.(event.areaKey, { sectionId: event.sectionId }, exportsRef) });
      },
      onCaptureDecision(decision) {
        if (!decision.allowed) return;
        const area = decision.areaKey ? state?.areas?.[decision.areaKey] : null;
        onNotice({
          type: 'catch-allowed',
          ...decision,
          label: area?.label ?? adapter?.areaLabel?.(decision.areaKey, { sectionId: area?.sectionId }, exportsRef) ?? decision.areaKey,
        });
      },
      onGift(event) {
        const key = event.giftKey === 0x53545254
          ? 'emerald:gift:starter'
          : `emerald:gift:${event.giftKey}:${event.species}`;
        const badgeCount = currentBadgeCount();
        const claim = emit('encounter.claim', {
          areaKey: key,
          label: adapter?.areaLabel?.(key, { sectionId: event.sectionId }, exportsRef) ?? key,
          sectionId: event.sectionId,
          species: event.species,
          level: event.level,
          pid: (((event.pidHi & 0xffff) << 16) | (event.pidLo & 0xffff)) >>> 0,
          isGift: true,
          badgeCount,
        });
        if (claim.accepted) emit('encounter.resolve', { areaKey: key, sectionId: event.sectionId, result: 'caught', badgeCount });
        if (claim.accepted) onNotice({ type: 'gift-claimed', areaKey: key, species: event.species, label: 'Gift Pokémon' });
      },
      onFaint({ pidLo, pidHi }) {
        const pid = (((pidHi & 0xffff) << 16) | (pidLo & 0xffff)) >>> 0;
        return deathForPid(pid);
      },
      shouldRelease({ pidLo, pidHi }) {
        const pid = ((((pidHi ?? 0) & 0xffff) << 16) | ((pidLo ?? 0) & 0xffff)) >>> 0;
        if (!pendingReleases.has(pid)) return false;
        pendingReleases.delete(pid);
        return true;
      },
      onPartyWipe() {
        if (state?.status === 'active') {
          const payload = { ready: false, badgeCount: currentBadgeCount() };
          const sectionId = currentSectionId();
          if (sectionId !== null) {
            payload.sectionId = sectionId;
            const areaKey = adapter?.areaKey?.({ sectionId }, { exports: exportsRef });
            if (areaKey) payload.areaKey = areaKey;
          }
          emit('wipe.pending', payload);
        }
      },
      onPcBoxBlocked,
      onSafePoint({ outcome }) {
        const lostAreaKey = pendingWildAreaKey ?? Object.values(state?.areas ?? {})
          .find((area) => area.status === 'pending' && area.claims?.[localPlayerId]?.status === 'claimed')?.areaKey ?? null;
        if (lostAreaKey) {
          const claim = state?.areas?.[lostAreaKey]?.claims?.[localPlayerId];
          if (claim?.status === 'claimed') {
            emit('encounter.resolve', {
              areaKey: lostAreaKey,
              result: 'lost',
              badgeCount: currentBadgeCount(),
            });
          }
        }
        pendingWildAreaKey = null;
        if (state?.status === 'active' && exportsRef?.WasmRunIsChampion?.()) {
          recordVictory();
        }
        transport?.onSafePoint?.({ outcome, state: snapshot() });
      },
    });
  }

  const hooks = createHooks();

  return {
    get settings() { return { ...settings }; },
    get active() { return Boolean(state && state.status !== 'closed'); },
    get localPlayerId() { return localPlayerId; },
    get cachedRunId() { return cachedRunId; },
    get persistenceError() { return persistenceError; },
    get hasPendingReleases() { return pendingReleases.size > 0; },
    get hooks() { return hooks; },
    configure,
    start,
    restoreLocalState,
    snapshot,
    state: snapshot,
    peekState,
    bindExports,
    syncSnapshot,
    applyEvent,
    emit,
    recordVictory,
    visitArea({ sectionId, areaKey = null, label = null } = {}) {
      if (!Number.isInteger(sectionId) || sectionId < 0) return { accepted: false, reason: 'section_invalid' };
      const key = areaKey ?? adapter?.areaKey?.({ sectionId }, { exports: exportsRef });
      if (!key) return { accepted: false, reason: 'area_required' };
      if (state?.areas?.[key]?.visits?.some((visit) => visit.playerId === localPlayerId)) {
        return { accepted: false, reason: 'already_visited' };
      }
      const result = emit('area.visit', {
        areaKey: key,
        sectionId,
        label: label ?? adapter?.areaLabel?.(key, { sectionId }, exportsRef) ?? key,
      });
      if (result.accepted) onNotice({ type: 'area-visited', areaKey: key, sectionId, label: label ?? adapter?.areaLabel?.(key, { sectionId }, exportsRef) ?? key });
      return result;
    },
    setNoticeHandler(handler) { onNotice = typeof handler === 'function' ? handler : () => {}; },
    gymCap,
    tracker: (presence = null) => buildRunTracker({ run: state, presence, regionMap: adapter?.regionMap }),
    setTransport(value) { transport = value ?? null; },
    queueRelease(playerId, pid, details = {}) {
      if (playerId === localPlayerId && Number.isInteger(pid)) pendingReleases.set(pid >>> 0, details);
    },
  };
}
