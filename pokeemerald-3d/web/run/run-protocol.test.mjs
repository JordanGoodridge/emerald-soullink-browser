import test from 'node:test';
import assert from 'node:assert/strict';
import { RUN_PROTOCOL_VERSION, validateRunClientMessage } from './run-protocol.mjs';

test('run attach uses existing room resume credentials and rejects extra credential fields', () => {
  assert.equal(validateRunClientMessage({
    v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: 'ABCD2345', playerId: 'p1', token: 'secret',
  }).ok, true);
  assert.equal(validateRunClientMessage({
    v: RUN_PROTOCOL_VERSION, type: 'run.attach', room: 'ABCD2345', playerId: 'p1', token: 'secret', account: 'not-used',
  }).ok, false);
});

test('run event types are restricted and caller cannot smuggle another player identity', () => {
  assert.equal(validateRunClientMessage({
    v: RUN_PROTOCOL_VERSION, type: 'run.event', event: { eventId: 'e1', type: 'encounter.claim', areaKey: 'r1', species: 25, playerId: 'victim' },
  }).ok, false);
  assert.equal(validateRunClientMessage({ v: RUN_PROTOCOL_VERSION, type: 'run.event', event: { eventId: 'e2', type: 'run.reset' } }).ok, false);
  assert.equal(validateRunClientMessage({
    v: RUN_PROTOCOL_VERSION, type: 'run.event', event: { eventId: 'e3', type: 'encounter.skip', areaKey: 'route101', species: 25, reason: 'dupes' },
  }).ok, true);
  assert.equal(validateRunClientMessage({
    v: RUN_PROTOCOL_VERSION, type: 'run.event', event: { eventId: 'e4', type: 'area.visit', areaKey: 'route101', sectionId: 10, label: 'Route 101' },
  }).ok, true);
});

test('run start options must be an object and leave is strict', () => {
  assert.equal(validateRunClientMessage({ v: RUN_PROTOCOL_VERSION, type: 'run.start', options: [] }).ok, false);
  assert.equal(validateRunClientMessage({ v: RUN_PROTOCOL_VERSION, type: 'run.restart' }).ok, true);
  assert.equal(validateRunClientMessage({ v: RUN_PROTOCOL_VERSION, type: 'run.restart', playerId: 'spoof' }).ok, false);
  assert.equal(validateRunClientMessage({ v: RUN_PROTOCOL_VERSION, type: 'run.leave' }).ok, true);
});

test('run restore requires a saved checkpoint object', () => {
  assert.equal(validateRunClientMessage({ v: RUN_PROTOCOL_VERSION, type: 'run.restore', checkpoint: { runState: {} } }).ok, true);
  assert.equal(validateRunClientMessage({ v: RUN_PROTOCOL_VERSION, type: 'run.restore', checkpoint: [] }).ok, false);
  assert.equal(validateRunClientMessage({ v: RUN_PROTOCOL_VERSION, type: 'run.restore', checkpoint: {}, extra: true }).ok, false);
});

test('lobby transfer chunks are bounded, ordered and scoped to supported purposes', () => {
  assert.equal(validateRunClientMessage({
    v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.begin', transferId: 'x1', recipientPlayerId: 'p1',
    purpose: 'slot-save', totalBytes: 5, chunkCount: 1,
  }).ok, true);
  assert.equal(validateRunClientMessage({
    v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.begin', transferId: 'x1', recipientPlayerId: '*',
    purpose: 'lobby-snapshot', totalBytes: 5, chunkCount: 1,
  }).ok, true);
  assert.equal(validateRunClientMessage({
    v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.chunk', transferId: 'x1', index: 0, data: 'YWJjZGU=',
  }).ok, true);
  assert.equal(validateRunClientMessage({
    v: RUN_PROTOCOL_VERSION, type: 'lobby.transfer.chunk', transferId: 'x1', index: -1, data: 'not-base64!',
  }).ok, false);
});
