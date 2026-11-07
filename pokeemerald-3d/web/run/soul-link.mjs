// Shared rule helpers that do not depend on a particular game engine.

export function evaluateEncounter({
  species,
  ownedSpecies = [],
  partnerOwnedSpecies = [],
  options = {},
  area = null,
  playerId = null,
} = {}) {
  if (!Number.isInteger(species) || species <= 0) return { action: 'reject', reason: 'invalid_species' };
  if (area?.status === 'void' || area?.status === 'dead') return { action: 'reject', reason: area.status === 'void' ? 'area_void' : 'area_dead' };
  if (area?.claims?.[playerId]) return { action: 'reject', reason: 'area_already_claimed' };

  const alreadyOwned = new Set(ownedSpecies).has(species);
  if (options.partnerSpeciesClause === true) {
    const partnerOwns = partnerOwnedSpecies.includes(species) || Object.values(area?.claims ?? {})
      .some((claim) => claim.playerId !== playerId && claim.species === species);
    if (partnerOwns) return { action: 'skip', reason: 'partner_owns_species', reroll: true };
  }
  if (options.dupesClause === true && alreadyOwned) {
    return { action: 'skip', reason: 'species_already_owned', reroll: true };
  }
  return { action: 'claim', reason: null, reroll: false };
}

export function rareCandyTargetAllowed({ targetLevel, highestLivingPartyLevel, gymCap } = {}) {
  if (![targetLevel, highestLivingPartyLevel, gymCap].every(Number.isInteger)) return false;
  return targetLevel < highestLivingPartyLevel && targetLevel < gymCap;
}

export function isPartyWiped(party = []) {
  return !party.some((pokemon) => pokemon
    && pokemon.isEgg !== true
    && Number.isInteger(pokemon.hp)
    && pokemon.hp > 0);
}

export function allContinuingPlayersReady(members = []) {
  const continuing = members.filter((member) => member.active !== false);
  return continuing.length >= 1 && continuing.every((member) => member.ready === true);
}
