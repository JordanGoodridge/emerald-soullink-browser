// Game-agnostic party snapshot model.
//
// A pack adapter reads its engine's party and normalizes it into this shape;
// the shared shell publishes and renders it. Nothing here reads engine memory
// or the network. Party data is presentation-only: it never mutates saves or
// party state, and it never carries moves, items, save bytes or rule decisions.

export const PARTY_MAX_MEMBERS = 6;
export const PARTY_NICKNAME_MAX = 24;
export const PARTY_SPECIES_NAME_MAX = 32;
export const PARTY_SPECIES_MAX = 65535;
export const PARTY_LEVEL_MAX = 100;

export const PARTY_AVAILABILITY = Object.freeze([
  'available',
  'hidden',
  'unavailable',
  'stale',
]);

// A peer whose pack/game has no party support, or that is not publishing yet.
export function partyUnavailable() {
  return { availability: 'unavailable', members: [], revision: 0 };
}

// Canonical, cheap change-detection key for a member list. Used by the reader
// to advance `revision` and by the transport to skip unchanged re-broadcasts.
export function partySignature(members = []) {
  const parts = [];
  for (const member of members) {
    if (!member) continue;
    parts.push([
      member.species ?? 0,
      member.speciesName ?? '',
      member.nickname ?? '',
      member.level ?? '',
      member.hp ?? '',
    ].join(':'));
  }
  return parts.join(';');
}

export function normalizePartyMember(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isInteger(value.species) || value.species < 1 || value.species > PARTY_SPECIES_MAX) {
    return null;
  }
  const member = { species: value.species };
  if (value.speciesName !== undefined && value.speciesName !== null) {
    if (typeof value.speciesName !== 'string' || !value.speciesName || value.speciesName.length > PARTY_SPECIES_NAME_MAX) {
      return null;
    }
    member.speciesName = value.speciesName;
  }
  if (value.nickname !== undefined && value.nickname !== null) {
    if (typeof value.nickname !== 'string' || !value.nickname || value.nickname.length > PARTY_NICKNAME_MAX) {
      return null;
    }
    member.nickname = value.nickname;
  }
  if (value.level !== undefined && value.level !== null) {
    if (!Number.isInteger(value.level) || value.level < 1 || value.level > PARTY_LEVEL_MAX) return null;
    member.level = value.level;
  }
  if (value.hp !== undefined && value.hp !== null) {
    if (!Number.isInteger(value.hp) || value.hp < 0) return null;
    member.hp = value.hp;
  }
  return member;
}

// Validates and normalizes a full snapshot into { availability, members, revision }.
export function normalizeParty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'party_invalid' };
  }
  const availability = value.availability ?? 'available';
  if (!PARTY_AVAILABILITY.includes(availability)) {
    return { ok: false, reason: 'availability_invalid' };
  }
  if (!Array.isArray(value.members)) return { ok: false, reason: 'members_invalid' };
  const members = [];
  for (const raw of value.members) {
    const member = normalizePartyMember(raw);
    if (!member) return { ok: false, reason: 'member_invalid' };
    members.push(member);
  }
  if (members.length > PARTY_MAX_MEMBERS) return { ok: false, reason: 'members_too_many' };
  if (value.revision !== undefined && (!Number.isInteger(value.revision) || value.revision < 0)) {
    return { ok: false, reason: 'revision_invalid' };
  }
  return {
    ok: true,
    party: { availability, members, revision: value.revision ?? 0 },
  };
}
