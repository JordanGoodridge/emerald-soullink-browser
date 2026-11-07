import test from 'node:test';
import assert from 'node:assert/strict';
import { allContinuingPlayersReady, evaluateEncounter, isPartyWiped, rareCandyTargetAllowed } from './soul-link.mjs';

test('dupes clause skips an already-owned species only when enabled', () => {
  assert.deepEqual(evaluateEncounter({ species: 25, ownedSpecies: [25], options: { dupesClause: true } }), {
    action: 'skip', reason: 'species_already_owned', reroll: true,
  });
  assert.equal(evaluateEncounter({ species: 25, ownedSpecies: [25], options: {} }).action, 'claim');
});

test('partner species clause allows a reroll when partner already owns the species', () => {
  const area = { claims: { p1: { playerId: 'p1', species: 25 } } };
  assert.equal(evaluateEncounter({
    species: 25, playerId: 'p2', area, options: { partnerSpeciesClause: true },
  }).reason, 'partner_owns_species');
  assert.equal(evaluateEncounter({
    species: 25, playerId: 'p2', partnerOwnedSpecies: [25], options: { partnerSpeciesClause: true },
  }).reason, 'partner_owns_species');
});

test('rare candy ceiling is below the highest living party level and gym cap', () => {
  assert.equal(rareCandyTargetAllowed({ targetLevel: 9, highestLivingPartyLevel: 10, gymCap: 12 }), true);
  assert.equal(rareCandyTargetAllowed({ targetLevel: 10, highestLivingPartyLevel: 10, gymCap: 12 }), false);
  assert.equal(rareCandyTargetAllowed({ targetLevel: 11, highestLivingPartyLevel: 15, gymCap: 11 }), false);
});

test('wipe is party-only; boxed Pokémon do not affect it', () => {
  assert.equal(isPartyWiped([{ species: 25, hp: 0 }, { species: 1, hp: 0 }]), true);
  assert.equal(isPartyWiped([{ species: 25, hp: 1 }]), false);
  assert.equal(isPartyWiped([{ species: 412, hp: 0, isEgg: true }]), true);
});

test('reset readiness counts continuing players only and permits one player to continue', () => {
  assert.equal(allContinuingPlayersReady([
    { active: true, ready: true }, { active: true, ready: true }, { active: false, ready: false },
  ]), true);
  assert.equal(allContinuingPlayersReady([{ active: true, ready: true }, { active: true, ready: false }]), false);
  assert.equal(allContinuingPlayersReady([{ active: true, ready: true }]), true);
});
