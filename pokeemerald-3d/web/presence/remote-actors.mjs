// Deterministic remote actor store. No sockets, GPU, DOM, WASM or globals.

import { DEFAULT_LIMITS } from './protocol.mjs';

const VISIBLE = new Set(['overworld', 'dialogue', 'menu', 'cutscene']);
const BUSY = new Set(['dialogue', 'menu', 'cutscene']);
const MAX_DISPLACEMENT_PX = 64;

// A cutscene peer keeps a frozen ghost at its last footpoint and is labelled so
// it is not mistaken for someone standing still.
function markerFor(state) {
  return state?.activity === 'cutscene' ? 'cutscene' : null;
}

function sameWorld(a, b) {
  if (a === null || b === null) return false;
  return a.mapGroup === b.mapGroup
    && a.mapNum === b.mapNum
    && a.layoutId === b.layoutId
    && a.variant === b.variant;
}

function copyActor(member, snapshot, busy, marker = null, crossBorder = false) {
  return {
    playerId: member.playerId,
    world: snapshot.state.world,
    pose: snapshot.state.pose,
    busy,
    marker,
    crossBorder,
  };
}

const CONNECTION_SOUTH = 1;
const CONNECTION_NORTH = 2;
const CONNECTION_WEST = 3;
const CONNECTION_EAST = 4;

function connectionFor(connections, world) {
  if (!world || !Array.isArray(connections)) return null;
  for (const connection of connections) {
    if (connection.mapGroup === world.mapGroup && connection.mapNum === world.mapNum) {
      return connection;
    }
  }
  return null;
}

// Translate a connected map's footpoint into the local map's space. This is the
// inverse of the renderer's connection sampling (wasm_display.c).
function translatePose(pose, connection, mapSize) {
  if (!pose || !connection) return pose;
  const tile = 16;
  switch (connection.direction) {
  case CONNECTION_NORTH:
    return {
      ...pose,
      xPx: pose.xPx + connection.offset * tile,
      yPx: pose.yPx - connection.height * tile,
    };
  case CONNECTION_SOUTH:
    return {
      ...pose,
      xPx: pose.xPx + connection.offset * tile,
      yPx: pose.yPx + (mapSize?.height ?? 0) * tile,
    };
  case CONNECTION_WEST:
    return {
      ...pose,
      xPx: pose.xPx - connection.width * tile,
      yPx: pose.yPx + connection.offset * tile,
    };
  case CONNECTION_EAST:
    return {
      ...pose,
      xPx: pose.xPx + (mapSize?.width ?? 0) * tile,
      yPx: pose.yPx - connection.offset * tile,
    };
  default:
    return null;
  }
}

export function createRemoteActorStore({
  interpolationDelayMs = DEFAULT_LIMITS.interpolationDelayMs,
  historyLimit = DEFAULT_LIMITS.historySamples,
  visibleSnapshotAgeMs = DEFAULT_LIMITS.visibleSnapshotAgeMs,
  maxDisplacementPx = MAX_DISPLACEMENT_PX,
} = {}) {
  let revision = -1;
  const members = new Map();
  const histories = new Map();
  const lastVisible = new Map();
  let lastSampleWorld = null;

  function clearInterpolation() {
    histories.clear();
    lastVisible.clear();
  }

  function reset() {
    revision = -1;
    members.clear();
    histories.clear();
    lastVisible.clear();
    lastSampleWorld = null;
  }

  function hide(playerId) {
    lastVisible.set(playerId, false);
    histories.delete(playerId);
  }

  function historyFor(playerId, member) {
    let history = histories.get(playerId);
    if (!history || history.generation !== member.generation) {
      history = {
        generation: member.generation,
        samples: [],
        lastSeq: 0,
        lastEpoch: -1,
        offsetMs: 0,
        senderTime: true,
        lastSampleMs: -Infinity,
      };
      histories.set(playerId, history);
    }
    return history;
  }

  // Sender monotonic time mapped into the server timeline. The offset is the
  // smallest observed arrival delay, so jitter pushes samples later but never
  // makes the displayed timeline wobble.
  function historyTime(history, sample) {
    if (history.senderTime && Number.isFinite(sample.sampleMs)) {
      return sample.sampleMs + (history.offsetMs ?? 0);
    }
    return sample.receivedMs;
  }

  function updateOffset(history) {
    let min = Infinity;
    for (const sample of history.samples.slice(-32)) {
      if (!Number.isFinite(sample.sampleMs)) continue;
      const delay = sample.receivedMs - sample.sampleMs;
      if (Number.isFinite(delay) && delay < min) min = delay;
    }
    if (Number.isFinite(min)) history.offsetMs = min;
  }

  // Sender time is only usable when it actually advances; fixtures or senders
  // that omit it fall back to arrival times for this history.
  function noteSenderTime(history, snapshot) {
    if (!history.senderTime) return;
    if (!Number.isFinite(snapshot.sampleMs) || snapshot.sampleMs <= history.lastSampleMs) {
      history.senderTime = false;
      return;
    }
    history.lastSampleMs = snapshot.sampleMs;
  }

  function acceptSample(history, snapshot) {
    if (snapshot.seq <= history.lastSeq) return false;
    const epoch = snapshot.state.epoch;
    if (epoch < history.lastEpoch) return false;

    const previous = history.samples.at(-1);
    if (previous && epoch === previous.state.epoch) {
      const currentWorld = snapshot.state.world;
      if (previous.state.world !== null || currentWorld !== null) {
        if (!sameWorld(previous.state.world, currentWorld)) return false;
      }
      if (previous.state.pose && snapshot.state.pose) {
        const dx = snapshot.state.pose.xPx - previous.state.pose.xPx;
        const dy = snapshot.state.pose.yPx - previous.state.pose.yPx;
        if (Math.hypot(dx, dy) > maxDisplacementPx) history.samples.length = 0;
      }
    }
    if (epoch > history.lastEpoch) history.samples.length = 0;

    history.samples.push(snapshot);
    history.lastSeq = snapshot.seq;
    history.lastEpoch = epoch;
    if (history.samples.length > historyLimit) {
      history.samples.splice(0, history.samples.length - historyLimit);
    }
    noteSenderTime(history, snapshot);
    updateOffset(history);
    return true;
  }

  function ingest(snapshot) {
    const member = members.get(snapshot.playerId);
    if (!member) return;
    if (snapshot.generation !== member.generation) return;
    if (member.latest && snapshot.seq <= member.latest.seq) return;

    const history = historyFor(snapshot.playerId, member);
    if (!acceptSample(history, snapshot)) return;
    member.latest = snapshot;
  }

  function replaceRoster(nextMembers, nextRevision) {
    if (nextRevision <= revision) return false;
    revision = nextRevision;
    const seen = new Set();
    for (const entry of nextMembers) {
      seen.add(entry.playerId);
      const existing = members.get(entry.playerId);
      if (existing && existing.generation !== entry.generation) {
        histories.delete(entry.playerId);
        lastVisible.delete(entry.playerId);
      }
      const member = {
        playerId: entry.playerId,
        name: entry.name,
        generation: entry.generation,
        connection: entry.connection,
        latest: null,
      };
      members.set(entry.playerId, member);
      if (entry.latest) {
        if (existing && existing.generation === entry.generation
            && existing.latest && existing.latest.seq >= entry.latest.seq) {
          member.latest = existing.latest;
        } else {
          ingest(entry.latest);
        }
      }
    }
    for (const playerId of [...members.keys()]) {
      if (seen.has(playerId)) continue;
      members.delete(playerId);
      histories.delete(playerId);
      lastVisible.delete(playerId);
    }
    return true;
  }

  function sample({
    selfId, world, canRenderWorld, serverNowMs, clockReady,
    connections = [], mapSize = null,
  }) {
    if (!canRenderWorld || !world) {
      clearInterpolation();
      return [];
    }
    if (!sameWorld(world, lastSampleWorld) && lastSampleWorld !== null) {
      clearInterpolation();
    }
    lastSampleWorld = world;

    // A peer is placeable when it shares our exact world or sits on a directly
    // connected map (one hop only).
    const mappingFor = (candidate) => {
      if (candidate && sameWorld(candidate, world)) return { kind: 'same' };
      const connection = connectionFor(connections, candidate);
      if (!connection) return null;
      if (connection.direction < CONNECTION_SOUTH || connection.direction > CONNECTION_EAST) return null;
      return { kind: 'connection', connection };
    };

    const localizeState = (state, mapping) => (mapping.kind === 'same'
      ? state
      : { ...state, world, pose: translatePose(state.pose, mapping.connection, mapSize) });

    const result = [];
    for (const member of members.values()) {
      if (member.playerId === selfId) continue;
      if (member.connection !== 'connected' || !member.latest) {
        hide(member.playerId);
        continue;
      }
      const snapshot = member.latest;
      const state = snapshot.state;

      // A peer in battle has no live pose, only a retained field anchor. Place a
      // stationary marker in the matching world and never interpolate it.
      if (state.activity === 'battle') {
        const anchor = state.battleAnchor;
        const mapping = anchor ? mappingFor(anchor.world) : null;
        if (!anchor || !mapping) {
          hide(member.playerId);
          continue;
        }
        if (serverNowMs !== null && serverNowMs - snapshot.receivedMs > visibleSnapshotAgeMs) {
          hide(member.playerId);
          continue;
        }
        const anchorPose = mapping.kind === 'same'
          ? anchor.pose
          : translatePose(anchor.pose, mapping.connection, mapSize);
        if (!anchorPose) {
          hide(member.playerId);
          continue;
        }
        lastVisible.set(member.playerId, true);
        result.push({
          playerId: member.playerId,
          world,
          pose: anchorPose,
          busy: false,
          marker: 'battle',
          crossBorder: mapping.kind !== 'same',
        });
        continue;
      }

      const mapping = mappingFor(state.world);
      if (!mapping) {
        hide(member.playerId);
        continue;
      }
      if (!VISIBLE.has(state.activity)) {
        hide(member.playerId);
        continue;
      }
      if (serverNowMs !== null && serverNowMs - snapshot.receivedMs > visibleSnapshotAgeMs) {
        hide(member.playerId);
        continue;
      }
      if (!state.pose) {
        hide(member.playerId);
        continue;
      }

      const crossBorder = mapping.kind !== 'same';
      const localizedSnapshot = { ...snapshot, state: localizeState(state, mapping) };
      const busy = BUSY.has(state.activity);
      const wasVisible = lastVisible.get(member.playerId) === true;
      lastVisible.set(member.playerId, true);

      if (busy || !clockReady || serverNowMs === null || !wasVisible) {
        result.push(copyActor(member, localizedSnapshot, busy, markerFor(state), crossBorder));
        continue;
      }

      const history = historyFor(member.playerId, member);
      const samples = history.samples
        .filter((entry) => (
          entry.state.epoch === state.epoch
          && entry.state.world
          && entry.state.pose
          && sameWorld(entry.state.world, state.world)
        ))
        .map((entry) => (
          crossBorder ? { ...entry, state: localizeState(entry.state, mapping) } : entry
        ));
      if (samples.length < 2) {
        result.push(copyActor(member, localizedSnapshot, busy, markerFor(state), crossBorder));
        continue;
      }

      const target = serverNowMs - interpolationDelayMs;
      const first = samples[0];
      const last = samples.at(-1);
      const firstTime = historyTime(history, first);
      const lastTime = historyTime(history, last);
      if (target <= firstTime) {
        result.push(copyActor(member, first, busy, markerFor(first.state), crossBorder));
        continue;
      }
      if (target >= lastTime) {
        result.push(copyActor(member, last, busy, markerFor(last.state), crossBorder));
        continue;
      }

      let before = first;
      let after = last;
      for (let index = 1; index < samples.length; index++) {
        if (historyTime(history, samples[index]) >= target) {
          before = samples[index - 1];
          after = samples[index];
          break;
        }
      }
      const beforeTime = historyTime(history, before);
      const span = historyTime(history, after) - beforeTime;
      const alpha = span > 0 ? Math.max(0, Math.min(1, (target - beforeTime) / span)) : 1;
      const a = before.state.pose;
      const b = after.state.pose;
      const pose = {
        ...before.state.pose,
        xPx: a.xPx + (b.xPx - a.xPx) * alpha,
        yPx: a.yPx + (b.yPx - a.yPx) * alpha,
        jumpPx: a.jumpPx + (b.jumpPx - a.jumpPx) * alpha,
        elevation: alpha >= 1 ? b.elevation : a.elevation,
        facing: alpha >= 1 ? b.facing : a.facing,
        frame: alpha >= 1 ? b.frame : a.frame,
        motion: alpha >= 1 ? b.motion : a.motion,
        appearance: alpha >= 1 ? b.appearance : a.appearance,
      };
      result.push({
        playerId: member.playerId,
        world: before.state.world,
        pose,
        busy,
        marker: null,
        crossBorder,
      });
    }
    return result;
  }

  function getMembers() {
    return [...members.values()].map((member) => ({
      playerId: member.playerId,
      name: member.name,
      generation: member.generation,
      connection: member.connection,
      latest: member.latest,
      visible: lastVisible.get(member.playerId) === true,
    }));
  }

  return {
    reset,
    clearInterpolation,
    replaceRoster,
    ingest,
    sample,
    getMembers,
    get revision() { return revision; },
  };
}
