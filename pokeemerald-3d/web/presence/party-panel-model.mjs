// DOM-free model for the party panel: local party plus peers' published
// snapshots and the SoulLink pairs that connect them.
//
// Everything here is presentation data. It never mutates party or save state,
// and it never decides rules; linked pairs are read from the run core.

import { PARTY_MAX_MEMBERS } from './party-model.mjs';
import { memberFreshness, memberMapName } from './member-status.mjs';

const MAX_PLAYERS = 4;

function displayName(members, playerId) {
  const found = members.find((member) => member?.playerId === playerId);
  return found?.name || 'Player';
}

function resolveAreaLabel(areaKey, areas, areaLabelFor) {
  if (!areaKey) return null;
  const fromArea = areas?.[areaKey]?.label;
  if (typeof fromArea === 'string' && fromArea.trim()) return fromArea.trim();
  const fromCallback = areaLabelFor?.(areaKey);
  if (typeof fromCallback === 'string' && fromCallback.trim()) return fromCallback.trim();
  const raw = String(areaKey);
  if (raw === 'starter' || raw.endsWith(':starter')) return 'Starter';
  const giftMatch = raw.match(/:gift:([^:]+)$/i);
  if (giftMatch) return `Gift (${giftMatch[1].replace(/_/g, ' ')})`;
  const sectionMatch = raw.match(/:section:(\d+)$/i);
  if (sectionMatch) return `Area ${sectionMatch[1]}`;
  return raw;
}

function pairDisplayLabel(pair) {
  return pair?.nickname || pair?.speciesName || (pair?.species ? `#${pair.species}` : 'Unknown');
}

function normalizeMembers(party, speciesNameFor) {
  if (!Array.isArray(party?.members)) return [];
  return party.members.slice(0, PARTY_MAX_MEMBERS).map((member) => ({
    species: member.species,
    speciesName: member.speciesName ?? speciesNameFor?.(member.species) ?? null,
    nickname: member.nickname ?? null,
    level: member.level ?? null,
    hp: member.hp ?? null,
  }));
}

function attachInlineLinksToParty(player, linkList) {
  if (!Array.isArray(player?.members) || !player.members.length || !linkList.length) return;
  const usedLinkIndices = new Set();

  for (const member of player.members) {
    if (!member?.species) continue;
    let matchedIndex = -1;

    // Prefer exact species + nickname match first when both specify a nickname.
    if (member.nickname) {
      matchedIndex = linkList.findIndex((link, idx) => !usedLinkIndices.has(idx)
        && link.pairs.some((pair) => pair.playerId === player.playerId
          && pair.species === member.species
          && pair.nickname === member.nickname));
    }
    if (matchedIndex === -1) {
      matchedIndex = linkList.findIndex((link, idx) => !usedLinkIndices.has(idx)
        && link.pairs.some((pair) => pair.playerId === player.playerId
          && pair.species === member.species));
    }
    if (matchedIndex === -1) continue;

    usedLinkIndices.add(matchedIndex);
    const link = linkList[matchedIndex];
    if (link.status !== 'dead') {
      link.placement = 'party';
    }
    const partnerPairs = link.pairs.filter((pair) => pair.playerId !== player.playerId);
    member.link = {
      linkId: link.linkId,
      status: link.status,
      areaKey: link.areaKey,
      areaLabel: link.areaLabel,
      partners: partnerPairs.map((pair) => ({
        playerId: pair.playerId,
        name: pair.name,
        species: pair.species,
        speciesName: pair.speciesName,
        nickname: pair.nickname,
        label: pairDisplayLabel(pair),
      })),
    };
  }
}

export function buildPartyPanel({
  self = null,
  members = [],
  parties = {},
  links = {},
  areas = {},
  areaLabelFor = null,
  speciesNameFor = () => null,
  serverNowMs = null,
  visibleSnapshotAgeMs = 5000,
  nameFor = () => null,
} = {}) {
  const players = [];
  if (self) {
    players.push({
      playerId: self.playerId,
      name: displayName(members, self.playerId),
      isSelf: true,
      stale: false,
      mapName: null,
      availability: self.party?.availability ?? 'unavailable',
      members: normalizeMembers(self.party, speciesNameFor),
    });
  }
  for (const [playerId, party] of Object.entries(parties ?? {})) {
    if (players.length >= MAX_PLAYERS) break;
    if (self && playerId === self.playerId) continue;
    const member = members.find((candidate) => candidate?.playerId === playerId) ?? null;
    const { stale } = memberFreshness(member, { serverNowMs, visibleSnapshotAgeMs });
    players.push({
      playerId,
      name: displayName(members, playerId),
      isSelf: false,
      stale,
      mapName: memberMapName(member, nameFor),
      availability: party?.availability ?? 'unavailable',
      members: normalizeMembers(party, speciesNameFor),
    });
  }

  const linkList = [];
  for (const link of Object.values(links ?? {})) {
    if (!link || !Array.isArray(link.members)) continue;
    const status = link.status ?? 'active';
    const areaKey = link.areaKey ?? null;
    linkList.push({
      linkId: link.linkId ?? null,
      areaKey,
      areaLabel: resolveAreaLabel(areaKey, areas, areaLabelFor),
      status,
      placement: status === 'dead' ? 'dead' : 'boxed',
      pairs: link.members.map((entry) => ({
        playerId: entry.playerId,
        name: displayName(members, entry.playerId),
        species: entry.species ?? null,
        speciesName: entry.speciesName ?? speciesNameFor?.(entry.species) ?? null,
        nickname: entry.nickname ?? null,
        level: entry.level ?? null,
        status: entry.status ?? 'alive',
      })),
    });
  }

  for (const player of players) {
    attachInlineLinksToParty(player, linkList);
  }

  return { players, links: linkList };
}
