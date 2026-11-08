#!/usr/bin/env node
// Installs the upstream tripplyons/pokeemerald-wasm source tree into
// pokeemerald-3d/ at its pinned revision and applies patches/pokeemerald-wasm.patch
// without overwriting first-party PokeTech files.
//
// Usage:
//   node tools/install-upstream.mjs [--verify] [--force]

import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KAIZO_SHARED_FROM_EMERALD_PATHS,
  KAIZO_UPSTREAM_COMMIT,
  KAIZO_UPSTREAM_REPO_URL,
  OUTER_OWNED_UPSTREAM_PATHS,
  UPSTREAM_COMMIT,
  UPSTREAM_REPO_URL,
} from './save-upstream-patch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const gameRoot = join(repoRoot, 'pokeemerald-3d');
const upstreamGitDir = join(gameRoot, '.git-upstream');
const patchPath = join(repoRoot, 'patches', 'pokeemerald-wasm.patch');

const kaizoWorktreeRoot = join(repoRoot, '.build', 'kaizo-worktree');
const kaizoGameRoot = join(kaizoWorktreeRoot, 'pokeemerald-3d');
const kaizoUpstreamGitDir = join(repoRoot, '.build', 'kaizo-upstream.git');
const kaizoPatchPath = join(repoRoot, 'patches', 'emerald-kaizo-wasm.patch');

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
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

async function ensureUpstreamRepo() {
  await mkdir(gameRoot, { recursive: true });
  const hasCommit =
    (await exists(join(upstreamGitDir, 'HEAD'))) &&
    runGit(
      [`--git-dir=${upstreamGitDir}`, 'cat-file', '-e', `${UPSTREAM_COMMIT}^{commit}`],
      { allowFailure: true },
    ).status === 0;

  if (hasCommit) {
    return;
  }

  console.log(`Fetching upstream ${UPSTREAM_REPO_URL} @ ${UPSTREAM_COMMIT.slice(0, 8)}...`);
  await mkdir(upstreamGitDir, { recursive: true });
  if (!(await exists(join(upstreamGitDir, 'HEAD')))) {
    runGit(['init', '--bare', upstreamGitDir]);
  }
  const remotes = runGit([`--git-dir=${upstreamGitDir}`, 'remote']).stdout.split(/\r?\n/);
  if (remotes.includes('origin')) {
    runGit([`--git-dir=${upstreamGitDir}`, 'remote', 'set-url', 'origin', UPSTREAM_REPO_URL]);
  } else {
    runGit([`--git-dir=${upstreamGitDir}`, 'remote', 'add', 'origin', UPSTREAM_REPO_URL]);
  }
  runGit(
    [`--git-dir=${upstreamGitDir}`, 'fetch', '--depth', '1', 'origin', UPSTREAM_COMMIT],
    { stdio: 'inherit' },
  );
  runGit([`--git-dir=${upstreamGitDir}`, 'update-ref', 'HEAD', UPSTREAM_COMMIT]);
}

function checkoutUpstreamTree() {
  const excludeSpecs = OUTER_OWNED_UPSTREAM_PATHS.map((p) => `:(exclude)${p}`);
  runGit([
    `--git-dir=${upstreamGitDir}`,
    `--work-tree=${gameRoot}`,
    '-c', 'core.autocrlf=false',
    'checkout',
    '-f',
    UPSTREAM_COMMIT,
    '--',
    '.',
    ...excludeSpecs,
  ]);
}

function applyUpstreamPatch({ checkOnly = false } = {}) {
  const args = [
    `--git-dir=${upstreamGitDir}`,
    `--work-tree=${gameRoot}`,
    '-c', 'core.autocrlf=false',
    'apply',
    '--whitespace=nowarn',
  ];
  if (checkOnly) args.push('--check');
  args.push(patchPath);
  runGit(args);
}

async function hydrateDerivedResources() {
  const regionMapSrc = join(gameRoot, 'graphics', 'pokenav', 'region_map', 'map.png');
  const regionMapDest = join(repoRoot, 'game-packs', 'emerald', 'resources', 'hoenn-region-map.png');
  if (await exists(regionMapSrc)) {
    await mkdir(dirname(regionMapDest), { recursive: true });
    await copyFile(regionMapSrc, regionMapDest);
  }

  const generators = [
    [join(gameRoot, 'tools', 'generate_species_names.mjs')],
    [join(gameRoot, 'tools', 'generate_move_names.mjs')],
    [join(gameRoot, 'tools', 'generate_map_names.mjs')],
    [join(gameRoot, 'tools', 'generate_region_map.mjs')],
  ];
  for (const [script] of generators) {
    if (!(await exists(script))) continue;
    const res = spawnSync(process.execPath, [script], {
      cwd: gameRoot,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`${script} failed: ${res.stderr || res.stdout}`);
    }
  }
}

export async function installKaizoUpstream({ verifyOnly = false } = {}) {
  await mkdir(kaizoGameRoot, { recursive: true });
  await mkdir(kaizoUpstreamGitDir, { recursive: true });

  if (!(await exists(join(kaizoUpstreamGitDir, 'HEAD')))) {
    runGit(['init', '--bare', kaizoUpstreamGitDir]);
  }

  // Share objects with outer .git if the commit is already present locally
  const outerGitObjects = join(repoRoot, '.git', 'objects');
  if (
    (await exists(outerGitObjects)) &&
    runGit(
      [`--git-dir=${join(repoRoot, '.git')}`, 'cat-file', '-e', `${KAIZO_UPSTREAM_COMMIT}^{commit}`],
      { allowFailure: true },
    ).status === 0
  ) {
    const alternatesPath = join(kaizoUpstreamGitDir, 'objects', 'info', 'alternates');
    await mkdir(dirname(alternatesPath), { recursive: true });
    await writeFile(alternatesPath, `${outerGitObjects.replace(/\\/g, '/')}\n`, 'utf8');
  }

  const hasKaizoCommit =
    runGit(
      [`--git-dir=${kaizoUpstreamGitDir}`, 'cat-file', '-e', `${KAIZO_UPSTREAM_COMMIT}^{commit}`],
      { allowFailure: true },
    ).status === 0;

  if (!hasKaizoCommit) {
    console.log(`Fetching upstream ${KAIZO_UPSTREAM_REPO_URL} @ ${KAIZO_UPSTREAM_COMMIT.slice(0, 8)}...`);
    const remotes = runGit([`--git-dir=${kaizoUpstreamGitDir}`, 'remote']).stdout.split(/\r?\n/);
    if (remotes.includes('origin')) {
      runGit([`--git-dir=${kaizoUpstreamGitDir}`, 'remote', 'set-url', 'origin', KAIZO_UPSTREAM_REPO_URL]);
    } else {
      runGit([`--git-dir=${kaizoUpstreamGitDir}`, 'remote', 'add', 'origin', KAIZO_UPSTREAM_REPO_URL]);
    }
    runGit(
      [`--git-dir=${kaizoUpstreamGitDir}`, 'fetch', '--depth', '1', 'origin', KAIZO_UPSTREAM_COMMIT],
      { stdio: 'inherit' },
    );
  }
  runGit([`--git-dir=${kaizoUpstreamGitDir}`, 'update-ref', 'HEAD', KAIZO_UPSTREAM_COMMIT]);

  console.log(`Checking out Emerald Kaizo upstream tree (${KAIZO_UPSTREAM_COMMIT.slice(0, 8)}) into .build/kaizo-worktree/pokeemerald-3d/...`);
  runGit(
    [
      `--git-dir=${kaizoUpstreamGitDir}`,
      `--work-tree=${kaizoGameRoot}`,
      '-c', 'core.fileMode=false',
      '-c', 'core.autocrlf=false',
      'checkout',
      '-f',
      KAIZO_UPSTREAM_COMMIT,
      '--',
      '.',
    ],
    { cwd: kaizoGameRoot },
  );

  for (const unusedAsm of ['src/crt0.s', 'src/libgcnmultiboot.s', 'src/rom_header.s']) {
    await rm(join(kaizoGameRoot, unusedAsm), { force: true });
  }

  if (verifyOnly) {
    console.log('Verifying patches/emerald-kaizo-wasm.patch applies cleanly...');
    runGit(
      [
        `--git-dir=${kaizoUpstreamGitDir}`,
        `--work-tree=${kaizoGameRoot}`,
        '-c', 'core.autocrlf=false',
        'apply',
        '--whitespace=nowarn',
        '--check',
        kaizoPatchPath,
      ],
      { cwd: kaizoGameRoot },
    );
  }
  console.log('Applying patches/emerald-kaizo-wasm.patch...');
  runGit(
    [
      `--git-dir=${kaizoUpstreamGitDir}`,
      `--work-tree=${kaizoGameRoot}`,
      '-c', 'core.autocrlf=false',
      'apply',
      '--whitespace=nowarn',
      kaizoPatchPath,
    ],
    { cwd: kaizoGameRoot },
  );

  for (const relPath of KAIZO_SHARED_FROM_EMERALD_PATHS) {
    const src = join(gameRoot, relPath);
    const dst = join(kaizoGameRoot, relPath);
    if (await exists(src)) {
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
    }
  }

  const kaizoDistDir = join(repoRoot, 'game-packs', 'emerald-kaizo', 'dist');
  const kaizoResourcesDir = join(repoRoot, 'game-packs', 'emerald-kaizo', 'resources');
  await mkdir(kaizoDistDir, { recursive: true });
  await mkdir(kaizoResourcesDir, { recursive: true });

  const regionMapSrc = join(kaizoGameRoot, 'graphics', 'pokenav', 'region_map', 'map.png');
  if (await exists(regionMapSrc)) {
    await copyFile(regionMapSrc, join(kaizoResourcesDir, 'hoenn-region-map.png'));
  }

  const kaizoMapGroupsH = join(kaizoGameRoot, 'include', 'constants', 'map_groups.h');
  const mapGroupsSource = (await exists(kaizoMapGroupsH))
    ? kaizoMapGroupsH
    : join(gameRoot, 'include', 'constants', 'map_groups.h');

  const kaizoGenerators = [
    ...(await exists(mapGroupsSource)
      ? [[
          join(gameRoot, 'tools', 'generate_map_names.mjs'),
          `--source=${mapGroupsSource}`,
          `--output=${join(kaizoDistDir, 'map-names.json')}`,
        ]]
      : []),
    [
      join(gameRoot, 'tools', 'generate_region_map.mjs'),
      `--source=${kaizoGameRoot}`,
      `--output=${join(kaizoDistDir, 'region-map.json')}`,
      '--game-id=emerald-kaizo',
    ],
  ];
  for (const args of kaizoGenerators) {
    const res = spawnSync(process.execPath, args, {
      cwd: gameRoot,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`${args[0]} failed: ${res.stderr || res.stdout}`);
    }
  }
  console.log('Upstream Pokemon-Emerald-Kaizo hydrated and patched successfully.');
}

export async function installUpstream({ verifyOnly = false } = {}) {
  await ensureUpstreamRepo();
  console.log(`Checking out upstream tree (${UPSTREAM_COMMIT.slice(0, 8)}) into pokeemerald-3d/...`);
  checkoutUpstreamTree();
  if (verifyOnly) {
    console.log('Verifying patches/pokeemerald-wasm.patch applies cleanly...');
    applyUpstreamPatch({ checkOnly: true });
  }
  console.log('Applying patches/pokeemerald-wasm.patch...');
  applyUpstreamPatch({ checkOnly: false });
  await hydrateDerivedResources();
  console.log('Upstream pokeemerald-wasm hydrated and patched successfully.');
  await installKaizoUpstream({ verifyOnly });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verifyOnly = process.argv.includes('--verify');
  await installUpstream({ verifyOnly });
}
