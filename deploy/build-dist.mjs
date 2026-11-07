// Assembles the static deployment bundle for the multi-game shell.
//
//   node deploy/build-dist.mjs [--dist=<output-directory>] [--include-hidden]
//
// The game packager (tools/build_game_packs.mjs) owns manifests, adapters,
// resources and digests. This script owns the shell assets: index.html and
// web/**.

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const game = join(repo, 'pokeemerald-3d');
const distArg = process.argv.find((arg) => arg.startsWith('--dist='));
const dist = distArg ? resolve(repo, distArg.slice('--dist='.length)) : join(game, 'dist');

const SKIP = new Set(['server.mjs']);

function isTest(name) {
  return name.endsWith('.test.mjs') || name.endsWith('.test.js');
}

async function copyTree(from, to, filter) {
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
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

async function requireFile(path, hint) {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`Missing ${relative(repo, path)}. ${hint}`);
  }
}

await requireFile(join(game, 'build', 'wasm', 'pokeemerald.wasm'), 'Run .\\build-wasm.ps1 first.');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await copyFile(join(game, 'web', 'index.html'), join(dist, 'index.html'));
const regionMapImage = join(game, 'graphics', 'pokenav', 'region_map', 'map.png');
await requireFile(regionMapImage, 'The friends map needs the original Emerald region-map image.');
await mkdir(join(dist, 'graphics', 'pokenav', 'region_map'), { recursive: true });
await copyFile(regionMapImage, join(dist, 'graphics', 'pokenav', 'region_map', 'map.png'));
await copyTree(
  join(game, 'graphics', 'pokemon'),
  join(dist, 'graphics', 'pokemon'),
  (name) => name === 'front.png',
);
await copyTree(
  join(game, 'web'),
  join(dist, 'web'),
  (name) => !SKIP.has(name) && !isTest(name) && /\.(js|mjs|css|html|md|svg|woff2?|ttf|otf)$/.test(name),
);
await requireFile(join(dist, 'web', 'pokeball-loader.svg'), 'The initial library loader needs its Poké Ball sprite.');

const packagerArgs = [join(repo, 'tools', 'build_game_packs.mjs'), `--dist=${dist}`];
if (process.argv.includes('--include-hidden')) packagerArgs.push('--include-hidden');
const packaged = spawnSync(
  process.execPath,
  packagerArgs,
  { cwd: repo, stdio: 'inherit', env: { ...process.env, POKETECH_DIST_DIR: dist } },
);
if (packaged.status !== 0) {
  throw new Error('game pack packaging failed');
}

const files = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collect(full);
    else files.push(relative(dist, full).replaceAll('\\', '/'));
  }
}
await collect(dist);

console.log(`Assembled ${files.length} assets in ${relative(repo, dist)}`);
if (process.argv.includes('--verbose')) {
  for (const file of files.sort()) console.log(`  ${file}`);
}
