import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSpeciesDexTable,
  buildSpeciesNameTable,
  buildSpeciesSpriteTable,
  parseNationalDexIds,
  parseSpeciesIds,
  parseSpeciesNames,
  parseSpritePaths,
} from './generate_species_names.mjs';
import { getEmeraldSpeciesInfo } from '../web/packs/shared/species-names-emerald.mjs';

test('parses species constant ids', () => {
  const ids = parseSpeciesIds(`
#define SPECIES_NONE 0
#define SPECIES_BULBASAUR 1
#define SPECIES_PIKACHU 25
`);
  assert.equal(ids.get('SPECIES_BULBASAUR'), 1);
  assert.equal(ids.get('SPECIES_PIKACHU'), 25);
});

test('parses localised species names', () => {
  const names = parseSpeciesNames(`
    [SPECIES_BULBASAUR] = _("BULBASAUR"),
    [SPECIES_PIKACHU] = _("PIKACHU"),
`);
  assert.equal(names.get('SPECIES_BULBASAUR'), 'BULBASAUR');
  assert.equal(names.get('SPECIES_PIKACHU'), 'PIKACHU');
});

test('joins ids and names into a lookup table keyed by numeric id', () => {
  const ids = new Map([['SPECIES_NONE', 0], ['SPECIES_BULBASAUR', 1], ['SPECIES_PIKACHU', 25]]);
  const names = new Map([['SPECIES_BULBASAUR', 'BULBASAUR'], ['SPECIES_PIKACHU', 'PIKACHU']]);
  assert.deepEqual(buildSpeciesNameTable(ids, names), { 1: 'BULBASAUR', 25: 'PIKACHU' });
});

test('parses national dex numbers and sprite paths for internal species ids', () => {
  const ids = new Map([['SPECIES_TREECKO', 277], ['SPECIES_TORCHIC', 280], ['SPECIES_ARON', 382]]);
  const dex = parseNationalDexIds(`
enum {
    NATIONAL_DEX_NONE,
    NATIONAL_DEX_TREECKO = 252,
    NATIONAL_DEX_GROVYLE,
    NATIONAL_DEX_SCEPTILE,
    NATIONAL_DEX_TORCHIC,
    NATIONAL_DEX_ARON = 304,
};
`);
  const sprites = parseSpritePaths(`
    SPECIES_SPRITE(TREECKO, gMonStillFrontPic_Treecko),
    SPECIES_SPRITE(TORCHIC, gMonStillFrontPic_Torchic),
    SPECIES_SPRITE(ARON, gMonStillFrontPic_Aron),
`, `
const u32 gMonStillFrontPic_Treecko[] = INCGFX_U32("graphics/pokemon/treecko/front.png", ".4bpp.lz");
const u32 gMonStillFrontPic_Torchic[] = INCGFX_U32("graphics/pokemon/torchic/front.png", ".4bpp.lz");
const u32 gMonStillFrontPic_Aron[] = INCGFX_U32("graphics/pokemon/aron/front.png", ".4bpp.lz");
`);
  assert.deepEqual(buildSpeciesDexTable(ids, dex), { 277: 252, 280: 255, 382: 304 });
  assert.deepEqual(buildSpeciesSpriteTable(ids, sprites), {
    277: '/graphics/pokemon/treecko/front.png',
    280: '/graphics/pokemon/torchic/front.png',
    382: '/graphics/pokemon/aron/front.png',
  });
});

test('getEmeraldSpeciesInfo resolves display name, true National Dex number, and sprite url', () => {
  assert.deepEqual(getEmeraldSpeciesInfo(277), {
    species: 277,
    rawName: 'TREECKO',
    name: 'Treecko',
    nationalDex: 252,
    spriteUrl: '/graphics/pokemon/treecko/front.png',
  });
  assert.deepEqual(getEmeraldSpeciesInfo(280), {
    species: 280,
    rawName: 'TORCHIC',
    name: 'Torchic',
    nationalDex: 255,
    spriteUrl: '/graphics/pokemon/torchic/front.png',
  });
  assert.deepEqual(getEmeraldSpeciesInfo(382), {
    species: 382,
    rawName: 'ARON',
    name: 'Aron',
    nationalDex: 304,
    spriteUrl: '/graphics/pokemon/aron/front.png',
  });
});
