import { LOBBY_TRANSFER_CHUNK_BYTES, MAX_LOBBY_TRANSFER_BYTES } from './run-protocol.mjs';

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function createLobbyTransferReceiver({ onComplete = async () => {}, acknowledge = () => {} } = {}) {
  const transfers = new Map();

  async function handle(message) {
    const transferId = message?.transferId;
    if (typeof transferId !== 'string' || !transferId) return false;
    if (message.type === 'lobby.transfer.begin') {
      if (!Number.isSafeInteger(message.totalBytes) || message.totalBytes < 1
        || message.totalBytes > MAX_LOBBY_TRANSFER_BYTES
        || !Number.isInteger(message.chunkCount) || message.chunkCount < 1
        || message.chunkCount !== Math.ceil(message.totalBytes / LOBBY_TRANSFER_CHUNK_BYTES)
        || !['slot-save', 'lobby-snapshot', 'slot-claim-request'].includes(message.purpose)
        || typeof message.senderPlayerId !== 'string' || !message.senderPlayerId) return false;
      transfers.set(transferId, {
        transferId,
        senderPlayerId: message.senderPlayerId,
        purpose: message.purpose,
        totalBytes: message.totalBytes,
        chunkCount: message.chunkCount,
        nextIndex: 0,
        receivedBytes: 0,
        chunks: [],
      });
      return true;
    }

    const transfer = transfers.get(transferId);
    if (!transfer) return false;
    if (message.type === 'lobby.transfer.chunk') {
      if (message.index !== transfer.nextIndex || typeof message.data !== 'string') return false;
      const chunk = decodeBase64(message.data);
      if (!chunk.length || chunk.length > LOBBY_TRANSFER_CHUNK_BYTES
        || transfer.receivedBytes + chunk.length > transfer.totalBytes) return false;
      transfer.chunks.push(chunk);
      transfer.receivedBytes += chunk.length;
      transfer.nextIndex++;
      return true;
    }
    if (message.type !== 'lobby.transfer.end') return false;

    transfers.delete(transferId);
    if (transfer.nextIndex !== transfer.chunkCount || transfer.receivedBytes !== transfer.totalBytes) {
      acknowledge({ transferId, accepted: false, reason: 'transfer_incomplete' });
      return false;
    }
    const joined = new Uint8Array(transfer.totalBytes);
    let offset = 0;
    for (const chunk of transfer.chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(joined);
      const result = await onComplete({
        transferId,
        senderPlayerId: transfer.senderPlayerId,
        purpose: transfer.purpose,
        text,
      });
      acknowledge({ transferId, accepted: true, revision: result?.revision ?? null });
      return true;
    } catch (error) {
      acknowledge({ transferId, accepted: false, reason: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  return Object.freeze({ handle, pending: () => transfers.size, clear: () => transfers.clear() });
}
