// Shared presence protocol for browser and room service.
//
// This module is the single source of truth for wire shapes, validation and
// tunable defaults. It must stay free of DOM, WASM, Node and socket imports.

import { normalizeParty } from './party-model.mjs';

export const PROTOCOL_VERSION = 2;
export const CONTENT_VERSION = 'emerald-presence-v2';
export const ROOM_CAPACITY = 4;
export const MAX_MESSAGE_BYTES = 4096;

export const ERROR_CODES = Object.freeze({
  roomFull: 'room_full',
  roomNotFound: 'room_not_found',
  runInProgress: 'run_in_progress',
  sessionExpired: 'session_expired',
  invalidResume: 'invalid_resume',
  incompatibleVersion: 'incompatible_version',
  invalidMessage: 'invalid_message',
  rateLimited: 'rate_limited',
  handshakeTimeout: 'handshake_timeout',
});

export const DEFAULT_LIMITS = Object.freeze({
  handshakeTimeoutMs: 5000,
  maxMessageBytes: MAX_MESSAGE_BYTES,
  movingSendHz: 15,
  idleRefreshMs: 2000,
  transitionBurst: 5,
  transitionPerSecond: 20,
  pingIntervalMs: 5000,
  socketDeadMs: 15000,
  commandPerSecond: 25,
  commandBurst: 10,
  reservationMs: 1800000,
  emptyRoomMs: 600000,
  retryDelaysMs: Object.freeze([500, 1000, 2000, 4000, 5000]),
  retryJitter: 0.2,
  interpolationDelayMs: 200,
  historySamples: 8,
  offsetResetMs: 250,
  visibleSnapshotAgeMs: 5000,
  congestionBytes: 65536,
  congestionTimeoutMs: 5000,
});

export const ACTIVITIES = Object.freeze([
  'overworld', 'dialogue', 'menu', 'battle', 'cutscene', 'loading', 'away', 'unsupported',
]);
export const FACINGS = Object.freeze(['up', 'down', 'left', 'right']);
export const MOTIONS = Object.freeze(['idle', 'walk', 'run', 'bike', 'surf', 'jump']);
export const CONNECTIONS = Object.freeze(['connected', 'reconnecting']);

const IDENTIFIER_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ROOM_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_COORD_PX = 1048576;
const MAX_JUMP_PX = 256;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return false;
  }
  for (const key of keys) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function isCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function fail(code, detail, fatal = true) {
  return { ok: false, code, detail, fatal };
}

function ok(value) {
  return { ok: true, value };
}

export function isRoomCode(value) {
  return typeof value === 'string' && ROOM_CODE_RE.test(value);
}

export function isContentVersion(value) {
  return typeof value === 'string' && IDENTIFIER_RE.test(value);
}

export function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || CONTROL_RE.test(trimmed)) return null;
  if ([...trimmed].length > 24) return null;
  return trimmed;
}

export function validateWorld(value) {
  if (!isObject(value) || !hasExactKeys(value, ['mapGroup', 'mapNum', 'layoutId', 'variant'])) {
    return fail(ERROR_CODES.invalidMessage, 'world must have mapGroup, mapNum, layoutId and variant');
  }
  if (!isCounter(value.mapGroup) || value.mapGroup > 255) return fail(ERROR_CODES.invalidMessage, 'invalid mapGroup');
  if (!isCounter(value.mapNum) || value.mapNum > 255) return fail(ERROR_CODES.invalidMessage, 'invalid mapNum');
  if (typeof value.layoutId !== 'string' || !IDENTIFIER_RE.test(value.layoutId)) {
    return fail(ERROR_CODES.invalidMessage, 'invalid layoutId');
  }
  if (typeof value.variant !== 'string' || !IDENTIFIER_RE.test(value.variant)) {
    return fail(ERROR_CODES.invalidMessage, 'invalid variant');
  }
  return ok(value);
}

export function validatePose(value) {
  const keys = [
    'xPx', 'yPx', 'elevation', 'jumpPx', 'facing', 'appearance', 'motion', 'frame',
  ];
  if (!isObject(value) || !hasExactKeys(value, keys)) {
    return fail(ERROR_CODES.invalidMessage, 'pose fields are invalid');
  }
  if (!isFiniteNumber(value.xPx) || Math.abs(value.xPx) > MAX_COORD_PX) {
    return fail(ERROR_CODES.invalidMessage, 'invalid xPx');
  }
  if (!isFiniteNumber(value.yPx) || Math.abs(value.yPx) > MAX_COORD_PX) {
    return fail(ERROR_CODES.invalidMessage, 'invalid yPx');
  }
  if (!isCounter(value.elevation) || value.elevation > 15) {
    return fail(ERROR_CODES.invalidMessage, 'invalid elevation');
  }
  if (!isFiniteNumber(value.jumpPx) || value.jumpPx < 0 || value.jumpPx > MAX_JUMP_PX) {
    return fail(ERROR_CODES.invalidMessage, 'invalid jumpPx');
  }
  if (!FACINGS.includes(value.facing)) return fail(ERROR_CODES.invalidMessage, 'invalid facing');
  if (typeof value.appearance !== 'string' || !IDENTIFIER_RE.test(value.appearance)) {
    return fail(ERROR_CODES.invalidMessage, 'invalid appearance');
  }
  if (!MOTIONS.includes(value.motion)) return fail(ERROR_CODES.invalidMessage, 'invalid motion');
  if (!isCounter(value.frame) || value.frame > 255) return fail(ERROR_CODES.invalidMessage, 'invalid frame');
  return ok(value);
}

// A battle anchor is the last trustworthy field footpoint captured before the
// player left the field. It is presentation data only: no party, opponent or
// save state travels with it.
export function validateBattleAnchor(value) {
  if (!isObject(value) || !hasExactKeys(value, ['world', 'pose', 'epoch'])) {
    return fail(ERROR_CODES.invalidMessage, 'battleAnchor fields are invalid');
  }
  const world = validateWorld(value.world);
  if (!world.ok) return world;
  const pose = validatePose(value.pose);
  if (!pose.ok) return pose;
  if (!isCounter(value.epoch)) return fail(ERROR_CODES.invalidMessage, 'invalid anchor epoch');
  return ok(value);
}

export function validateLocalPresence(value) {
  const required = ['epoch', 'activity', 'world', 'pose'];
  const allowed = [...required, 'battleAnchor'];
  if (!isObject(value) || !required.every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    return fail(ERROR_CODES.invalidMessage, 'presence state fields are invalid');
  }
  if (!isCounter(value.epoch)) return fail(ERROR_CODES.invalidMessage, 'invalid epoch');
  if (!ACTIVITIES.includes(value.activity)) return fail(ERROR_CODES.invalidMessage, 'invalid activity');

  if (value.world !== null) {
    const world = validateWorld(value.world);
    if (!world.ok) return world;
  }
  if (value.pose !== null) {
    if (value.world === null) return fail(ERROR_CODES.invalidMessage, 'pose requires a world');
    const pose = validatePose(value.pose);
    if (!pose.ok) return pose;
  }

  const anchor = value.battleAnchor ?? null;
  if (anchor !== null) {
    if (value.activity === 'away') {
      const validated = validateBattleAnchor(anchor);
      if (!validated.ok) return validated;
      return ok({ ...value, battleAnchor: null });
    }
    if (value.activity !== 'battle') {
      return fail(ERROR_CODES.invalidMessage, 'battleAnchor requires battle activity');
    }
    const validated = validateBattleAnchor(anchor);
    if (!validated.ok) return validated;
  }
  return ok(value);
}

export function validateSnapshot(value) {
  const keys = [
    'playerId', 'generation', 'seq', 'sampleMs', 'receivedMs', 'state',
  ];
  if (!isObject(value) || !hasExactKeys(value, keys)) {
    return fail(ERROR_CODES.invalidMessage, 'snapshot fields are invalid');
  }
  if (typeof value.playerId !== 'string' || !PLAYER_ID_RE.test(value.playerId)) {
    return fail(ERROR_CODES.invalidMessage, 'invalid playerId');
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    return fail(ERROR_CODES.invalidMessage, 'invalid generation');
  }
  if (!Number.isSafeInteger(value.seq) || value.seq < 1) {
    return fail(ERROR_CODES.invalidMessage, 'invalid seq');
  }
  if (!isFiniteNumber(value.sampleMs) || value.sampleMs < 0) {
    return fail(ERROR_CODES.invalidMessage, 'invalid sampleMs');
  }
  if (!isFiniteNumber(value.receivedMs) || value.receivedMs < 0) {
    return fail(ERROR_CODES.invalidMessage, 'invalid receivedMs');
  }
  return validateLocalPresence(value.state);
}

export function validateMember(value) {
  const keys = ['playerId', 'name', 'generation', 'connection', 'latest'];
  if (!isObject(value) || !hasExactKeys(value, keys)) {
    return fail(ERROR_CODES.invalidMessage, 'member fields are invalid');
  }
  if (typeof value.playerId !== 'string' || !PLAYER_ID_RE.test(value.playerId)) {
    return fail(ERROR_CODES.invalidMessage, 'invalid member playerId');
  }
  if (typeof value.name !== 'string' || !normalizeName(value.name) || normalizeName(value.name) !== value.name) {
    return fail(ERROR_CODES.invalidMessage, 'invalid member name');
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    return fail(ERROR_CODES.invalidMessage, 'invalid member generation');
  }
  if (!CONNECTIONS.includes(value.connection)) {
    return fail(ERROR_CODES.invalidMessage, 'invalid member connection');
  }
  if (value.latest !== null) {
    const snapshot = validateSnapshot(value.latest);
    if (!snapshot.ok) return snapshot;
  }
  return ok(value);
}

// A party snapshot is a low-frequency, presentation-only copy of one player's
// team. It travels separately from pose snapshots and never carries moves,
// items, save bytes or rule state. `availability` expresses hidden (opt-out)
// and unavailable (unsupported pack) without a distinct message type.
export function validatePartySnapshot(value) {
  const result = normalizeParty(value);
  if (!result.ok) return fail(ERROR_CODES.invalidMessage, `party ${result.reason}`);
  return ok(result.party);
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function validateAvatarCustomization(value) {
  if (!isObject(value)) return fail(ERROR_CODES.invalidMessage, 'avatar must be an object');
  if (!hasExactKeys(value, ['equipped', 'colors'], ['version', 'rigId', 'revision'])) {
    return fail(ERROR_CODES.invalidMessage, 'avatar fields are invalid');
  }
  if (value.version !== undefined && value.version !== 1) {
    return fail(ERROR_CODES.invalidMessage, 'invalid avatar version');
  }
  if (value.rigId !== undefined && (typeof value.rigId !== 'string' || !IDENTIFIER_RE.test(value.rigId))) {
    return fail(ERROR_CODES.invalidMessage, 'invalid avatar rigId');
  }
  if (value.revision !== undefined && !isCounter(value.revision)) {
    return fail(ERROR_CODES.invalidMessage, 'invalid avatar revision');
  }
  if (!isObject(value.equipped) || Object.keys(value.equipped).length > 16) {
    return fail(ERROR_CODES.invalidMessage, 'invalid avatar equipped');
  }
  const equipped = {};
  for (const [slotId, itemId] of Object.entries(value.equipped)) {
    if (!IDENTIFIER_RE.test(slotId) || typeof itemId !== 'string' || !IDENTIFIER_RE.test(itemId)) {
      return fail(ERROR_CODES.invalidMessage, 'invalid avatar equipped item');
    }
    equipped[slotId] = itemId;
  }
  if (!isObject(value.colors) || Object.keys(value.colors).length > 16) {
    return fail(ERROR_CODES.invalidMessage, 'invalid avatar colors');
  }
  const colors = {};
  for (const [aspectId, hex] of Object.entries(value.colors)) {
    if (!IDENTIFIER_RE.test(aspectId) || typeof hex !== 'string' || !HEX_COLOR_RE.test(hex)) {
      return fail(ERROR_CODES.invalidMessage, 'invalid avatar color');
    }
    colors[aspectId] = hex.toLowerCase();
  }
  return ok({
    version: 1,
    rigId: typeof value.rigId === 'string' ? value.rigId : 'gen3-brendan',
    equipped,
    colors,
    revision: value.revision ?? 0,
  });
}

function handshakeEnvelope(value, type, fields) {
  if (!hasExactKeys(value, ['v', 'type', ...fields])) {
    return fail(ERROR_CODES.invalidMessage, `${type} fields are invalid`);
  }
  if (value.v !== PROTOCOL_VERSION) {
    return fail(ERROR_CODES.incompatibleVersion, 'unsupported protocol version');
  }
  return null;
}

/**
 * Validate one decoded client message.
 * Returns {ok:true, value} or {ok:false, code, detail, fatal}.
 */
export function validateClientMessage(value) {
  if (!isObject(value)) return fail(ERROR_CODES.invalidMessage, 'message must be an object');
  if (value.v !== PROTOCOL_VERSION) return fail(ERROR_CODES.incompatibleVersion, 'unsupported protocol version');

  switch (value.type) {
    case 'create': {
      const envelope = handshakeEnvelope(value, 'create', ['contentVersion', 'name']);
      if (envelope) return envelope;
      if (!isContentVersion(value.contentVersion)) return fail(ERROR_CODES.incompatibleVersion, 'invalid contentVersion');
      const name = normalizeName(value.name);
      if (!name) return fail(ERROR_CODES.invalidMessage, 'invalid name');
      return ok({ v: PROTOCOL_VERSION, type: 'create', contentVersion: value.contentVersion, name });
    }
    case 'join': {
      const envelope = handshakeEnvelope(value, 'join', ['room', 'contentVersion', 'name']);
      if (envelope) return envelope;
      if (!isRoomCode(value.room)) return fail(ERROR_CODES.roomNotFound, 'invalid room code');
      if (!isContentVersion(value.contentVersion)) return fail(ERROR_CODES.incompatibleVersion, 'invalid contentVersion');
      const name = normalizeName(value.name);
      if (!name) return fail(ERROR_CODES.invalidMessage, 'invalid name');
      return ok({ v: PROTOCOL_VERSION, type: 'join', room: value.room, contentVersion: value.contentVersion, name });
    }
    case 'resume': {
      const envelope = handshakeEnvelope(value, 'resume', ['room', 'contentVersion', 'playerId', 'token']);
      if (envelope) return envelope;
      if (!isRoomCode(value.room)) return fail(ERROR_CODES.roomNotFound, 'invalid room code');
      if (!isContentVersion(value.contentVersion)) return fail(ERROR_CODES.incompatibleVersion, 'invalid contentVersion');
      if (typeof value.playerId !== 'string' || !PLAYER_ID_RE.test(value.playerId)) {
        return fail(ERROR_CODES.invalidResume, 'invalid playerId');
      }
      if (typeof value.token !== 'string' || !TOKEN_RE.test(value.token)) {
        return fail(ERROR_CODES.invalidResume, 'invalid token');
      }
      return ok({
        v: PROTOCOL_VERSION, type: 'resume', room: value.room,
        contentVersion: value.contentVersion, playerId: value.playerId, token: value.token,
      });
    }
    case 'presence': {
      if (!hasExactKeys(value, ['v', 'type', 'generation', 'seq', 'sampleMs', 'state'])) {
        return fail(ERROR_CODES.invalidMessage, 'presence fields are invalid');
      }
      if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
        return fail(ERROR_CODES.invalidMessage, 'invalid generation');
      }
      if (!Number.isSafeInteger(value.seq) || value.seq < 1) {
        return fail(ERROR_CODES.invalidMessage, 'invalid seq');
      }
      if (!isFiniteNumber(value.sampleMs) || value.sampleMs < 0) {
        return fail(ERROR_CODES.invalidMessage, 'invalid sampleMs');
      }
      const state = validateLocalPresence(value.state);
      if (!state.ok) return state;
      return ok({
        v: PROTOCOL_VERSION, type: 'presence', generation: value.generation,
        seq: value.seq, sampleMs: value.sampleMs, state: state.value,
      });
    }
    case 'ping': {
      if (!hasExactKeys(value, ['v', 'type', 'id', 'clientMs'])) {
        return fail(ERROR_CODES.invalidMessage, 'ping fields are invalid');
      }
      if (!isCounter(value.id) || !isFiniteNumber(value.clientMs) || value.clientMs < 0) {
        return fail(ERROR_CODES.invalidMessage, 'invalid ping');
      }
      return ok({ v: PROTOCOL_VERSION, type: 'ping', id: value.id, clientMs: value.clientMs });
    }
    case 'leave': {
      if (!hasExactKeys(value, ['v', 'type'])) {
        return fail(ERROR_CODES.invalidMessage, 'leave fields are invalid');
      }
      return ok({ v: PROTOCOL_VERSION, type: 'leave' });
    }
    case 'party': {
      if (!hasExactKeys(value, ['v', 'type', 'party'])) {
        return fail(ERROR_CODES.invalidMessage, 'party fields are invalid');
      }
      const party = validatePartySnapshot(value.party);
      if (!party.ok) return party;
      return ok({ v: PROTOCOL_VERSION, type: 'party', party: party.value });
    }
    case 'avatar': {
      if (!hasExactKeys(value, ['v', 'type', 'avatar'])) {
        return fail(ERROR_CODES.invalidMessage, 'avatar fields are invalid');
      }
      const avatar = validateAvatarCustomization(value.avatar);
      if (!avatar.ok) return avatar;
      return ok({ v: PROTOCOL_VERSION, type: 'avatar', avatar: avatar.value });
    }
    default:
      return fail(ERROR_CODES.invalidMessage, 'unknown message type');
  }
}

export function serverEnvelope(type, fields) {
  return { v: PROTOCOL_VERSION, type, ...fields };
}

export function errorMessage(code, fatal = true) {
  return serverEnvelope('error', { code, fatal });
}

export function welcomeMessage({ room, contentVersion, playerId, token, generation, revision, serverMs, members }) {
  return serverEnvelope('welcome', {
    room, contentVersion, playerId, token, generation, revision, serverMs, members,
  });
}

export function rosterMessage({ revision, serverMs, members }) {
  return serverEnvelope('roster', { revision, serverMs, members });
}

export function partyMessage({ playerId, party }) {
  return serverEnvelope('party', { playerId, party });
}

export function avatarMessage({ playerId, avatar }) {
  return serverEnvelope('avatar', { playerId, avatar });
}

export function presenceMessage(snapshot) {
  return serverEnvelope('presence', { snapshot });
}

export function pongMessage({ id, clientMs, serverMs }) {
  return serverEnvelope('pong', { id, clientMs, serverMs });
}
