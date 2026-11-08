#!/usr/bin/env node
// Build Emerald Kaizo from the hydrated .build/kaizo-worktree/pokeemerald-3d tree.
//
//   node game-packs/emerald-kaizo/build/build.mjs
//
// Uses the same MSYS2/Clang WASM pipeline as the Emerald pack.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KAIZO_SHARED_FROM_EMERALD_PATHS } from '../../../tools/save-upstream-patch.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const emeraldRoot = join(repo, 'pokeemerald-3d');
const pack = join(repo, 'game-packs', 'emerald-kaizo');
const worktree = join(repo, '.build', 'kaizo-worktree');
const gameRoot = join(worktree, 'pokeemerald-3d');
const manifest = JSON.parse(await readFile(join(pack, 'manifest.json'), 'utf8'));
const pinned = manifest.build.sourceRevision;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}

if (!(await exists(join(gameRoot, 'Makefile')))) {
  console.log('Kaizo source tree not yet hydrated; running tools/install-upstream.mjs...');
  run(process.execPath, [join(repo, 'tools', 'install-upstream.mjs')], { cwd: repo });
} else {
  for (const relPath of KAIZO_SHARED_FROM_EMERALD_PATHS) {
    const src = join(emeraldRoot, relPath);
    const dst = join(gameRoot, relPath);
    if (await exists(src)) {
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
    }
  }
}

if (process.platform === 'win32') {
  const shell = join(repo, '.toolchain', 'msys64', 'msys2_shell.cmd');
  run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `& '${shell.replaceAll("'", "''")}' -ucrt64 -defterm -no-start -here -c 'make -j$(nproc) wasm'`,
  ], {
    cwd: gameRoot,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
} else {
  run('make', ['-j4', 'wasm'], { cwd: gameRoot });
}

const built = join(gameRoot, 'build', 'wasm', 'pokeemerald.wasm');
const target = join(pack, 'dist', 'pokeemeraldkaizo.wasm');
await mkdir(dirname(target), { recursive: true });
await copyFile(built, target);

const mapNames = join(pack, 'dist', 'map-names.json');
run(process.execPath, [
  join(repo, 'pokeemerald-3d', 'tools', 'generate_map_names.mjs'),
  `--source=${join(gameRoot, 'include', 'constants', 'map_groups.h')}`,
  `--output=${mapNames}`,
], { cwd: repo, stdio: 'inherit' });

const regionMap = join(pack, 'dist', 'region-map.json');
run(process.execPath, [
  join(repo, 'pokeemerald-3d', 'tools', 'generate_region_map.mjs'),
  `--source=${gameRoot}`,
  '--game-id=emerald-kaizo',
  `--output=${regionMap}`,
], { cwd: repo, stdio: 'inherit' });

const regionMapArtSrc = join(gameRoot, 'graphics', 'pokenav', 'region_map', 'map.png');
const regionMapArtDest = join(pack, 'resources', 'hoenn-region-map.png');
if (await exists(regionMapArtSrc)) {
  await mkdir(dirname(regionMapArtDest), { recursive: true });
  await copyFile(regionMapArtSrc, regionMapArtDest);
}

const bytes = await readFile(target);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(join(pack, 'dist', 'build-info.json'), `${JSON.stringify({
  gameId: manifest.game.id,
  packVersion: manifest.game.packVersion,
  sourceRevision: pinned,
  upstream: manifest.build.upstream,
  runtimeModule: 'dist/pokeemeraldkaizo.wasm',
  runtimeSha256: sha256,
  runtimeBytes: bytes.length,
  builtAt: new Date().toISOString(),
}, null, 2)}\n`);
console.log(`Built ${target}`);
console.log(`sha256 ${sha256} (${bytes.length} bytes)`);
