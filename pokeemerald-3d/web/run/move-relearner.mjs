// Candidate construction for the optional browser move relearner. The engine
// supplies the species/level-legal level-up list; the sidecar adds moves this
// individual Pokémon has previously held.

export function buildMoveRelearnerChoices({
  currentMoves = [],
  levelUpMoves = [],
  rememberedMoves = [],
  maxMoveId = 0xffff,
} = {}) {
  const current = new Set(currentMoves.filter((move) => Number.isInteger(move) && move > 0));
  const choices = new Map();
  for (const move of levelUpMoves) {
    if (!Number.isInteger(move) || move <= 0 || move > maxMoveId || current.has(move)) continue;
    choices.set(move, { move, source: 'level-up' });
  }
  for (const move of rememberedMoves) {
    if (!Number.isInteger(move) || move <= 0 || move > maxMoveId || current.has(move)) continue;
    if (!choices.has(move)) choices.set(move, { move, source: 'previously known' });
  }
  return [...choices.values()];
}
