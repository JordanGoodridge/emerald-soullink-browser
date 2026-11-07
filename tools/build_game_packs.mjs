#!/usr/bin/env node
// Assemble installed game packs into pokeemerald-3d/dist.
//
// - copies each pack's manifest/adapters/resources into a versioned directory
// - rewrites pack URLs to the packaged layout
// - computes real SHA-256 digests
// - writes dist/game-packs/index.json
// - never copies ROMs, patches or reference saves
//
//   node tools/build_game_packs.mjs [--include-hidden]

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateManifest,
  validatePackIndex,
} from '../pokeemerald-3d/web/packs/manifest-schema.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const game = join(repo, 'pokeemerald-3d');
const distArg = process.argv.find((arg) => arg.startsWith('--dist='));
const dist = distArg
  ? resolve(repo, distArg.slice('--dist='.length))
  : process.env.POKETECH_DIST_DIR
    ? resolve(repo, process.env.POKETECH_DIST_DIR)
    : join(game, 'dist');
const packsRoot = join(repo, 'game-packs');
const includeHidden = process.argv.includes('--include-hidden');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(from, to, filter = () => true) {
  if (!(await exists(from))) return;
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, target, filter);
      continue;
    }
    if (!filter(entry.name)) continue;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

function isTestModule(name) {
  return name.endsWith('.test.mjs') || name.endsWith('.test.js');
}

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

function rootRelative(url) {
  return url.startsWith('/') && !url.startsWith('//');
}

// Pack data is generated from the pinned game source immediately before
// packaging, so a clean checkout does not need to track build outputs.
const mapGeneration = spawnSync(process.execPath, [join(game, 'tools', 'generate_region_map.mjs')], {
  cwd: game,
  encoding: 'utf8',
});
if (mapGeneration.status !== 0) {
  throw new Error(`region map generation failed: ${mapGeneration.stderr || mapGeneration.stdout}`);
}

const index = await readJson(join(packsRoot, 'index.json'));
const indexResult = validatePackIndex(index);
if (!indexResult.ok) {
  throw new Error(`invalid game-packs/index.json: ${JSON.stringify(indexResult.errors)}`);
}

const packagedGames = [];
for (const entry of index.games) {
  if (entry.hidden && !includeHidden) continue;
  const manifestPath = join(packsRoot, ...entry.manifest.split('/'));
  const manifest = await readJson(manifestPath);
  const result = validateManifest(manifest, { packId: entry.id, requireDigests: false });
  if (!result.ok) {
    throw new Error(`invalid manifest for ${entry.id}: ${JSON.stringify(result.errors)}`);
  }

  const outDir = join(dist, 'packs', entry.id, entry.packVersion);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await copyTree(
    join(packsRoot, entry.id, 'adapter'),
    join(outDir, 'adapter'),
    (name) => !isTestModule(name),
  );
  // fixtures are source-only test vectors and never ship in the static bundle.
  if (await exists(join(packsRoot, entry.id, 'README.md'))) {
    await copyFile(join(packsRoot, entry.id, 'README.md'), join(outDir, 'README.md'));
  }
  let packagedCover = null;
  if (entry.cover) {
    const coverName = entry.cover.split('/').pop();
    const coverSource = join(packsRoot, ...entry.cover.split('/'));
    if (await exists(coverSource)) {
      await copyFile(coverSource, join(outDir, coverName));
      packagedCover = `/packs/${entry.id}/${entry.packVersion}/${coverName}`;
    }
  }

  const packaged = structuredClone(manifest);
  const resources = [];
  for (const resource of packaged.resources ?? []) {
    if (resource.embedded) {
      resources.push(resource);
      continue;
    }
    let source;
    let targetUrl = resource.url;
    if (rootRelative(resource.url)) {
      source = join(game, resource.url.slice(1));
      if (resource.url.startsWith('/build/')) {
        targetUrl = `dist/${resource.url.split('/').pop()}`;
      }
    } else {
      source = join(packsRoot, entry.id, ...resource.url.split('/'));
      targetUrl = resource.url;
    }
    if (!(await exists(source))) {
      throw new Error(`${entry.id}: missing resource ${resource.url} at ${relative(repo, source)}`);
    }
    // Root-relative avatar assets stay at the origin root so the shared atlas
    // loader can fetch them from the packaged bundle. Build resources move
    // into the versioned pack directory.
    const target = rootRelative(resource.url) && !resource.url.startsWith('/build/')
      ? join(dist, resource.url.slice(1))
      : join(outDir, ...targetUrl.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    resources.push({ ...resource, url: targetUrl, sha256: await sha256(target) });
  }
  packaged.resources = resources;

  const moduleResource = packaged.runtime.module;
  const moduleMatch = resources.find((resource) => resource.id === moduleResource.id);
  if (moduleMatch) packaged.runtime.module = { ...moduleResource, ...moduleMatch };

  if (packaged.runtime.module.url) packaged.build.artifact = packaged.runtime.module.url;
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(packaged, null, 2)}\n`);
  await writeFile(join(outDir, 'build-info.json'), `${JSON.stringify({
    gameId: entry.id,
    packVersion: entry.packVersion,
    builtAt: new Date().toISOString(),
    runtimeModule: packaged.runtime.module.url,
    runtimeSha256: packaged.runtime.module.sha256,
  }, null, 2)}\n`);

  packagedGames.push({
    id: entry.id,
    title: entry.title,
    packVersion: entry.packVersion,
    manifest: `/packs/${entry.id}/${entry.packVersion}/manifest.json`,
    ...(packagedCover ? { cover: packagedCover } : {}),
    summary: entry.summary ?? '',
    hidden: Boolean(entry.hidden),
    capabilities: entry.capabilities ?? null,
  });
}

await mkdir(join(dist, 'game-packs'), { recursive: true });
await writeFile(join(dist, 'game-packs', 'index.json'), `${JSON.stringify({
  schemaVersion: 1,
  default: index.default,
  games: packagedGames,
}, null, 2)}\n`);

console.log(`Packaged ${packagedGames.length} game(s) into ${relative(repo, dist)}`);
for (const game of packagedGames) console.log(`  ${game.id} ${game.packVersion} -> ${game.manifest}`);
