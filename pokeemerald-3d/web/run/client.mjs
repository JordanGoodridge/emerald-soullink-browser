import {
  LOBBY_TRANSFER_CHUNK_BYTES,
  MAX_LOBBY_TRANSFER_BYTES,
  RUN_PROTOCOL_VERSION,
} from './run-protocol.mjs';

const RETRY_DELAYS = [500, 1000, 2000, 4000, 5000];

export function createRunClient({
  url,
  room,
  playerId,
  token,
  WebSocketImpl = globalThis.WebSocket,
  onState = () => {},
  onError = () => {},
  onStatus = () => {},
  onLobbyMessage = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  if (!url || !WebSocketImpl) throw new Error('run client requires a URL and WebSocket implementation');
  let socket = null;
  let stopped = true;
  let attached = false;
  let attempts = 0;
  let timer = null;
  let latestState = null;
  let outbox = [];
  let socketGeneration = 0;

  function sendRaw(value) {
    if (socket?.readyState !== 1) return false;
    socket.send(JSON.stringify({ v: RUN_PROTOCOL_VERSION, ...value }));
    return true;
  }

  function flush() {
    if (!attached) return;
    const queued = outbox;
    outbox = [];
    for (const command of queued) sendRaw(command);
  }

  function scheduleReconnect() {
    if (stopped || timer) return;
    const delay = RETRY_DELAYS[Math.min(attempts, RETRY_DELAYS.length - 1)];
    attempts++;
    onStatus({ status: 'reconnecting', delay });
    timer = schedule(() => {
      timer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) return;
    attached = false;
    onStatus({ status: 'connecting' });
    try {
      socket = new WebSocketImpl(url);
    } catch (error) {
      onError(error);
      scheduleReconnect();
      return;
    }
    const thisSocket = socket;
    const generation = ++socketGeneration;
    thisSocket.addEventListener('open', () => {
      if (socket !== thisSocket || generation !== socketGeneration) return;
      if (stopped) return;
      sendRaw({ type: 'run.attach', room, playerId, token });
      onStatus({ status: 'attaching' });
    });
    thisSocket.addEventListener('message', (messageEvent) => {
      if (socket !== thisSocket || generation !== socketGeneration) return;
      let message;
      try {
        message = JSON.parse(typeof messageEvent.data === 'string' ? messageEvent.data : String(messageEvent.data));
      } catch (error) {
        onError(error);
        return;
      }
      if (message?.v !== RUN_PROTOCOL_VERSION) {
        onError(new Error('run protocol version mismatch'));
        return;
      }
      if (message.type === 'run.welcome' || message.type === 'run.state') {
        attached = true;
        attempts = 0;
        latestState = message.state ?? null;
        onState(latestState, message.events ?? []);
        onStatus({ status: 'attached', room, playerId });
        flush();
      } else if (message.type.startsWith('lobby.transfer.')) {
        onLobbyMessage(message);
      } else if (message.type === 'run.error') {
        onError(new Error(message.reason ?? 'run request rejected'));
      }
    });
    thisSocket.addEventListener('close', () => {
      if (socket !== thisSocket || generation !== socketGeneration) return;
      attached = false;
      if (!stopped) scheduleReconnect();
    });
    thisSocket.addEventListener('error', (error) => {
      if (socket === thisSocket && generation === socketGeneration) onError(error);
    });
  }

  function enqueue(command) {
    if (stopped) return false;
    if (command.type === 'run.event' && command.event?.eventId
        && outbox.some((queued) => queued.type === 'run.event' && queued.event?.eventId === command.event.eventId)) {
      return true;
    }
    if (!attached || !sendRaw(command)) {
      outbox.push(command);
      return true;
    }
    return true;
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    connect();
  }

  function updateCredentials(next = {}) {
    room = next.room ?? room;
    playerId = next.playerId ?? playerId;
    token = next.token ?? token;
    if (!stopped) {
      if (timer) clearTimeout(timer);
      timer = null;
      attached = false;
      const previous = socket;
      socket = null;
      socketGeneration++;
      previous?.close(4000, 'credentials_updated');
      connect();
    }
  }

  function stop({ sendLeave = true } = {}) {
    if (stopped) return;
    if (sendLeave && attached) sendRaw({ type: 'run.leave' });
    stopped = true;
    attached = false;
    if (timer) clearTimeout(timer);
    timer = null;
    outbox = [];
    socket?.close(1000, 'run_client_stopped');
    socket = null;
    onStatus({ status: 'stopped' });
  }

  function sendEvent(event) {
    if (!event || typeof event !== 'object') return false;
    const payload = { ...event };
    // Identity, sequence and timestamp are server/run-client envelope data;
    // the server derives the acting member from the authenticated socket.
    delete payload.playerId;
    delete payload.seq;
    delete payload.revision;
    delete payload.at;
    return enqueue({ type: 'run.event', event: payload });
  }

  async function sendLobbyTransfer({ recipientPlayerId, purpose, text, transferId = globalThis.crypto?.randomUUID?.() } = {}) {
    if (!attached || stopped) throw new Error('run channel is not attached for lobby transfer');
    if (!transferId) transferId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (typeof text !== 'string') throw new Error('lobby transfer requires text data');
    const payload = new TextEncoder().encode(text);
    if (!payload.length || payload.length > MAX_LOBBY_TRANSFER_BYTES) throw new Error('lobby transfer size is outside the supported limit');
    const chunkCount = Math.ceil(payload.length / LOBBY_TRANSFER_CHUNK_BYTES);
    if (!enqueue({
      type: 'lobby.transfer.begin', transferId, recipientPlayerId, purpose,
      totalBytes: payload.length, chunkCount,
    })) throw new Error('lobby transfer could not start');
    for (let index = 0; index < chunkCount; index++) {
      if (index > 0) await new Promise((resolveDelay) => schedule(resolveDelay, 100));
      const chunk = payload.subarray(index * LOBBY_TRANSFER_CHUNK_BYTES, Math.min(payload.length, (index + 1) * LOBBY_TRANSFER_CHUNK_BYTES));
      let binary = '';
      for (let offset = 0; offset < chunk.length; offset += 0x8000) {
        binary += String.fromCharCode(...chunk.subarray(offset, offset + 0x8000));
      }
      if (!enqueue({ type: 'lobby.transfer.chunk', transferId, index, data: btoa(binary) })) {
        throw new Error(`lobby transfer stopped at chunk ${index} (stopped=${stopped}, attached=${attached}, socket=${socket?.readyState ?? 'none'})`);
      }
    }
    if (!enqueue({ type: 'lobby.transfer.end', transferId })) throw new Error('lobby transfer could not finish');
    return transferId;
  }

  return {
    start,
    stop,
    updateCredentials,
    startRun(options = {}) { return enqueue({ type: 'run.start', options }); },
    restoreRun(checkpoint) { return enqueue({ type: 'run.restore', checkpoint }); },
    restartRun() { return enqueue({ type: 'run.restart' }); },
    sendEvent,
    sendLobbyMessage(message = {}) {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string'
        || !message.type.startsWith('lobby.transfer.')) return false;
      return enqueue(message);
    },
    sendLobbyTransfer,
    state() { return latestState; },
    get attached() { return attached; },
    get pendingCount() { return outbox.length; },
  };
}
