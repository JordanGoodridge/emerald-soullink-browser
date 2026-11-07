#!/usr/bin/env node
// Saves all modifications made to upstream pokeemerald-wasm files inside
// pokeemerald-3d/ into patches/pokeemerald-wasm.patch.
//
// Files that are directly tracked as first-party code in the outer PokeTech
// repository (web/**, src/wasm_*.c, include/wasm/run.h, tools/*.mjs, etc.) are
// excluded from the patch because they live directly in Git.

import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_REPO_URL = 'https://github.com/tripplyons/pokeemerald-wasm.git';
export const UPSTREAM_COMMIT = '6fa044ec5e8b948ed764ebdb80e5f2b6ce917e1c';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const gameRoot = join(repoRoot, 'pokeemerald-3d');
const upstreamGitDir = join(gameRoot, '.git-upstream');
const patchPath = join(repoRoot, 'patches', 'pokeemerald-wasm.patch');

// Paths inside pokeemerald-3d/ that existed in upstream but are now owned and
// tracked directly by the outer PokeTech repo rather than patched.
export const OUTER_OWNED_UPSTREAM_PATHS = [
  '.gitignore',
  'tools/test_building_rendering.mjs',
  'tools/wasm_replay.mjs',
  'trailer/README.md',
  'web/app.js',
  'web/index.html',
  'web/presenter.js',
  'web/server.mjs',
  'web/style.css',
];

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: gameRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export async function saveUpstreamPatch() {
  const excludeSpecs = OUTER_OWNED_UPSTREAM_PATHS.map((p) => `:(exclude)${p}`);
  const rawDiff = runGit([
    `--git-dir=${upstreamGitDir}`,
    `--work-tree=${gameRoot}`,
    '-c', 'core.autocrlf=false',
    'diff',
    '--binary',
    UPSTREAM_COMMIT,
    '--',
    '.',
    ...excludeSpecs,
  ]);

  // Normalize CRLF -> LF so the patch applies cleanly across Windows/Linux/macOS
  const normalized = rawDiff.replace(/\r\n/g, '\n');
  await mkdir(dirname(patchPath), { recursive: true });
  await writeFile(patchPath, normalized, 'utf8');

  const changedFiles = normalized
    .split('\n')
    .filter((line) => line.startsWith('diff --git '))
    .map((line) => line.replace(/^diff --git a\/(\S+) b\/\S+$/, '$1'));

  return { patchPath, changedFiles, bytes: Buffer.byteLength(normalized, 'utf8') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { changedFiles, bytes } = await saveUpstreamPatch();
  console.log(`Saved patches/pokeemerald-wasm.patch (${changedFiles.length} files, ${bytes} bytes):`);
  for (const file of changedFiles) {
    console.log(`  ${file}`);
  }
}
