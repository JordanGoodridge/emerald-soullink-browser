import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunRandomizer, eligibleSpecies, hashRunContext } from './randomizer.mjs';

const SPECIES = [
  { species: 1 },
  { species: 2 },
  { species: 3 },
  { species: 382, legendary: true, bst: 670 }, // Kyogre remains eligible.
  { species: 412, isEgg: true },
];

test('randomizer accepts legendary and high-BST species without strength filters', () => {
  assert.deepEqual(eligibleSpecies(SPECIES), [1, 2, 3, 382]);
  const randomizer = createRunRandomizer({ seed: 'chaos-seed', species: SPECIES, eggSpecies: 412 });
  assert.deepEqual(randomizer.pool, [1, 2, 3, 382]);
  assert.equal(randomizer.pool.includes(382), true);
});

test('same run seed and context is stable; distinct contexts are independently keyed', () => {
  const first = createRunRandomizer({ seed: 42, species: [1, 2, 3, 382] });
  const second = createRunRandomizer({ seed: 42, species: [1, 2, 3, 382] });
  assert.equal(first.choose('wild', 'route101', 'land', 0), second.choose('wild', 'route101', 'land', 0));
  assert.notEqual(hashRunContext(42, 'wild', 'route101', 0), hashRunContext(42, 'trainer', 101, 0));
});

test('replacement does not consume level data or exclude legendary results', () => {
  const randomizer = createRunRandomizer({ seed: 'find-legendary', species: [1, 382] });
  let sawKyogre = false;
  for (let slot = 0; slot < 100; slot++) {
    if (randomizer.replace(1, 'wild', 'route101', slot) === 382) sawKyogre = true;
  }
  assert.equal(sawKyogre, true);
  const originalLevel = { min: 2, max: 4 };
  randomizer.replace(1, 'wild', 'route101', 0);
  assert.deepEqual(originalLevel, { min: 2, max: 4 });
});

test('invalid empty pools and missing seeds fail with a useful error', () => {
  assert.throws(() => createRunRandomizer({ seed: 1, species: [0] }), /pool is empty/);
  assert.throws(() => createRunRandomizer({ species: [1] }), /run seed/);
});

test('UPR-ZX similarStrengthPool matches within ±10% BST, expands by ±5% to reach ≥5 candidates, and separates Legendaries', () => {
  const poolRows = [
    { species: 10, bst: 195 },
    { species: 13, bst: 195 },
    { species: 263, bst: 240 }, // Zigzagoon
    { species: 261, bst: 220 }, // Poochyena (within ±10% of 240: 216..264)
    { species: 265, bst: 195 },
    { species: 270, bst: 220 }, // Lotad
    { species: 273, bst: 220 }, // Seedot
    { species: 276, bst: 270 }, // Taillow (outside ±10% of 240, inside +15%)
    { species: 304, bst: 330 }, // Aron
    { species: 305, bst: 430 }, // Lairon
    { species: 306, bst: 530 }, // Aggron
    { species: 380, bst: 600, isLegendary: true }, // Latias
    { species: 381, bst: 600, isLegendary: true }, // Latios
    { species: 382, bst: 670, isLegendary: true }, // Kyogre
    { species: 383, bst: 670, isLegendary: true }, // Groudon
    { species: 384, bst: 680, isLegendary: true }, // Rayquaza
    { species: 376, bst: 600, isLegendary: false }, // Metagross (pseudo-legendary, non-legendary)
  ];
  const randomizer = createRunRandomizer({ seed: 'upr-zx', species: poolRows });

  // Zigzagoon (240): initial ±10% [216..264] has 4 candidates (263, 261, 270, 273);
  // expands by ±5% (±12 -> [204..276]) to include Taillow (276) and reach 5 candidates.
  const zigzagoonPool = randomizer.similarStrengthPool(263);
  assert.deepEqual(zigzagoonPool, [263, 261, 270, 273, 276]);
  assert.equal(zigzagoonPool.some((id) => [380, 381, 382, 383, 384].includes(id)), false);

  // Metagross (600, non-legendary) never matches Legendaries (380..384) even with identical 600 BST.
  const metagrossPool = randomizer.similarStrengthPool(376);
  assert.equal(metagrossPool.some((id) => [380, 381, 382, 383, 384].includes(id)), false);

  // Latias (600, legendary) only matches Legendaries.
  const latiasPool = randomizer.similarStrengthPool(380);
  assert.deepEqual(latiasPool, [380, 381, 382, 383, 384]);

  for (let slot = 0; slot < 40; slot++) {
    const pick = randomizer.chooseSimilar(263, 'wild', 'route101', slot);
    assert.equal(zigzagoonPool.includes(pick), true);
  }
});

test('similarStrengthPool uses evolution-stage power tiers when tier metadata is provided', () => {
  const tieredRows = [
    { species: 288, bst: 240, tier: 0 }, // Zigzagoon (Unevolved)
    { species: 58, bst: 350, tier: 0 },  // Growlithe (Unevolved, high BST)
    { species: 382, bst: 330, tier: 0 }, // Aron (Unevolved)
    { species: 277, bst: 310, tier: 0 }, // Treecko (Unevolved)
    { species: 383, bst: 430, tier: 1 }, // Lairon (Mid-stage)
    { species: 278, bst: 405, tier: 1 }, // Grovyle (Mid-stage)
    { species: 384, bst: 530, tier: 2 }, // Aggron (Fully evolved)
    { species: 404, bst: 670, tier: 3, isLegendary: true }, // Kyogre (Legendary)
  ];
  const randomizer = createRunRandomizer({ seed: 'evo-tiers', species: tieredRows });
  // Zigzagoon (240 BST, tier 0) matches Growlithe (350 BST), Aron (330 BST), and Treecko (310 BST)!
  assert.deepEqual(randomizer.similarStrengthPool(288), [288, 58, 382, 277]);
  assert.deepEqual(randomizer.similarStrengthPool(383), [383, 278]);
  assert.deepEqual(randomizer.similarStrengthPool(384), [384]);
  assert.deepEqual(randomizer.similarStrengthPool(404), [404]);
});
