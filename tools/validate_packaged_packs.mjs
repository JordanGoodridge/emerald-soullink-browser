#!/usr/bin/env node
// Validate the packaged dist: manifests, digests, artifacts and forbidden files.
//
//   node tools/validate_packaged_packs.mjs

import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateManifest,
  validatePackIndex,
} from '../pokeemerald-3d/web/packs/manifest-schema.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distArg = process.argv.find((arg) => arg.startsWith('--dist='));
const dist = distArg
  ? resolve(repo, distArg.slice('--dist='.length))
  : process.env.POKETECH_DIST_DIR
  ? resolve(repo, process.env.POKETECH_DIST_DIR)
  : join(repo, 'pokeemerald-3d', 'dist');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function fileFor(manifestPath, url) {
  if (url.startsWith('/')) return join(dist, url.slice(1));
  return join(dirname(manifestPath), ...url.split('/'));
}

const errors = [];
const allowedSaveTemplates = new Set();
const indexPath = join(dist, 'game-packs', 'index.json');
if (!(await exists(indexPath))) {
  console.error('packaged index missing; run node deploy/build-dist.mjs first');
  process.exit(1);
}
const index = JSON.parse(await readFile(indexPath, 'utf8'));
const indexResult = validatePackIndex(index);
if (!indexResult.ok) errors.push(`index: ${JSON.stringify(indexResult.errors)}`);

for (const entry of index.games ?? []) {
  const manifestPath = join(dist, ...entry.manifest.slice(1).split('/'));
  if (!(await exists(manifestPath))) {
    errors.push(`${entry.id}: manifest missing at ${relative(repo, manifestPath)}`);
    continue;
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const result = validateManifest(manifest, { packId: entry.id, requireDigests: true });
  if (!result.ok) {
    errors.push(`${entry.id}: ${JSON.stringify(result.errors)}`);
    continue;
  }
  for (const resource of manifest.resources ?? []) {
    if (resource.embedded) continue;
    const path = fileFor(manifestPath, resource.url);
    if (resource.id === manifest.run?.quickStartBaseResource && resource.kind === 'data') {
      allowedSaveTemplates.add(relative(dist, path));
    }
    if (!(await exists(path))) {
      errors.push(`${entry.id}: resource missing at ${relative(repo, path)}`);
      continue;
    }
    const actual = await sha256(path);
    if (actual !== resource.sha256) {
      errors.push(`${entry.id}: digest mismatch for ${resource.id}: ${actual} != ${resource.sha256}`);
    }
  }
  if (!manifest.runtime.module.embedded) {
    const modulePath = fileFor(manifestPath, manifest.runtime.module.url);
    if (!(await exists(modulePath))) {
      errors.push(`${entry.id}: runtime module missing at ${relative(repo, modulePath)}`);
    }
  }
}

const forbidden = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    const relativePath = relative(dist, full);
    if (relativePath.startsWith(`packs${sep}`) && /\.test\.(mjs|js)$/i.test(entry.name)) {
      forbidden.push(relativePath);
    }
    if (/\.(gba|gbc|ips|bps|ups|sav|srm|pat)$/i.test(entry.name)
      && !allowedSaveTemplates.has(relativePath)) {
      forbidden.push(relativePath);
    }
  }
}
await walk(dist);

for (const file of forbidden) errors.push(`forbidden packaged file: ${file}`);

if (errors.length) {
  console.error(`Packaged dist validation failed (${errors.length}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Packaged dist valid: ${index.games.length} game(s), ${forbidden.length} forbidden files.`);
  for (const entry of index.games) console.log(`  ${entry.id} ${entry.packVersion}`);
}
