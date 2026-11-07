import { createRunRandomizer } from './randomizer.mjs';
import { evaluateEncounter } from './soul-link.mjs';

export const RUN_KIND_WILD = 0;
export const RUN_KIND_TRAINER = 1;
export const RUN_KIND_GYM = 2;
export const RUN_KIND_ELITE = 3;
export const RUN_KIND_CHAMPION = 4;
export const RUN_KIND_STARTER = 5;

function randomizationMode(kind, options) {
  if (kind === RUN_KIND_WILD) {
    if (options.powerBalanceWild === true) return 'power_balance';
    return options.randomizeWild === true ? 'random' : 'off';
  }
  if (kind === RUN_KIND_STARTER) {
    return options.randomizeStarters === true ? 'random' : 'off';
  }
  if ([RUN_KIND_GYM, RUN_KIND_ELITE, RUN_KIND_CHAMPION].includes(kind)) {
    if (options.powerBalanceGyms === true) return 'power_balance';
    return options.randomizeGyms === true ? 'random' : 'off';
  }
  if (options.powerBalanceTrainers === true) return 'power_balance';
  return options.randomizeTrainers === true ? 'random' : 'off';
}

export function createRunEngineHooks({
  enabled = false,
  seed = null,
  adapter = null,
  exports = null,
  getExports = null,
  options = {},
  getOptions = null,
  getSeed = null,
  getState = () => null,
  isSynchronized = () => true,
  onEncounter = () => {},
  onEncounterSkipped = () => {},
  onEncounterRejected = () => {},
  onCapture = () => {},
  onCaptureDecision = () => {},
  onGift = () => {},
  onFaint = () => false,
  onSafePoint = () => {},
  shouldRelease = () => false,
  onPartyWipe = () => {},
  allowItemEffect = () => true,
  onPcBoxBlocked = () => {},
  getGymCap = () => 0,
} = {}) {
  const isEnabled = () => typeof enabled === 'function' ? enabled() : enabled;
  const currentOptions = () => getOptions?.() ?? (typeof options === 'function' ? options() : options);
  const currentSeed = () => getSeed?.() ?? (typeof seed === 'function' ? seed() : seed);
  const currentExports = () => getExports?.() ?? exports;
  let randomizerCache = null;
  let speciesTableKey = null;
  let speciesSource;
  let speciesRows = [];

  function randomizer() {
    const runSeed = currentSeed();
    const localPlayerId = getState()?.localPlayerId ?? null;
    const liveExports = currentExports();
    if (liveExports !== speciesSource) {
      speciesSource = liveExports;
      speciesRows = adapter?.speciesTable?.(liveExports) ?? [];
      randomizerCache = null;
      speciesTableKey = null;
    }
    const table = speciesRows;
    if (!isEnabled() || runSeed === null || !table.length) return null;
    const tableKey = table.map((row) => typeof row === 'number'
      ? String(row)
      : `${row.species}:${row.tier ?? ''}:${row.bst ?? ''}:${row.isLegendary || row.legendary ? 1 : 0}`).join(',');
    if (randomizerCache?.seed === runSeed && randomizerCache?.playerId === localPlayerId
        && speciesTableKey === tableKey) return randomizerCache.value;
    speciesTableKey = tableKey;
    randomizerCache = {
      seed: runSeed,
      playerId: localPlayerId,
      value: createRunRandomizer({ seed: runSeed, playerId: localPlayerId, species: table, noneSpecies: 0 }),
    };
    return randomizerCache.value;
  }

  function areaKeyFromSection(areaOrSection, sectionId = areaOrSection) {
    const numericSection = Number.isInteger(sectionId) ? sectionId : Number(areaOrSection);
    return adapter?.areaKey?.({ sectionId: numericSection }, { exports: currentExports() }) ?? String(areaOrSection);
  }

  return {
    WasmRunRandomSpecies(kind, originalSpecies, contextA, contextB) {
      const state = getState();
      if (state && state.status !== 'active') return originalSpecies;
      const chooseSpecies = randomizer();
      const runOptions = currentOptions();
      if (!isEnabled() || !chooseSpecies) return originalSpecies;
      const mode = randomizationMode(kind, runOptions);
      if (mode === 'off') return originalSpecies;
      const kindName = kind === RUN_KIND_WILD ? 'wild'
        : kind === RUN_KIND_STARTER ? 'starter'
          : kind === RUN_KIND_GYM ? 'gym'
            : kind === RUN_KIND_ELITE ? 'elite'
              : kind === RUN_KIND_CHAMPION ? 'champion' : 'trainer';
      const localPlayerId = state?.localPlayerId ?? null;
      const owned = new Set(runOptions.dupesClause === true
        ? state?.ownedSpecies?.[localPlayerId] ?? []
        : []);
      if (kind === RUN_KIND_WILD && runOptions.partnerSpeciesClause === true) {
        for (const [playerId, partnerSpecies] of Object.entries(state?.ownedSpecies ?? {})) {
          if (playerId !== localPlayerId) {
            for (const species of partnerSpecies) owned.add(species);
          }
        }
      }
      const candidatePool = mode === 'power_balance'
        ? chooseSpecies.similarStrengthPool(originalSpecies)
        : chooseSpecies.pool;
      const pickForSlot = (slotKeyValue, attemptValue) => (mode === 'power_balance'
        ? chooseSpecies.chooseSimilar(originalSpecies, kindName, contextA, slotKeyValue, attemptValue)
        : chooseSpecies.choose(kindName, contextA, slotKeyValue, attemptValue));
      if (kind === RUN_KIND_WILD && Number.isInteger(contextB) && contextB >= 0) {
        const tablePrefix = contextB & ~0xff;
        const slotIndex = Math.min(contextB & 0xff, 11);
        for (let priorSlot = 0; priorSlot < slotIndex; priorSlot++) {
          const priorKey = tablePrefix | priorSlot;
          let priorPicked = null;
          for (let priorAttempt = 0; priorAttempt < 24; priorAttempt++) {
            const candidate = pickForSlot(priorKey, priorAttempt);
            if (!owned.has(candidate)) {
              priorPicked = candidate;
              break;
            }
          }
          if (priorPicked !== null && owned.size + 1 < candidatePool.length) {
            owned.add(priorPicked);
          }
        }
      }
      const attempts = kind === RUN_KIND_WILD ? candidatePool.length * 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const species = pickForSlot(contextB, attempt);
        if (!owned.has(species)) return species;
      }
      // The bounded deterministic retries can collide repeatedly in a small
      // test/future-game pool; guarantee a valid reroll whenever one exists.
      return candidatePool.find((species) => !owned.has(species))
        ?? chooseSpecies.pool.find((species) => !owned.has(species))
        ?? originalSpecies;
    },
    WasmRunAllowCapture(areaKey, speciesId, pidLo, pidHi) {
      if (!isEnabled()) return 1;
      const state = getState();
      if (state && state.status !== 'active') { onCaptureDecision({ allowed: false, reason: 'run_inactive', species: speciesId }); return 0; }
      const key = areaKeyFromSection(areaKey);
      const area = state?.areas?.[key] ?? null;
      if (area?.status === 'void') { onCaptureDecision({ allowed: false, reason: 'area_missed', areaKey: key, species: speciesId }); return 0; }
      const localPlayerId = state?.localPlayerId ?? null;
      const ownClaim = area?.claims?.[localPlayerId];
      // Allow catching an already-claimed local first encounter even if the
      // run socket is temporarily reconnecting; the capture resolution is
      // recorded locally in unconfirmedEvents and flushed upon reconnect.
      if (!isSynchronized() && (!ownClaim || ownClaim.status !== 'claimed' || ownClaim.species !== speciesId)) {
        onCaptureDecision({ allowed: false, reason: 'not_synchronized', areaKey: key, species: speciesId });
        return 0;
      }
      // Capture enforcement fails closed if the encounter hook did not claim
      // this player's area first.
      if (!ownClaim) { onCaptureDecision({ allowed: false, reason: 'no_encounter_claim', areaKey: key, species: speciesId }); return 0; }
      if (ownClaim && (ownClaim.status !== 'claimed' || ownClaim.species !== speciesId)) { onCaptureDecision({ allowed: false, reason: 'not_first_encounter', areaKey: key, species: speciesId }); return 0; }
      const runOptions = currentOptions();
      if (runOptions.partnerSpeciesClause === true
          && ((Object.entries(state?.ownedSpecies ?? {}).some(([ownerId, owned]) => ownerId !== localPlayerId && owned.includes(speciesId)))
            || Object.values(area?.claims ?? {}).some((claim) => claim.playerId !== localPlayerId && claim.species === speciesId))) { onCaptureDecision({ allowed: false, reason: 'partner_species_clause', areaKey: key, species: speciesId }); return 0; }
      if (runOptions.dupesClause === true
          && (state?.ownedSpecies?.[localPlayerId] ?? []).includes(speciesId)) { onCaptureDecision({ allowed: false, reason: 'dupes_clause', areaKey: key, species: speciesId }); return 0; }
      onCaptureDecision({ allowed: true, reason: 'first_encounter', areaKey: key, species: speciesId });
      return 1;
    },
    WasmRunAllowItemEffect(speciesId, pidLo, pidHi, itemId, hp, level, highestLivingPartyLevel, gymCap, isRareCandy) {
      if (!isEnabled()) return 1;
      const pid = ((((pidHi ?? 0) & 0xffff) << 16) | ((pidLo ?? 0) & 0xffff)) >>> 0;
      const state = getState();
      if ((state?.deaths ?? []).some((death) => death.pid === pid
          && (!state.localPlayerId || death.playerId === state.localPlayerId))) return 0;
      if (isRareCandy) {
        const options = currentOptions();
        if (options.rareCandyPartyLevelCeiling === false) return 0;
        return Number.isInteger(level) && highestLivingPartyLevel > level && gymCap > level ? 1 : 0;
      }
      return allowItemEffect({
        species: speciesId, pidLo, pidHi, itemId, hp, level,
        highestLivingPartyLevel, gymCap, state,
      }) ? 1 : 0;
    },
    WasmRunAllowPcBoxing(personality) {
      if (!isEnabled()) return 1;
      const state = getState();
      const options = currentOptions();
      if (state?.mode !== 'soullink' || options.allowLinkedPcBoxing === true) return 1;
      const localPlayerId = state?.localPlayerId ?? null;
      const pid = Number(personality) >>> 0;
      const linked = Object.values(state?.links ?? {}).some((link) => link.status === 'active'
        && link.members.some((member) => member.playerId === localPlayerId
          && member.pid === pid && member.status === 'alive'));
      if (!linked) return 1;
      onPcBoxBlocked({ pid, playerId: localPlayerId });
      return 0;
    },
    WasmRunOnEncounter(areaKey, sectionId, speciesId, level, pidLo, pidHi, kind) {
      if (!isEnabled()) return;
      const key = areaKeyFromSection(areaKey, sectionId);
      const state = getState();
      const decision = evaluateEncounter({
        species: speciesId,
        playerId: state?.localPlayerId ?? null,
        area: state?.areas?.[key] ?? null,
        ownedSpecies: state?.ownedSpecies?.[state?.localPlayerId] ?? [],
        partnerOwnedSpecies: Object.entries(state?.ownedSpecies ?? {})
          .filter(([ownerId]) => ownerId !== state?.localPlayerId)
          .flatMap(([, owned]) => owned),
        options: currentOptions(),
      });
      const encounter = { areaKey: key, sectionId, species: speciesId, level, pidLo, pidHi, kind };
      if (decision.action === 'claim') onEncounter(encounter);
      else if (decision.action === 'skip') onEncounterSkipped({ ...encounter, reason: decision.reason });
      else onEncounterRejected({ ...encounter, reason: decision.reason });
    },
    WasmRunOnCapture(areaKey, sectionId, speciesId, level, pidLo, pidHi) {
      if (isEnabled()) onCapture({ areaKey: areaKeyFromSection(areaKey, sectionId), sectionId, species: speciesId, level, pidLo, pidHi });
    },
    WasmRunOnGift(giftKey, sectionId, speciesId, level, pidLo, pidHi) {
      if (isEnabled()) onGift({ giftKey, sectionId, species: speciesId, level, pidLo, pidHi });
    },
    WasmRunOnFaint(pidLo, pidHi, cause) {
      return isEnabled() && onFaint({ pidLo, pidHi, cause, state: getState() }) ? 1 : 0;
    },
    WasmRunShouldRelease(pidLo, pidHi) {
      return isEnabled() && shouldRelease({ pidLo, pidHi, state: getState() }) ? 1 : 0;
    },
    WasmRunOnPartyWipe(wiped) {
      if (isEnabled() && wiped) onPartyWipe({ state: getState() });
    },
    WasmRunAtSafePoint(outcome) {
      if (isEnabled()) onSafePoint({ outcome, state: getState() });
    },
    WasmRunInfiniteRareCandy() {
      const state = getState();
      const options = currentOptions();
      return isEnabled()
        && (!state || state.status === 'active')
        && options.infiniteRareCandies === true
        && options.rareCandyPartyLevelCeiling !== false ? 1 : 0;
    },
    WasmRunInfiniteMoney() {
      const state = getState();
      const options = currentOptions();
      return isEnabled()
        && (!state || state.status === 'active')
        && options.infiniteMoney === true ? 1 : 0;
    },
  };
}
