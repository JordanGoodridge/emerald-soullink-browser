// DOM-free freshness and location labels shared by the roster, the people map
// and the party panel.
//
// A member is stale when the newest presence snapshot is older than the visible
// snapshot age. The clock comes from the room service, so a page that has not
// estimated the server clock yet never accuses anyone of being away.

export const NO_AREA = 'elsewhere';

export function memberFreshness(member, {
  serverNowMs = null,
  visibleSnapshotAgeMs = 5000,
} = {}) {
  const receivedMs = member?.latest?.receivedMs;
  if (!Number.isFinite(receivedMs) || !Number.isFinite(serverNowMs)) {
    return { stale: false, ageMs: null };
  }
  const ageMs = Math.max(0, serverNowMs - receivedMs);
  return { stale: ageMs > visibleSnapshotAgeMs, ageMs };
}

export function memberWorld(member) {
  const state = member?.latest?.state ?? null;
  return state?.world ?? state?.battleAnchor?.world ?? null;
}

export function memberMapName(member, nameFor) {
  const world = memberWorld(member);
  return world ? (nameFor?.(world) ?? 'Unknown area') : NO_AREA;
}

export function awayLabel(mapName) {
  return `Away · ${mapName || NO_AREA}`;
}
