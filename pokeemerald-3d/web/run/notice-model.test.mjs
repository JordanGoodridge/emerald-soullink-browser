import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRunNotice } from './notice-model.mjs';

test('banner explains route visits without consuming the encounter', () => {
  assert.deepEqual(describeRunNotice({ type: 'area-visited', label: 'Route 101' }), {
    title: 'Route 101', detail: 'Visited · encounter available. Entering does not use the encounter.',
  });
});

test('banner distinguishes first encounter, allowed attempt and capture result', () => {
  const speciesNameFor = () => 'Poochyena';
  assert.equal(describeRunNotice({ type: 'encounter-claimed', species: 261, label: 'Route 101' }, { speciesNameFor }).title,
    'Poochyena · First eligible encounter');
  assert.equal(describeRunNotice({ type: 'catch-allowed', species: 261, label: 'Route 101' }, { speciesNameFor }).title,
    'Poochyena · Catch allowed');
  assert.equal(describeRunNotice({ type: 'capture-complete', species: 261, label: 'Route 101' }, { speciesNameFor }).title,
    'Poochyena caught');
});

test('banner names duplicate rerolls, blocked catches and gifts explicitly', () => {
  assert.match(describeRunNotice({ type: 'encounter-skipped', reason: 'species_already_owned', species: 261 }).title, /Duplicate clause · reroll allowed/);
  assert.match(describeRunNotice({ type: 'encounter-skipped', reason: 'partner_owns_species', species: 261 }).title, /Partner species clause · reroll allowed/);
  assert.equal(describeRunNotice({ type: 'encounter-rejected', reason: 'area_already_claimed', label: 'Route 101', species: 261 }), null);
  assert.equal(describeRunNotice({ type: 'catch-blocked', reason: 'not_first_encounter', species: 261 }), null);
  assert.equal(describeRunNotice({ type: 'gift-claimed', species: 25 }, { speciesNameFor: () => 'Pikachu' }).detail,
    'Tracked separately from wild route encounters.');
});
