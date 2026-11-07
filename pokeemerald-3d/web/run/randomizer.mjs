// Deterministic, unrestricted species replacement. No BST, type, evolution-stage
// or legendary filtering: only invalid/egg species are excluded by default.

const MAX_SEED = 0xffffffff;

export function hashRunContext(seed, ...context) {
  const text = [String(seed), ...context.map(String)].join('\u001f');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Avalanche the FNV-1a result so adjacent integer contexts do not produce
  // visibly related selections.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function eligibleSpeciesMetadata(speciesRows, { noneSpecies = 0, eggSpecies = null } = {}) {
  if (!Array.isArray(speciesRows)) return [];
  const seen = new Set();
  const rows = [];
  for (const row of speciesRows) {
    const species = typeof row === 'number' ? row : row?.species;
    if (!Number.isInteger(species) || species <= noneSpecies || species === eggSpecies) continue;
    if (typeof row === 'object' && row && (row.isEgg === true || row.randomizable === false)) continue;
    if (seen.has(species)) continue;
    seen.add(species);
    const bst = typeof row === 'object' && row && Number.isFinite(row.bst) && row.bst > 0
      ? Math.round(row.bst)
      : null;
    const tier = typeof row === 'object' && row && Number.isInteger(row.tier) && row.tier >= 0
      ? row.tier
      : null;
    const isLegendary = typeof row === 'object' && row
      ? Boolean(row.isLegendary || row.legendary || tier === 3)
      : false;
    rows.push({ species, bst, tier, isLegendary });
  }
  return rows;
}

export function eligibleSpecies(speciesRows, { noneSpecies = 0, eggSpecies = null } = {}) {
  return eligibleSpeciesMetadata(speciesRows, { noneSpecies, eggSpecies }).map((row) => row.species);
}

export function createRunRandomizer({
  seed,
  playerId = null,
  species,
  noneSpecies = 0,
  eggSpecies = null,
} = {}) {
  if (seed === undefined || seed === null || seed === '') throw new Error('randomizer requires a run seed');
  const metadataRows = eligibleSpeciesMetadata(species, { noneSpecies, eggSpecies });
  const pool = metadataRows.map((row) => row.species);
  if (!pool.length) throw new Error('randomizer species pool is empty');
  const metadataBySpecies = new Map(metadataRows.map((row) => [row.species, row]));
  const rowsWithTier = metadataRows.filter((row) => row.tier !== null);
  const rowsWithBst = metadataRows.filter((row) => row.bst !== null);
  const similarPoolCache = new Map();
  const scopedSeed = playerId === null || playerId === undefined
    ? seed
    : hashRunContext(seed, 'player', playerId);

  function choose(kind, ...context) {
    if (typeof kind !== 'string' || !kind) throw new Error('randomizer requires a context kind');
    return pool[hashRunContext(scopedSeed, kind, ...context) % pool.length];
  }

  // Power-Balance pool selection:
  // 1. When evolution-stage `tier` metadata (0=Unevolved, 1=Mid-Stage,
  //    2=Fully-Evolved, 3=Legendary) is present on the species table, matches
  //    all eligible species in the same evolution power tier (~185 unevolved,
  //    ~75 mid-stage, ~145 fully-evolved, 21 legendary).
  // 2. Falls back to UPR-ZX expanding ±10% BST window when only `bst` metadata
  //    is provided.
  function similarStrengthPool(originalSpecies) {
    const cached = similarPoolCache.get(originalSpecies);
    if (cached) return cached;
    const target = metadataBySpecies.get(originalSpecies);
    if (target && target.tier !== null && rowsWithTier.length > 0) {
      const tierMatches = rowsWithTier
        .filter((row) => row.tier === target.tier)
        .map((row) => row.species);
      const result = tierMatches.length > 0 ? tierMatches : pool;
      similarPoolCache.set(originalSpecies, result);
      return result;
    }
    if (!target || target.bst === null || rowsWithBst.length === 0) {
      return pool;
    }
    const matchingTier = rowsWithBst.filter((row) => row.isLegendary === target.isLegendary);
    const subPool = matchingTier.length > 0 ? matchingTier : rowsWithBst;
    const minDesiredCount = Math.min(5, subPool.length);
    let minTarget = Math.floor(target.bst - target.bst / 10);
    let maxTarget = Math.ceil(target.bst + target.bst / 10);
    const stepDown = Math.max(1, Math.floor(target.bst / 20));
    const stepUp = Math.max(1, Math.ceil(target.bst / 20));
    let candidates = [];
    for (let expansion = 0; expansion < 64; expansion++) {
      candidates = subPool.filter((row) => row.bst >= minTarget && row.bst <= maxTarget);
      if (candidates.length >= minDesiredCount || candidates.length === subPool.length) {
        break;
      }
      minTarget -= stepDown;
      maxTarget += stepUp;
    }
    const result = (candidates.length > 0 ? candidates : subPool).map((row) => row.species);
    similarPoolCache.set(originalSpecies, result);
    return result;
  }

  function chooseSimilar(originalSpecies, kind, ...context) {
    if (typeof kind !== 'string' || !kind) throw new Error('randomizer requires a context kind');
    const candidates = similarStrengthPool(originalSpecies);
    return candidates[hashRunContext(scopedSeed, kind, ...context) % candidates.length];
  }

  return {
    choose,
    chooseSimilar,
    similarStrengthPool,
    pool: [...pool],
    // Kept as a compatibility-shaped helper for engine hooks: the original
    // species/level are not inputs to eligibility and level is never changed.
    replace(originalSpecies, kind, ...context) {
      void originalSpecies;
      return choose(kind, ...context);
    },
  };
}

export function normalizeSeed(seed) {
  if (Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED) return seed >>> 0;
  return hashRunContext(seed ?? '');
}
