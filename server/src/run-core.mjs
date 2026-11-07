import { randomUUID, randomInt } from 'node:crypto';
import { createRunState, reduceRunEvent } from '../../pokeemerald-3d/web/run/run-state.mjs';
import { normalizeRunSettings } from '../../pokeemerald-3d/web/run/run-settings.mjs';
import { allContinuingPlayersReady } from '../../pokeemerald-3d/web/run/soul-link.mjs';

export function createRunService({
  roomService,
  createRunId = randomUUID,
  createSeed = () => randomInt(0, 0x100000000),
} = {}) {
  if (!roomService || typeof roomService.inspect !== 'function') throw new Error('run service requires the room service');
  const runs = new Map();

  function attach(credentials) {
    const member = roomService.validateMember(credentials);
    if (!member) return { ok: false, reason: 'room_membership_invalid' };
    return { ok: true, member, state: runs.get(member.roomCode) ?? null };
  }

  function handoffHost(roomCode, roomHostPlayerId) {
    const current = runs.get(roomCode);
    if (!current) return null;
    const room = roomService.inspect(roomCode);
    if (!room) return null;
    const roomMembers = new Set(room.members.map((member) => member.playerId));
    const members = current.members.map((member) => {
      if (roomMembers.has(member.playerId)) return member;
      return { ...member, active: false, ready: false };
    });
    const eligibleHost = members.find((member) => member.playerId === roomHostPlayerId && member.active !== false)
      ?? members.find((member) => member.active !== false);
    if (!eligibleHost) return null;
    if (current.hostPlayerId === eligibleHost.playerId && members.every((member, index) => member.active === current.members[index].active)) {
      return current;
    }
    const state = structuredClone(current);
    state.hostPlayerId = eligibleHost.playerId;
    state.members = members;
    state.revision++;
    const event = {
      eventId: createRunId(),
      type: 'host.handoff',
      playerId: eligibleHost.playerId,
      previousHostPlayerId: current.hostPlayerId,
      revision: state.revision,
    };
    state.events.push(event);
    state.appliedEventIds.push(event.eventId);
    runs.set(roomCode, state);
    return state;
  }

  function start(roomCode, playerId, options = {}) {
    if (!roomService.validateMember({ roomCode, playerId, token: options.token })) {
      return { accepted: false, reason: 'room_membership_invalid' };
    }
    const prior = runs.get(roomCode);
    if (prior && prior.status !== 'closed') return { accepted: false, reason: 'run_already_exists', state: prior };
    const room = roomService.inspect(roomCode);
    if (!room || room.memberCount < 2 || room.memberCount > 4) return { accepted: false, reason: 'room_size_unsupported' };
    if (room.hostPlayerId && room.hostPlayerId !== playerId) return { accepted: false, reason: 'host_required' };
    const settings = normalizeRunSettings({ ...options.settings, mode: 'soullink' });
    const state = createRunState({
      runId: createRunId(),
      gameId: options.gameId ?? 'emerald',
      contentVersion: options.contentVersion ?? room.contentVersion,
      seed: options.seed ?? createSeed(),
      mode: 'soullink',
      options: settings,
      members: room.members.map((member) => ({ playerId: member.playerId, name: member.name, active: true })),
      hostPlayerId: room.hostPlayerId ?? room.members[0]?.playerId ?? playerId,
    });
    runs.set(roomCode, state);
    return { accepted: true, state };
  }

  function restore(roomCode, playerId, checkpoint, credentials = {}) {
    if (!roomService.validateMember({ roomCode, playerId, token: credentials.token })) {
      return { accepted: false, reason: 'room_membership_invalid' };
    }
    const room = roomService.inspect(roomCode);
    if (!room || room.hostPlayerId !== playerId) return { accepted: false, reason: 'host_required' };
    if (runs.has(roomCode)) return { accepted: false, reason: 'run_already_exists', state: runs.get(roomCode) };
    const source = checkpoint?.runState;
    if (!source || source.mode !== 'soullink' || typeof source.runId !== 'string'
      || !['active', 'wipe_pending', 'victory'].includes(source.status)
      || !Array.isArray(source.members) || source.members.length < 2 || source.members.length > 4
      || !Array.isArray(source.events) || !Array.isArray(source.deaths)
      || !Number.isSafeInteger(source.revision) || source.revision < 0
      || (typeof source.seed !== 'string' && !Number.isSafeInteger(source.seed))
      || !source.options || typeof source.options !== 'object' || Array.isArray(source.options)
      || !source.areas || typeof source.areas !== 'object' || Array.isArray(source.areas)
      || !source.links || typeof source.links !== 'object' || Array.isArray(source.links)
      || !source.ownedSpecies || typeof source.ownedSpecies !== 'object' || Array.isArray(source.ownedSpecies)) {
      return { accepted: false, reason: 'checkpoint_invalid' };
    }
    if (source.contentVersion && source.contentVersion !== room.contentVersion) {
      return { accepted: false, reason: 'checkpoint_version_mismatch' };
    }
    if (room.members.length < 2 || room.members.length > 4 || source.members.length !== room.members.length) {
      return { accepted: false, reason: 'checkpoint_players_mismatch' };
    }
    const savedNames = source.members.map((member) => member.name);
    const liveNames = room.members.map((member) => member.name);
    if (savedNames.some((name) => typeof name !== 'string')
      || source.members.some((member) => typeof member.playerId !== 'string' || !member.playerId)
      || new Set(source.members.map((member) => member.playerId)).size !== source.members.length
      || new Set(savedNames).size !== savedNames.length
      || new Set(liveNames).size !== liveNames.length) {
      return { accepted: false, reason: 'checkpoint_names_ambiguous' };
    }
    const idMap = new Map();
    for (const saved of source.members) {
      const live = room.members.find((member) => member.name === saved.name);
      if (!live || typeof saved.playerId !== 'string' || idMap.has(saved.playerId)) {
        return { accepted: false, reason: 'checkpoint_players_mismatch' };
      }
      idMap.set(saved.playerId, live.playerId);
    }
    const remap = (value) => {
      if (Array.isArray(value)) return value.map(remap);
      if (!value || typeof value !== 'object') return typeof value === 'string' ? (idMap.get(value) ?? value) : value;
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [idMap.get(key) ?? key, remap(entry)]));
    };
    const restored = remap(source);
    restored.members = source.members.map((saved, slot) => {
      const live = room.members.find((member) => member.name === saved.name);
      return { ...saved, playerId: live.playerId, name: live.name, slot, active: saved.active !== false };
    });
    restored.hostPlayerId = room.hostPlayerId;
    runs.set(roomCode, restored);
    return { accepted: true, state: restored };
  }

  function submit(roomCode, playerId, event, credentials = {}) {
    const authorized = roomService.validateMember({ roomCode, playerId, token: credentials.token });
    if (!authorized) return { accepted: false, reason: 'room_membership_invalid' };
    const state = runs.get(roomCode);
    if (!state) return { accepted: false, reason: 'run_not_started' };
    const member = state.members.find((candidate) => candidate.playerId === playerId && candidate.active);
    if (!member) return { accepted: false, reason: 'player_not_in_run', state };
    const result = reduceRunEvent(state, { ...event, playerId });
    if (!result.accepted) return result;
    const next = result.state;
    runs.set(roomCode, next);
    return { accepted: true, state: next, events: [next.events.at(-1)], effects: result.effects };
  }

  function restart(roomCode, playerId, credentials = {}) {
    if (!roomService.validateMember({ roomCode, playerId, token: credentials.token })) {
      return { accepted: false, reason: 'room_membership_invalid' };
    }
    const state = runs.get(roomCode);
    if (!state) return { accepted: false, reason: 'run_not_started' };
    if (state.hostPlayerId !== playerId) return { accepted: false, reason: 'host_required' };
    if (state.status !== 'wipe_pending' && state.status !== 'victory') return { accepted: false, reason: 'wipe_not_pending', state };
    if (!allContinuingPlayersReady(state.members)) return { accepted: false, reason: 'players_not_ready', state };
    const reset = reduceRunEvent(state, {
      eventId: createRunId(),
      type: 'run.reset',
      playerId,
      nextRunId: createRunId(),
      seed: createSeed(),
    });
    if (!reset.accepted) return reset;
    runs.set(roomCode, reset.state);
    return {
      accepted: true,
      state: reset.state,
      events: [reset.state.events.at(-1)],
      effects: reset.effects,
    };
  }

  function get(roomCode) {
    return runs.get(roomCode) ?? null;
  }

  function deleteRoom(roomCode) {
    return runs.delete(roomCode);
  }

  function count() {
    return runs.size;
  }

  return { attach, start, restore, submit, restart, handoffHost, get, deleteRoom, count };
}
