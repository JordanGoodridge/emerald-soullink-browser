// S5 renderer adapter: maps remote actor snapshots into presenter billboard
// primitives using the local avatar's visual foot anchor as the shared screen
// reference. This avoids depending on camera internals or reading the camera
// twice in different coordinate spaces.

import { avatarLayerFor, ghostLayerFor } from './avatar-manifest.mjs';

export function mapRemoteActors({ actors = [], selfPose, selfScreen, avatarAtlas }) {
  if (!selfPose || !selfScreen || !avatarAtlas) return [];
  const result = [];
  for (const actor of actors) {
    if (!actor?.pose) continue;
    let layer = avatarLayerFor(avatarAtlas, actor.pose.appearance, actor.pose.frame, actor.playerId);
    if (layer < 0) continue;
    // Battle markers use the translucent ghost copy of the same cell.
    if (actor.marker) layer = ghostLayerFor(avatarAtlas, layer);
    const screenX = selfScreen.x + (actor.pose.xPx - selfPose.xPx);
    const screenY = selfScreen.y + (actor.pose.yPx - selfPose.yPx) - (actor.pose.jumpPx ?? 0);
    result.push({
      playerId: actor.playerId,
      screenX,
      screenY,
      layer,
      hFlip: actor.pose.facing === 'right',
      busy: Boolean(actor.busy),
      marker: actor.marker ?? null,
      crossBorder: Boolean(actor.crossBorder),
    });
  }
  return result;
}

export function remotePresenterOptions({
  actors = [],
  selfPose = null,
  selfScreen = null,
  avatarAtlas = null,
  canRender = false,
} = {}) {
  if (!canRender || !avatarAtlas) {
    return { remoteActors: [], remoteAvatarPixels: null, remoteAvatarLayers: 0, remoteAvatarRevision: 0 };
  }
  return {
    remoteActors: mapRemoteActors({ actors, selfPose, selfScreen, avatarAtlas }),
    remoteAvatarPixels: avatarAtlas.pixels,
    remoteAvatarLayers: avatarAtlas.layerCount,
    remoteAvatarRevision: avatarAtlas.revision,
  };
}
