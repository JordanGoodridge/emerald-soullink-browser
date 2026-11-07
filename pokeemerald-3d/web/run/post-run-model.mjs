// Pure, DOM-free post-run analytics, Hall of Fame roster, and superlative awards model.

export const HOENN_GYM_SPLITS = Object.freeze([
  { badgeCount: 0, id: 'roxanne', leader: 'Roxanne', badgeName: 'Stone Badge', title: 'Split 1 · Stone Badge (Roxanne)', location: 'Rustboro Gym' },
  { badgeCount: 1, id: 'brawly', leader: 'Brawly', badgeName: 'Knuckle Badge', title: 'Split 2 · Knuckle Badge (Brawly)', location: 'Dewford Gym' },
  { badgeCount: 2, id: 'wattson', leader: 'Wattson', badgeName: 'Dynamo Badge', title: 'Split 3 · Dynamo Badge (Wattson)', location: 'Mauville Gym' },
  { badgeCount: 3, id: 'flannery', leader: 'Flannery', badgeName: 'Heat Badge', title: 'Split 4 · Heat Badge (Flannery)', location: 'Lavaridge Gym' },
  { badgeCount: 4, id: 'norman', leader: 'Norman', badgeName: 'Balance Badge', title: 'Split 5 · Balance Badge (Norman)', location: 'Petalburg Gym' },
  { badgeCount: 5, id: 'winona', leader: 'Winona', badgeName: 'Feather Badge', title: 'Split 6 · Feather Badge (Winona)', location: 'Fortree Gym' },
  { badgeCount: 6, id: 'tate-liza', leader: 'Tate & Liza', badgeName: 'Mind Badge', title: 'Split 7 · Mind Badge (Tate & Liza)', location: 'Mossdeep Gym' },
  { badgeCount: 7, id: 'juan', leader: 'Juan', badgeName: 'Rain Badge', title: 'Split 8 · Rain Badge (Juan)', location: 'Sootopolis Gym' },
  { badgeCount: 8, id: 'wallace', leader: 'Wallace', badgeName: 'Champion Title', title: 'Finale · Pokémon League (Wallace)', location: 'Ever Grande City' },
]);

export function formatRunDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '—';
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function safeSpeciesInfo(speciesInfoFor, species) {
  if (!Number.isInteger(species) || species <= 0) {
    return { name: 'Unknown', spriteUrl: null, nationalDex: null };
  }
  const info = speciesInfoFor?.(species) ?? null;
  return {
    name: info?.name || `#${species}`,
    spriteUrl: info?.spriteUrl ?? null,
    nationalDex: Number.isInteger(info?.nationalDex) ? info.nationalDex : species,
  };
}

function buildSectionLookup(regionMap) {
  const map = new Map();
  for (const section of regionMap?.sections ?? []) {
    if (Number.isInteger(section?.id) && typeof section?.name === 'string') {
      map.set(section.id, section.name);
    }
  }
  return map;
}

function resolveAreaLabel(areaKey, area, sectionLookup) {
  if (areaKey === 'emerald:gift:starter') return 'Starter Gift';
  if (typeof areaKey === 'string' && areaKey.startsWith('emerald:gift:')) return area?.label || 'Gift Pokémon';
  if (typeof area?.label === 'string' && area.label && !area.label.startsWith('emerald:')) return area.label;
  if (Number.isInteger(area?.sectionId) && sectionLookup.has(area.sectionId)) {
    return sectionLookup.get(area.sectionId);
  }
  if (typeof areaKey === 'string') {
    const match = /^emerald:section:(\d+)$/.exec(areaKey);
    if (match) {
      const id = Number(match[1]);
      if (sectionLookup.has(id)) return sectionLookup.get(id);
      return `Route / Area ${id}`;
    }
  }
  return area?.label || areaKey || 'Hoenn';
}

function buildRulePills(run) {
  const options = run?.options ?? {};
  const pills = [
    run?.mode === 'nuzlocke' ? 'Solo Nuzlocke' : `${(run?.members ?? []).filter((m) => m.active !== false).length || 2}P SoulLink`,
  ];
  if (options.gymLevelCap !== false) pills.push('Gym Level Caps');
  if (options.dupesClause !== false) pills.push('Dupes Clause');
  if (options.partnerSpeciesClause) pills.push('Partner Species Clause');
  if (options.randomizeStarters) pills.push('Randomized Starters');
  if (options.randomizeWild) pills.push('Randomized Wild');
  if (options.randomizeTrainers) pills.push('Randomized Trainers');
  if (options.randomizeGyms) pills.push('Randomized Bosses');
  if (options.autoLevelCaught) pills.push('Auto-Level Captures');
  if (options.partyLevelSync) pills.push('Party Level Sync');
  return pills;
}

export function buildPostRunSummary({
  run = null,
  localPlayerId = null,
  parties = {},
  speciesInfoFor = () => ({ name: 'Pokémon', spriteUrl: null, nationalDex: null }),
  regionMap = null,
} = {}) {
  if (!run || typeof run !== 'object') {
    return {
      status: 'unavailable',
      outcome: 'unavailable',
      kicker: '',
      title: 'Run Summary',
      subtitle: '',
      seed: null,
      mode: 'soullink',
      badgeCount: 0,
      durationMs: null,
      durationLabel: '—',
      rulePills: [],
      wipeDetail: null,
      stats: [],
      metrics: {},
      awards: [],
      champions: [],
      graveyard: [],
      splits: [],
    };
  }

  const sectionLookup = buildSectionLookup(regionMap);
  const members = Array.isArray(run.members) ? run.members : [];
  const playerNames = new Map(members.map((m) => [m.playerId, m.name || 'Player']));
  const playerNameFor = (playerId) => playerNames.get(playerId) ?? 'Player';

  const events = Array.isArray(run.events) ? run.events : [];
  const areas = Object.values(run.areas ?? {});
  const links = Object.values(run.links ?? {});
  const deaths = Array.isArray(run.deaths) ? run.deaths : [];

  const isVictory = run.status === 'victory';
  const isWipe = run.status === 'wipe_pending';
  const outcome = isVictory ? 'victory' : isWipe ? 'wipe' : 'active';

  // Badge count: max across progress, events, deaths, wipe, or 8 on victory.
  let badgeCount = Number.isInteger(run.progress?.gymIndex) ? run.progress.gymIndex : 0;
  for (const ev of events) {
    if (Number.isInteger(ev?.badgeCount)) badgeCount = Math.max(badgeCount, ev.badgeCount);
  }
  for (const d of deaths) {
    if (Number.isInteger(d?.badgeCount)) badgeCount = Math.max(badgeCount, d.badgeCount);
  }
  if (Number.isInteger(run.wipe?.badgeCount)) badgeCount = Math.max(badgeCount, run.wipe.badgeCount);
  if (isVictory) badgeCount = 8;
  badgeCount = Math.max(0, Math.min(8, badgeCount));

  // Timestamps & duration
  const eventTimes = events.map((e) => e?.at).filter((t) => Number.isFinite(t) && t > 0);
  const startedAt = Number.isFinite(run.startedAt) && run.startedAt > 0
    ? run.startedAt
    : (eventTimes.length ? Math.min(...eventTimes) : null);
  const endedAt = Number.isFinite(run.endedAt) && run.endedAt > 0
    ? run.endedAt
    : (eventTimes.length ? Math.max(...eventTimes) : null);
  const durationMs = startedAt !== null && endedAt !== null && endedAt >= startedAt
    ? endedAt - startedAt
    : null;
  const durationLabel = formatRunDuration(durationMs);

  // Origin lookup by playerId + pid (or species fallback)
  const caughtResolutionKeys = new Set();
  for (const ev of events) {
    if (ev?.type === 'encounter.resolve' && ev?.result === 'caught' && ev.playerId && ev.areaKey) {
      caughtResolutionKeys.add(`${ev.areaKey}:${ev.playerId}`);
    }
  }
  const claimOriginByPid = new Map();
  const claimOriginBySpecies = new Map();
  const allCaughtClaims = [];
  let claimOrder = 0;

  for (const area of areas) {
    const originLabel = resolveAreaLabel(area.areaKey, area, sectionLookup);
    for (const claim of Object.values(area.claims ?? {})) {
      if (!claim?.species) continue;
      const entry = {
        ...claim,
        areaKey: area.areaKey,
        sectionId: area.sectionId ?? null,
        originLabel,
        order: claimOrder++,
      };
      if (claim.pid !== null && claim.pid !== undefined) {
        claimOriginByPid.set(`${claim.playerId}:${claim.pid >>> 0}`, entry);
      }
      if (!claimOriginBySpecies.has(`${claim.playerId}:${claim.species}`)) {
        claimOriginBySpecies.set(`${claim.playerId}:${claim.species}`, entry);
      }
      const wasCaughtBeforeVoid = claim.status === 'void'
        && caughtResolutionKeys.has(`${area.areaKey}:${claim.playerId}`);
      if (['caught', 'dead'].includes(claim.status) || wasCaughtBeforeVoid) {
        allCaughtClaims.push(entry);
      }
    }
  }

  // Partner lookup by playerId + pid (or areaKey)
  const partnerByPlayerPid = new Map();
  const linkByAreaKey = new Map();
  for (const link of links) {
    linkByAreaKey.set(link.areaKey, link);
    for (const member of link.members ?? []) {
      const partners = (link.members ?? []).filter((other) => other.playerId !== member.playerId);
      if (!partners.length) continue;
      const partnerLabel = partners.map((p) => {
        const sInfo = safeSpeciesInfo(speciesInfoFor, p.species);
        return `${playerNameFor(p.playerId)}’s ${p.nickname || sInfo.name}`;
      }).join(' · ');
      if (member.pid !== null && member.pid !== undefined) {
        partnerByPlayerPid.set(`${member.playerId}:${member.pid >>> 0}`, {
          partnerLabel,
          partners,
          link,
        });
      }
    }
  }

  // Funnel & route telemetry
  const wildAreas = areas.filter((a) => !Object.values(a.claims ?? {}).some((c) => c.isGift));
  const visitedRoutesCount = wildAreas.filter(
    (a) => (a.visits?.length ?? 0) > 0 || Object.keys(a.claims ?? {}).length > 0 || (a.skips?.length ?? 0) > 0,
  ).length;
  const totalRoutes = Math.max(visitedRoutesCount, regionMap?.sections?.length ?? visitedRoutesCount);
  const areaHasCaughtMon = (a) => Object.values(a.claims ?? {}).some(
    (c) => ['caught', 'dead'].includes(c?.status)
      || (c?.status === 'void' && caughtResolutionKeys.has(`${a.areaKey}:${c.playerId}`)),
  );
  const successfulWildAreas = wildAreas.filter(
    (a) => ['linked', 'caught', 'dead'].includes(a.status) || (a.status === 'pending' && areaHasCaughtMon(a)),
  );
  const resolvedWildAreas = wildAreas.filter(
    (a) => ['linked', 'caught', 'dead', 'void'].includes(a.status) || (a.status === 'pending' && areaHasCaughtMon(a)),
  );
  const missedEncounters = wildAreas.filter((a) => a.status === 'void').length;
  const clauseRerolls = areas.reduce((sum, a) => sum + (a.skips?.length ?? 0), 0);

  const totalCatches = allCaughtClaims.length;
  const wildCaughtCount = allCaughtClaims.filter((c) => !c.isGift).length;
  const giftCaughtCount = allCaughtClaims.filter((c) => c.isGift).length;
  const catchRatePercent = resolvedWildAreas.length > 0
    ? Math.round((successfulWildAreas.length / resolvedWildAreas.length) * 100)
    : (totalCatches > 0 ? 100 : 0);
  const catchDetailLabel = wildCaughtCount === 0 && giftCaughtCount > 0 && missedEncounters > 0
    ? `0 wild caught · ${giftCaughtCount} starter${giftCaughtCount === 1 ? '' : 's'}`
    : `${totalCatches} Pokémon caught`;

  const linksFormed = links.length;
  const linksSurvived = links.filter((l) => l.status === 'active').length;
  const linksBroken = links.filter((l) => l.status === 'dead').length;

  // Graveyard / Fallen Epitaphs
  const graveyard = deaths.map((death, index) => {
    const sInfo = safeSpeciesInfo(speciesInfoFor, death.species);
    const pidKey = death.pid !== null && death.pid !== undefined ? `${death.playerId}:${death.pid >>> 0}` : null;
    const origin = (pidKey && claimOriginByPid.get(pidKey))
      ?? claimOriginBySpecies.get(`${death.playerId}:${death.species}`)
      ?? null;
    const areaObj = death.areaKey ? run.areas?.[death.areaKey] : null;
    const originLabel = origin?.originLabel ?? resolveAreaLabel(death.areaKey, areaObj, sectionLookup);
    const partnerEntry = (pidKey && partnerByPlayerPid.get(pidKey)) ?? null;
    const triggeredBy = death.triggeredByPlayerId ?? death.playerId;
    const isCollateral = Boolean(run.mode === 'soullink' && triggeredBy && triggeredBy !== death.playerId);
    const deathBadge = Number.isInteger(death.badgeCount) ? Math.max(0, Math.min(8, death.badgeCount)) : badgeCount;
    const split = HOENN_GYM_SPLITS[deathBadge] ?? HOENN_GYM_SPLITS[0];
    const level = Number.isInteger(death.level) ? death.level : (origin?.level ?? null);
    const nickname = death.nickname || origin?.nickname || null;
    const displayName = nickname ? `${nickname} (${sInfo.name})` : sInfo.name;
    const causeLabel = isCollateral
      ? `SoulLink tether (${playerNameFor(triggeredBy)}’s partner fainted)`
      : (death.cause === 'poison' ? 'Overworld poison' : 'Fainted in battle');

    return {
      index,
      playerId: death.playerId,
      playerName: playerNameFor(death.playerId),
      triggeredByPlayerId: triggeredBy,
      triggeredByPlayerName: playerNameFor(triggeredBy),
      isCollateral,
      species: death.species,
      speciesName: sInfo.name,
      nickname,
      displayName,
      level,
      spriteUrl: sInfo.spriteUrl,
      areaKey: death.areaKey ?? null,
      originLabel,
      badgeCount: deathBadge,
      splitLabel: `Badge ${deathBadge} · ${split.leader} Split`,
      causeLabel,
      partnerLabel: partnerEntry?.partnerLabel ?? null,
      at: death.at ?? null,
    };
  });

  const directDeaths = graveyard.filter((g) => !g.isCollateral).length;
  const collateralDeaths = graveyard.filter((g) => g.isCollateral).length;
  const totalDeaths = graveyard.length;
  const survivingCatches = Math.max(0, totalCatches - totalDeaths);
  const survivalRatePercent = totalCatches > 0
    ? Math.round((survivingCatches / totalCatches) * 100)
    : 0;

  // Build Champions / Final Party Roster per player
  const deadPidsByPlayer = new Map();
  for (const d of deaths) {
    if (d.pid !== null && d.pid !== undefined) {
      if (!deadPidsByPlayer.has(d.playerId)) deadPidsByPlayer.set(d.playerId, new Set());
      deadPidsByPlayer.get(d.playerId).add(d.pid >>> 0);
    }
  }

  const champions = members.filter((m) => m.active !== false).map((member) => {
    const recordedChamp = run.champions?.[member.playerId]?.party;
    const liveParty = parties?.[member.playerId]?.members ?? parties?.[member.playerId] ?? [];
    const rawRoster = Array.isArray(recordedChamp) && recordedChamp.length > 0
      ? recordedChamp
      : (Array.isArray(liveParty) && liveParty.length > 0
          ? liveParty
          : allCaughtClaims
              .filter((c) => c.playerId === member.playerId && c.status === 'caught')
              .slice(-6));

    const deadSet = deadPidsByPlayer.get(member.playerId) ?? new Set();
    const rosterMembers = rawRoster.map((mon) => {
      const species = Number(mon?.species ?? 0);
      if (species <= 0) return null;
      const sInfo = safeSpeciesInfo(speciesInfoFor, species);
      const pid = mon?.pid !== null && mon?.pid !== undefined
        ? (mon.pid >>> 0)
        : (mon?.personality !== null && mon?.personality !== undefined ? (mon.personality >>> 0) : null);
      const pidKey = pid !== null ? `${member.playerId}:${pid}` : null;
      const origin = (pidKey && claimOriginByPid.get(pidKey))
        ?? claimOriginBySpecies.get(`${member.playerId}:${species}`)
        ?? null;
      const partnerEntry = (pidKey && partnerByPlayerPid.get(pidKey)) ?? null;
      const nickname = mon?.nickname || origin?.nickname || null;
      const level = Number.isInteger(mon?.level) ? mon.level : (origin?.level ?? null);
      const isDead = (pid !== null && deadSet.has(pid)) || (Number.isInteger(mon?.hp) && mon.hp === 0 && !isVictory);
      return {
        species,
        speciesName: sInfo.name,
        nickname,
        displayName: nickname || sInfo.name,
        level,
        spriteUrl: sInfo.spriteUrl,
        originLabel: origin?.originLabel ?? 'Hoenn',
        partnerLabel: partnerEntry?.partnerLabel ?? null,
        status: isVictory ? 'champion' : (isDead ? 'fallen' : 'survivor'),
        moves: Array.isArray(mon?.moves) ? mon.moves : [],
      };
    }).filter(Boolean);

    return {
      playerId: member.playerId,
      playerName: member.name || 'Player',
      isSelf: member.playerId === localPlayerId,
      members: rosterMembers,
    };
  });

  // Wipe detail
  const wipeEvent = [...events].reverse().find((e) => e?.type === 'wipe.pending') ?? null;
  const wipePlayerId = run.wipe?.playerId ?? wipeEvent?.playerId ?? null;
  const wipeAreaKey = run.wipe?.areaKey ?? wipeEvent?.areaKey ?? graveyard.at(-1)?.areaKey ?? null;
  const wipeSectionId = run.wipe?.sectionId ?? wipeEvent?.sectionId ?? null;
  const wipeAreaLabel = wipeAreaKey
    ? resolveAreaLabel(wipeAreaKey, run.areas?.[wipeAreaKey] ?? { sectionId: wipeSectionId }, sectionLookup)
    : (Number.isInteger(wipeSectionId) && sectionLookup.has(wipeSectionId)
        ? sectionLookup.get(wipeSectionId)
        : (graveyard.at(-1)?.originLabel ?? 'Hoenn'));
  const currentSplit = HOENN_GYM_SPLITS[badgeCount] ?? HOENN_GYM_SPLITS[0];

  const wipeDetail = isWipe ? {
    playerId: wipePlayerId,
    playerName: wipePlayerId ? playerNameFor(wipePlayerId) : 'Party',
    areaLabel: wipeAreaLabel,
    badgeCount,
    splitLabel: currentSplit.title,
    reason: run.mode === 'soullink' && wipePlayerId
      ? `${playerNameFor(wipePlayerId)}’s active party was wiped out near ${wipeAreaLabel} during ${currentSplit.title}.`
      : `No living Pokémon remain in the active party near ${wipeAreaLabel} (${badgeCount}/8 Badges).`,
  } : null;

  // 8-Gym Split Timeline
  const splits = HOENN_GYM_SPLITS.map((split) => {
    const splitCatches = [];
    for (const ev of events) {
      if (ev?.type !== 'encounter.claim') continue;
      const evBadge = Number.isInteger(ev.badgeCount) ? Math.max(0, Math.min(8, ev.badgeCount)) : 0;
      if (evBadge !== split.badgeCount) continue;
      const area = run.areas?.[ev.areaKey];
      const claim = area?.claims?.[ev.playerId];
      if (!claim || !['caught', 'dead'].includes(claim.status)) continue;
      const sInfo = safeSpeciesInfo(speciesInfoFor, ev.species);
      splitCatches.push({
        playerId: ev.playerId,
        playerName: playerNameFor(ev.playerId),
        species: ev.species,
        speciesName: sInfo.name,
        nickname: claim.nickname || ev.nickname || null,
        displayName: claim.nickname || ev.nickname || sInfo.name,
        spriteUrl: sInfo.spriteUrl,
        areaLabel: resolveAreaLabel(ev.areaKey, area, sectionLookup),
      });
    }
    const splitDeaths = graveyard.filter((g) => g.badgeCount === split.badgeCount);
    return {
      ...split,
      reached: split.badgeCount <= badgeCount,
      isCurrent: split.badgeCount === badgeCount,
      catches: splitCatches,
      deaths: splitDeaths,
    };
  });

  // Superlatives / Run Awards
  const awards = [];
  const usedAwardSpecies = new Set();

  // 1. Day-One Ride-or-Die (MVP)
  const survivingClaims = allCaughtClaims.filter((c) => c.status === 'caught');
  const mvpCandidate = survivingClaims[0] ?? allCaughtClaims[0] ?? null;
  if (mvpCandidate) {
    const sInfo = safeSpeciesInfo(speciesInfoFor, mvpCandidate.species);
    const survived = mvpCandidate.status === 'caught';
    const monName = mvpCandidate.nickname || sInfo.name;
    if (mvpCandidate.species) usedAwardSpecies.add(mvpCandidate.species);
    awards.push({
      id: 'mvp',
      icon: '🏆',
      title: isVictory ? 'Hall of Fame Anchor' : 'Day-One Ride-or-Die',
      headline: `${playerNameFor(mvpCandidate.playerId)}’s ${monName}`,
      detail: survived
        ? `Caught at ${mvpCandidate.originLabel} and survived all the way through ${badgeCount}/8 Badges.`
        : `First partner from ${mvpCandidate.originLabel} before falling on the road.`,
      species: mvpCandidate.species,
      spriteUrl: sInfo.spriteUrl,
      playerName: playerNameFor(mvpCandidate.playerId),
    });
  }

  // 2. Iron Link (SoulLink strongest / longest-surviving linked pair)
  if (run.mode === 'soullink' && links.length > 0) {
    const scoredLinks = links.map((link) => {
      const aliveBonus = link.status === 'active' ? 1000 : 0;
      const levelSum = (link.members ?? []).reduce((s, m) => s + (Number(m.level) || 5), 0);
      return { link, score: aliveBonus + levelSum };
    }).sort((a, b) => b.score - a.score);
    const best = scoredLinks[0]?.link;
    if (best && (best.members?.length ?? 0) >= 2) {
      const featuredMember = best.members.find((m) => m.species && !usedAwardSpecies.has(m.species)) ?? best.members[0];
      const featuredInfo = safeSpeciesInfo(speciesInfoFor, featuredMember.species);
      if (featuredMember.species) usedAwardSpecies.add(featuredMember.species);
      const pairNames = best.members.map((m) => {
        const info = safeSpeciesInfo(speciesInfoFor, m.species);
        return `${playerNameFor(m.playerId)}’s ${m.nickname || info.name}`;
      }).join(' ↔ ');
      const areaLabel = resolveAreaLabel(best.areaKey, run.areas?.[best.areaKey], sectionLookup);
      awards.push({
        id: 'iron-link',
        icon: '⛓️',
        title: best.status === 'active' ? 'Unbreakable SoulLink' : 'Flagship SoulLink',
        headline: pairNames,
        detail: `Bonded at ${areaLabel} (${best.status === 'active' ? 'Survived intact' : 'Fell together'}).`,
        species: featuredMember.species,
        spriteUrl: featuredInfo.spriteUrl,
        playerName: playerNameFor(featuredMember.playerId),
      });
    }
  }

  // 3. Heartbreaker (SoulLink collateral damage award)
  const collateralList = graveyard.filter((g) => g.isCollateral);
  if (collateralList.length > 0) {
    const sortedCollateral = [...collateralList].sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
    const worstCollateral = sortedCollateral.find((c) => c.species && !usedAwardSpecies.has(c.species)) ?? sortedCollateral[0];
    if (worstCollateral?.species) usedAwardSpecies.add(worstCollateral.species);
    const sameTriggerCollateral = collateralList.filter(
      (c) => c.triggeredByPlayerId === worstCollateral.triggeredByPlayerId,
    );
    const victimSummary = sameTriggerCollateral.length > 1
      ? sameTriggerCollateral.map((c) => `${c.playerName}’s ${c.nickname || c.speciesName}`).slice(0, 2).join(' & ')
      : `${worstCollateral.playerName}’s ${worstCollateral.level ? `Lv ${worstCollateral.level} ` : ''}${worstCollateral.nickname || worstCollateral.speciesName}`;
    awards.push({
      id: 'heartbreaker',
      icon: '💔',
      title: 'SoulLink Heartbreaker',
      headline: `${worstCollateral.triggeredByPlayerName} → ${victimSummary}`,
      detail: `${worstCollateral.triggeredByPlayerName}’s faint dragged down ${collateralList.length} linked partner Pokémon across the run.`,
      species: worstCollateral.species,
      spriteUrl: worstCollateral.spriteUrl,
      playerName: worstCollateral.triggeredByPlayerName,
    });
  }

  // 4. Deadliest Gym Split
  const splitsWithDeaths = splits.filter((s) => s.deaths.length > 0)
    .sort((a, b) => b.deaths.length - a.deaths.length);
  if (splitsWithDeaths.length > 0) {
    const worstSplit = splitsWithDeaths[0];
    const featuredVictim = worstSplit.deaths.find((d) => d.species && !usedAwardSpecies.has(d.species)) ?? worstSplit.deaths[0];
    if (featuredVictim?.species) usedAwardSpecies.add(featuredVictim.species);
    awards.push({
      id: 'deadliest-split',
      icon: '💀',
      title: 'Bloodiest Gym Split',
      headline: `${worstSplit.leader} Split (${worstSplit.deaths.length} Fallen)`,
      detail: `Claimed ${worstSplit.deaths.map((d) => d.nickname || d.speciesName).slice(0, 3).join(', ')} at ${worstSplit.location}.`,
      species: featuredVictim?.species ?? null,
      spriteUrl: featuredVictim?.spriteUrl ?? null,
      playerName: featuredVictim?.playerName ?? null,
    });
  }

  // 5. Butterfingers (Missed encounters)
  if (missedEncounters > 0) {
    const lostByPlayer = new Map();
    for (const ev of events) {
      if (ev?.type === 'encounter.resolve' && ev?.result === 'lost' && ev.playerId) {
        lostByPlayer.set(ev.playerId, (lostByPlayer.get(ev.playerId) ?? 0) + 1);
      }
    }
    const topLosingEntry = [...lostByPlayer.entries()].sort((a, b) => b[1] - a[1])[0];
    const culpritName = topLosingEntry ? playerNameFor(topLosingEntry[0]) : 'The Party';
    const culpritCount = topLosingEntry ? topLosingEntry[1] : missedEncounters;
    awards.push({
      id: 'butterfingers',
      icon: '🧈',
      title: 'Slippery Poké Balls',
      headline: `${culpritName} (${culpritCount} Missed Route${culpritCount === 1 ? '' : 's'})`,
      detail: `${missedEncounters} wild route encounter${missedEncounters === 1 ? ' was' : 's were'} KO’d or fled before capture.`,
      species: null,
      spriteUrl: null,
      playerName: culpritName,
    });
  }

  // 6. Clause Magnet (Dupes rerolls)
  if (clauseRerolls > 0) {
    awards.push({
      id: 'clause-magnet',
      icon: '🧬',
      title: 'Dupes Clause Magnet',
      headline: `${clauseRerolls} Duplicate Reroll${clauseRerolls === 1 ? '' : 's'}`,
      detail: `Saved ${clauseRerolls} route encounter${clauseRerolls === 1 ? '' : 's'} from duplicate species.`,
      species: null,
      spriteUrl: null,
      playerName: null,
    });
  }

  const metrics = {
    badgesEarned: badgeCount,
    routesVisited: visitedRoutesCount,
    totalRoutes,
    encountersCaught: totalCatches,
    catchRatePercent,
    linksFormed,
    linksSurvived,
    linksBroken,
    totalDeaths,
    directDeaths,
    collateralDeaths,
    missedEncounters,
    clauseRerolls,
    survivalRatePercent,
  };

  const stats = [
    {
      id: 'badges',
      label: 'Badges Earned',
      value: `${badgeCount} / 8`,
      detail: isVictory ? 'Pokémon League Champion' : `Current cap: ${currentSplit.leader}`,
    },
    {
      id: 'routes',
      label: 'Routes Explored',
      value: `${visitedRoutesCount}`,
      detail: `${successfulWildAreas.length} claimed · ${missedEncounters} missed`,
    },
    {
      id: 'catches',
      label: 'Catch Conversion',
      value: `${catchRatePercent}%`,
      detail: catchDetailLabel,
    },
    {
      id: 'links',
      label: run.mode === 'nuzlocke' ? 'Survivors' : 'SoulLinks',
      value: run.mode === 'nuzlocke' ? `${survivingCatches}` : `${linksSurvived} / ${linksFormed}`,
      detail: run.mode === 'nuzlocke'
        ? `${survivalRatePercent}% survival rate`
        : `${linksSurvived} active · ${linksBroken} broken`,
    },
    {
      id: 'deaths',
      label: 'Fallen Pokémon',
      value: `${totalDeaths}`,
      detail: run.mode === 'soullink'
        ? `${directDeaths} fainted · ${collateralDeaths} linked`
        : `${survivalRatePercent}% survival rate`,
    },
    {
      id: 'duration',
      label: 'Run Duration',
      value: durationLabel,
      detail: `Seed ${run.seed}`,
    },
  ];

  const kicker = isVictory
    ? 'POKETÉCH HALL OF FAME'
    : (run.mode === 'nuzlocke' ? 'NUZLOCKE RUN FELL' : 'SOULLINK RUN FELL');
  const title = isVictory
    ? 'Hall of Fame Champions'
    : (run.mode === 'nuzlocke' ? 'Run Over' : 'Group Wipe');
  const subtitle = isVictory
    ? `Entered the Ever Grande Hall of Fame with ${badgeCount}/8 Badges · Seed ${run.seed}`
    : (wipeDetail?.reason ?? `No living Pokémon remain in the active party · ${badgeCount}/8 Badges`);

  return {
    status: run.status,
    outcome,
    kicker,
    title,
    subtitle,
    seed: run.seed,
    mode: run.mode,
    badgeCount,
    durationMs,
    durationLabel,
    rulePills: buildRulePills(run),
    wipeDetail,
    stats,
    metrics,
    awards,
    champions,
    graveyard,
    splits,
  };
}
