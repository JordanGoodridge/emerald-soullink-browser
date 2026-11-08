#!/usr/bin/env node
// Generate the Emerald region map resource from the canonical decomp data.
//
//   node tools/generate_region_map.mjs [--output=path]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultGame = resolve(here, '..');
const repo = resolve(defaultGame, '..');
const sourceArg = process.argv.slice(2).find((arg) => arg.startsWith('--source='));
const game = sourceArg ? resolve(sourceArg.slice('--source='.length)) : defaultGame;
const gameIdArg = process.argv.slice(2).find((arg) => arg.startsWith('--game-id='));
const gameId = gameIdArg ? gameIdArg.slice('--game-id='.length) : 'emerald';
const outputArg = process.argv.slice(2).find((arg) => arg.startsWith('--output='));
const output = outputArg
  ? resolve(outputArg.slice('--output='.length))
  : join(repo, 'game-packs', gameId, 'dist', 'region-map.json');

const sectionsPath = join(game, 'src', 'data', 'region_map', 'region_map_sections.json');
const constantsPath = join(game, 'include', 'constants', 'region_map_sections.h');
const layoutPath = join(game, 'src', 'data', 'region_map', 'region_map_layout.h');

const definitions = JSON.parse(await readFile(sectionsPath, 'utf8')).map_sections;
const constantsText = await readFile(constantsPath, 'utf8');
const layoutText = await readFile(layoutPath, 'utf8');
const ids = [...constantsText.matchAll(/^\s*(MAPSEC_[A-Z0-9_]+)\s*,?\s*$/gm)]
  .map((match) => match[1]);
const idByName = new Map(ids.map((name, index) => [name, index]));

if (!definitions?.length || !ids.length) throw new Error('region map source data is empty');
const sections = definitions.map((section) => {
  const numericId = idByName.get(section.id);
  if (!Number.isInteger(numericId)) throw new Error(`map section constant missing: ${section.id}`);
  const hasMapRectangle = ['x', 'y', 'width', 'height'].every((field) => Number.isInteger(section[field]));
  if (hasMapRectangle && ['x', 'y', 'width', 'height'].some((field) => section[field] < 0)) {
    throw new Error(`${section.id}: invalid map rectangle`);
  }
  return {
    id: numericId,
    key: section.id,
    name: section.name,
    x: hasMapRectangle ? section.x : null,
    y: hasMapRectangle ? section.y : null,
    width: hasMapRectangle ? section.width : null,
    height: hasMapRectangle ? section.height : null,
  };
});

const rows = [...layoutText.matchAll(/^\s*\{([^{}]+)\},?\s*$/gm)];
const layout = rows.map((row, y) => {
  const tokens = [...row[1].matchAll(/MAPSEC_[A-Z0-9_]+/g)].map((match) => match[0]);
  if (tokens.length !== 28) throw new Error(`region map row ${y} has ${tokens.length} columns; expected 28`);
  return tokens.map((token) => {
    if (token === 'MAPSEC_NONE') return null;
    const numericId = idByName.get(token);
    if (!Number.isInteger(numericId)) throw new Error(`layout references unknown map section: ${token}`);
    return numericId;
  });
});
if (layout.length !== 15) throw new Error(`region map has ${layout.length} rows; expected 15`);

const outputData = {
  schemaVersion: 1,
  gameId,
  dimensions: { columns: 28, rows: 15 },
  image: { url: 'resources/hoenn-region-map.png', width: 1507, height: 990 },
  sections,
  layout,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(outputData, null, 2)}\n`);
console.log(`Generated ${sections.filter((section) => section.x !== null).length} map sections (${sections.length} total IDs) and ${layout.length}x${layout[0].length} layout: ${output}`);
