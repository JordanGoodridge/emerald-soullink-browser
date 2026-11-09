// WebSocket transport for the presence room service.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  LOBBY_TRANSFER_CHUNK_BYTES,
  MAX_RUN_MESSAGE_BYTES,
  runMessage,
  validateRunClientMessage,
} from '../../pokeemerald-3d/web/run/run-protocol.mjs';
import {
  DEFAULT_LIMITS,
  ERROR_CODES,
  MAX_MESSAGE_BYTES,
  errorMessage,
  validateClientMessage,
} from '../../pokeemerald-3d/web/presence/protocol.mjs';
import { createRoomService } from './room-core.mjs';
import { createRunService } from './run-core.mjs';

const HANDSHAKE_TYPES = new Set(['create', 'join', 'resume']);

function createTokenBucket(perSecond, burst, now) {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const current = now();
      tokens = Math.min(burst, tokens + ((current - last) / 1000) * perSecond);
      last = current;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

export function startServer({
  port = Number(process.env.PORT || 8787),
  host = process.env.HOST || '0.0.0.0',
  limits = DEFAULT_LIMITS,
  serviceOptions = {},
  log = console,
} = {}) {
  let runService = null;
  const priorRoomExpired = serviceOptions.onRoomExpired;
  const service = createRoomService({
    limits,
    ...serviceOptions,
    onRoomExpired(roomCode) {
      runService?.deleteRoom(roomCode);
      for (const [key, transfer] of lobbyTransfers ?? []) {
        if (transfer.roomCode === roomCode) lobbyTransfers.delete(key);
      }
      priorRoomExpired?.(roomCode);
    },
    onRoomHostChanged(roomCode, hostPlayerId) {
      const state = runService?.handoffHost(roomCode, hostPlayerId);
      if (state) broadcastRun(roomCode, state, [state.events.at(-1)]);
    },
  });
  runService = createRunService({ roomService: service });
  const sockets = new Map(); // socketId -> transport state
  const runSockets = new Map(); // socketId -> run transport state
  const lobbyTransfers = new Map(); // transferId -> ephemeral transfer metadata only; bytes are never retained here
  const heartbeat = new Set();

  const httpServer = createServer((request, response) => {
    if (request.url === '/health') {
      const body = JSON.stringify({
        ok: true,
        rooms: service.roomCount(),
        members: service.memberCount(),
        runs: runService.count(),
      });
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    clientTracking: false,
  });
  const runWss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RUN_MESSAGE_BYTES,
    clientTracking: false,
  });

  function send(socketId, message) {
    const state = sockets.get(socketId);
    if (!state || state.ws.readyState !== state.ws.OPEN) return;
    if (state.ws.bufferedAmount > limits.congestionBytes) {
      state.ws.terminate();
      return;
    }
    state.ws.send(JSON.stringify(message));
  }

  function closeSocket(socketId, reason) {
    const state = sockets.get(socketId);
    if (!state) return;
    try {
      state.ws.close(4000, String(reason).slice(0, 120));
    } catch {
      state.ws.terminate();
    }
    const timer = setTimeout(() => state.ws.terminate(), 1000);
    timer.unref?.();
  }

  function execute(effects) {
    for (const effect of effects) {
      if (effect.type === 'send') send(effect.socketId, effect.message);
      else if (effect.type === 'close') closeSocket(effect.socketId, effect.reason);
    }
  }

  function reject(state, code, fatal) {
    log.log?.(`presence reject ${code} fatal=${fatal} handshaked=${state.handshaked}`);
    send(state.id, errorMessage(code, fatal));
    if (fatal) closeSocket(state.id, code);
  }

  function clearHandshake(state) {
    if (state.handshakeTimer) {
      clearTimeout(state.handshakeTimer);
      state.handshakeTimer = null;
    }
  }

  function handleMessage(state, raw) {
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
    if (size > limits.maxMessageBytes) {
      reject(state, ERROR_CODES.invalidMessage, true);
      return;
    }

    if (!state.bucket.take()) {
      state.violations++;
      send(state.id, errorMessage(ERROR_CODES.rateLimited, false));
      if (state.violations >= 5) closeSocket(state.id, ERROR_CODES.rateLimited);
      return;
    }

    let decoded;
    try {
      decoded = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      reject(state, ERROR_CODES.invalidMessage, true);
      return;
    }

    const validated = validateClientMessage(decoded);
    if (!validated.ok) {
      reject(state, validated.code, validated.fatal);
      return;
    }
    const command = validated.value;

      if (!state.handshaked) {
        if (!HANDSHAKE_TYPES.has(command.type)) {
          reject(state, ERROR_CODES.invalidMessage, true);
          return;
        }
        const roomRun = command.type === 'join' ? runService.get(command.room) : null;
        if (roomRun && roomRun.status !== 'closed') {
          reject(state, ERROR_CODES.runInProgress, true);
          return;
        }
        const effects = service[command.type](state.id, command);
      execute(effects);
      const welcomed = effects.some((effect) => (
        effect.type === 'send' && effect.message?.type === 'welcome'
      ));
      if (welcomed) {
        state.handshaked = true;
        clearHandshake(state);
        log.log?.(`presence handshake ${command.type} ok`);
      } else {
        log.log?.(`presence handshake ${command.type} refused`);
      }
      return;
    }

    if (HANDSHAKE_TYPES.has(command.type)) {
      reject(state, ERROR_CODES.invalidMessage, true);
      return;
    }

    if (command.type === 'presence') execute(service.presence(state.id, command));
    else if (command.type === 'party') execute(service.party(state.id, command));
    else if (command.type === 'avatar') execute(service.avatar(state.id, command));
    else if (command.type === 'ping') execute(service.ping(state.id, command));
    else if (command.type === 'leave') execute(service.leave(state.id));
  }

  wss.on('connection', (ws) => {
    const state = {
      id: randomUUID(),
      ws,
      handshaked: false,
      violations: 0,
      bucket: createTokenBucket(limits.commandPerSecond, limits.commandBurst, () => Date.now()),
      handshakeTimer: null,
      alive: true,
    };
    sockets.set(state.id, state);

    state.handshakeTimer = setTimeout(() => {
      if (state.handshaked) return;
      log.log?.('presence handshake timeout');
      send(state.id, errorMessage(ERROR_CODES.handshakeTimeout, true));
      closeSocket(state.id, ERROR_CODES.handshakeTimeout);
    }, limits.handshakeTimeoutMs);
    state.handshakeTimer.unref?.();

    ws.on('pong', () => { state.alive = true; });
    ws.on('message', (data) => {
      try {
        handleMessage(state, data);
      } catch (error) {
        log.error?.('presence message handler failed', error);
        closeSocket(state.id, 'internal_error');
      }
    });
    ws.on('close', (code, reason) => {
      clearHandshake(state);
      sockets.delete(state.id);
      log.log?.(`presence socket closed code=${code} reason=${String(reason || '').slice(0, 60)} handshaked=${state.handshaked}`);
      execute(service.disconnect(state.id));
    });
    ws.on('error', (error) => {
      log.error?.('presence socket error', error.message);
    });
  });

  function sendRun(state, message) {
    if (!state || state.ws.readyState !== state.ws.OPEN) return;
    if (state.ws.bufferedAmount > limits.congestionBytes) {
      state.ws.terminate();
      return;
    }
    state.ws.send(JSON.stringify(message));
  }

  function broadcastRun(roomCode, state, events = []) {
    for (const peer of runSockets.values()) {
      if (peer.roomCode !== roomCode || !peer.handshaked) continue;
      if (!service.validateMember({ roomCode, playerId: peer.playerId, token: peer.token })) {
        sendRun(peer, runMessage('run.error', { reason: 'room_membership_expired' }));
        peer.ws.close(4001, 'room_membership_expired');
        continue;
      }
      sendRun(peer, runMessage('run.state', { state, events }));
    }
  }

  function sendRunError(state, reason) {
    sendRun(state, runMessage('run.error', { reason }));
  }

  function transferKey(roomCode, transferId) {
    return `${roomCode}:${transferId}`;
  }

  function transferPeers(roomCode, recipients) {
    return [...runSockets.values()].filter((peer) => peer.roomCode === roomCode
      && peer.handshaked && recipients.has(peer.playerId)
      && service.validateMember({ roomCode, playerId: peer.playerId, token: peer.token }));
  }

  function memberIsActive(run, playerId) {
    return run.members.some((member) => member.playerId === playerId && member.active !== false);
  }

  function handleLobbyTransfer(state, command) {
    const key = transferKey(state.roomCode, command.transferId);
    const run = runService.get(state.roomCode);
    const room = service.inspect(state.roomCode);
    // Lobby save replication is also used by Standard play, which deliberately
    // has no shared run state. In that case room membership/host authority is
    // sufficient; no run reducer is created just to move opaque save bundles.
    const lobby = run ?? (room ? {
      hostPlayerId: room.hostPlayerId,
      members: room.members.map((member) => ({ playerId: member.playerId, active: true })),
    } : null);
    const hostPlayerId = lobby?.hostPlayerId ?? room?.hostPlayerId;

    if (command.type === 'lobby.transfer.begin') {
      const now = Date.now();
      for (const [oldKey, transfer] of lobbyTransfers) {
        if (now - transfer.updatedAt > 60_000) lobbyTransfers.delete(oldKey);
      }
      if (!lobby || !hostPlayerId) return sendRunError(state, 'lobby_transfer_room_missing');
      let recipients;
      if (command.purpose === 'slot-save') {
        if (state.playerId === hostPlayerId || command.recipientPlayerId !== hostPlayerId
          || !memberIsActive(lobby, state.playerId)) {
          return sendRunError(state, 'lobby_transfer_recipient_invalid');
        }
        recipients = new Set([hostPlayerId]);
      } else if (command.purpose === 'slot-claim-request') {
        if (command.recipientPlayerId !== hostPlayerId || !memberIsActive(lobby, state.playerId)) {
          return sendRunError(state, 'lobby_transfer_recipient_invalid');
        }
        recipients = new Set([hostPlayerId]);
      } else {
        if (state.playerId !== hostPlayerId || command.recipientPlayerId !== '*') {
          return sendRunError(state, 'host_required');
        }
        recipients = new Set(lobby.members.map((member) => member.playerId).filter((id) => id !== hostPlayerId && memberIsActive(lobby, id)));
      }
      const peers = transferPeers(state.roomCode, recipients);
      recipients = new Set(peers.map((peer) => peer.playerId));
      if (!recipients.size) return sendRunError(state, 'lobby_transfer_recipients_offline');
      if (lobbyTransfers.size >= 16 || lobbyTransfers.has(key)) return sendRunError(state, 'lobby_transfer_busy');
      const transfer = {
        key,
        roomCode: state.roomCode,
        transferId: command.transferId,
        senderPlayerId: state.playerId,
        recipientPlayerId: command.recipientPlayerId,
        purpose: command.purpose,
        totalBytes: command.totalBytes,
        chunkCount: command.chunkCount,
        nextIndex: 0,
        bytesReceived: 0,
        recipients,
        updatedAt: now,
        ended: false,
      };
      lobbyTransfers.set(key, transfer);
      const message = runMessage('lobby.transfer.begin', {
        transferId: transfer.transferId,
        senderPlayerId: transfer.senderPlayerId,
        purpose: transfer.purpose,
        totalBytes: transfer.totalBytes,
        chunkCount: transfer.chunkCount,
      });
      for (const peer of peers) sendRun(peer, message);
      return;
    }

    const transfer = lobbyTransfers.get(key);
    if (!transfer || transfer.roomCode !== state.roomCode) return sendRunError(state, 'lobby_transfer_not_found');
    if (command.type === 'lobby.transfer.chunk') {
      if (state.playerId !== transfer.senderPlayerId || transfer.ended) return sendRunError(state, 'lobby_transfer_sender_invalid');
      if (command.index !== transfer.nextIndex) return sendRunError(state, 'lobby_transfer_chunk_order_invalid');
      const chunkBytes = Buffer.from(command.data, 'base64').byteLength;
      if (chunkBytes > LOBBY_TRANSFER_CHUNK_BYTES || transfer.bytesReceived + chunkBytes > transfer.totalBytes) {
        lobbyTransfers.delete(key);
        return sendRunError(state, 'lobby_transfer_size_invalid');
      }
      transfer.nextIndex++;
      transfer.bytesReceived += chunkBytes;
      transfer.updatedAt = Date.now();
      const message = runMessage('lobby.transfer.chunk', {
        transferId: transfer.transferId,
        index: command.index,
        data: command.data,
      });
      for (const peer of transferPeers(state.roomCode, transfer.recipients)) sendRun(peer, message);
      return;
    }
    if (command.type === 'lobby.transfer.end') {
      if (state.playerId !== transfer.senderPlayerId || transfer.ended) return sendRunError(state, 'lobby_transfer_sender_invalid');
      if (transfer.nextIndex !== transfer.chunkCount || transfer.bytesReceived !== transfer.totalBytes) {
        lobbyTransfers.delete(key);
        return sendRunError(state, 'lobby_transfer_incomplete');
      }
      transfer.ended = true;
      transfer.updatedAt = Date.now();
      const message = runMessage('lobby.transfer.end', { transferId: transfer.transferId });
      for (const peer of transferPeers(state.roomCode, transfer.recipients)) sendRun(peer, message);
      return;
    }
    if (command.type === 'lobby.transfer.ack') {
      if (!transfer.ended || !transfer.recipients.has(state.playerId)) return sendRunError(state, 'lobby_transfer_ack_invalid');
      const sender = [...runSockets.values()].find((peer) => peer.roomCode === state.roomCode
        && peer.playerId === transfer.senderPlayerId && peer.handshaked);
      if (sender) sendRun(sender, runMessage('lobby.transfer.ack', {
        transferId: transfer.transferId,
        recipientPlayerId: state.playerId,
        accepted: command.accepted,
        ...(command.reason ? { reason: command.reason } : {}),
        ...(command.revision !== undefined ? { revision: command.revision } : {}),
      }));
      transfer.recipients.delete(state.playerId);
      transfer.updatedAt = Date.now();
      if (!transfer.recipients.size) lobbyTransfers.delete(key);
    }
  }

  function handleRunMessage(state, raw) {
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
    if (size > MAX_RUN_MESSAGE_BYTES) {
      sendRunError(state, 'message_too_large');
      state.ws.close(4002, 'message_too_large');
      return;
    }
    if (!state.bucket.take()) {
      state.violations++;
      sendRunError(state, 'rate_limited');
      if (state.violations >= 5) state.ws.close(4003, 'rate_limited');
      return;
    }
    // Only a sustained run of rejected messages should disconnect a client.
    state.violations = 0;

    let decoded;
    try {
      decoded = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      sendRunError(state, 'message_json_invalid');
      state.ws.close(4002, 'message_json_invalid');
      return;
    }
    const validation = validateRunClientMessage(decoded);
    if (!validation.ok) {
      sendRunError(state, validation.reason);
      state.ws.close(4002, validation.reason);
      return;
    }
    const command = validation.value;

    if (!state.handshaked) {
      if (command.type !== 'run.attach') {
        sendRunError(state, 'run_attach_required');
        state.ws.close(4002, 'run_attach_required');
        return;
      }
      const attached = runService.attach({
        roomCode: command.room,
        playerId: command.playerId,
        token: command.token,
      });
      if (!attached.ok) {
        sendRunError(state, attached.reason);
        state.ws.close(4001, attached.reason);
        return;
      }
      state.roomCode = attached.member.roomCode;
      state.playerId = attached.member.playerId;
      state.token = command.token;
      state.handshaked = true;
      clearHandshake(state);
      sendRun(state, runMessage('run.welcome', {
        room: state.roomCode,
        playerId: state.playerId,
        contentVersion: attached.member.contentVersion,
        state: attached.state,
      }));
      return;
    }

    if (!service.validateMember({ roomCode: state.roomCode, playerId: state.playerId, token: state.token })) {
      sendRunError(state, 'room_membership_expired');
      state.ws.close(4001, 'room_membership_expired');
      return;
    }
    if (command.type.startsWith('lobby.transfer.')) {
      handleLobbyTransfer(state, command);
      return;
    }
    if (command.type === 'run.start') {
      const result = runService.start(state.roomCode, state.playerId, {
        token: state.token,
        settings: command.options ?? {},
        contentVersion: service.validateMember({ roomCode: state.roomCode, playerId: state.playerId, token: state.token })?.contentVersion,
      });
      if (!result.accepted) {
        sendRunError(state, result.reason);
        return;
      }
      broadcastRun(state.roomCode, result.state, []);
      return;
    }
    if (command.type === 'run.restore') {
      const result = runService.restore(state.roomCode, state.playerId, command.checkpoint, { token: state.token });
      if (!result.accepted) {
        sendRunError(state, result.reason);
        return;
      }
      broadcastRun(state.roomCode, result.state, []);
      return;
    }
    if (command.type === 'run.event') {
      const result = runService.submit(state.roomCode, state.playerId, command.event, { token: state.token });
      if (!result.accepted) {
        sendRunError(state, result.reason);
        return;
      }
      broadcastRun(state.roomCode, result.state, result.events);
      return;
    }
    if (command.type === 'run.restart') {
      const result = runService.restart(state.roomCode, state.playerId, { token: state.token });
      if (!result.accepted) {
        sendRunError(state, result.reason);
        return;
      }
      broadcastRun(state.roomCode, result.state, result.events);
      return;
    }
    if (command.type === 'run.leave') {
      runSockets.delete(state.id);
      state.ws.close(1000, 'left');
    }
  }

  runWss.on('connection', (ws) => {
    const state = {
      id: randomUUID(), ws, handshaked: false, roomCode: null, playerId: null, token: null,
      violations: 0,
      bucket: createTokenBucket(limits.commandPerSecond, limits.commandBurst, () => Date.now()),
      handshakeTimer: null,
      alive: true,
    };
    runSockets.set(state.id, state);
    state.handshakeTimer = setTimeout(() => {
      if (state.handshaked) return;
      sendRunError(state, 'run_handshake_timeout');
      state.ws.close(4004, 'run_handshake_timeout');
    }, limits.handshakeTimeoutMs);
    state.handshakeTimer.unref?.();
    ws.on('pong', () => { state.alive = true; });
    ws.on('message', (data) => {
      try {
        handleRunMessage(state, data);
      } catch (error) {
        log.error?.('run message handler failed', error);
        ws.close(1011, 'run_internal_error');
      }
    });
    ws.on('close', () => {
      clearHandshake(state);
      runSockets.delete(state.id);
    });
    ws.on('error', (error) => log.error?.('run socket error', error.message));
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/presence') {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
      return;
    }
    if (pathname === '/run') {
      runWss.handleUpgrade(request, socket, head, (ws) => runWss.emit('connection', ws, request));
      return;
    }
    {
      socket.destroy();
    }
  });

  heartbeat.add(setInterval(() => {
    for (const state of sockets.values()) {
      if (!state.alive) {
        log.log?.(`presence heartbeat terminated handshaked=${state.handshaked}`);
        state.ws.terminate();
        continue;
      }
      state.alive = false;
      try {
        state.ws.ping();
      } catch {
        state.ws.terminate();
      }
    }
    for (const state of runSockets.values()) {
      if (!state.alive) {
        state.ws.terminate();
        continue;
      }
      state.alive = false;
      try {
        state.ws.ping();
      } catch {
        state.ws.terminate();
      }
    }
  }, limits.pingIntervalMs));

  heartbeat.add(setInterval(() => {
    try {
      execute(service.tick());
    } catch (error) {
      log.error?.('presence room tick failed', error);
    }
  }, 500));

  for (const timer of heartbeat) timer.unref?.();

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const url = `ws://127.0.0.1:${actualPort}/presence`;
      log.log?.(`presence relay listening on ${url} (rooms=${service.roomCount()})`);
      resolve({
        url,
        port: actualPort,
        service,
        runService,
        runUrl: `ws://127.0.0.1:${actualPort}/run`,
        close: async () => {
          for (const timer of heartbeat) clearInterval(timer);
          for (const state of sockets.values()) state.ws.terminate();
          for (const state of runSockets.values()) state.ws.terminate();
          await new Promise((done) => wss.close(() => done()));
          await new Promise((done) => runWss.close(() => done()));
          await new Promise((done) => httpServer.close(() => done()));
        },
      });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.on('uncaughtException', (err) => {
    console.error('server uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('server unhandledRejection:', reason);
  });
  startServer().then(({ close }) => {
    const stop = async () => {
      await close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
