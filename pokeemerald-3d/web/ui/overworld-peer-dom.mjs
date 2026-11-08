// Overworld DOM overlay controller for remote battle badges, off-screen
// indicator arrows, avatar thumbnails, and on-screen peer name tags.

import { computeIndicators, indicatorHue } from '../presence/player-indicators.mjs';
import { leadBattlePokemonName } from '../presence/peer-overlay-model.mjs';
import {
  AVATAR_CELL_HEIGHT,
  AVATAR_CELL_WIDTH,
  AVATAR_LAYER_SIZE,
} from '../presence/avatar-manifest.mjs';

export const EMERALD_TYPE_BADGES = Object.freeze({
  0: Object.freeze({ label: 'NRM', bg: '#9099a1', border: '#d4dadf' }),
  1: Object.freeze({ label: 'FGT', bg: '#ce4069', border: '#f28da8' }),
  2: Object.freeze({ label: 'FLY', bg: '#6882d4', border: '#b3c3f7' }),
  3: Object.freeze({ label: 'PSN', bg: '#ab6ac8', border: '#dfaef5' }),
  4: Object.freeze({ label: 'GRD', bg: '#d97746', border: '#f5b895' }),
  5: Object.freeze({ label: 'RCK', bg: '#b69e31', border: '#e6d37a' }),
  6: Object.freeze({ label: 'BUG', bg: '#90c12c', border: '#cbe884' }),
  7: Object.freeze({ label: 'GHT', bg: '#5269ac', border: '#9eb2eb' }),
  8: Object.freeze({ label: 'STL', bg: '#5a8ea1', border: '#a8d3e3' }),
  9: Object.freeze({ label: '???', bg: '#68a090', border: '#a6d4c7' }),
  10: Object.freeze({ label: 'FIR', bg: '#ff9c54', border: '#ffd0a6' }),
  11: Object.freeze({ label: 'WTR', bg: '#4d90d5', border: '#a1caf7' }),
  12: Object.freeze({ label: 'GRS', bg: '#63bb5b', border: '#aee8a9' }),
  13: Object.freeze({ label: 'ELC', bg: '#f3d23b', border: '#fff099', text: '#1b222c' }),
  14: Object.freeze({ label: 'PSY', bg: '#f97176', border: '#ffb5b8' }),
  15: Object.freeze({ label: 'ICE', bg: '#74cec0', border: '#c4f5ed', text: '#142628' }),
  16: Object.freeze({ label: 'DRG', bg: '#0a6dc4', border: '#7cbef7' }),
  17: Object.freeze({ label: 'DRK', bg: '#5a5366', border: '#a89fb8' }),
});

export function createOverworldPeerDom({
  canvas,
  panel,
  getAvatarAtlas,
  doc = globalThis.document,
}) {
  const remoteBadgeLayer = doc.createElement('div');
  remoteBadgeLayer.className = 'remote-badges';
  remoteBadgeLayer.hidden = true;
  panel.append(remoteBadgeLayer);
  const remoteBadgeElements = new Map();
  const remoteArrowElements = new Map();

  const peerOverlayLayer = doc.createElement('div');
  peerOverlayLayer.className = 'peer-overlay';
  peerOverlayLayer.hidden = true;
  panel.append(peerOverlayLayer);
  const peerTagElements = new Map();
  const peerIconCache = new Map();

  const battleHudLayer = doc.createElement('div');
  battleHudLayer.className = 'battle-hud-overlay';
  battleHudLayer.hidden = true;
  panel.append(battleHudLayer);
  const battleHudElements = new Map();

  let overlayGeometry = null;
  let overlayGeometryKey = '';

  function invalidateOverlayGeometry() {
    overlayGeometry = null;
  }

  function overlayGeometryNow() {
    const key = `${canvas.width}x${canvas.height}@${globalThis.devicePixelRatio ?? 1}`;
    if (overlayGeometry && overlayGeometryKey === key) return overlayGeometry;
    const canvasRect = canvas.getBoundingClientRect();
    const panelRect = remoteBadgeLayer.parentElement.getBoundingClientRect();
    overlayGeometryKey = key;
    overlayGeometry = {
      dx: canvasRect.left - panelRect.left,
      dy: canvasRect.top - panelRect.top,
      sx: canvasRect.width / 240,
      sy: canvasRect.height / 160,
    };
    return overlayGeometry;
  }

  globalThis.addEventListener?.('resize', invalidateOverlayGeometry);
  doc.addEventListener?.('fullscreenchange', invalidateOverlayGeometry);
  if (typeof ResizeObserver === 'function') {
    const resizeObserver = new ResizeObserver(invalidateOverlayGeometry);
    resizeObserver.observe(canvas);
    resizeObserver.observe(remoteBadgeLayer.parentElement);
  }

  function placeInPanel(element, x, y) {
    const geometry = overlayGeometryNow();
    const left = `${geometry.dx + x * geometry.sx}px`;
    const top = `${geometry.dy + y * geometry.sy}px`;
    if (element.style.left !== left) element.style.left = left;
    if (element.style.top !== top) element.style.top = top;
  }

  function updateRemoteBadges({ presentedBadges = [], remoteActors = [], members = [], parties = null, peerNameTags = true }) {
    remoteBadgeLayer.classList.toggle('with-peer-tags', peerNameTags !== false);
    if (!presentedBadges.length && !remoteActors.length) {
      if (remoteBadgeLayer.hidden && remoteBadgeElements.size === 0 && remoteArrowElements.size === 0) return;
      remoteBadgeLayer.hidden = true;
      remoteBadgeLayer.replaceChildren();
      remoteBadgeElements.clear();
      remoteArrowElements.clear();
      return;
    }
    const badges = presentedBadges.length
      ? presentedBadges
      : remoteActors
        .filter((actor) => actor.marker)
        .map((actor) => ({
          playerId: actor.playerId,
          x: actor.screenX,
          y: actor.screenY - 23,
          marker: actor.marker,
        }));

    const memberNames = new Map(members.map((member) => [member.playerId, member.name]));
    const indicators = computeIndicators({ actors: remoteActors.filter((actor) => !actor.crossBorder) });
    const hidden = !badges.length && !indicators.length;
    if (hidden) {
      if (remoteBadgeLayer.hidden && remoteBadgeElements.size === 0 && remoteArrowElements.size === 0) return;
      remoteBadgeLayer.hidden = true;
      remoteBadgeLayer.replaceChildren();
      remoteBadgeElements.clear();
      remoteArrowElements.clear();
      return;
    }
    remoteBadgeLayer.hidden = false;

    const seenBadges = new Set();
    for (const badge of badges) {
      seenBadges.add(badge.playerId);
      let element = remoteBadgeElements.get(badge.playerId);
      if (!element) {
        element = doc.createElement('p');
        element.className = 'remote-badge';
        remoteBadgeLayer.append(element);
        remoteBadgeElements.set(badge.playerId, element);
      }
      const battleMon = badge.marker === 'battle' ? leadBattlePokemonName(parties, badge.playerId) : null;
      const text = badge.marker === 'cutscene'
        ? 'In cutscene'
        : battleMon ? `In battle · ${battleMon}` : 'In battle';
      if (element.textContent !== text) element.textContent = text;
      placeInPanel(element, badge.x, badge.y);
    }
    for (const [playerId, element] of remoteBadgeElements) {
      if (seenBadges.has(playerId)) continue;
      element.remove();
      remoteBadgeElements.delete(playerId);
    }

    const seenArrows = new Set();
    for (const indicator of indicators) {
      seenArrows.add(indicator.playerId);
      let element = remoteArrowElements.get(indicator.playerId);
      if (!element) {
        element = doc.createElement('p');
        element.className = 'remote-arrow';
        remoteBadgeLayer.append(element);
        remoteArrowElements.set(indicator.playerId, element);
        element.style.setProperty('--hue', String(indicatorHue(indicator.playerId)));
      }
      const name = memberNames.get(indicator.playerId) ?? 'Player';
      const glyph = { left: '←', right: '→', up: '↑', down: '↓' }[indicator.edge] ?? '•';
      const battleMon = indicator.marker === 'battle' ? leadBattlePokemonName(parties, indicator.playerId) : null;
      const label = indicator.marker === 'battle'
        ? (battleMon ? `${name} (battle · ${battleMon})` : `${name} (battle)`)
        : indicator.marker === 'cutscene' ? `${name} (cutscene)` : name;
      element.textContent = `${glyph} ${label}`;
      element.dataset.edge = indicator.edge;
      placeInPanel(element, indicator.x, indicator.y);
    }
    for (const [playerId, element] of remoteArrowElements) {
      if (seenArrows.has(playerId)) continue;
      element.remove();
      remoteArrowElements.delete(playerId);
    }
  }

  function avatarThumbUrl(layer) {
    if (!Number.isInteger(layer) || layer < 0) return null;
    const atlas = getAvatarAtlas?.();
    if (!atlas?.pixels) return null;
    const key = `${atlas.revision ?? 0}:${layer}`;
    const cached = peerIconCache.get(key);
    if (cached !== undefined) return cached;

    const offset = layer * AVATAR_LAYER_SIZE * AVATAR_LAYER_SIZE * 4;
    if (offset + AVATAR_LAYER_SIZE * AVATAR_LAYER_SIZE * 4 > atlas.pixels.length) return null;

    const canvas2d = doc.createElement('canvas');
    canvas2d.width = AVATAR_CELL_WIDTH;
    canvas2d.height = AVATAR_CELL_HEIGHT;
    const context = canvas2d.getContext('2d');
    if (!context) return null;
    const imageData = context.createImageData(AVATAR_CELL_WIDTH, AVATAR_CELL_HEIGHT);
    for (let y = 0; y < AVATAR_CELL_HEIGHT; y++) {
      for (let x = 0; x < AVATAR_CELL_WIDTH; x++) {
        const src = offset + (y * AVATAR_LAYER_SIZE + x) * 4;
        const dst = (y * AVATAR_CELL_WIDTH + x) * 4;
        imageData.data[dst] = atlas.pixels[src];
        imageData.data[dst + 1] = atlas.pixels[src + 1];
        imageData.data[dst + 2] = atlas.pixels[src + 2];
        imageData.data[dst + 3] = atlas.pixels[src + 3];
      }
    }
    context.putImageData(imageData, 0, 0);
    const url = canvas2d.toDataURL();
    if (peerIconCache.size > 64) {
      const oldest = peerIconCache.keys().next().value;
      peerIconCache.delete(oldest);
    }
    peerIconCache.set(key, url);
    return url;
  }

  function syncPeerTags(tags) {
    const seen = new Set();
    for (const tag of tags) {
      seen.add(tag.playerId);
      let element = peerTagElements.get(tag.playerId);
      if (!element) {
        element = doc.createElement('p');
        element.className = 'peer-tag';
        element.dataset.peerId = tag.playerId;
        peerOverlayLayer.append(element);
        peerTagElements.set(tag.playerId, element);
        element.style.setProperty('--hue', String(tag.hue));
      }
      const text = remoteBadgeElements.has(tag.playerId) && tag.name ? tag.name : tag.label;
      if (element.textContent !== text) element.textContent = text;
      placeInPanel(element, tag.x, tag.y);
    }
    for (const [playerId, element] of peerTagElements) {
      if (seen.has(playerId)) continue;
      element.remove();
      peerTagElements.delete(playerId);
    }
  }

  function syncPeerIcons(indicators, current) {
    const seen = new Set();
    for (const indicator of indicators) {
      seen.add(indicator.playerId);
      const element = remoteArrowElements.get(indicator.playerId);
      if (!element) continue;
      const url = current.peerIcons ? avatarThumbUrl(indicator.layer) : null;
      if (url) {
        element.classList.add('has-icon');
        element.style.setProperty('--peer-icon', `url("${url}")`);
      } else {
        element.classList.remove('has-icon');
        element.style.removeProperty('--peer-icon');
      }
    }
    for (const [playerId, element] of remoteArrowElements) {
      if (seen.has(playerId)) continue;
      element.classList.remove('has-icon');
      element.style.removeProperty('--peer-icon');
    }
  }

  function updateBattleHud(exports) {
    const count = typeof exports?.WasmBattleHudCount === 'function'
      ? (exports.WasmBattleHudCount() >>> 0)
      : 0;
    const seen = new Set();
    for (let battler = 0; battler < count; battler++) {
      if (!exports.WasmBattleHudVisible?.(battler)) continue;
      const hbX = Number(exports.WasmBattleHudX?.(battler) ?? 0);
      const hbY = Number(exports.WasmBattleHudY?.(battler) ?? 0);
      if (hbX < -40 || hbX > 260 || hbY < -20 || hbY > 170) continue;
      const side = Number(exports.WasmBattleHudSide?.(battler) ?? 0);
      const type1 = Number(exports.WasmBattleHudType1?.(battler) ?? 0);
      const type2 = Number(exports.WasmBattleHudType2?.(battler) ?? type1);
      const types = type1 === type2 ? [type1] : [type1, type2];
      const signature = `${side}:${types.join('/')}`;
      seen.add(battler);

      let container = battleHudElements.get(battler);
      if (!container) {
        container = doc.createElement('div');
        container.className = 'battle-hud-types';
        battleHudLayer.append(container);
        battleHudElements.set(battler, container);
      }
      if (container.dataset.signature !== signature) {
        container.dataset.signature = signature;
        container.dataset.side = side === 0 ? 'player' : 'opponent';
        container.replaceChildren();
        for (const typeId of types) {
          const info = EMERALD_TYPE_BADGES[typeId] ?? EMERALD_TYPE_BADGES[9];
          const pill = doc.createElement('span');
          pill.className = 'battle-type-badge';
          pill.textContent = info.label;
          pill.style.setProperty('--type-bg', info.bg);
          pill.style.setProperty('--type-border', info.border);
          if (info.text) pill.style.setProperty('--type-text', info.text);
          container.append(pill);
        }
      }
      // Place the type pills inside the healthbox's top row, right-aligned
      // just before the Lv label (x = hbX + 40 on player boxes, hbX + 32 on
      // opponent boxes) so they sit inside the frame instead of floating.
      const anchorX = side === 0 ? hbX + 38 : hbX + 30;
      const anchorY = hbY - 5;
      placeInPanel(container, anchorX, anchorY);
    }
    for (const [battler, element] of battleHudElements) {
      if (seen.has(battler)) continue;
      element.remove();
      battleHudElements.delete(battler);
    }
    battleHudLayer.hidden = seen.size === 0;
  }

  return {
    peerOverlayLayer,
    peerTagElements,
    battleHudLayer,
    battleHudElements,
    invalidateOverlayGeometry,
    updateRemoteBadges,
    syncPeerTags,
    syncPeerIcons,
    updateBattleHud,
  };
}
