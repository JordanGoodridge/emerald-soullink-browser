// Transport-free shared run state and event reducer.

export const MIN_RUN_PLAYERS = 2;
export const MAX_RUN_PLAYERS = 4;

function clone(value) {
  return structuredClone(value);
}

function memberExists(state, playerId) {
  return state.members.some((member) => member.playerId === playerId && member.active !== false);
}

export function createRunState({
  runId,
  gameId = 'emerald',
  contentVersion,
  seed,
  mode = 'soullink',
  options = {},
  members = [],
  allowSolo = false,
  hostPlayerId = null,
  startedAt = null,
} = {}) {
  if (typeof runId !== 'string' || !runId) throw new Error('run requires runId');
  if (typeof seed !== 'string' && !Number.isSafeInteger(seed)) throw new Error('run requires a seed');
  const minimumPlayers = allowSolo ? 1 : MIN_RUN_PLAYERS;
  if (!Array.isArray(members) || members.length < minimumPlayers || members.length > MAX_RUN_PLAYERS) {
    throw new Error(`run must have ${minimumPlayers}-${MAX_RUN_PLAYERS} members`);
  }
  const ids = new Set();
  const normalizedMembers = members.map((member, slot) => {
    if (typeof member?.playerId !== 'string' || !member.playerId || ids.has(member.playerId)) {
      throw new Error('run members require unique player IDs');
    }
    ids.add(member.playerId);
    return {
      playerId: member.playerId,
      name: typeof member.name === 'string' ? member.name : 'Player',
      slot,
      active: member.active !== false,
      ready: false,
    };
  });
  return {
    runId,
    gameId,
    contentVersion: contentVersion ?? null,
    seed,
    mode,
    options: clone(options),
    hostPlayerId: hostPlayerId ?? normalizedMembers[0].playerId,
    status: 'active',
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    endedAt: null,
    wipe: null,
    champions: {},
    members: normalizedMembers,
    areas: {},
    links: {},
    deaths: [],
    ownedSpecies: Object.fromEntries(normalizedMembers.map((member) => [member.playerId, []])),
    progress: { gymIndex: 0 },
    events: [],
    revision: 0,
    appliedEventIds: [],
  };
}

function reject(state, reason) {
  return { state, accepted: false, reason, effects: [] };
}

export function reduceRunEvent(current, event) {
  if (!current || typeof current !== 'object') throw new Error('run state is required');
  if (typeof event?.eventId !== 'string' || !event.eventId) return reject(current, 'event_id_required');
  if (current.appliedEventIds.includes(event.eventId)) {
    return { state: current, accepted: false, duplicate: true, reason: 'duplicate_event', effects: [] };
  }
  if (current.status === 'closed' && event.type !== 'run.reset') return reject(current, 'run_closed');

  const state = clone(current);
  const effects = [];
  const playerId = event.playerId;
  if (state.startedAt === null && Number.isFinite(event.at)) {
    state.startedAt = event.at;
  }
  if (Number.isInteger(event.badgeCount) && event.badgeCount >= 0 && event.badgeCount <= 8) {
    state.progress = {
      ...(state.progress ?? {}),
      gymIndex: Math.max(state.progress?.gymIndex ?? 0, event.badgeCount),
    };
  }

  switch (event.type) {
    case 'area.visit': {
      if (!memberExists(state, playerId)) return reject(current, 'unknown_player');
      if (state.status !== 'active') return reject(current, 'run_not_active');
      if (typeof event.areaKey !== 'string' || !event.areaKey) return reject(current, 'area_required');
      const area = state.areas[event.areaKey] ?? {
        areaKey: event.areaKey,
        sectionId: event.sectionId ?? null,
        label: event.label ?? event.areaKey,
        status: 'available',
        claims: {},
        skips: [],
        linkId: null,
        visits: [],
      };
      area.visits ??= [];
      if (!area.visits.some((visit) => visit.playerId === playerId)) {
        area.visits.push({ playerId, at: event.at ?? null });
      }
      if (!area.claims[playerId] && ['open', 'available'].includes(area.status)) area.status = 'available';
      state.areas[event.areaKey] = area;
      break;
    }
    case 'encounter.claim': {
      if (!memberExists(state, playerId)) return reject(current, 'unknown_player');
      if (state.status !== 'active') return reject(current, 'run_not_active');
      if (typeof event.areaKey !== 'string' || !event.areaKey) return reject(current, 'area_required');
      if (!Number.isInteger(event.species) || event.species <= 0) return reject(current, 'species_invalid');
      const isGiftClaim = event.isGift === true
        && /^emerald:gift:(?:starter|\d+:\d+)$/.test(event.areaKey);
      const area = state.areas[event.areaKey] ?? {
        areaKey: event.areaKey,
        sectionId: event.sectionId ?? null,
        label: event.label ?? event.areaKey,
        status: 'open',
        claims: {},
        skips: [],
        linkId: null,
      };
      if (area.status === 'void' || area.status === 'dead') return reject(current, area.status === 'void' ? 'area_void' : 'area_dead');
      if (area.claims[playerId]) return reject(current, 'area_already_claimed');
      if (!isGiftClaim && state.options.dupesClause === true
          && (state.ownedSpecies[playerId] ?? []).includes(event.species)) return reject(current, 'dupes_clause');
      if (!isGiftClaim && state.options.partnerSpeciesClause === true
          && Object.entries(state.ownedSpecies).some(([ownerId, speciesList]) => ownerId !== playerId
            && speciesList.includes(event.species))) return reject(current, 'partner_species_clause');
      area.claims[playerId] = {
        playerId,
        species: event.species,
        pid: event.pid ?? null,
        nickname: event.nickname ?? null,
        level: Number.isInteger(event.level) ? event.level : null,
        status: 'claimed',
        isGift: isGiftClaim,
        at: event.at ?? null,
      };
      // Seeing an encounter claims an area's slot, but the link is not
      // complete until every continuing player actually catches theirs.
      area.status = 'pending';
      state.areas[event.areaKey] = area;
      break;
    }
    case 'encounter.skip': {
      if (!memberExists(state, playerId)) return reject(current, 'unknown_player');
      if (state.status !== 'active') return reject(current, 'run_not_active');
      if (typeof event.areaKey !== 'string' || !event.areaKey) return reject(current, 'area_required');
      if (!Number.isInteger(event.species) || event.species <= 0) return reject(current, 'species_invalid');
      const area = state.areas[event.areaKey] ?? {
        areaKey: event.areaKey,
        sectionId: event.sectionId ?? null,
        label: event.label ?? event.areaKey,
        status: 'open',
        claims: {},
        skips: [],
        linkId: null,
      };
      if (area.status === 'void' || area.status === 'dead') return reject(current, 'area_closed');
      if (area.claims[playerId]) return reject(current, 'area_already_claimed');
      area.skips ??= [];
      area.skips.push({ playerId, species: event.species, reason: event.reason ?? 'clause', at: event.at ?? null });
      area.status = Object.keys(area.claims).length ? 'pending' : 'open';
      state.areas[event.areaKey] = area;
      break;
    }
    case 'encounter.resolve': {
      if (!memberExists(state, playerId)) return reject(current, 'unknown_player');
      const area = state.areas[event.areaKey];
      if (!area) return reject(current, 'area_unclaimed');
      if (!['caught', 'lost', 'skipped'].includes(event.result)) return reject(current, 'resolution_invalid');
      const claim = area.claims[playerId];
      if (area.status === 'void' || area.status === 'dead') {
        if (event.result === 'caught' && claim && claim.species && claim.status !== 'dead') {
          claim.status = area.status;
          if (Number.isInteger(claim.species)) {
            const owned = state.ownedSpecies[playerId] ?? (state.ownedSpecies[playerId] = []);
            if (!owned.includes(claim.species)) owned.push(claim.species);
          }
          if (area.status === 'void') {
            effects.push({
              type: 'release-area',
              areaKey: event.areaKey,
              members: [{ playerId, pid: claim.pid, species: claim.species }],
            });
          } else {
            effects.push({
              type: 'release-pokemon',
              areaKey: event.areaKey,
              playerId,
              pid: claim.pid,
              species: claim.species,
              reason: 'soullink',
            });
          }
          break;
        }
        return reject(current, 'area_unclaimed');
      }
      if (!claim) {
        if (event.result !== 'lost') return reject(current, 'claim_required');
        area.claims[playerId] = { playerId, species: null, status: 'lost', pid: null, level: null };
      } else {
        if (!['claimed', 'caught'].includes(claim.status)) return reject(current, 'claim_resolved');
        if (event.result === 'skipped') {
          // A dupe-clause reroll leaves this player's area slot open. The
          // skipped species remains auditable in the event log, not as claim.
          delete area.claims[playerId];
          area.status = Object.keys(area.claims).length ? 'pending' : 'open';
        } else {
          claim.status = event.result;
          if (event.result === 'caught' && Number.isInteger(claim.species)) {
            const owned = state.ownedSpecies[playerId] ?? (state.ownedSpecies[playerId] = []);
            if (!owned.includes(claim.species)) owned.push(claim.species);
          }
        }
      }
      if (event.result === 'lost') {
        area.status = 'void';
        if (area.linkId && state.links[area.linkId]) state.links[area.linkId].status = 'void';
        const released = [];
        for (const otherClaim of Object.values(area.claims)) {
          if (otherClaim.species && otherClaim.status !== 'dead') {
            if ((otherClaim.status === 'caught' || otherClaim.status === 'claimed')
                && otherClaim.pid !== null && otherClaim.pid !== undefined) {
              released.push({ playerId: otherClaim.playerId, pid: otherClaim.pid, species: otherClaim.species });
            }
            otherClaim.status = 'void';
          }
        }
        effects.push({ type: 'release-area', areaKey: event.areaKey, members: released });
      } else if (event.result === 'caught') {
        const continuing = state.members.filter((member) => member.active !== false);
        const allCaught = continuing.every((member) => area.claims[member.playerId]?.status === 'caught');
        const caught = Object.values(area.claims).filter((claim) => claim.status === 'caught');
        if (state.mode === 'nuzlocke') {
          area.status = allCaught ? 'caught' : 'pending';
        } else if (caught.length >= 2) {
          const linkId = `link:${event.areaKey}`;
          area.linkId = linkId;
          // Link the players who have caught now. Other active players retain
          // their own unresolved slots and can join this link when they catch.
          const existing = state.links[linkId];
          state.links[linkId] = {
            ...existing,
            linkId,
            areaKey: event.areaKey,
            status: 'active',
            members: caught.map((claim) => ({
              playerId: claim.playerId,
              species: claim.species,
              pid: claim.pid,
              nickname: claim.nickname,
              level: claim.level,
              status: 'alive',
            })),
          };
          area.status = allCaught ? 'linked' : 'pending';
        } else {
          area.status = allCaught ? 'linked' : 'pending';
        }
      }
      break;
    }
    case 'death': {
      if (!memberExists(state, playerId)) return reject(current, 'unknown_player');
      const badgeCount = Number.isInteger(event.badgeCount) ? event.badgeCount : (state.progress?.gymIndex ?? 0);
      let link = state.links[event.linkId];
      if (!link && state.mode === 'nuzlocke' && typeof event.areaKey === 'string') {
        const area = state.areas[event.areaKey];
        const claim = Object.values(area?.claims ?? {}).find((candidate) => candidate.playerId === playerId
          && candidate.pid === event.pid && candidate.status === 'caught');
        if (!area || area.status !== 'caught' || !claim) return reject(current, 'link_not_found');
        const priorDeath = state.deaths.some((death) => death.playerId === playerId && death.pid === event.pid);
        if (priorDeath) return reject(current, 'link_not_active');
        const deathLevel = Number.isInteger(event.level) ? event.level : (claim.level ?? null);
        const deathNickname = typeof event.nickname === 'string' && event.nickname ? event.nickname : (claim.nickname ?? null);
        area.status = 'dead';
        claim.status = 'dead';
        if (deathLevel !== null) claim.level = deathLevel;
        if (deathNickname !== null) claim.nickname = deathNickname;
        state.deaths.push({
          linkId: null,
          areaKey: event.areaKey,
          sectionId: event.sectionId ?? area.sectionId ?? null,
          playerId,
          triggeredByPlayerId: playerId,
          species: claim.species,
          pid: claim.pid,
          level: deathLevel,
          nickname: deathNickname,
          badgeCount,
          cause: event.cause ?? 'fainted',
          at: event.at ?? null,
          eventId: event.eventId,
        });
        effects.push({ type: 'release-pokemon', playerId, pid: claim.pid, species: claim.species, safePoint: true });
        break;
      }
      if (!link && typeof event.areaKey === 'string') {
        const area = state.areas[event.areaKey];
        const faintedClaim = Object.values(area?.claims ?? {}).find((claim) => claim.pid === event.pid && claim.status === 'caught');
        if (!area || !faintedClaim || area.status !== 'pending') return reject(current, 'link_not_found');
        area.status = 'dead';
        const linkId = `link:${event.areaKey}`;
        link = state.links[linkId] = {
          linkId,
          areaKey: event.areaKey,
          status: 'dead',
          members: Object.values(area.claims).filter((claim) => claim.status === 'caught').map((claim) => ({
            playerId: claim.playerId, species: claim.species, pid: claim.pid,
            nickname: claim.nickname, level: claim.level, status: 'dead',
          })),
        };
      }
      if (!link) return reject(current, 'link_not_found');
      if (link.status !== 'active' && link.status !== 'dead') return reject(current, 'link_not_active');
      const wasAlreadyDead = link.status === 'dead';
      link.status = 'dead';
      for (const member of link.members) {
        const priorDeath = state.deaths.some((death) => death.linkId === link.linkId
          && death.playerId === member.playerId && death.pid === member.pid);
        if (priorDeath) continue;
        const isTrigger = member.playerId === playerId;
        const memberLevel = isTrigger && Number.isInteger(event.level) ? event.level : (member.level ?? null);
        const memberNickname = isTrigger && typeof event.nickname === 'string' && event.nickname ? event.nickname : (member.nickname ?? null);
        member.status = 'dead';
        if (memberLevel !== null) member.level = memberLevel;
        if (memberNickname !== null) member.nickname = memberNickname;
        state.deaths.push({
          linkId: link.linkId,
          areaKey: link.areaKey,
          sectionId: event.sectionId ?? state.areas[link.areaKey]?.sectionId ?? null,
          playerId: member.playerId,
          triggeredByPlayerId: playerId,
          species: member.species,
          pid: member.pid,
          level: memberLevel,
          nickname: memberNickname,
          badgeCount,
          cause: event.cause ?? 'fainted',
          at: event.at ?? null,
          eventId: event.eventId,
        });
        effects.push({ type: 'release-pokemon', playerId: member.playerId, pid: member.pid, species: member.species, safePoint: true });
      }
      const area = state.areas[link.areaKey];
      if (area) {
        area.status = 'dead';
        for (const claim of Object.values(area.claims)) {
          if (claim.status === 'caught') claim.status = 'dead';
        }
      }
      if (wasAlreadyDead && effects.length === 0) return reject(current, 'link_not_active');
      break;
    }
    case 'wipe.pending': {
      if (!memberExists(state, playerId)) return reject(current, 'unknown_player');
      const badgeCount = Number.isInteger(event.badgeCount) ? event.badgeCount : (state.progress?.gymIndex ?? 0);
      state.status = 'wipe_pending';
      state.endedAt = event.at ?? state.endedAt ?? null;
      state.wipe = {
        playerId,
        areaKey: typeof event.areaKey === 'string' ? event.areaKey : null,
        sectionId: Number.isInteger(event.sectionId) ? event.sectionId : null,
        badgeCount,
        at: event.at ?? null,
      };
      for (const member of state.members) member.ready = false;
      state.members.find((member) => member.playerId === playerId).ready = event.ready === true;
      break;
    }
    case 'run.victory': {
      if (!memberExists(state, playerId)) return reject(current, 'unknown_player');
      if (state.status !== 'active' && state.status !== 'victory') return reject(current, 'run_not_active');
      const badgeCount = Number.isInteger(event.badgeCount) ? event.badgeCount : 8;
      state.champions ??= {};
      const party = Array.isArray(event.party)
        ? event.party.slice(0, 6).map((mon) => ({
            species: Number.isInteger(mon?.species) ? mon.species : 0,
            level: Number.isInteger(mon?.level) ? mon.level : null,
            nickname: typeof mon?.nickname === 'string' && mon.nickname ? mon.nickname : null,
            pid: Number.isInteger(mon?.pid) ? (mon.pid >>> 0) : null,
            moves: Array.isArray(mon?.moves) ? mon.moves.filter((m) => Number.isInteger(m) && m > 0).slice(0, 4) : [],
          })).filter((mon) => mon.species > 0)
        : [];
      state.champions[playerId] = {
        playerId,
        party,
        sectionId: Number.isInteger(event.sectionId) ? event.sectionId : null,
        badgeCount,
        at: event.at ?? null,
      };
      state.progress = { ...(state.progress ?? {}), gymIndex: Math.max(state.progress?.gymIndex ?? 0, badgeCount) };
      if (state.status !== 'victory') {
        state.status = 'victory';
        state.endedAt = event.at ?? state.endedAt ?? null;
        for (const member of state.members) member.ready = false;
      }
      break;
    }
    case 'run.ready': {
      if (state.status !== 'wipe_pending' && state.status !== 'victory') return reject(current, 'wipe_not_pending');
      const member = state.members.find((candidate) => candidate.playerId === playerId);
      if (!member || !member.active) return reject(current, 'unknown_player');
      member.ready = event.ready !== false;
      break;
    }
    case 'run.exclude-member': {
      if (state.status !== 'wipe_pending' && state.status !== 'victory') return reject(current, 'wipe_not_pending');
      if (!memberExists(state, playerId) || !memberExists(state, event.excludedPlayerId)) return reject(current, 'unknown_player');
      if (playerId === event.excludedPlayerId) return reject(current, 'cannot_self_exclude');
      const excluded = state.members.find((member) => member.playerId === event.excludedPlayerId);
      excluded.active = false;
      excluded.ready = false;
      break;
    }
    case 'run.reset': {
      if (state.status !== 'wipe_pending' && state.status !== 'victory') return reject(current, 'wipe_not_pending');
      const activeMembers = state.members.filter((member) => member.active);
      if (activeMembers.length < 1) return reject(current, 'not_enough_active_players');
      if (activeMembers.some((member) => !member.ready)) return reject(current, 'players_not_ready');
      if (typeof event.nextRunId !== 'string' || !event.nextRunId || event.seed === undefined) return reject(current, 'new_run_identity_required');
      const reset = createRunState({
        runId: event.nextRunId,
        gameId: state.gameId,
        contentVersion: state.contentVersion,
        seed: event.seed,
        mode: state.mode,
        options: state.options,
        members: activeMembers,
        allowSolo: true,
        hostPlayerId: state.hostPlayerId,
        startedAt: event.at ?? null,
      });
      reset.revision = 1;
      reset.events = [{ ...event, revision: reset.revision }];
      reset.appliedEventIds = [event.eventId];
      return { state: reset, accepted: true, effects: [{ type: 'reset-run', runId: reset.runId, seed: reset.seed, playerIds: activeMembers.map((member) => member.playerId) }] };
    }
    default:
      return reject(current, 'event_type_unknown');
  }

  state.revision++;
  state.events.push({ ...event, revision: state.revision });
  state.appliedEventIds.push(event.eventId);
  return { state, accepted: true, effects };
}
