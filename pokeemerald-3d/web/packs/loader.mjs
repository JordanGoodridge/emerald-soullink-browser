// Game-pack loader: validate a manifest, import its adapters, and verify
// external resources. The loader never boots the engine or touches the DOM;
// the composition root decides when to call the adapters.

import {
  findGame,
  loadIndex,
  PackError,
  resolveHref,
  summarizeManifestErrors,
} from './registry.mjs';
import { validateManifest } from './manifest-schema.mjs';

const PACK_DIRECTORY_RE = /\/$/;

function manifestDirectory(manifestUrl) {
  const url = new URL(manifestUrl);
  if (!PACK_DIRECTORY_RE.test(url.pathname)) {
    url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  }
  return url;
}

export function resolvePackModule(manifestUrl, relativePath) {
  const directory = manifestDirectory(manifestUrl);
  const resolved = new URL(relativePath, directory);
  if (resolved.origin !== directory.origin) {
    throw new PackError('path_escape', `pack: adapter path escapes the pack origin: ${relativePath}`);
  }
  if (!resolved.pathname.startsWith(directory.pathname)) {
    throw new PackError('path_escape', `pack: adapter path escapes the pack directory: ${relativePath}`);
  }
  return resolved.href;
}

export function resolveResourceUrl(manifestUrl, resource) {
  if (!resource?.url) throw new PackError('resource_invalid', 'pack: resource has no URL');
  if (resource.url.startsWith('/')) {
    const base = new URL(manifestUrl);
    return new URL(resource.url, base.origin).href;
  }
  return new URL(resource.url, manifestDirectory(manifestUrl)).href;
}

function normalizeDigest(value) {
  return String(value || '').replace(/^sha256:/i, '').toLowerCase();
}

async function sha256Hex(bytes, digestImpl) {
  if (digestImpl) return normalizeDigest(await digestImpl(bytes));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new PackError('digest_unavailable', 'pack: WebCrypto SHA-256 is unavailable');
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function fetchVerifiedResource(
  manifestUrl,
  resource,
  { fetchImpl = fetch, digestImpl = null, requireDigest = true } = {},
) {
  if (resource?.embedded) {
    throw new PackError('resource_embedded', `pack: ${resource.id ?? 'resource'} is embedded`);
  }
  const url = resolveResourceUrl(manifestUrl, resource);
  let response;
  try {
    response = await fetchImpl(url, { cache: 'no-store' });
  } catch (error) {
    throw new PackError('resource_unreachable', `pack: could not fetch ${url}`, { cause: error });
  }
  if (!response.ok) {
    throw new PackError('resource_unreachable', `pack: HTTP ${response.status} for ${url}`, {
      status: response.status,
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (resource.bytes !== undefined && bytes.byteLength > resource.bytes) {
    throw new PackError('resource_too_large', `pack: ${resource.id} is larger than the declared bound`);
  }
  const expected = normalizeDigest(resource.sha256);
  if (expected === 'pending') {
    if (requireDigest) throw new PackError('digest_pending', `pack: ${resource.id} digest is not generated`);
    return { url, bytes, verified: false };
  }
  if (requireDigest) {
    const actual = await sha256Hex(bytes, digestImpl);
    if (actual !== expected) {
      throw new PackError('digest_mismatch', `pack: ${resource.id} digest mismatch (expected ${expected}, got ${actual})`, {
        expected,
        actual,
      });
    }
  }
  return { url, bytes, verified: requireDigest };
}

async function fetchJson(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { cache: 'no-store' });
  } catch (error) {
    throw new PackError('manifest_unreachable', `pack: could not fetch ${url}`, { cause: error });
  }
  if (!response.ok) {
    throw new PackError('manifest_unreachable', `pack: HTTP ${response.status} for ${url}`, {
      status: response.status,
    });
  }
  try {
    return await response.json();
  } catch (error) {
    throw new PackError('manifest_invalid', `pack: invalid JSON at ${url}`, { cause: error });
  }
}

function requireFactory(module, name, packId) {
  if (!module || typeof module[name] !== 'function') {
    throw new PackError(
      'adapter_contract',
      `pack ${packId}: adapter must export ${name}()`,
      { export: name },
    );
  }
}

function capabilitySummary(manifest) {
  const capabilities = manifest?.capabilities ?? {};
  return {
    rendering: [...(capabilities.rendering ?? [])].sort(),
    presence: capabilities.presence,
    rules: capabilities.rules,
    link: capabilities.link,
    customUi: capabilities.customUi,
  };
}

function capabilitySummaryMatches(summary, manifest) {
  if (summary == null) return true;
  return JSON.stringify(capabilitySummary({ capabilities: summary }))
    === JSON.stringify(capabilitySummary(manifest));
}

export async function loadManifest({
  gameId,
  indexUrl = '/game-packs/index.json',
  baseUrl = globalThis.location?.href,
  fetchImpl = fetch,
  requireDigests = true,
} = {}) {
  const { index, indexUrl: resolvedIndexUrl } = await loadIndex({ indexUrl, baseUrl, fetchImpl });
  const resolvedGameId = gameId || index.default;
  const entry = findGame(index, resolvedGameId);
  if (!entry) {
    throw new PackError('unknown_game', `game ${resolvedGameId}: not installed`, { gameId: resolvedGameId });
  }
  const manifestUrl = resolveHref(entry.manifest, resolvedIndexUrl);
  const raw = await fetchJson(manifestUrl, fetchImpl);
  const validation = validateManifest(raw, { packId: entry.id, requireDigests });
  if (!validation.ok) {
    throw new PackError('manifest_invalid', summarizeManifestErrors(entry.id, validation.errors), {
      errors: validation.errors,
    });
  }
  if (!capabilitySummaryMatches(entry.capabilities, raw)) {
    throw new PackError(
      'capability_mismatch',
      `pack ${entry.id}: index capability summary does not match manifest capabilities`,
      { index: entry.capabilities, manifest: raw.capabilities },
    );
  }
  return { index, entry, manifest: raw, manifestUrl };
}

export async function loadPack({
  gameId,
  indexUrl = '/game-packs/index.json',
  baseUrl = globalThis.location?.href,
  fetchImpl = fetch,
  importModule = (url) => import(url),
  requireDigests = true,
  loadAdapters = true,
} = {}) {
  const loaded = await loadManifest({ gameId, indexUrl, baseUrl, fetchImpl, requireDigests });
  const { entry, manifest, manifestUrl } = loaded;

  if (!loadAdapters) return { ...loaded, adapters: null };

  const runtimeUrl = resolvePackModule(manifestUrl, manifest.runtime.adapter);
  const sceneUrl = resolvePackModule(manifestUrl, manifest.rendering.adapter);
  const savesUrl = resolvePackModule(manifestUrl, manifest.saves.codec);
  const worldUrl = manifest.multiplayer
    ? resolvePackModule(manifestUrl, manifest.multiplayer.adapter)
    : null;
  const runUrl = manifest.run
    ? resolvePackModule(manifestUrl, manifest.run.adapter)
    : null;
  const partyUrl = manifest.party
    ? resolvePackModule(manifestUrl, manifest.party.adapter)
    : null;
  const rulesUrl = manifest.nuzlocke?.support && manifest.nuzlocke.support !== 'none'
    ? resolvePackModule(manifestUrl, manifest.nuzlocke.adapter)
    : null;

  let runtime;
  let scene;
  let saves;
  let world = null;
  let run = null;
  let party = null;
  let rules = null;
  try {
    runtime = await importModule(runtimeUrl);
    scene = await importModule(sceneUrl);
    saves = await importModule(savesUrl);
    if (worldUrl) world = await importModule(worldUrl);
    if (runUrl) run = await importModule(runUrl);
    if (partyUrl) party = await importModule(partyUrl);
    if (rulesUrl) rules = await importModule(rulesUrl);
  } catch (error) {
    throw new PackError('adapter_import', `pack ${entry.id}: adapter import failed`, { cause: error });
  }

  requireFactory(runtime, 'createRuntime', entry.id);
  requireFactory(scene, 'createScene', entry.id);
  requireFactory(saves, 'createSaveCodec', entry.id);
  if (worldUrl) requireFactory(world, 'createWorldModel', entry.id);
  if (runUrl) requireFactory(run, 'createRunAdapter', entry.id);
  if (partyUrl) requireFactory(party, 'createPartyAdapter', entry.id);
  if (rulesUrl) requireFactory(rules, 'createRulesAdapter', entry.id);

  return {
    ...loaded,
    adapters: { runtime, scene, saves, world, run, party, rules },
    urls: { manifest: manifestUrl, runtime: runtimeUrl, scene: sceneUrl, saves: savesUrl, world: worldUrl, run: runUrl, party: partyUrl, rules: rulesUrl },
  };
}

export { PackError };
