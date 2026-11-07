#!/usr/bin/env node
// Build Emerald Kaizo from the pinned pack branch worktree.
//
//   node game-packs/emerald-kaizo/build/build.mjs
//
// The pack branch is expected at .build/kaizo-worktree and must be at the
// manifest's sourceRevision. The build uses the same MSYS2/Clang WASM pipeline
// as the Emerald pack.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pack = join(repo, 'game-packs', 'emerald-kaizo');
const worktree = join(repo, '.build', 'kaizo-worktree');
const gameRoot = join(worktree, 'pokeemerald-3d');
const manifest = JSON.parse(await readFile(join(pack, 'manifest.json'), 'utf8'));
const pinned = manifest.build.sourceRevision;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}

const head = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: worktree,
  encoding: 'utf8',
});
if (head.status !== 0) throw new Error('Kaizo worktree is missing; create .build/kaizo-worktree first');
if (head.stdout.trim() !== pinned) {
  throw new Error(`Kaizo worktree is at ${head.stdout.trim()}, expected ${pinned}`);
}

if (process.platform === 'win32') {
  const shell = join(repo, '.toolchain', 'msys64', 'msys2_shell.cmd');
  run(shell, ['-ucrt64', '-defterm', '-no-start', '-here', '-c', 'make wasm'], {
    cwd: gameRoot,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
} else {
  run('make', ['wasm'], { cwd: gameRoot });
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
