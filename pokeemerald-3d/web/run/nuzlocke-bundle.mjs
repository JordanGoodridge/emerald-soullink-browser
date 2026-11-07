export const NUZLOCKE_BUNDLE_FORMAT = 'poketech-nuzlocke-save';
export const NUZLOCKE_BUNDLE_VERSION = 1;

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  if (typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('Nuzlocke bundle save data is not valid base64');
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function validNuzlockeState(state, gameId, playerId) {
  return state
    && typeof state === 'object'
    && state.mode === 'nuzlocke'
    && state.gameId === gameId
    && typeof state.runId === 'string'
    && (typeof state.seed === 'string' || Number.isSafeInteger(state.seed))
    && ['active', 'wipe_pending', 'closed'].includes(state.status)
    && Array.isArray(state.members)
    && state.members.length === 1
    && state.members[0]?.playerId === playerId
    && state.members[0]?.active !== false
    && state.areas && typeof state.areas === 'object' && !Array.isArray(state.areas)
    && state.links && typeof state.links === 'object' && !Array.isArray(state.links)
    && Array.isArray(state.deaths)
    && Array.isArray(state.events)
    && state.options && typeof state.options === 'object' && !Array.isArray(state.options)
    && state.options.mode === 'nuzlocke'
    && state.options.saveSlot === 'nuzlocke';
}

export function serializeNuzlockeBundle({
  gameId,
  formatId,
  formatVersion,
  profile = '',
  playerId,
  saveBytes,
  runState,
} = {}) {
  const bytes = saveBytes instanceof Uint8Array
    ? saveBytes
    : saveBytes instanceof ArrayBuffer ? new Uint8Array(saveBytes) : null;
  if (!gameId || !formatId || !Number.isInteger(formatVersion) || !playerId || !bytes?.length) {
    throw new Error('Nuzlocke bundle requires game/save identity and save bytes');
  }
  if (!validNuzlockeState(runState, gameId, playerId)) {
    throw new Error('Nuzlocke bundle run history does not match this game and player');
  }
  return JSON.stringify({
    format: NUZLOCKE_BUNDLE_FORMAT,
    schemaVersion: NUZLOCKE_BUNDLE_VERSION,
    gameId,
    formatId,
    formatVersion,
    profile,
    playerId,
    saveBytes: bytesToBase64(bytes),
    runState,
  });
}

export function parseNuzlockeBundle(text, {
  gameId,
  formatId,
  formatVersion,
  profile = '',
  playerId,
  saveBytesLength,
} = {}) {
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    throw new Error('Nuzlocke backup is not valid JSON');
  }
  if (bundle?.format !== NUZLOCKE_BUNDLE_FORMAT || bundle.schemaVersion !== NUZLOCKE_BUNDLE_VERSION) {
    throw new Error('Nuzlocke backup format or version is unsupported');
  }
  if (bundle.gameId !== gameId || bundle.formatId !== formatId || bundle.formatVersion !== formatVersion) {
    throw new Error('Nuzlocke backup belongs to a different game or save version');
  }
  if ((bundle.profile ?? '') !== profile || bundle.playerId !== playerId) {
    throw new Error('Nuzlocke backup belongs to a different local profile');
  }
  if (!validNuzlockeState(bundle.runState, gameId, playerId)) {
    throw new Error('Nuzlocke backup has invalid run history');
  }
  const bytes = base64ToBytes(bundle.saveBytes);
  if (saveBytesLength !== undefined && bytes.length !== saveBytesLength) {
    throw new Error(`Nuzlocke backup save must contain ${saveBytesLength} bytes`);
  }
  return { bytes, runState: bundle.runState };
}
