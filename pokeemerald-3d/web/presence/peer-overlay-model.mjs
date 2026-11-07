// DOM-free model for peer chrome: on-screen name tags and off-screen extender
// icons. Geometry comes from the same field-pixel space as the remote renderer
// and the existing indicators, so tags line up with the sprites they describe.
//
// No DOM, GPU or sockets: the shell renders the returned lists.

import { computeIndicators, indicatorHue } from './player-indicators.mjs';

// The remote sprite is a 16x32 avatar standing on the footpoint, so the tag
// sits just above the head with a small gap.
export const TAG_HEAD_OFFSET = 34;

function displayName(members, playerId) {
  const found = members.find((member) => member?.playerId === playerId);
  return found?.name || 'Player';
}

export function leadBattlePokemonName(parties, playerId) {
  const party = parties?.[playerId];
  if (!party || party.availability === 'hidden' || party.availability === 'unavailable' || !Array.isArray(party.members)) {
    return null;
  }
  const active = party.members.find((mon) => mon && (mon.hp === null || mon.hp === undefined || mon.hp > 0))
    ?? party.members[0]
    ?? null;
  const raw = active?.nickname || active?.speciesName || null;
  if (!raw || typeof raw !== 'string') return null;
  return raw
    .toLowerCase()
    .replace(/(^|[\s.'\-])([a-z])/g, (_, prefix, letter) => prefix + letter.toUpperCase());
}

function labelFor(name, marker, battleMonName = null) {
  if (marker === 'battle') {
    return battleMonName ? `${name} (battle · ${battleMonName})` : `${name} (battle)`;
  }
  if (marker === 'cutscene') return `${name} (cutscene)`;
  return name;
}

export function buildPeerOverlay({
  actors = [],
  members = [],
  parties = null,
  settings = {},
  width = 240,
  height = 160,
  inset = 10,
  projected = null,
} = {}) {
  const showTags = settings.peerNameTags !== false;
  const showIndicators = settings.peerIndicators !== false;

  // Only actors with a finite screen position can be placed. Marker-only peers
  // are handled by the existing battle badges, not by tags.
  const placeable = actors.filter((actor) => actor
    && Number.isFinite(actor.screenX)
    && Number.isFinite(actor.screenY));

  // The presenter reports projected screen-space geometry (head centre/top and
  // foot) for peers it draws as billboards. When present, prefer it over the
  // flat field-pixel offset so tags stay glued to the person in 3D scenes.
  const projectedFor = (playerId) => {
    const entry = projected?.get?.(playerId) ?? projected?.[playerId];
    if (entry && Number.isFinite(entry.x) && Number.isFinite(entry.y)) return entry;
    return null;
  };

  const tags = [];
  if (showTags) {
    for (const actor of placeable) {
      const proj = projectedFor(actor.playerId);
      const footX = proj ? proj.x : actor.screenX;
      const footY = proj ? proj.footY : actor.screenY;
      const onScreen = footX >= 0 && footX <= width
        && footY >= 0 && footY <= height;
      if (!onScreen) continue;
      const name = displayName(members, actor.playerId);
      const battleMon = actor.marker === 'battle' ? leadBattlePokemonName(parties, actor.playerId) : null;
      tags.push({
        playerId: actor.playerId,
        name,
        label: labelFor(name, actor.marker, battleMon),
        x: proj ? proj.x : actor.screenX,
        y: proj ? proj.y : actor.screenY - TAG_HEAD_OFFSET,
        hue: indicatorHue(actor.playerId),
      });
    }
  }

  const indicators = [];
  if (showIndicators) {
    // Arrows are same-map only; a peer across a border is on screen or absent,
    // never pointed at from another map.
    const sameMap = placeable.filter((actor) => !actor.crossBorder);
    for (const indicator of computeIndicators({ actors: sameMap, width, height, inset })) {
      const name = displayName(members, indicator.playerId);
      const actor = sameMap.find((candidate) => candidate.playerId === indicator.playerId);
      const battleMon = indicator.marker === 'battle' ? leadBattlePokemonName(parties, indicator.playerId) : null;
      indicators.push({
        playerId: indicator.playerId,
        name,
        label: labelFor(name, indicator.marker, battleMon),
        x: indicator.x,
        y: indicator.y,
        edge: indicator.edge,
        marker: indicator.marker ?? null,
        // Layer index lets the renderer build an avatar thumbnail without
        // needing the pose again; null means fall back to the hue dot.
        layer: Number.isInteger(actor?.layer) ? actor.layer : null,
        hue: indicatorHue(indicator.playerId),
      });
    }
  }

  return { tags, indicators };
}
