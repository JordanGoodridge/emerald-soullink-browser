// Emerald Kaizo RunAdapter.
//
// Reuses the shared Emerald run adapter with Kaizo's pack identity and
// disables all randomization categories so Kaizo's handcrafted encounters,
// trainers, Gyms, and starters are preserved.

import { createEmeraldRunAdapter } from '../../emerald/adapter/run.mjs';

export const KAIZO_RANDOMIZER_CAPABILITIES = Object.freeze({
  wild: false,
  trainers: false,
  gyms: false,
  starters: false,
});

export const KAIZO_PRECEDENCE = Object.freeze({
  gameOwns: Object.freeze([
    'wild-encounter-tables',
    'trainer-rosters-and-movesets',
    'starter-species',
    'expanded-386-regional-dex',
  ]),
  pokeTechAdds: Object.freeze([
    'nuzlocke-encounter-and-capture-gate',
    'soullink-pair-linking-and-shared-deaths',
    'gym-level-cap-and-party-level-sync',
    'move-relearner-and-max-money-qol',
  ]),
  conflicts: Object.freeze([]),
});

export function createRunAdapter(context = {}) {
  return createEmeraldRunAdapter({
    id: 'emerald-kaizo',
    regionMap: context.regionMap ?? context.resources?.regionMap ?? null,
    trainerIdFromMemory: context.shared?.emeraldTrainerId ?? null,
    randomizer: KAIZO_RANDOMIZER_CAPABILITIES,
    precedence: KAIZO_PRECEDENCE,
  });
}
