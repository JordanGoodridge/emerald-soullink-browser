import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRunAdapter } from './adapter-contract.mjs';

const base = {
  id: 'fixture',
  modes: ['soullink'],
  areaKey() {}, areaLabel() {}, isWildArea() {}, sectionId() {}, speciesTable() {}, trainerKind() {},
  saveSlot: 'soulrun',
  capabilities: { encounter: 'enforce', captureGate: 'enforce', faintRelease: 'observe', reviveGate: 'none' },
};

test('SoulLink adapter requires real declared encounter and capture enforcement', () => {
  assert.equal(validateRunAdapter(base).ok, true);
  const observeOnly = { ...base, capabilities: { ...base.capabilities, captureGate: 'observe' } };
  assert.equal(validateRunAdapter(observeOnly).ok, false);
});

test('adapter missing a required seam or using shared main save is rejected', () => {
  assert.equal(validateRunAdapter({ ...base, areaKey: undefined }).ok, false);
  assert.equal(validateRunAdapter({ ...base, saveSlot: 'main' }).ok, false);
});
