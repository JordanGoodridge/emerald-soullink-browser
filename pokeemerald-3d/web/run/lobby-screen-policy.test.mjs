import test from 'node:test';
import assert from 'node:assert/strict';
import { canStartLobby, lobbyScreenPolicy } from './lobby-screen-policy.mjs';

test('Standard defaults to a visible settings panel and permits an offline one-player start', () => {
  const policy = lobbyScreenPolicy('standard');
  assert.equal(policy.requireMultiplePlayersToStart, false);
  assert.equal(policy.showSettings, true);
  assert.equal(canStartLobby(policy, { playerCount: 1, roomJoined: false, isHost: false }), true);
});

test('SoulLink defaults retain the room, host, settings, and multiple-player requirements', () => {
  const policy = lobbyScreenPolicy('soullink');
  assert.equal(policy.requireMultiplePlayersToStart, true);
  assert.equal(policy.showSettings, true);
  assert.equal(canStartLobby(policy, { playerCount: 1, roomJoined: true, isHost: true }), false);
  assert.equal(canStartLobby(policy, { playerCount: 2, roomJoined: false, isHost: true }), false);
  assert.equal(canStartLobby(policy, { playerCount: 2, roomJoined: true, isHost: false }), false);
  assert.equal(canStartLobby(policy, { playerCount: 2, roomJoined: true, isHost: true }), true);
});

test('lobby policy overrides can independently hide settings and relax start requirements', () => {
  const policy = lobbyScreenPolicy('soullink', {
    requireMultiplePlayersToStart: false,
    showSettings: false,
  });
  assert.equal(policy.showSettings, false);
  assert.equal(canStartLobby(policy, { playerCount: 1, roomJoined: true, isHost: true }), true);
});
