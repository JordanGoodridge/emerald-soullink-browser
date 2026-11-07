import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_VERSION,
  PROTOCOL_VERSION,
  validateClientMessage,
  validateMember,
  validateSnapshot,
} from '../../pokeemerald-3d/web/presence/protocol.mjs';
import { member, snapshot, presence, battlePresence } from '../../pokeemerald-3d/web/presence/fixtures.mjs';

const envelope = (fields) => ({ v: PROTOCOL_VERSION, ...fields });

test('valid handshake messages are normalized', () => {
  const create = validateClientMessage(envelope({
    type: 'create', contentVersion: CONTENT_VERSION, name: '  Jordan  ',
  }));
  assert.equal(create.ok, true);
  assert.equal(create.value.name, 'Jordan');

  const join = validateClientMessage(envelope({
    type: 'join', room: 'ABCD2345', contentVersion: CONTENT_VERSION, name: 'May',
  }));
  assert.equal(join.ok, true);
});

test('unknown fields, types and versions are rejected', () => {
  assert.equal(validateClientMessage({ v: PROTOCOL_VERSION + 1, type: 'leave' }).code, 'incompatible_version');
  assert.equal(validateClientMessage(envelope({ type: 'leave', extra: true })).code, 'invalid_message');
  assert.equal(validateClientMessage(envelope({ type: 'create', contentVersion: CONTENT_VERSION, name: 'A', extra: 1 })).code, 'invalid_message');
  assert.equal(validateClientMessage(envelope({ type: 'unknown' })).code, 'invalid_message');
  assert.equal(validateClientMessage(envelope({ type: 'join', room: 'bad', contentVersion: CONTENT_VERSION, name: 'A' })).code, 'room_not_found');
});

test('names reject controls, empty values and excessive length', () => {
  for (const name of ['', '   ', 'a\nb', 'x'.repeat(25)]) {
    const result = validateClientMessage(envelope({ type: 'create', contentVersion: CONTENT_VERSION, name }));
    assert.equal(result.ok, false, name);
  }
  assert.equal(validateClientMessage(envelope({ type: 'create', contentVersion: CONTENT_VERSION, name: 'x'.repeat(24) })).ok, true);
});

test('presence validation enforces coordinates, pose/world and epochs', () => {
  const base = envelope({
    type: 'presence', generation: 1, seq: 1, sampleMs: 200, state: presence(),
  });
  assert.equal(validateClientMessage(base).ok, true);

  const poseWithoutWorld = {
    ...base,
    state: { ...presence(), world: null },
  };
  assert.equal(validateClientMessage(poseWithoutWorld).code, 'invalid_message');

  const outOfRange = {
    ...base,
    state: presence({ pose: { ...presence().pose, xPx: 2_000_000 } }),
  };
  assert.equal(validateClientMessage(outOfRange).code, 'invalid_message');

  const negativeJump = {
    ...base,
    state: presence({ pose: { ...presence().pose, jumpPx: -1 } }),
  };
  assert.equal(validateClientMessage(negativeJump).code, 'invalid_message');
});

test('battle anchors are accepted only on battle samples', () => {
  const battle = envelope({
    type: 'presence', generation: 1, seq: 1, sampleMs: 200, state: battlePresence(),
  });
  assert.equal(validateClientMessage(battle).ok, true);

  const wrongActivity = {
    ...battle,
    state: { ...battlePresence(), activity: 'overworld' },
  };
  assert.equal(validateClientMessage(wrongActivity).code, 'invalid_message');

  const missingWorld = {
    ...battle,
    state: { ...battlePresence(), battleAnchor: { world: null, pose: presence().pose, epoch: 1 } },
  };
  assert.equal(validateClientMessage(missingWorld).code, 'invalid_message');

  const badPose = {
    ...battle,
    state: {
      ...battlePresence(),
      battleAnchor: { world: battlePresence().battleAnchor.world, pose: { ...presence().pose, facing: 'sideways' }, epoch: 1 },
    },
  };
  assert.equal(validateClientMessage(badPose).code, 'invalid_message');

  const extraKey = {
    ...battle,
    state: { ...battlePresence(), party: [] },
  };
  assert.equal(validateClientMessage(extraKey).code, 'invalid_message');
});

test('resume requires a room, player id and token', () => {
  const base = { type: 'resume', room: 'ABCD2345', contentVersion: CONTENT_VERSION, playerId: 'p1', token: 't1' };
  assert.equal(validateClientMessage(envelope(base)).ok, true);
  assert.equal(validateClientMessage(envelope({ ...base, playerId: 'bad id' })).code, 'invalid_resume');
  assert.equal(validateClientMessage(envelope({ ...base, token: '' })).code, 'invalid_resume');
});

test('snapshot and member fixture shapes validate', () => {
  assert.equal(validateSnapshot(snapshot('p1')).ok, true);
  assert.equal(validateMember(member('p1', { latest: snapshot('p1') })).ok, true);
  assert.equal(validateMember({ ...member('p1'), token: 'secret' }).code, 'invalid_message');
});

test('party messages validate a bounded snapshot', () => {
  const valid = envelope({
    type: 'party',
    party: { availability: 'available', members: [{ species: 25, level: 18 }], revision: 1 },
  });
  const result = validateClientMessage(valid);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.party, { availability: 'available', members: [{ species: 25, level: 18 }], revision: 1 });

  assert.equal(validateClientMessage(envelope({ type: 'party' })).code, 'invalid_message');
  assert.equal(validateClientMessage(envelope({ type: 'party', party: 'nope' })).code, 'invalid_message');
  assert.equal(validateClientMessage(envelope({ type: 'party', party: { availability: 'nope', members: [] } })).code, 'invalid_message');
  assert.equal(validateClientMessage(envelope({ type: 'party', party: { members: [{ species: 0 }] } })).code, 'invalid_message');
  assert.equal(validateClientMessage(envelope({ type: 'party', party: { members: [] }, extra: 1 })).code, 'invalid_message');
});

test('party snapshots allow hidden and unavailable availability', () => {
  const hidden = envelope({ type: 'party', party: { availability: 'hidden', members: [], revision: 2 } });
  assert.equal(validateClientMessage(hidden).ok, true);
  const unavailable = envelope({ type: 'party', party: { availability: 'unavailable', members: [], revision: 0 } });
  assert.equal(validateClientMessage(unavailable).ok, true);
});
