// DOM-free model for the "find people" overlay.
//
// Groups room members by world identity, keeps same-map peers first, and adds a
// distance and 8-way bearing when both players are in the same world. Worlds
// that cannot be compared are never merged, even if map numbers collide.

import { memberFreshness } from './member-status.mjs';

export const ACTIVITY_LABELS = Object.freeze({
  overworld: 'Exploring',
  dialogue: 'Talking',
  menu: 'In menu',
  battle: 'In battle',
  cutscene: 'Cutscene',
  loading: 'Loading',
  away: 'Away',
  unsupported: 'Not shareable',
});

const COMPASS = Object.freeze(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);

export function worldKeyFor(world) {
  if (!world) return null;
  return [world.mapGroup, world.mapNum, world.layoutId, world.variant].join('/');
}

export function sameWorld(a, b) {
  if (!a || !b) return false;
  return a.mapGroup === b.mapGroup
    && a.mapNum === b.mapNum
    && a.layoutId === b.layoutId
    && a.variant === b.variant;
}

// Screen space has +Y down, so north is negative Y.
export function bearingFor(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const index = Math.round((degrees < 0 ? degrees + 360 : degrees) / 45) % 8;
  return COMPASS[index];
}

export function distanceFor(selfPose, pose) {
  if (!selfPose || !pose) return null;
  const dx = pose.xPx - selfPose.xPx;
  const dy = pose.yPx - selfPose.yPx;
  if (![dx, dy].every(Number.isFinite)) return null;
  return Math.round(Math.hypot(dx, dy));
}

function describeMember(member, self, selfWorld, nameFor, freshnessOptions) {
  const state = member?.latest?.state ?? null;
  const world = state?.world ?? state?.battleAnchor?.world ?? null;
  // A peer in battle has no live pose; the battle anchor holds a copy of the
  // last trustworthy field footpoint, which is exactly what we want to place.
  const pose = state?.pose ?? state?.battleAnchor?.pose ?? null;
  const mapName = world ? (nameFor?.(world) ?? `Area ${world.layoutId}`) : 'No area';
  const same = sameWorld(world, selfWorld);
  const dx = same && pose && self?.pose ? pose.xPx - self.pose.xPx : null;
  const dy = same && pose && self?.pose ? pose.yPx - self.pose.yPx : null;
  const activity = state?.activity ?? 'unsupported';
  const { stale } = memberFreshness(member, freshnessOptions);

  return {
    playerId: member.playerId,
    name: member.name || 'Player',
    mapName,
    worldKey: worldKeyFor(world),
    sameMap: same,
    activity,
    activityLabel: stale ? 'Away' : (ACTIVITY_LABELS[activity] ?? 'Unknown'),
    stale,
    marker: state?.battleAnchor ? 'battle' : null,
    connection: member.connection ?? 'connected',
    visible: Boolean(member.visible),
    distancePx: same && !stale ? distanceFor(self?.pose, pose) : null,
    bearing: same && !stale ? bearingFor(dx, dy) : null,
  };
}

export function buildPeopleMap({
  members = [],
  self = null,
  nameFor = () => null,
  serverNowMs = null,
  visibleSnapshotAgeMs = 5000,
} = {}) {
  const selfWorld = self?.world ?? null;
  const freshnessOptions = { serverNowMs, visibleSnapshotAgeMs };
  const peers = members
    .filter((member) => member && member.playerId !== self?.playerId)
    .map((member) => describeMember(member, self, selfWorld, nameFor, freshnessOptions));

  const groups = new Map();
  for (const peer of peers) {
    const key = peer.worldKey ?? 'none';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        mapName: peer.mapName,
        sameMap: peer.sameMap,
        peers: [],
      });
    }
    groups.get(key).peers.push(peer);
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.sameMap !== b.sameMap) return a.sameMap ? -1 : 1;
    return a.mapName.localeCompare(b.mapName);
  });
  for (const group of ordered) {
    group.peers.sort((a, b) => {
      if (a.distancePx !== null && b.distancePx !== null && a.distancePx !== b.distancePx) {
        return a.distancePx - b.distancePx;
      }
      if (a.distancePx !== null && b.distancePx === null) return -1;
      if (a.distancePx === null && b.distancePx !== null) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  return {
    self: {
      playerId: self?.playerId ?? null,
      mapName: selfWorld ? (nameFor?.(selfWorld) ?? `Area ${selfWorld.layoutId}`) : 'No area',
      worldKey: worldKeyFor(selfWorld),
    },
    groups: ordered,
    total: peers.length,
  };
}

export function formatPeerLocation(peer) {
  if (!peer) return '';
  if (peer.distancePx === null) return peer.mapName;
  const bearing = peer.bearing ? ` ${peer.bearing}` : '';
  return `${peer.mapName} · ${peer.distancePx} px${bearing}`;
}

function normalizedAreaName(value) {
  return String(value ?? '')
    .replace(/route\s*(\d+)/gi, 'route $1')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

export function regionSectionForName(mapName, sections = []) {
  const area = normalizedAreaName(mapName);
  if (!area) return null;
  return [...sections]
    .filter((section) => Number.isFinite(section?.x) && Number.isFinite(section?.y)
      && Number.isFinite(section?.width) && Number.isFinite(section?.height)
      && section.width > 0 && section.height > 0 && section.name)
    .sort((a, b) => normalizedAreaName(b.name).length - normalizedAreaName(a.name).length)
    .find((section) => {
      const name = normalizedAreaName(section.name);
      return area === name || area.startsWith(`${name} `) || area.includes(` ${name} `);
    }) ?? null;
}

export function buildRegionMarkers({ peers = [], sections = [], columns = 28, rows = 15 } = {}) {
  const placed = [];
  const counts = new Map();
  for (const peer of peers) {
    const section = regionSectionForName(peer.mapName, sections);
    if (!section) continue;
    const key = section.key ?? section.id ?? section.name;
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    const angle = (index * 2.399963229728653) - Math.PI / 2;
    const radius = index ? Math.min(0.24, 0.09 + 0.045 * Math.sqrt(index)) : 0;
    const x = ((section.x + section.width / 2) / columns + Math.cos(angle) * radius) * 100;
    const y = ((section.y + section.height / 2) / rows + Math.sin(angle) * radius) * 100;
    placed.push({
      ...peer,
      section,
      x: Math.max(2, Math.min(98, x)),
      y: Math.max(3, Math.min(97, y)),
    });
  }
  return placed;
}
