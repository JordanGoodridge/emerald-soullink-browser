// Off-screen peer indicators. Pure geometry: no DOM, GPU or sockets.
//
// Actors arrive in field pixel space (the same space the remote renderer uses),
// so the viewport is the 240x160 GBA field. An indicator exists only for a peer
// that is genuinely outside the viewport, not merely occluded by terrain.

const EDGE_INSET = 10;

export function computeIndicators({
  actors = [],
  width = 240,
  height = 160,
  inset = EDGE_INSET,
} = {}) {
  const result = [];
  const centreX = width / 2;
  const centreY = height / 2;
  const limitX = Math.max(1, centreX - inset);
  const limitY = Math.max(1, centreY - inset);

  for (const actor of actors) {
    if (!actor) continue;
    const x = actor.screenX;
    const y = actor.screenY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x >= 0 && x <= width && y >= 0 && y <= height) continue;

    const dx = x - centreX;
    const dy = y - centreY;
    const scaleX = dx === 0 ? Infinity : limitX / Math.abs(dx);
    const scaleY = dy === 0 ? Infinity : limitY / Math.abs(dy);
    const scale = Math.min(scaleX, scaleY);

    const edge = Math.abs(dx) * limitY >= Math.abs(dy) * limitX
      ? (dx < 0 ? 'left' : 'right')
      : (dy < 0 ? 'up' : 'down');

    result.push({
      playerId: actor.playerId,
      x: centreX + dx * scale,
      y: centreY + dy * scale,
      edge,
      marker: actor.marker ?? null,
    });
  }
  return result;
}

// Stable identity colour per player so arrows do not swap appearance.
export function indicatorHue(playerId) {
  let hash = 0;
  for (const char of String(playerId ?? '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}
