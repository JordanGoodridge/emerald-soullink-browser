// Emerald Kaizo party seam.
//
// Overrides the 26 vanilla move slots that Emerald Kaizo repurposes for
// Gen 4+ attacks and typed Hidden Power / Weather Ball variants.

import { createEmeraldPartyModel } from '../../../pokeemerald-3d/web/packs/shared/party-emerald.mjs';

export const KAIZO_MOVE_NAME_OVERRIDES = Object.freeze({
  4: 'Weather Ball (Water)',
  11: 'Weather Ball (Fire)',
  32: 'Drill Run',
  66: 'Hidden Power (Psychic)',
  90: 'Earth Power',
  124: 'Sludge Bomb',
  130: 'Head Smash',
  131: 'Hidden Power (Fire)',
  132: 'Hidden Power (Grass)',
  139: 'Hidden Power (Ice)',
  140: 'Hidden Power (Ghost)',
  150: 'Hidden Power (Water)',
  159: 'Hidden Power (Dark)',
  167: 'Hidden Power (Rock)',
  178: 'Hidden Power (Electric)',
  188: 'Gunk Shot',
  200: 'Hidden Power (Ground)',
  209: 'Wild Charge',
  210: 'X-Scissors',
  271: 'Hidden Power (Flying)',
  284: 'Draco Meteor',
  289: 'Hidden Power (Fighting)',
  292: 'Force Palm',
  310: 'Shadow Sneak',
  314: 'Air Slash',
  319: 'Flash Cannon',
  333: 'Ice Shard',
  343: 'Hidden Power (Bug)',
});

export function createPartyAdapter(context = {}) {
  const createModel = context.shared?.createEmeraldPartyModel ?? createEmeraldPartyModel;
  return createModel({
    ...context,
    moveNames: {
      ...KAIZO_MOVE_NAME_OVERRIDES,
      ...(context.moveNames ?? {}),
    },
  });
}
