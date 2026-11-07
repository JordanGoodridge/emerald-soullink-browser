// Transport-free room service. All time, identity and room-code generation is
// injected so the lifecycle can be tested deterministically.

import { randomBytes } from 'node:crypto';
import {
  DEFAULT_LIMITS,
  ERROR_CODES,
  ROOM_CAPACITY,
  errorMessage,
  partyMessage,
  presenceMessage,
  pongMessage,
  rosterMessage,
  welcomeMessage,
} from '../../pokeemerald-3d/web/presence/protocol.mjs';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function defaultRoomCode() {
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += ROOM_CODE_ALPHABET[randomBytes(1)[0] % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

function defaultPlayerId() {
  return `p${randomBytes(6).toString('base64url')}`;
}

function defaultToken() {
  return randomBytes(24).toString('base64url');
}

function sameWorld(a, b) {
  if (a === null || b === null) return a === b;
  return a.mapGroup === b.mapGroup
    && a.mapNum === b.mapNum
    && a.layoutId === b.layoutId
    && a.variant === b.variant;
}

export function createRoomService({
  now = () => Date.now(),
  createRoomCode = defaultRoomCode,
  createPlayerId = defaultPlayerId,
  createToken = defaultToken,
  limits = DEFAULT_LIMITS,
  capacity = ROOM_CAPACITY,
  onRoomExpired = () => {},
  onRoomHostChanged = () => {},
} = {}) {
  const rooms = new Map();
  const bindings = new Map(); // socketId -> { roomCode, playerId }

  function setHost(room, hostPlayerId) {
    if (room.hostPlayerId === hostPlayerId) return false;
    room.hostPlayerId = hostPlayerId;
    onRoomHostChanged(room.code, hostPlayerId);
    return true;
  }

  function send(socketId, message) {
    return { type: 'send', socketId, message };
  }

  function close(socketId, reason) {
    return { type: 'close', socketId, reason };
  }

  function reject(socketId, code, fatal = true) {
    const effects = [send(socketId, errorMessage(code, fatal))];
    if (fatal) effects.push(close(socketId, code));
    return effects;
  }

  function allocateRoomCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = createRoomCode();
      if (typeof code === 'string' && code.length === 8 && !rooms.has(code)) return code;
    }
    throw new Error('unable to allocate a unique room code');
  }

  function memberView(member) {
    return {
      playerId: member.playerId,
      name: member.name,
      generation: member.generation,
      connection: member.connection,
      latest: member.latest,
    };
  }

  function roster(room) {
    return [...room.members.values()].map(memberView);
  }

  function connectedSockets(room, exceptPlayerId = null) {
    const sockets = [];
    for (const member of room.members.values()) {
      if (member.connection !== 'connected' || !member.socketId) continue;
      if (member.playerId === exceptPlayerId) continue;
      sockets.push(member.socketId);
    }
    return sockets;
  }

  function rosterEffects(room, exceptPlayerId = null) {
    return connectedSockets(room, exceptPlayerId)
      .map((socketId) => send(socketId, rosterMessage({
        revision: room.revision,
        serverMs: now(),
        members: roster(room),
      })));
  }

  function newMember(socketId, name, generation = 1) {
    return {
      playerId: createPlayerId(),
      name,
      token: createToken(),
      generation,
      socketId,
      connection: 'connected',
      latest: null,
      reservedUntil: null,
      seq: 0,
      lastSampleMs: 0,
      lastEpoch: 0,
      lastWorld: null,
      party: null,
      lastPartyRevision: 0,
    };
  }

  function partyEffects(room, forPlayerId) {
    const recipient = room.members.get(forPlayerId);
    if (!recipient) return [];
    const effects = [];
    for (const other of room.members.values()) {
      if (other.playerId === forPlayerId || !other.party) continue;
      effects.push(send(recipient.socketId, partyMessage({ playerId: other.playerId, party: other.party })));
    }
    return effects;
  }

  function welcomeEffects(room, member) {
    return [send(member.socketId, welcomeMessage({
      room: room.code,
      contentVersion: room.contentVersion,
      playerId: member.playerId,
      token: member.token,
      generation: member.generation,
      revision: room.revision,
      serverMs: now(),
      members: roster(room),
    }))];
  }

  function create(socketId, command) {
    if (bindings.has(socketId)) return reject(socketId, ERROR_CODES.invalidMessage);
    const code = allocateRoomCode();
    const room = {
      code,
      contentVersion: command.contentVersion,
      revision: 1,
      members: new Map(),
      emptySince: null,
      createdAt: now(),
    };
    const member = newMember(socketId, command.name);
    room.hostPlayerId = member.playerId;
    room.members.set(member.playerId, member);
    rooms.set(code, room);
    bindings.set(socketId, { roomCode: code, playerId: member.playerId });
    return welcomeEffects(room, member);
  }

  function join(socketId, command) {
    if (bindings.has(socketId)) return reject(socketId, ERROR_CODES.invalidMessage);
    const room = rooms.get(command.room);
    if (!room) return reject(socketId, ERROR_CODES.roomNotFound);
    if (room.contentVersion !== command.contentVersion) {
      return reject(socketId, ERROR_CODES.incompatibleVersion);
    }
    if (room.members.size >= capacity) return reject(socketId, ERROR_CODES.roomFull);

    const member = newMember(socketId, command.name);
    room.members.set(member.playerId, member);
    room.emptySince = null;
    room.revision++;
    bindings.set(socketId, { roomCode: room.code, playerId: member.playerId });

    return [
      ...welcomeEffects(room, member),
      ...rosterEffects(room, member.playerId),
      ...partyEffects(room, member.playerId),
    ];
  }

  function resume(socketId, command) {
    if (bindings.has(socketId)) return reject(socketId, ERROR_CODES.invalidMessage);
    const room = rooms.get(command.room);
    if (!room) return reject(socketId, ERROR_CODES.roomNotFound);
    if (room.contentVersion !== command.contentVersion) {
      return reject(socketId, ERROR_CODES.incompatibleVersion);
    }
    const member = room.members.get(command.playerId);
    if (!member) return reject(socketId, ERROR_CODES.sessionExpired);
    if (member.token !== command.token) return reject(socketId, ERROR_CODES.invalidResume);

    const effects = [];
    const replacedSocketId = member.socketId;
    if (replacedSocketId && replacedSocketId !== socketId) {
      bindings.delete(replacedSocketId);
      effects.push(close(replacedSocketId, 'resumed'));
    }

    member.token = createToken();
    member.generation++;
    member.socketId = socketId;
    member.connection = 'connected';
    member.reservedUntil = null;
    member.latest = null;
    member.seq = 0;
    member.lastSampleMs = 0;
    member.lastEpoch = 0;
    member.lastWorld = null;
    room.revision++;
    room.emptySince = null;
    bindings.set(socketId, { roomCode: room.code, playerId: member.playerId });

    effects.push(...welcomeEffects(room, member));
    effects.push(...rosterEffects(room, member.playerId));
    effects.push(...partyEffects(room, member.playerId));
    return effects;
  }

  function leave(socketId) {
    const binding = bindings.get(socketId);
    if (!binding) return [];
    bindings.delete(socketId);
    const room = rooms.get(binding.roomCode);
    if (!room) return [];

    const member = room.members.get(binding.playerId);
    if (!member || member.socketId !== socketId) return [];

    room.members.delete(member.playerId);
    if (room.hostPlayerId === member.playerId) setHost(room, room.members.keys().next().value ?? null);
    room.revision++;
    if (room.members.size === 0) room.emptySince = now();
    return [
      ...rosterEffects(room),
      close(socketId, 'left'),
    ];
  }

  function disconnect(socketId) {
    const binding = bindings.get(socketId);
    if (!binding) return [];
    bindings.delete(socketId);
    const room = rooms.get(binding.roomCode);
    if (!room) return [];

    const member = room.members.get(binding.playerId);
    if (!member || member.socketId !== socketId) return [];

    member.socketId = null;
    member.connection = 'reconnecting';
    member.reservedUntil = now() + limits.reservationMs;
    room.revision++;
    return rosterEffects(room);
  }

  function presence(socketId, command) {
    const binding = bindings.get(socketId);
    if (!binding) return [];
    const room = rooms.get(binding.roomCode);
    if (!room) return [];
    const member = room.members.get(binding.playerId);
    if (!member || member.socketId !== socketId || member.connection !== 'connected') return [];
    if (command.generation !== member.generation) return [];
    if (command.seq <= member.seq) return [];
    if (command.sampleMs < member.lastSampleMs) return [];

    const epoch = command.state.epoch;
    if (epoch < member.lastEpoch) return [];
    if (epoch === member.lastEpoch && !sameWorld(member.lastWorld, command.state.world)) return [];

    member.seq = command.seq;
    member.lastSampleMs = command.sampleMs;
    member.lastEpoch = epoch;
    member.lastWorld = command.state.world;

    const snapshot = {
      playerId: member.playerId,
      generation: member.generation,
      seq: command.seq,
      sampleMs: command.sampleMs,
      receivedMs: now(),
      state: command.state,
    };
    member.latest = snapshot;

    const effects = [];
    for (const socket of connectedSockets(room, member.playerId)) {
      effects.push(send(socket, presenceMessage(snapshot)));
    }
    return effects;
  }

  function ping(socketId, command) {
    if (!bindings.has(socketId)) return [];
    return [send(socketId, pongMessage({
      id: command.id,
      clientMs: command.clientMs,
      serverMs: now(),
    }))];
  }

  // Party snapshots are low-frequency, presentation-only data. The relay stores
  // the latest snapshot per member and rebroadcasts it; it never persists it or
  // uses it to decide gameplay.
  function party(socketId, command) {
    const binding = bindings.get(socketId);
    if (!binding) return [];
    const room = rooms.get(binding.roomCode);
    if (!room) return [];
    const member = room.members.get(binding.playerId);
    if (!member || member.socketId !== socketId || member.connection !== 'connected') return [];
    const snapshot = command.party;
    if (!snapshot || typeof snapshot !== 'object') return [];
    if (Number.isInteger(snapshot.revision)) {
      if (snapshot.revision <= member.lastPartyRevision) return [];
      member.lastPartyRevision = snapshot.revision;
    }
    member.party = snapshot;
    const effects = [];
    for (const socket of connectedSockets(room, member.playerId)) {
      effects.push(send(socket, partyMessage({ playerId: member.playerId, party: snapshot })));
    }
    return effects;
  }

  function tick() {
    const effects = [];
    const current = now();
    for (const [code, room] of rooms) {
      let changed = false;
      for (const member of [...room.members.values()]) {
        if (member.connection !== 'reconnecting') continue;
        if (member.reservedUntil !== null && member.reservedUntil <= current) {
          room.members.delete(member.playerId);
          if (room.hostPlayerId === member.playerId) setHost(room, room.members.keys().next().value ?? null);
          changed = true;
        }
      }
      if (changed) {
        room.revision++;
        effects.push(...rosterEffects(room));
      }
      if (room.members.size === 0 && room.emptySince === null) room.emptySince = current;
      if (room.members.size > 0) room.emptySince = null;
      if (room.members.size === 0 && room.emptySince !== null
          && current - room.emptySince >= limits.emptyRoomMs) {
        rooms.delete(code);
        onRoomExpired(code);
      }
    }
    return effects;
  }

  function inspect(code) {
    const room = rooms.get(code);
    if (!room) return null;
    return {
      code: room.code,
      contentVersion: room.contentVersion,
      revision: room.revision,
      memberCount: room.members.size,
      emptySince: room.emptySince,
      members: [...room.members.values()].map((member) => ({
        playerId: member.playerId,
        name: member.name,
        generation: member.generation,
        connection: member.connection,
        socketId: member.socketId,
        hasLatest: member.latest !== null,
      })),
      hostPlayerId: room.hostPlayerId,
    };
  }

  function socketBinding(socketId) {
    return bindings.get(socketId) ?? null;
  }

  function validateMember({ roomCode, playerId, token } = {}) {
    if (typeof roomCode !== 'string' || typeof playerId !== 'string' || typeof token !== 'string') return null;
    const room = rooms.get(roomCode);
    const member = room?.members.get(playerId);
    if (!member || member.token !== token) return null;
    return {
      roomCode: room.code,
      contentVersion: room.contentVersion,
      playerId: member.playerId,
      name: member.name,
      connection: member.connection,
    };
  }

  function roomCount() {
    return rooms.size;
  }

  function memberCount() {
    let count = 0;
    for (const room of rooms.values()) count += room.members.size;
    return count;
  }

  return {
    create,
    join,
    resume,
    leave,
    disconnect,
    presence,
    party,
    ping,
    tick,
    inspect,
    socketBinding,
    validateMember,
    roomCount,
    memberCount,
  };
}
