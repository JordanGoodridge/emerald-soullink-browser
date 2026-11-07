// Hoenn Friends Map DOM view for multiplayer presence.

import { buildPeopleMap, buildRegionMarkers } from '../presence/map-overlay-model.mjs';

export function renderPeopleMapInto({
  bodyEl,
  summaryEl,
  snapshot,
  nameFor,
  regionMap,
  packManifestUrl,
  doc = globalThis.document,
}) {
  if (!bodyEl || !summaryEl) return;
  const model = buildPeopleMap({
    members: snapshot.members ?? [],
    self: { playerId: snapshot.playerId, world: snapshot.world, pose: snapshot.pose },
    nameFor,
    serverNowMs: snapshot.serverNowMs,
    visibleSnapshotAgeMs: snapshot.visibleSnapshotAgeMs,
  });
  const count = model.total;
  const others = count === 1 ? '1 other player' : `${count} other players`;
  summaryEl.textContent = `${others} · you are in ${model.self.mapName}`;

  if (!count) {
    const empty = doc.createElement('p');
    empty.className = 'world-map-empty';
    empty.textContent = 'No one else is in the room yet.';
    bodyEl.replaceChildren(empty);
    return;
  }

  const columns = regionMap?.dimensions?.columns ?? 28;
  const rows = regionMap?.dimensions?.rows ?? 15;
  const mapSurface = doc.createElement('div');
  mapSurface.className = 'world-map-surface';
  const mapImage = doc.createElement('img');
  mapImage.className = 'world-map-art';
  mapImage.alt = 'Map of the Hoenn region';
  mapImage.draggable = false;
  const hasMapImage = Boolean(regionMap?.image?.url);
  if (hasMapImage) {
    mapImage.src = new URL(regionMap.image.url, packManifestUrl ?? globalThis.location?.href).href;
  }
  mapSurface.append(mapImage);

  const peers = model.groups.flatMap((group) => group.peers);
  const markers = buildRegionMarkers({
    peers,
    sections: regionMap?.sections ?? [],
    columns,
    rows,
  });
  const markersById = new Set();
  for (const peer of markers) {
    markersById.add(peer.playerId);
    const marker = doc.createElement('button');
    marker.type = 'button';
    marker.className = 'world-map-marker';
    marker.style.left = `${peer.x}%`;
    marker.style.top = `${peer.y}%`;
    marker.dataset.label = `${peer.name} · ${peer.mapName}${peer.stale ? ' · Away' : ''}`;
    marker.dataset.stale = String(peer.stale);
    marker.title = marker.dataset.label;
    marker.setAttribute('aria-label', marker.dataset.label);
    marker.dataset.peerId = peer.playerId;
    marker.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 21c.4-5 2.9-7.5 7.5-7.5s7.1 2.5 7.5 7.5"/></svg>';
    mapSurface.append(marker);
  }

  const unplaced = peers.filter((peer) => !markersById.has(peer.playerId));
  const locationList = doc.createElement('ul');
  locationList.className = 'world-map-locations';
  for (const peer of unplaced) {
    const row = doc.createElement('li');
    row.classList.toggle('stale', peer.stale);
    const name = doc.createElement('strong');
    name.textContent = peer.name;
    const area = doc.createElement('span');
    area.textContent = peer.stale ? `${peer.mapName} · Away` : peer.mapName;
    row.append(name, area);
    locationList.append(row);
  }

  const caption = doc.createElement('p');
  caption.className = 'world-map-caption';
  caption.textContent = hasMapImage
    ? 'Friend markers show their current route or town. Hover or focus a marker to see who is there.'
    : 'The region map is unavailable; friends’ area names are listed below.';
  bodyEl.replaceChildren(...(hasMapImage ? [mapSurface] : []), caption, ...(unplaced.length ? [locationList] : []));
}
