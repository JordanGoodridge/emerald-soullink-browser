// Executable forms of the contract fixtures. Shared by tests and browser demos.

export const WORLD_A = Object.freeze({
  mapGroup: 0, mapNum: 9, layoutId: 'littleroot', variant: 'base',
});
export const WORLD_B = Object.freeze({
  mapGroup: 0, mapNum: 10, layoutId: 'littleroot', variant: 'base',
});
export const WORLD_VARIANT = Object.freeze({
  mapGroup: 0, mapNum: 9, layoutId: 'littleroot', variant: 'contest',
});

export const POSE_STANDING = Object.freeze({
  xPx: 168, yPx: 176, elevation: 3, jumpPx: 0,
  facing: 'down', appearance: 'brendan.on-foot', motion: 'idle', frame: 0,
});

export function standingAt(tileX, tileY, overrides = {}) {
  return {
    xPx: tileX * 16 + 8,
    yPx: tileY * 16 + 16,
    elevation: 3,
    jumpPx: 0,
    facing: 'down',
    appearance: 'brendan.on-foot',
    motion: 'idle',
    frame: 0,
    ...overrides,
  };
}

export function presence({ epoch = 1, activity = 'overworld', world = WORLD_A, pose = POSE_STANDING, battleAnchor = null } = {}) {
  return { epoch, activity, world, pose, battleAnchor };
}

// A peer that left the field for a battle: no live pose, but a marker anchor.
export function battlePresence({ epoch = 2, world = WORLD_A, anchorEpoch = 1 } = {}) {
  return presence({
    epoch,
    activity: 'battle',
    world,
    pose: null,
    battleAnchor: { world, pose: POSE_STANDING, epoch: anchorEpoch },
  });
}

export function snapshot(playerId, {
  generation = 1, seq = 1, sampleMs = 200, receivedMs = 1200, state = presence(),
} = {}) {
  return { playerId, generation, seq, sampleMs, receivedMs, state };
}

export function member(playerId, {
  name = playerId, generation = 1, connection = 'connected', latest = null,
} = {}) {
  return { playerId, name, generation, connection, latest };
}

export const ACTIVITY_FIXTURES = Object.freeze([
  { activity: 'overworld', visible: true, pose: POSE_STANDING },
  { activity: 'dialogue', visible: true, busy: true, pose: POSE_STANDING },
  { activity: 'menu', visible: true, busy: true, pose: POSE_STANDING },
  { activity: 'battle', visible: false, pose: null, marker: true },
  { activity: 'cutscene', visible: true, busy: true, marker: true, pose: POSE_STANDING },
  { activity: 'loading', visible: false, pose: null },
  { activity: 'away', visible: false, pose: null },
  { activity: 'unsupported', visible: false, pose: null },
]);
