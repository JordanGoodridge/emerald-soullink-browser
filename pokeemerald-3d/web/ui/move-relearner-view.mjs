// Move Relearner modal DOM helper functions.

import { buildMoveRelearnerChoices } from '../run/move-relearner.mjs';

export function moveRelearnerChoicesForMon({ mon, moveHistoryStore, partyAdapter }) {
  if (!mon) return [];
  return buildMoveRelearnerChoices({
    currentMoves: mon.moves,
    levelUpMoves: mon.levelUpMoves,
    rememberedMoves: moveHistoryStore?.get(mon.personality) ?? [],
    maxMoveId: partyAdapter?.maxMoveId ?? 0,
  }).filter((choice) => partyAdapter?.moveName?.(choice.move));
}

export function populateMoveRelearnerDialog({
  mon,
  partyMember,
  choices,
  partyAdapter,
  pokemonEl,
  choiceSelectEl,
  slotSelectEl,
  statusEl,
  doc = globalThis.document,
}) {
  const monName = partyMember?.nickname || partyMember?.speciesName || `Pokémon #${mon.species}`;
  if (pokemonEl) {
    pokemonEl.textContent = `${monName} · Lv ${mon.level}`;
  }
  if (choiceSelectEl) {
    choiceSelectEl.replaceChildren();
    const choicePlaceholder = doc.createElement('option');
    choicePlaceholder.value = '';
    choicePlaceholder.textContent = choices.length ? 'Choose a move to learn' : 'No eligible moves';
    choiceSelectEl.append(choicePlaceholder);
    if (!choices.length) {
      choicePlaceholder.disabled = true;
    } else {
      for (const choice of choices) {
        const option = doc.createElement('option');
        option.value = String(choice.move);
        option.textContent = `${partyAdapter.moveName(choice.move)} · ${choice.source}`;
        choiceSelectEl.append(option);
      }
    }
  }
  if (slotSelectEl) {
    slotSelectEl.replaceChildren();
    const emptySlot = mon.moves.findIndex((move) => move === 0);
    if (emptySlot >= 0) {
      const option = doc.createElement('option');
      option.value = String(emptySlot);
      option.textContent = `Empty slot ${emptySlot + 1} (add move)`;
      slotSelectEl.append(option);
    } else {
      const placeholder = doc.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choose a move to replace';
      slotSelectEl.append(placeholder);
    }
    mon.moves.forEach((move, slot) => {
      if (!move) return;
      const option = doc.createElement('option');
      option.value = String(slot);
      option.textContent = `Slot ${slot + 1}: ${partyAdapter?.moveName?.(move) ?? `Move #${move}`}`;
      slotSelectEl.append(option);
    });
  }
  if (statusEl) {
    statusEl.textContent = choices.length
      ? 'Current moves are excluded. Replacing a move resets its PP Ups.'
      : 'This Pokémon has no relearnable moves at its current level.';
  }
}
