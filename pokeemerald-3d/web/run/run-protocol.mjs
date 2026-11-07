export const RUN_PROTOCOL_VERSION = 2;
export const MAX_RUN_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_LOBBY_TRANSFER_BYTES = 4 * 1024 * 1024;
export const LOBBY_TRANSFER_CHUNK_BYTES = 24 * 1024;

const CLIENT_TYPES = new Set([
  'run.attach', 'run.start', 'run.restore', 'run.event', 'run.restart', 'run.leave',
  'lobby.transfer.begin', 'lobby.transfer.chunk', 'lobby.transfer.end', 'lobby.transfer.ack',
]);

function fail(reason) {
  return { ok: false, reason };
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function validText(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function validateRunClientMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('message_not_object');
  if (value.v !== RUN_PROTOCOL_VERSION) return fail('version_unsupported');
  if (!CLIENT_TYPES.has(value.type)) return fail('message_type_unknown');
  if (value.type === 'run.attach') {
    if (!exactKeys(value, ['v', 'type', 'room', 'playerId', 'token'])) return fail('attach_shape_invalid');
    if (!validText(value.room, 16) || !validText(value.playerId, 64) || !validText(value.token, 128)) return fail('attach_credentials_invalid');
    return { ok: true, value };
  }
  if (value.type === 'run.start') {
    if (!exactKeys(value, ['v', 'type'], ['options'])) return fail('start_shape_invalid');
    if (value.options !== undefined && (!value.options || typeof value.options !== 'object' || Array.isArray(value.options))) return fail('start_options_invalid');
    return { ok: true, value };
  }
  if (value.type === 'run.restore') {
    if (!exactKeys(value, ['v', 'type', 'checkpoint'])
      || !value.checkpoint || typeof value.checkpoint !== 'object' || Array.isArray(value.checkpoint)) {
      return fail('restore_checkpoint_invalid');
    }
    return { ok: true, value };
  }
  if (value.type === 'run.leave') {
    if (!exactKeys(value, ['v', 'type'])) return fail('leave_shape_invalid');
    return { ok: true, value };
  }
  if (value.type === 'run.restart') {
    if (!exactKeys(value, ['v', 'type'])) return fail('restart_shape_invalid');
    return { ok: true, value };
  }
  if (value.type === 'lobby.transfer.begin') {
    if (!exactKeys(value, ['v', 'type', 'transferId', 'recipientPlayerId', 'purpose', 'totalBytes', 'chunkCount'])) {
      return fail('lobby_transfer_begin_shape_invalid');
    }
    if (!validText(value.transferId, 64)
      || !(value.recipientPlayerId === '*' || validText(value.recipientPlayerId, 64))
      || !['slot-save', 'lobby-snapshot', 'slot-claim-request'].includes(value.purpose)
      || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1 || value.totalBytes > MAX_LOBBY_TRANSFER_BYTES
      || !Number.isInteger(value.chunkCount) || value.chunkCount < 1 || value.chunkCount > 256
      || value.chunkCount !== Math.ceil(value.totalBytes / LOBBY_TRANSFER_CHUNK_BYTES)) {
      return fail('lobby_transfer_begin_invalid');
    }
    return { ok: true, value };
  }
  if (value.type === 'lobby.transfer.chunk') {
    if (!exactKeys(value, ['v', 'type', 'transferId', 'index', 'data'])) return fail('lobby_transfer_chunk_shape_invalid');
    if (!validText(value.transferId, 64) || !Number.isInteger(value.index) || value.index < 0
      || typeof value.data !== 'string' || value.data.length < 1 || value.data.length > 32768
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
      return fail('lobby_transfer_chunk_invalid');
    }
    return { ok: true, value };
  }
  if (value.type === 'lobby.transfer.end') {
    if (!exactKeys(value, ['v', 'type', 'transferId']) || !validText(value.transferId, 64)) return fail('lobby_transfer_end_invalid');
    return { ok: true, value };
  }
  if (value.type === 'lobby.transfer.ack') {
    if (!exactKeys(value, ['v', 'type', 'transferId', 'accepted'], ['reason', 'revision'])
      || !validText(value.transferId, 64) || typeof value.accepted !== 'boolean'
      || (value.reason !== undefined && typeof value.reason !== 'string')
      || (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0))) {
      return fail('lobby_transfer_ack_invalid');
    }
    return { ok: true, value };
  }
  if (!exactKeys(value, ['v', 'type', 'event']) || !value.event || typeof value.event !== 'object' || Array.isArray(value.event)) {
    return fail('event_envelope_invalid');
  }
  if (!validText(value.event.eventId, 128) || !validText(value.event.type, 64)) return fail('event_identity_invalid');
  const fields = {
    'area.visit': ['areaKey', 'sectionId', 'label', 'at'],
    'encounter.claim': ['areaKey', 'sectionId', 'label', 'species', 'pid', 'nickname', 'level', 'isGift', 'badgeCount', 'at'],
    'encounter.skip': ['areaKey', 'sectionId', 'species', 'reason', 'badgeCount', 'at'],
    'encounter.resolve': ['areaKey', 'sectionId', 'result', 'badgeCount', 'at'],
    death: ['linkId', 'areaKey', 'sectionId', 'pid', 'level', 'nickname', 'cause', 'badgeCount', 'at'],
    'wipe.pending': ['ready', 'areaKey', 'sectionId', 'badgeCount', 'at'],
    'run.victory': ['badgeCount', 'sectionId', 'party', 'at'],
    'run.ready': ['ready'],
    'run.exclude-member': ['excludedPlayerId'],
  }[value.event.type];
  if (!fields) return fail('event_type_invalid');
  if (Object.keys(value.event).some((key) => !['eventId', 'type', ...fields].includes(key))) return fail('event_fields_invalid');
  if (value.event.badgeCount !== undefined
    && (!Number.isInteger(value.event.badgeCount) || value.event.badgeCount < 0 || value.event.badgeCount > 8)) {
    return fail('event_fields_invalid');
  }
  return { ok: true, value };
}

export const RUN_EVENT_TYPES = Object.freeze([
  'area.visit',
  'encounter.claim',
  'encounter.skip',
  'encounter.resolve',
  'death',
  'wipe.pending',
  'run.victory',
  'run.ready',
  'run.exclude-member',
]);

export function runMessage(type, fields = {}) {
  return { v: RUN_PROTOCOL_VERSION, type, ...fields };
}
