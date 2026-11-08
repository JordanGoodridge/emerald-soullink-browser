#!/usr/bin/env node
// Saves all modifications made to upstream pokeemerald-wasm files inside
// pokeemerald-3d/ into patches/pokeemerald-wasm.patch, and saves Emerald Kaizo
// WASM modifications into patches/emerald-kaizo-wasm.patch.
//
// Files that are directly tracked as first-party code in the outer PokeTech
// repository (web/**, src/wasm_*.c, include/wasm/run.h, tools/*.mjs, etc.) are
// excluded from the patch because they live directly in Git or are copied from
// pokeemerald-3d/ during hydration.

import { spawnSync } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_REPO_URL = 'https://github.com/tripplyons/pokeemerald-wasm.git';
export const UPSTREAM_COMMIT = '6fa044ec5e8b948ed764ebdb80e5f2b6ce917e1c';

export const KAIZO_UPSTREAM_REPO_URL = 'https://github.com/CreamElDudJafar/Pokemon-Emerald-Kaizo.git';
export const KAIZO_UPSTREAM_COMMIT = '33d21d6f1141a98da84f52b2b661089555e8e480';

// First-party WASM files in pokeemerald-3d/ that are copied directly into the
// Kaizo worktree after checking out KAIZO_UPSTREAM_COMMIT.
export const KAIZO_SHARED_FROM_EMERALD_PATHS = [
  'include/wasm/run.h',
  'include/wasm/stdio.h',
  'include/wasm/stdlib.h',
  'include/wasm/string.h',
  'src/wasm_display.c',
  'src/wasm_field_effect_scripts.c',
  'src/wasm_m4a.c',
  'src/wasm_presence.c',
  'src/wasm_run.c',
  'src/wasm_run_debug.c',
  'tools/generate_map_names.mjs',
  'tools/generate_move_names.mjs',
  'tools/generate_region_map.mjs',
  'tools/generate_species_names.mjs',
  'tools/generate_wasm_assets.py',
  'tools/generate_wasm_sound.py',
  'tools/wasm_asm_data.py',
];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const gameRoot = join(repoRoot, 'pokeemerald-3d');
const upstreamGitDir = join(gameRoot, '.git-upstream');
const patchPath = join(repoRoot, 'patches', 'pokeemerald-wasm.patch');

const kaizoGameRoot = join(repoRoot, '.build', 'kaizo-worktree', 'pokeemerald-3d');
const kaizoUpstreamGitDir = join(repoRoot, '.build', 'kaizo-upstream.git');
const kaizoPatchPath = join(repoRoot, 'patches', 'emerald-kaizo-wasm.patch');

// Paths inside pokeemerald-3d/ that existed in upstream but are now owned and
// tracked directly by the outer PokeTech repo rather than patched.
export const OUTER_OWNED_UPSTREAM_PATHS = [
  '.gitignore',
  'docs/original-pokeemerald-readme.md',
  'tools/build_wrangler_site.mjs',
  'tools/test_building_rendering.mjs',
  'tools/wasm_replay.mjs',
  'trailer/README.md',
  'trailer/scripts/capture-gameplay.mjs',
  'web/app.js',
  'web/index.html',
  'web/presenter.js',
  'web/server.mjs',
  'web/style.css',
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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

export async function saveKaizoUpstreamPatch() {
  if (!(await exists(kaizoGameRoot)) || !(await exists(join(kaizoUpstreamGitDir, 'HEAD')))) {
    return null;
  }
  await rm(join(kaizoUpstreamGitDir, 'index'), { force: true });
  runGit(
    [
      `--git-dir=${kaizoUpstreamGitDir}`,
      `--work-tree=${kaizoGameRoot}`,
      'read-tree',
      KAIZO_UPSTREAM_COMMIT,
    ],
    { cwd: kaizoGameRoot },
  );

  const excludeSpecs = [
    ':(exclude).gitignore',
    ':(exclude)README.md',
    ...KAIZO_SHARED_FROM_EMERALD_PATHS.map((p) => `:(exclude)${p}`),
  ];
  const rawDiff = runGit(
    [
      `--git-dir=${kaizoUpstreamGitDir}`,
      `--work-tree=${kaizoGameRoot}`,
      '-c', 'core.fileMode=false',
      '-c', 'core.autocrlf=false',
      'diff',
      '--diff-filter=M',
      KAIZO_UPSTREAM_COMMIT,
      '--',
      '.',
      ...excludeSpecs,
    ],
    { cwd: kaizoGameRoot },
  );

  const normalized = rawDiff.replace(/\r\n/g, '\n');
  await mkdir(dirname(kaizoPatchPath), { recursive: true });
  await writeFile(kaizoPatchPath, normalized, 'utf8');

  const changedFiles = normalized
    .split('\n')
    .filter((line) => line.startsWith('diff --git '))
    .map((line) => line.replace(/^diff --git a\/(\S+) b\/\S+$/, '$1'));

  return { patchPath: kaizoPatchPath, changedFiles, bytes: Buffer.byteLength(normalized, 'utf8') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { changedFiles, bytes } = await saveUpstreamPatch();
  console.log(`Saved patches/pokeemerald-wasm.patch (${changedFiles.length} files, ${bytes} bytes):`);
  for (const file of changedFiles) {
    console.log(`  ${file}`);
  }
  const kaizoResult = await saveKaizoUpstreamPatch();
  if (kaizoResult) {
    console.log(`Saved patches/emerald-kaizo-wasm.patch (${kaizoResult.changedFiles.length} files, ${kaizoResult.bytes} bytes):`);
    for (const file of kaizoResult.changedFiles) {
      console.log(`  ${file}`);
    }
  }
}
