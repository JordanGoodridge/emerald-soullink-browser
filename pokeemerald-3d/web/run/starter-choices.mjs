import { createRunRandomizer } from './randomizer.mjs';

export function starterChoicesForRun(runState, speciesTable, nativeChoices = []) {
  if (!runState || (typeof runState.seed !== 'string' && !Number.isSafeInteger(runState.seed))) {
    throw new Error('starter choices require an authoritative run seed');
  }
  if (runState.options?.randomizeStarters !== true) {
    if (!Array.isArray(nativeChoices) || nativeChoices.length !== 3
      || nativeChoices.some((species) => !Number.isInteger(species) || species <= 0)) {
      throw new Error('the game adapter must provide three native starter choices');
    }
    return [...nativeChoices];
  }

  const randomizer = createRunRandomizer({
    seed: runState.seed,
    playerId: runState.localPlayerId ?? null,
    species: speciesTable,
  });
  const choices = [];
  for (let index = 0; index < 3; index++) {
    const first = randomizer.choose('starter-choice', runState.runId, index);
    if (!choices.includes(first)) {
      choices.push(first);
      continue;
    }
    const alternative = randomizer.pool.find((species) => !choices.includes(species));
    if (alternative === undefined) throw new Error('starter species pool cannot supply three distinct choices');
    choices.push(alternative);
  }
  return choices;
}
