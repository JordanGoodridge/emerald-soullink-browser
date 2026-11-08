#!/usr/bin/env node
/**
 * Pixel & Color-Isolation Audit CLI for PokeTech Avatar Clothing
 *
 * Usage:
 *   node .agents/skills/poketech-avatar-clothing/scripts/audit-sprite.mjs
 *   node .agents/skills/poketech-avatar-clothing/scripts/audit-sprite.mjs --slot head --item kitten-ears
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
  custom.slots[slot] = item;
}

const compiled = compileCharacterCustomization(custom, { schema });
const grid = sheetName === 'running' ? compiled.runningIndexed : compiled.walkingIndexed;

console.log(`=== Sprite Audit: slot=${slot || 'default'} item=${item || 'default'} sheet=${sheetName} ===`);
console.log('Legend: . = 0(transparent) | 1,2 = skin | 3 = hair | 4,5 = bottom | 6,7 = trim | 8,9 = top | A,B = hat(10,11) | C = white(12) | D,E = grey(13,14) | F = outline(15)\n');

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
  headZone_y0_16: new Map(),
  torsoZone_y17_22: new Map(),
  legsZone_y23_28: new Map(),
  shoesZone_y29_31: new Map(),
};

for (let y = 0; y < 32; y += 1) {
  const zone =
    y <= 16 ? countsByZone.headZone_y0_16 :
    y <= 22 ? countsByZone.torsoZone_y17_22 :
    y <= 28 ? countsByZone.legsZone_y23_28 :
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
