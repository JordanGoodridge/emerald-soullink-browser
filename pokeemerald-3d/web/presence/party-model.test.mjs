import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeParty,
  normalizePartyMember,
  PARTY_MAX_MEMBERS,
  partySignature,
  partyUnavailable,
} from './party-model.mjs';

test('normalizes a member with optional fields and drops omitted ones', () => {
  assert.deepEqual(normalizePartyMember({ species: 25, nickname: 'Pikachu', level: 18, hp: 42 }), {
    species: 25, nickname: 'Pikachu', level: 18, hp: 42,
  });
  assert.deepEqual(normalizePartyMember({ species: 1 }), { species: 1 });
});

test('rejects malformed members', () => {
  assert.equal(normalizePartyMember(null), null);
  assert.equal(normalizePartyMember({}), null);
  assert.equal(normalizePartyMember({ species: 0 }), null);
  assert.equal(normalizePartyMember({ species: 1.5 }), null);
  assert.equal(normalizePartyMember({ species: 1, level: 0 }), null);
  assert.equal(normalizePartyMember({ species: 1, level: 101 }), null);
  assert.equal(normalizePartyMember({ species: 1, hp: -1 }), null);
  assert.equal(normalizePartyMember({ species: 1, nickname: '' }), null);
  assert.equal(normalizePartyMember({ species: 1, nickname: 'x'.repeat(25) }), null);
});

test('normalizes a full snapshot', () => {
  const result = normalizeParty({
    availability: 'available',
    members: [{ species: 25 }, { species: 6, level: 40, hp: 120 }],
    revision: 3,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.party, {
    availability: 'available',
    members: [{ species: 25 }, { species: 6, level: 40, hp: 120 }],
    revision: 3,
  });
});

test('defaults availability to available and revision to 0', () => {
  const result = normalizeParty({ members: [{ species: 1 }] });
  assert.equal(result.ok, true);
  assert.equal(result.party.availability, 'available');
  assert.equal(result.party.revision, 0);
});

test('rejects invalid availability, members and revision', () => {
  assert.equal(normalizeParty({ members: [], availability: 'nope' }).ok, false);
  assert.equal(normalizeParty({ members: 'not-an-array' }).ok, false);
  assert.equal(normalizeParty({ members: [null] }).ok, false);
  assert.equal(normalizeParty({ members: [], revision: -1 }).ok, false);
});

test('rejects a party larger than the shared cap', () => {
  const members = Array.from({ length: PARTY_MAX_MEMBERS + 1 }, (_, index) => ({ species: index + 1 }));
  const result = normalizeParty({ members });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'members_too_many');
});

test('partyUnavailable is a fail-closed empty snapshot', () => {
  assert.deepEqual(partyUnavailable(), { availability: 'unavailable', members: [], revision: 0 });
});

test('partySignature is stable and change-sensitive', () => {
  const a = [{ species: 25, level: 18 }, { species: 6 }];
  const b = [{ species: 25, level: 19 }, { species: 6 }];
  assert.equal(partySignature(a), partySignature([{ species: 25, level: 18 }, { species: 6 }]));
  assert.notEqual(partySignature(a), partySignature(b));
  assert.equal(partySignature([]), '');
});
