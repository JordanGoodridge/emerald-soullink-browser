import test from 'node:test';
import assert from 'node:assert/strict';

import { LOBBY_TRANSFER_CHUNK_BYTES } from './run-protocol.mjs';
import { createLobbyTransferReceiver } from './lobby-transfer.mjs';

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

test('bounded lobby transfer reassembles ordered chunks and acknowledges completed content', async () => {
  const source = new TextEncoder().encode('lobby-save-'.repeat(5000));
  const chunks = [];
  for (let offset = 0; offset < source.length; offset += LOBBY_TRANSFER_CHUNK_BYTES) {
    chunks.push(source.subarray(offset, Math.min(source.length, offset + LOBBY_TRANSFER_CHUNK_BYTES)));
  }
  let completed = null;
  const acknowledgements = [];
  const receiver = createLobbyTransferReceiver({
    onComplete: async (result) => { completed = result; return { revision: 17 }; },
    acknowledge: (message) => acknowledgements.push(message),
  });
  assert.equal(await receiver.handle({
    type: 'lobby.transfer.begin', transferId: 'transfer-1', senderPlayerId: 'guest',
    purpose: 'slot-save', totalBytes: source.length, chunkCount: chunks.length,
  }), true);
  for (let index = 0; index < chunks.length; index++) {
    assert.equal(await receiver.handle({
      type: 'lobby.transfer.chunk', transferId: 'transfer-1', index, data: base64(chunks[index]),
    }), true);
  }
  assert.equal(await receiver.handle({ type: 'lobby.transfer.end', transferId: 'transfer-1' }), true);
  assert.equal(completed.senderPlayerId, 'guest');
  assert.equal(completed.purpose, 'slot-save');
  assert.equal(completed.text, new TextDecoder().decode(source));
  assert.deepEqual(acknowledgements, [{ transferId: 'transfer-1', accepted: true, revision: 17 }]);
  assert.equal(receiver.pending(), 0);
});

test('lobby transfer refuses out-of-order chunks and reports incomplete transfers', async () => {
  const acknowledgements = [];
  const receiver = createLobbyTransferReceiver({ acknowledge: (message) => acknowledgements.push(message) });
  const source = new TextEncoder().encode('abcdef');
  await receiver.handle({
    type: 'lobby.transfer.begin', transferId: 'transfer-2', senderPlayerId: 'host',
    purpose: 'lobby-snapshot', totalBytes: source.length, chunkCount: 1,
  });
  assert.equal(await receiver.handle({
    type: 'lobby.transfer.chunk', transferId: 'transfer-2', index: 1, data: base64(source),
  }), false);
  assert.equal(await receiver.handle({ type: 'lobby.transfer.end', transferId: 'transfer-2' }), false);
  assert.deepEqual(acknowledgements[0], { transferId: 'transfer-2', accepted: false, reason: 'transfer_incomplete' });
});
