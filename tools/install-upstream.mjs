#!/usr/bin/env node
// Installs the upstream tripplyons/pokeemerald-wasm source tree into
// pokeemerald-3d/ at its pinned revision and applies patches/pokeemerald-wasm.patch
// without overwriting first-party PokeTech files.
//
// Usage:
//   node tools/install-upstream.mjs [--verify] [--force]

import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTER_OWNED_UPSTREAM_PATHS,
  UPSTREAM_COMMIT,
  UPSTREAM_REPO_URL,
} from './save-upstream-patch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const gameRoot = join(repoRoot, 'pokeemerald-3d');
const upstreamGitDir = join(gameRoot, '.git-upstream');
const patchPath = join(repoRoot, 'patches', 'pokeemerald-wasm.patch');

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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verifyOnly = process.argv.includes('--verify');
  await installUpstream({ verifyOnly });
}
