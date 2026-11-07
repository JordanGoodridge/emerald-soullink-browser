export function describeRunNotice(notice, { speciesNameFor = () => null } = {}) {
  const area = notice.label || notice.areaKey || 'this area';
  const species = speciesNameFor(notice.species) || (notice.species ? `#${notice.species}` : 'Pokémon');
  if (notice.type === 'area-visited') {
    return { title: area, detail: 'Visited · encounter available. Entering does not use the encounter.' };
  }
  if (notice.type === 'encounter-skipped') {
    const reason = notice.reason === 'species_already_owned' ? 'Duplicate clause · reroll allowed'
      : notice.reason === 'partner_owns_species' ? 'Partner species clause · reroll allowed' : 'Not eligible · reroll allowed';
    return { title: `${species} · ${reason}`, detail: area };
  }
  if (notice.type === 'encounter-claimed') {
    return { title: `${species} · First eligible encounter`, detail: `Encounter slot claimed · ${area}` };
  }
  if (notice.type === 'capture-complete') {
    return { title: `${species} caught`, detail: `Recorded for ${area}` };
  }
  if (notice.type === 'catch-allowed') {
    return { title: `${species} · Catch allowed`, detail: `First eligible encounter · ${area}` };
  }
  if (notice.type === 'gift-claimed') {
    return { title: `${species} · Gift recorded`, detail: 'Tracked separately from wild route encounters.' };
  }
  return null;
}
