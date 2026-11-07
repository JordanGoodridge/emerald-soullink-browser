// Generates web/packs/shared/species-names-emerald.mjs from the species
// constants and the localised species name table.
//
// Party snapshots carry only the internal species id, so the shell needs a
// local id -> name table to render a readable roster. Generating it keeps the
// table in step with the game data instead of hand-maintaining 400 names.
//
//   node pokeemerald-3d/tools/generate_species_names.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const game = resolve(here, '..');
const args = process.argv.slice(2);
const sourceArg = args.find((arg) => arg.startsWith('--source='));
const outputArg = args.find((arg) => arg.startsWith('--output='));
const speciesHeader = sourceArg
  ? resolve(sourceArg.slice('--source='.length))
  : join(game, 'include', 'constants', 'species.h');
const namesHeader = join(game, 'src', 'data', 'text', 'species_names.h');
const pokedexHeader = join(game, 'include', 'constants', 'pokedex.h');
const stillFrontPicHeader = join(game, 'src', 'data', 'pokemon_graphics', 'still_front_pic_table.h');
const pokemonGraphicsHeader = join(game, 'src', 'data', 'graphics', 'pokemon.h');
const target = outputArg
  ? resolve(outputArg.slice('--output='.length))
  : join(game, 'web', 'packs', 'shared', 'species-names-emerald.mjs');

export function parseSpeciesIds(text) {
  const ids = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*#define\s+(SPECIES_[A-Z0-9_]+)\s+(\d+)\s*$/);
    if (match) ids.set(match[1], Number(match[2]));
  }
  return ids;
}

export function parseSpeciesNames(text) {
  const names = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\[(SPECIES_[A-Z0-9_]+)\]\s*=\s*_\("(.*)"\)\s*,?\s*$/);
    if (match) names.set(match[1], match[2]);
  }
  return names;
}

export function parseNationalDexIds(text) {
  const dex = new Map();
  let current = -1;
  let inNationalEnum = false;
  for (const line of text.split(/\r?\n/)) {
    if (!inNationalEnum) {
      if (/^\s*enum\s*\{/.test(line)) inNationalEnum = true;
      continue;
    }
    if (/^\s*\};/.test(line)) break;
    const match = line.match(/^\s*NATIONAL_DEX_([A-Z0-9_]+)(?:\s*=\s*(\d+))?\s*,?\s*$/);
    if (!match) continue;
    current = match[2] !== undefined ? Number(match[2]) : current + 1;
    if (current >= 1 && current <= 386) {
      dex.set(`SPECIES_${match[1]}`, current);
    }
  }
  return dex;
}

export function parseSpritePaths(stillFrontPicText, pokemonGraphicsText) {
  const symbolToUrl = new Map();
  for (const line of pokemonGraphicsText.split(/\r?\n/)) {
    const match = line.match(/const\s+u32\s+(gMonStillFrontPic_[A-Za-z0-9_]+)\[\]\s*=\s*INCGFX_U32\("(graphics\/pokemon\/[^"]+)"/);
    if (match) symbolToUrl.set(match[1], `/${match[2]}`);
  }
  const sprites = new Map();
  for (const line of stillFrontPicText.split(/\r?\n/)) {
    const match = line.match(/SPECIES_SPRITE\(([A-Z0-9_]+),\s*(gMonStillFrontPic_[A-Za-z0-9_]+)\)/);
    if (!match) continue;
    const url = symbolToUrl.get(match[2]);
    if (url) sprites.set(`SPECIES_${match[1]}`, url);
  }
  return sprites;
}

export function buildSpeciesNameTable(ids, names) {
  const table = {};
  for (const [constant, id] of ids) {
    if (id <= 0) continue;
    const name = names.get(constant);
    if (name) table[id] = name;
  }
  return table;
}

export function buildSpeciesDexTable(ids, nationalDex) {
  const table = {};
  for (const [constant, id] of ids) {
    if (id <= 0) continue;
    const dex = nationalDex.get(constant);
    if (Number.isInteger(dex) && dex > 0) table[id] = dex;
  }
  return table;
}

export function buildSpeciesSpriteTable(ids, sprites) {
  const table = {};
  for (const [constant, id] of ids) {
    if (id <= 0) continue;
    const url = sprites.get(constant);
    if (url) table[id] = url;
  }
  return table;
}

export async function generate({
  source = speciesHeader,
  names = namesHeader,
  pokedex = pokedexHeader,
  stillFrontPic = stillFrontPicHeader,
  pokemonGraphics = pokemonGraphicsHeader,
} = {}) {
  const [speciesText, namesText, pokedexText, stillFrontPicText, pokemonGraphicsText] = await Promise.all([
    readFile(source, 'utf8'),
    readFile(names, 'utf8'),
    readFile(pokedex, 'utf8'),
    readFile(stillFrontPic, 'utf8'),
    readFile(pokemonGraphics, 'utf8'),
  ]);
  const ids = parseSpeciesIds(speciesText);
  return {
    names: buildSpeciesNameTable(ids, parseSpeciesNames(namesText)),
    nationalDex: buildSpeciesDexTable(ids, parseNationalDexIds(pokedexText)),
    sprites: buildSpeciesSpriteTable(ids, parseSpritePaths(stillFrontPicText, pokemonGraphicsText)),
  };
}

function formatTableRows(table) {
  return Object.entries(table)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([id, value]) => `  ${id}: ${JSON.stringify(value)},`)
    .join('\n');
}

function moduleSource({ names, nationalDex = {}, sprites = {} }) {
  return `// Generated by tools/generate_species_names.mjs. Do not edit by hand.
export const EMERALD_SPECIES_NAMES = Object.freeze({
${formatTableRows(names)}
});

export const EMERALD_SPECIES_NATIONAL_DEX = Object.freeze({
${formatTableRows(nationalDex)}
});

export const EMERALD_SPECIES_SPRITES = Object.freeze({
${formatTableRows(sprites)}
});

export function speciesName(id) {
  return EMERALD_SPECIES_NAMES[id] ?? null;
}

export function speciesNationalDex(id) {
  return EMERALD_SPECIES_NATIONAL_DEX[id] ?? null;
}

export function speciesSpriteUrl(id) {
  return EMERALD_SPECIES_SPRITES[id] ?? null;
}

function formatDisplayName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  return raw
    .toLowerCase()
    .replace(/(^|[\\s.'\\-])([a-z])/g, (_, prefix, letter) => prefix + letter.toUpperCase());
}

export function getEmeraldSpeciesInfo(id) {
  const numericId = Number(id);
  const rawName = speciesName(numericId);
  const displayName = formatDisplayName(rawName);
  const nationalDex = speciesNationalDex(numericId);
  const spriteUrl = speciesSpriteUrl(numericId);
  return {
    species: numericId,
    rawName,
    name: displayName ?? (Number.isFinite(numericId) ? \`Pokémon #\${numericId}\` : 'Pokémon'),
    nationalDex,
    spriteUrl,
  };
}
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tables = await generate();
  await writeFile(target, moduleSource(tables));
  console.log(`Generated ${Object.keys(tables.names).length} species names -> ${target}`);
}
