const DEFAULTS = Object.freeze({
  standard: Object.freeze({
    requireMultiplePlayersToStart: false,
    showSettings: true,
    requireRoomToStart: false,
    hostOnlyStart: false,
  }),
  soullink: Object.freeze({
    requireMultiplePlayersToStart: true,
    showSettings: true,
    requireRoomToStart: true,
    hostOnlyStart: true,
  }),
});

export function lobbyScreenPolicy(mode, overrides = {}) {
  const defaults = DEFAULTS[mode];
  if (!defaults) throw new Error(`unsupported lobby screen mode: ${mode}`);
  return Object.freeze({ ...defaults, ...overrides });
}

export function canStartLobby(policy, {
  playerCount = 0,
  roomJoined = false,
  isHost = false,
} = {}) {
  if (!policy || !Number.isInteger(playerCount) || playerCount < 1) return false;
  if (policy.requireMultiplePlayersToStart && playerCount < 2) return false;
  if (policy.requireRoomToStart && !roomJoined) return false;
  if (policy.hostOnlyStart && !isHost) return false;
  return true;
}
