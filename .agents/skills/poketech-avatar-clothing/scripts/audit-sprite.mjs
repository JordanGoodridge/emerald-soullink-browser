#!/usr/bin/env node
/**
 * Pixel & Color-Isolation Audit CLI for PokeTech Avatar Clothing
 *
 * Usage:
 *   node .agents/skills/poketech-avatar-clothing/scripts/audit-sprite.mjs
 *   node .agents/skills/poketech-avatar-clothing/scripts/audit-sprite.mjs --slot head --item kitten-ears --frames 9
 *   node .agents/skills/poketech-avatar-clothing/scripts/audit-sprite.mjs --slot top --item rs-jacket --sheet running
 */
import {
  resolveCharacterSchema,
} from '../../../../pokeemerald-3d/web/customization/character-catalog.mjs';
import {
  compileCharacterCustomization,
} from '../../../../pokeemerald-3d/web/customization/character-compositor.mjs';
import {
  normalizeCustomization,
} from '../../../../pokeemerald-3d/web/customization/character-store.mjs';

const args = process.argv.slice(2);
function getArg(flag, fallback = null) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const slot = getArg('--slot', null);
const item = getArg('--item', null);
const sheetName = getArg('--sheet', 'walking');
const maxFrames = Number(getArg('--frames', '3'));

const schema = resolveCharacterSchema({ rigId: 'gen3-brendan' });
const custom = normalizeCustomization({}, schema);
if (slot && item) {
  custom.equipped[slot] = item;
}

const compiled = compileCharacterCustomization(custom, { schema });
const grid = sheetName === 'running' ? compiled.runningIndexed : compiled.walkingIndexed;

console.log(`=== Sprite Audit: slot=${slot || 'default'} item=${item || 'default'} sheet=${sheetName} ===`);
console.log('Legend: .=0(trans) | 1..4=skin | 5=bottom(pants) | 6,7=trim(2nd) | 8=darkHair/eye | 9,E=head(hat/hair) | A,B=accent(bag/bandana) | C,D=top(shirt/shoes) | F=blackOutline\n');

for (let y = 0; y < 32; y += 1) {
  let line = `y=${String(y).padStart(2, '0')}: `;
  for (let f = 0; f < maxFrames; f += 1) {
    for (let x = 0; x < 16; x += 1) {
      const v = grid[y * 144 + f * 16 + x];
      line += v === 0 ? '.' : v.toString(16).toUpperCase();
    }
    line += ' | ';
  }
  console.log(line);
}

// Verify palette index isolation across body zones on Frame 0
const countsByZone = {
  headZone_y0_21: new Map(),
  torsoZone_y22_27: new Map(),
  legsZone_y28: new Map(),
  shoesZone_y29_31: new Map(),
};

for (let y = 0; y < 32; y += 1) {
  const zone =
    y <= 21 ? countsByZone.headZone_y0_21 :
    y <= 27 ? countsByZone.torsoZone_y22_27 :
    y === 28 ? countsByZone.legsZone_y28 :
    countsByZone.shoesZone_y29_31;
  for (let x = 0; x < 16; x += 1) {
    const v = grid[y * 144 + x];
    if (v === 0) continue;
    zone.set(v, (zone.get(v) || 0) + 1);
  }
}

console.log('\n=== Frame 0 Palette Index Histogram by Vertical Zone ===');
for (const [zoneName, map] of Object.entries(countsByZone)) {
  const entries = [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, count]) => `${idx.toString(16).toUpperCase()}(${idx}):${count}`)
    .join(', ');
  console.log(`  ${zoneName.padEnd(18)} -> ${entries}`);
}
