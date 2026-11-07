import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isPackRelativePath,
  validateManifest,
  validatePackIndex,
} from './manifest-schema.mjs';

const realManifest = JSON.parse(
  await readFile(new URL('../../../game-packs/emerald/manifest.json', import.meta.url), 'utf8'),
);

function clone(value) {
  return structuredClone(value);
}

test('the checked-in Emerald manifest is valid in source mode', () => {
  const result = validateManifest(realManifest, { packId: 'emerald', requireDigests: false });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('production mode requires generated digests', () => {
  const result = validateManifest(realManifest, { packId: 'emerald', requireDigests: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path.endsWith('.sha256')));
});

test('pack IDs and adapter paths cannot escape the pack', () => {
  assert.equal(isPackRelativePath('adapter/runtime.mjs'), true);
  assert.equal(isPackRelativePath('../outside.mjs'), false);
  assert.equal(isPackRelativePath('/absolute.mjs'), false);
  assert.equal(isPackRelativePath('adapter/../../outside.mjs'), false);

  const manifest = clone(realManifest);
  manifest.runtime.adapter = '../outside.mjs';
  const result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === 'runtime.adapter'));
});

test('presence capability requires multiplayer and avatars', () => {
  const manifest = clone(realManifest);
  delete manifest.multiplayer;
  const result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === 'multiplayer'));
});

test('rendering capabilities must match modes and default', () => {
  const manifest = clone(realManifest);
  manifest.rendering.defaultMode = 'classic';
  manifest.rendering.modes = ['hd2d'];
  const result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === 'rendering.defaultMode'));
});

test('rules capability must match the nuzlocke section', () => {
  const manifest = clone(realManifest);
  manifest.capabilities.rules = 'observe';
  const result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === 'nuzlocke.support' || error.path === 'capabilities.rules'));
});

test('enforced Nuzlocke needs a RulesAdapter, area data and run-mode declaration', () => {
  const manifest = clone(realManifest);
  manifest.nuzlocke = {
    support: 'enforce',
    adapter: 'adapter/rules.mjs',
    areas: 'region-map',
    requiredHooks: ['encounter', 'captureGate', 'faintRelease', 'reviveGate'],
  };
  manifest.capabilities.rules = 'enforce';
  manifest.run.modes = ['nuzlocke', 'soullink'];
  let result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  manifest.nuzlocke.adapter = '../outside.mjs';
  result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.ok(result.errors.some((error) => error.path === 'nuzlocke.adapter'));

  manifest.nuzlocke.adapter = 'adapter/rules.mjs';
  manifest.run.modes = ['soullink'];
  result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.ok(result.errors.some((error) => error.path === 'nuzlocke.support'));
});

test('SoulLink manifests must declare the linked-PC boxing enforcement level', () => {
  const manifest = clone(realManifest);
  manifest.run.capabilities.linkedPcBoxing = 'observe';
  let result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.ok(result.errors.some((error) => error.path === 'run.capabilities.linkedPcBoxing'));
  delete manifest.run.capabilities.linkedPcBoxing;
  result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.ok(result.errors.some((error) => error.path === 'run.capabilities.linkedPcBoxing'));
});

test('run quick-start base save must reference a declared pack resource', () => {
  const manifest = clone(realManifest);
  manifest.run.quickStartBaseResource = 'missing-save-resource';
  const result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.ok(result.errors.some((error) => error.path === 'run.quickStartBaseResource'));
});

test('run adapter paths and support claims are validated independently', () => {
  const manifest = clone(realManifest);
  manifest.run.adapter = '../outside.mjs';
  let result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === 'run.adapter'));

  manifest.run.adapter = 'adapter/run.mjs';
  manifest.run.support = 'enforce';
  manifest.run.modes = ['soullink'];
  manifest.run.capabilities.captureGate = 'observe';
  result = validateManifest(manifest, { packId: 'emerald', requireDigests: false });
  assert.ok(result.errors.some((error) => error.path === 'run.capabilities'));
});

test('pack index requires a unique default', () => {
  const index = {
    schemaVersion: 1,
    default: 'missing',
    games: [
      {
        id: 'emerald',
        title: 'Emerald',
        packVersion: '0.1.0',
        manifest: 'emerald/manifest.json',
      },
    ],
  };
  const result = validatePackIndex(index);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === 'default'));
});
