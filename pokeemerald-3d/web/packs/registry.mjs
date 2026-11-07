// Game-pack registry: find, validate and resolve installed games.
//
// Pure URL/JSON logic with injected fetch. No DOM, storage, WASM or dynamic
// import happens here; the loader owns adapter imports.

import {
  formatValidationErrors,
  validateManifest,
  validatePackIndex,
} from './manifest-schema.mjs';

export class PackError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PackError';
    this.code = code;
    this.details = details;
  }
}

function baseHref(baseUrl) {
  if (typeof baseUrl === 'string' && baseUrl) return baseUrl;
  return globalThis.location?.href ?? 'http://localhost/';
}

export function resolveHref(path, baseUrl) {
  return new URL(path, baseHref(baseUrl)).href;
}

export function packManifestUrl(index, indexUrl, gameId) {
  const entry = index.games.find((game) => game.id === gameId);
  if (!entry) throw new PackError('unknown_game', `game ${gameId}: not installed`, { gameId });
  return resolveHref(entry.manifest, indexUrl);
}

export async function loadIndex({
  indexUrl = '/game-packs/index.json',
  baseUrl = globalThis.location?.href,
  fetchImpl = fetch,
} = {}) {
  const url = resolveHref(indexUrl, baseUrl);
  let response;
  try {
    response = await fetchImpl(url, { cache: 'no-store' });
  } catch (error) {
    throw new PackError('index_unreachable', `game index: could not fetch ${url}`, { cause: error });
  }
  if (!response.ok) {
    throw new PackError('index_unreachable', `game index: HTTP ${response.status} for ${url}`, {
      status: response.status,
    });
  }
  let value;
  try {
    value = await response.json();
  } catch (error) {
    throw new PackError('index_invalid', `game index: invalid JSON at ${url}`, { cause: error });
  }
  const result = validatePackIndex(value);
  if (!result.ok) {
    throw new PackError('index_invalid', `game index: invalid\n${result.errors
      .map((error) => `${error.path || 'index'} ${error.message}`)
      .join('\n')}`, { errors: result.errors });
  }
  return { index: value, indexUrl: url };
}

export function findGame(index, gameId) {
  return index.games.find((game) => game.id === gameId) ?? null;
}

export function defaultGameId(index) {
  return index.default;
}

export function listGames(index) {
  return index.games.map((game) => ({
    id: game.id,
    title: game.title,
    packVersion: game.packVersion,
    manifest: game.manifest,
    summary: game.summary ?? '',
    hidden: Boolean(game.hidden),
    cover: game.cover ?? null,
    capabilities: game.capabilities ?? null,
  }));
}

// A game switch is a reload. Preserve durable settings and the current save
// profile, but drop session-scoped room parameters so the next game cannot
// auto-join an incompatible room.
export function gameUrl(href, gameId, mode = 'standard') {
  const url = new URL(href);
  if (gameId) url.searchParams.set('game', gameId);
  else url.searchParams.delete('game');
  url.searchParams.delete('mode');
  url.searchParams.delete('pregame');
  url.searchParams.delete('lobby');
  if (['standard', 'nuzlocke', 'soullink'].includes(mode)) url.searchParams.set('mode', mode);
  url.searchParams.delete('library');
  url.searchParams.delete('presence');
  url.searchParams.delete('presenceAuto');
  url.searchParams.delete('presenceRoom');
  return url.toString();
}

export function libraryUrl(href) {
  const url = new URL(href);
  url.searchParams.delete('game');
  url.searchParams.delete('automate');
  url.searchParams.delete('presence');
  url.searchParams.delete('presenceAuto');
  url.searchParams.delete('presenceRoom');
  url.searchParams.delete('mode');
  url.searchParams.delete('pregame');
  url.searchParams.delete('lobby');
  return url.toString();
}

export function createPackRegistry({
  indexUrl = '/game-packs/index.json',
  baseUrl = globalThis.location?.href,
  fetchImpl = fetch,
} = {}) {
  let cached = null;

  async function getIndex() {
    cached ??= loadIndex({ indexUrl, baseUrl, fetchImpl });
    return cached;
  }

  return {
    async load() {
      return getIndex();
    },
    async games() {
      const { index } = await getIndex();
      return listGames(index);
    },
    async manifestUrl(gameId) {
      const { index, indexUrl: resolvedIndexUrl } = await getIndex();
      return packManifestUrl(index, resolvedIndexUrl, gameId);
    },
    async defaultGame() {
      const { index } = await getIndex();
      return defaultGameId(index);
    },
  };
}

export function summarizeManifestErrors(packId, errors) {
  return formatValidationErrors(packId, errors);
}

export { validateManifest };
