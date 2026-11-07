// Emerald world/presence model.
//
// Reads only typed WASM presence exports and turns them into the shared world
// contract: map identity, epoch, activity, pose, screen anchor and battle
// anchor. Presence transport and rendering stay elsewhere.
//
// A pack may inject an appearance mapping; the default is the Emerald
// Brendan/May on-foot pair.

const ACTIVITIES = [
  'overworld', 'dialogue', 'menu', 'battle', 'cutscene', 'loading', 'away', 'unsupported',
];
const MOTIONS = ['idle', 'walk', 'run', 'bike', 'surf', 'jump'];
const FACING_BY_DIRECTION = [null, 'down', 'up', 'left', 'right'];

const IDLE_CELL = Object.freeze({ down: 0, up: 1, left: 2, right: 2 });
const WALK_CELLS = Object.freeze({
  down: [3, 0, 4, 0],
  up: [5, 1, 6, 1],
  left: [7, 2, 8, 2],
  right: [7, 2, 8, 2],
});

export function layoutName(layoutId) {
  return `layout_${(layoutId >>> 0).toString(16)}`;
}

export function worldKey(world) {
  if (!world) return 'none';
  return `${world.mapGroup}:${world.mapNum}:${world.layoutId}:${world.variant}`;
}

export function frameFor(motion, facing, animCmdIndex) {
  if (motion === 'walk' || motion === 'run') {
    const cells = WALK_CELLS[facing] ?? WALK_CELLS.down;
    return cells[Math.abs(animCmdIndex | 0) % cells.length];
  }
  return IDLE_CELL[facing] ?? IDLE_CELL.down;
}

export function createEmeraldWorldModel({
  exports = null,
  appearanceFor = ({ gender }) => (gender === 1 ? 'may.on-foot' : 'brendan.on-foot'),
} = {}) {
  let wasm = exports;
  let epoch = 0;
  let lastKey = 'none';
  let lastValid = false;
  // Last trustworthy field snapshot, kept only to place a battle marker.
  let lastFieldAnchor = null;

  function bind(nextExports) {
    wasm = nextExports;
    // Force the next valid read to advance the epoch without resetting it.
    lastKey = 'none';
    lastValid = false;
    lastFieldAnchor = null;
  }

  function valid() {
    return Boolean(wasm?.WasmPresenceValid?.());
  }

  function read() {
    if (!wasm) return { state: { epoch, activity: 'loading', world: null, pose: null }, screen: null };

    // Advance the C adapter's smooth-position integrator once per sample.
    // Reading XPx/YPx alone must not depend on how many times they are queried.
    wasm.WasmPresenceRefresh?.();
    const isValid = valid();
    let activity = ACTIVITIES[wasm.WasmPresenceActivity?.() ?? 5] ?? 'unsupported';
    const mapGroup = wasm.WasmPresenceMapGroup?.() ?? 0;
    const mapNum = wasm.WasmPresenceMapNum?.() ?? 0;
    const mapType = wasm.WasmPresenceMapType?.() ?? 0;
    // A cutscene can hide the avatar while the map stays loaded, so keep the
    // identity for its frozen ghost. Loading has no trustworthy identity.
    const world = (isValid || activity === 'cutscene') && mapType !== 0
      ? {
        mapGroup,
        mapNum,
        layoutId: layoutName(wasm.WasmPresenceMapLayoutId?.() ?? 0),
        // Secret bases are runtime instances that do not share a stable map
        // instance identity yet. Mark them distinctly and let the activity
        // classifier hide them.
        variant: mapType === 9 ? 'dynamic' : 'base',
      }
      : null;
    const key = worldKey(world);

    if (key !== lastKey || (isValid && !lastValid)) epoch++;
    lastKey = key;
    lastValid = isValid;

    const fieldKind = wasm.WasmPresenceFieldKind?.() ?? 0;
    const motion = MOTIONS[wasm.WasmPresenceMotion?.() ?? 0] ?? 'idle';
    const facing = FACING_BY_DIRECTION[wasm.WasmPresenceFacing?.() ?? 1] ?? 'down';
    const gender = wasm.WasmPresenceGender?.() ?? 0;
    const appearance = appearanceFor({ gender, exports: wasm });
    let pose = isValid
      ? {
        xPx: wasm.WasmPresenceXPx?.() ?? 0,
        yPx: wasm.WasmPresenceYPx?.() ?? 0,
        elevation: Math.max(0, Math.min(15, wasm.WasmPresenceElevation?.() ?? 0)),
        jumpPx: Math.max(0, Math.min(256, wasm.WasmPresenceJumpPx?.() ?? 0)),
        facing,
        appearance,
        motion,
        frame: frameFor(motion, facing, wasm.WasmPresenceAnimCmdIndex?.() ?? 0),
      }
      : null;

    let battleAnchor = null;
    if (activity === 'battle') {
      // The live avatar no longer exists. Publish the editable copy of the last
      // field footpoint so peers can place a marker; never reuse battle memory.
      pose = null;
      if (lastFieldAnchor) {
        battleAnchor = {
          world: lastFieldAnchor.world,
          pose: { ...lastFieldAnchor.pose },
          epoch: lastFieldAnchor.epoch,
        };
      }
    } else if (activity === 'cutscene' && !pose) {
      // The avatar is hidden mid-scene. Reuse the last footpoint on the same map
      // so peers freeze a ghost there instead of losing the player entirely.
      if (lastFieldAnchor && worldKey(lastFieldAnchor.world) === key) {
        pose = { ...lastFieldAnchor.pose };
      } else {
        activity = 'loading';
      }
    } else if (pose) {
      lastFieldAnchor = { world, pose: { ...pose }, epoch };
    }

    return {
      state: { epoch, activity, world, pose, battleAnchor },
      screen: isValid
        ? { x: wasm.WasmPresenceScreenX?.() ?? 0, y: wasm.WasmPresenceScreenY?.() ?? 0 }
        : null,
      fieldKind,
      mapSize: {
        width: wasm.WasmPresenceMapWidth?.() ?? 0,
        height: wasm.WasmPresenceMapHeight?.() ?? 0,
      },
      connections: readConnections(),
    };
  }

  // Local-only adjacency for cross-border presentation; never published.
  function readConnections() {
    const count = wasm?.WasmPresenceConnectionCount?.() ?? 0;
    const list = [];
    for (let index = 0; index < count; index++) {
      list.push({
        mapGroup: wasm.WasmPresenceConnectionGroup?.(index) ?? 0,
        mapNum: wasm.WasmPresenceConnectionNum?.(index) ?? 0,
        direction: wasm.WasmPresenceConnectionDirection?.(index) ?? 0,
        offset: wasm.WasmPresenceConnectionOffset?.(index) ?? 0,
        width: wasm.WasmPresenceConnectionWidth?.(index) ?? 0,
        height: wasm.WasmPresenceConnectionHeight?.(index) ?? 0,
      });
    }
    return list;
  }

  return {
    bind,
    read,
    get epoch() { return epoch; },
  };
}
