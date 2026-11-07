import test from 'node:test';
import assert from 'node:assert/strict';
import { describePresence, lobbyHint } from './lobby.mjs';

test('describes offline and joined lobby states', () => {
  assert.equal(describePresence(null), 'Not connected');
  assert.equal(describePresence({ status: 'disconnected', members: [] }), 'Not connected');
  assert.equal(describePresence({
    status: 'joined', room: 'ABCDEFGH', playerCount: 2, members: [],
  }), 'Connected — room ABCDEFGH — 2/4 players');
});

test('surfaces connection errors in the lobby', () => {
  assert.equal(describePresence({
    status: 'closed',
    lastError: { code: 'room_full', detail: null },
  }), 'room_full');
  assert.equal(describePresence({
    status: 'closed',
    lastError: { code: 'invalid_room', detail: 'Enter an 8-character room code.' },
  }), 'invalid_room: Enter an 8-character room code.');
  assert.equal(describePresence({
    status: 'closed',
    lastError: { code: 'run_in_progress', detail: null },
  }), 'This run has started. To continue it, load its saved run in a new room.');
});

test('offers a one-click rejoin after a terminal disconnect', () => {
  assert.equal(lobbyHint({
    status: 'closed',
    room: 'ABCD2345',
    lastError: { code: 'session_expired', detail: 'reservation expired' },
  }), 'Disconnected (session_expired). Press Join room to rejoin ABCD2345.');
});

test('explains why a reconnect is still running', () => {
  assert.equal(lobbyHint({ status: 'reconnecting' }), 'Reconnecting…');
  assert.equal(lobbyHint({ status: 'reconnecting', lastClose: { code: 1006, reason: '' } }),
    'Reconnecting (1006)…');
  assert.equal(lobbyHint({ status: 'reconnecting', lastClose: { code: 4000, reason: 'network lost' } }),
    'Reconnecting (network lost)…');
});

test('hints only while a session is usable', () => {
  assert.equal(lobbyHint({ status: 'closed', room: 'ABCD2345' }), '');
  assert.equal(lobbyHint({ status: 'joined', room: 'ABCD2345', clockReady: false }),
    'Syncing clocks for smooth movement…');
  assert.equal(lobbyHint({ status: 'joined', room: 'ABCD2345', clockReady: true, activity: 'overworld' }),
    'Walk around in the same outdoor area to see each other.');
  assert.equal(lobbyHint({ status: 'joined', clockReady: true, activity: 'unsupported' }),
    'This area cannot show other players yet. Only the clean outdoor 3D view is supported.');
  assert.equal(lobbyHint({ status: 'joined', avatarStatus: 'loading' }), 'Loading trainer sprites…');
});
