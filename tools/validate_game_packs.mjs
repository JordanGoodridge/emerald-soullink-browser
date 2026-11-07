#!/usr/bin/env node
// Validate every installed game pack against the manifest schema and check that
// its adapter, evidence and (when present) build artifact paths exist.
//
//   node tools/validate_game_packs.mjs
//   node tools/validate_game_packs.mjs --require-digests
//   node tools/validate_game_packs.mjs --require-build

import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatValidationErrors,
  validateManifest,
  validatePackIndex,
} from '../pokeemerald-3d/web/packs/manifest-schema.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packsRoot = join(repo, 'game-packs');
const args = new Set(process.argv.slice(2));
const requireDigests = args.has('--require-digests');
const requireBuild = args.has('--require-build');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function packPath(packId, relative) {
  return join(packsRoot, packId, ...relative.split('/'));
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

const errors = [];
const warnings = [];

const index = await readJson(join(packsRoot, 'index.json'), 'game-packs/index.json');
const indexResult = validatePackIndex(index);
if (!indexResult.ok) {
  for (const error of indexResult.errors) errors.push(`index: ${error.path} ${error.message}`);
}

for (const entry of index.games ?? []) {
  if (!entry?.id) continue;
  const manifestRelative = entry.manifest.startsWith('/')
    ? entry.manifest.slice(1)
    : `game-packs/${entry.manifest}`;
  const manifestPath = entry.manifest.startsWith('/')
    ? join(repo, manifestRelative)
    : join(packsRoot, ...entry.manifest.split('/'));
  let manifest;
  try {
    manifest = await readJson(manifestPath, `${entry.id} manifest`);
  } catch (error) {
    errors.push(`${entry.id}: ${error.message}`);
    continue;
  }
  const result = validateManifest(manifest, {
    packId: entry.id,
    requireDigests,
  });
  if (!result.ok) {
    errors.push(formatValidationErrors(entry.id, result.errors));
    continue;
  }

  const pathChecks = [
    ['runtime.adapter', manifest.runtime.adapter],
    ['rendering.adapter', manifest.rendering.adapter],
    ['saves.codec', manifest.saves.codec],
  ];
  if (manifest.multiplayer) pathChecks.push(['multiplayer.adapter', manifest.multiplayer.adapter]);
  for (const [label, relative] of pathChecks) {
    if (!(await exists(packPath(entry.id, relative)))) {
      errors.push(`${entry.id}: ${label} does not exist at game-packs/${entry.id}/${relative}`);
    }
  }

  for (const evidence of manifest.verification?.evidence ?? []) {
    const evidencePath = evidence.startsWith('/') ? join(repo, evidence.slice(1)) : join(repo, evidence);
    if (!(await exists(evidencePath))) {
      errors.push(`${entry.id}: verification evidence does not exist: ${evidence}`);
    }
  }

  const moduleUrl = manifest.runtime.module?.url;
  if (moduleUrl && !moduleUrl.startsWith('/')) {
    const artifactPath = packPath(entry.id, moduleUrl);
    if (!(await exists(artifactPath))) {
      const message = `${entry.id}: build artifact is missing at game-packs/${entry.id}/${moduleUrl}`;
      if (requireBuild) errors.push(message);
      else warnings.push(message);
    }
  }

  if (manifest.interiorSupport === 'verified') {
    warnings.push(`${entry.id}: interiorSupport is "verified"; keep the interior acceptance evidence with the pack`);
  }
}

if (errors.length) {
  console.error(`Game pack validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):`);
  for (const error of errors) console.error(`  - ${error}`);
  if (warnings.length) {
    console.error('Warnings:');
    for (const warning of warnings) console.error(`  - ${warning}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Game packs valid: ${index.games.length} installed.`);
  for (const warning of warnings) console.log(`  warning: ${warning}`);
  if (requireDigests) console.log('  digests: required');
  if (requireBuild) console.log('  build artifacts: required');
}
