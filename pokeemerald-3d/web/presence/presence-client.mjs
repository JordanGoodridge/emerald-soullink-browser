// Browser presence client: connection lifecycle, handshake, send scheduling and
// clock estimation. Network and time are injected for deterministic tests.

import {
  DEFAULT_LIMITS,
  PROTOCOL_VERSION,
} from './protocol.mjs';

function noop() {}

function worldKey(world) {
  if (!world) return 'none';
  return `${world.mapGroup}:${world.mapNum}:${world.layoutId}:${world.variant}`;
}

function stateKey(state) {
  if (!state) return 'none';
  const pose = state.pose;
  return [
    state.epoch,
    state.activity,
    worldKey(state.world),
    pose ? `${pose.xPx},${pose.yPx},${pose.jumpPx},${pose.facing},${pose.frame},${pose.motion},${pose.appearance}` : 'no-pose',
  ].join('|');
}

function transitionKey(state) {
  if (!state) return 'none';
  return [
    state.epoch,
    state.activity,
    worldKey(state.world),
    state.pose ? `${state.pose.facing},${state.pose.appearance},${state.pose.motion}` : 'no-pose',
  ].join('|');
}

function moving(state) {
  return Boolean(state?.pose && state.pose.motion !== 'idle');
}

export function createPresenceClient({
  url,
  name,
  contentVersion,
  transportFactory = (target) => new WebSocket(target),
  now = () => performance.now(),
  limits = DEFAULT_LIMITS,
  onWelcome = noop,
  onRoster = noop,
  onPresence = noop,
  onParty = noop,
  onAvatar = noop,
  onStatus = noop,
  onError = noop,
  onClock = noop,
} = {}) {
  let status = 'disconnected';
  let socket = null;
  let intent = null;
  let room = null;
  let playerId = null;
  let token = null;
  let generation = 0;
  let revision = 0;
  let members = [];
  let selfName = name;
  let seq = 0;
  let lastSentAt = -Infinity;
  let lastSentKey = null;
  let lastTransitionKey = null;
  let pendingState = null;
  let pendingSampleMs = 0;
  let pendingDirty = false;
  let lastStateKey = null;
  let lastPartyRevision = -1;
  let pendingAvatar = null;
  let lastAvatarKey = null;
  let transitionTokens = limits.transitionBurst;
  let transitionUpdatedAt = 0;
  let handshakeDeadline = 0;
  let nextRetryAt = 0;
  let retryIndex = 0;
  let reservationDeadline = 0;
  let terminal = false;
  let lastError = null;
  let lastPingAt = 0;
  let lastTickAt = 0;
  const rttHistory = [];
  let lastPongAt = 0;
  let pingId = 0;
  const pings = new Map();
  const offsetSamples = [];
  let lastCloseReason = null;
  let lastActivityAt = now();
  let bytesSent = 0;
  let bytesReceived = 0;

  function setStatus(next, detail = null) {
    if (status === next) return;
    status = next;
    onStatus({ state: status, detail, error: lastError });
  }

  function fail(code, detail, isTerminal = true) {
    lastError = { code, detail };
    if (isTerminal) {
      terminal = true;
      try { socket?.close(4000, code); } catch { /* ignore */ }
      socket = null;
      setStatus('closed', detail);
    }
    onError({ code, detail, terminal: isTerminal });
  }

  function send(message) {
    if (!socket || socket.readyState !== 1) return false;
    const text = JSON.stringify({ v: PROTOCOL_VERSION, ...message });
    bytesSent += text.length;
    socket.send(text);
    return true;
  }

  function resetClock() {
    offsetSamples.length = 0;
    pings.clear();
    onClock({ ready: false, offsetMs: 0, rttMs: null });
  }

  function updateRoster(nextMembers, nextRevision) {
    if (nextRevision < revision) return false;
    members = nextMembers;
    revision = nextRevision;
    onRoster({ members, revision });
    return true;
  }

  function openSocket(reason) {
    if (terminal) return;
    lastError = null;
    lastCloseReason = null;
    setStatus('connecting', reason);
    const target = typeof url === 'function' ? url() : url;
    let ws;
    try {
      ws = transportFactory(target);
    } catch (error) {
      lastError = { code: 'transport_error', detail: error.message };
      scheduleRetry();
      return;
    }
    socket = ws;
    ws.onopen = () => { if (socket === ws) onOpen(); };
    ws.onmessage = (event) => { if (socket === ws) handleMessage(event.data); };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      handleClose(event?.code, event?.reason);
    };
    ws.onerror = () => {};
  }

  function onOpen() {
    if (!socket) return;
    const mode = intent?.mode;
    if (mode === 'resume' && room && playerId && token) {
      setStatus('handshaking', 'resuming');
      send({
        type: 'resume', room, contentVersion, playerId, token,
      });
    } else if (mode === 'create') {
      setStatus('handshaking', 'creating');
      send({ type: 'create', contentVersion, name: selfName });
    } else if (mode === 'join') {
      setStatus('handshaking', 'joining');
      send({ type: 'join', room: intent.room, contentVersion, name: selfName });
    }
    handshakeDeadline = now() + limits.handshakeTimeoutMs;
    lastActivityAt = now();
  }

  function handleMessage(raw) {
    let message;
    const text = typeof raw === 'string' ? raw : String(raw);
    bytesReceived += text.length;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || message.v !== PROTOCOL_VERSION) return;
    lastActivityAt = now();

    switch (message.type) {
      case 'welcome': {
        const isResume = intent?.mode === 'resume';
        room = message.room;
        playerId = message.playerId;
        token = message.token;
        generation = message.generation;
        revision = message.revision;
        members = message.members;
        seq = 0;
        retryIndex = 0;
        reservationDeadline = 0;
        terminal = false;
        resetClock();
        lastSentAt = -Infinity;
        lastSentKey = null;
        lastStateKey = null;
        lastTransitionKey = null;
        lastPingAt = 0;
        lastPongAt = now();
        pendingDirty = Boolean(pendingState);
        setStatus('joined', isResume ? 'resumed' : 'joined');
        onWelcome({
          room, playerId, generation, revision, members, resumed: isResume,
        });
        sendPing();
        if (pendingAvatar) {
          lastAvatarKey = null;
          publishAvatar(pendingAvatar);
        }
        if (pendingState && pendingDirty) sendPresence();
        break;
      }
      case 'roster': {
        updateRoster(message.members, message.revision);
        break;
      }
      case 'presence': {
        if (status !== 'joined') break;
        onPresence(message.snapshot);
        break;
      }
      case 'party': {
        if (status !== 'joined') break;
        onParty(message.playerId, message.party);
        break;
      }
      case 'avatar': {
        if (status !== 'joined') break;
        onAvatar(message.playerId, message.avatar);
        break;
      }
      case 'pong': {
        const sent = pings.get(message.id);
        if (sent === undefined) break;
        pings.delete(message.id);
        const received = now();
        const rtt = Math.max(0, received - sent);
        lastPongAt = received;
        rttHistory.push(rtt);
        if (rttHistory.length > 16) rttHistory.shift();
        const sample = {
          at: received,
          rttMs: rtt,
          offsetMs: message.serverMs - (sent + received) / 2,
        };
        offsetSamples.push(sample);
        offsetSamples.sort((a, b) => a.rttMs - b.rttMs);
        offsetSamples.length = Math.min(offsetSamples.length, 8);
        const best = offsetSamples[0];
        onClock({
          ready: true,
          offsetMs: best.offsetMs,
          rttMs: best.rttMs,
          sampledAt: best.at,
        });
        break;
      }
      case 'error': {
        const hasSession = Boolean(room && playerId && token);
        const unrecoverable = ['room_not_found', 'session_expired', 'invalid_resume', 'incompatible_version'];
        const isTerminal = unrecoverable.includes(message.code)
          || (!hasSession && (message.fatal || ['room_full', 'run_in_progress', 'invalid_message', 'handshake_timeout'].includes(message.code)));
        fail(message.code, null, isTerminal);
        if (!isTerminal && hasSession) {
          try { socket?.close(4000, message.code); } catch { /* ignore */ }
          socket = null;
          if (!reservationDeadline) reservationDeadline = now() + limits.reservationMs;
          scheduleRetry();
        }
        break;
      }
      default:
        break;
    }
  }

  function handleClose(code, reason) {
    if (!socket) return;
    socket = null;
    lastCloseReason = { code, reason };
    if (terminal) {
      setStatus('closed', reason);
      return;
    }
    if (intent?.mode === 'resume' && !room && !playerId) {
      fail('session_expired', reason);
      return;
    }
    if (!room) {
      scheduleRetry();
      return;
    }
    if (!reservationDeadline) reservationDeadline = now() + limits.reservationMs;
    setStatus('reconnecting', 'network lost');
    scheduleRetry();
  }

  function scheduleRetry() {
    if (terminal) return;
    const delays = limits.retryDelaysMs;
    const index = Math.min(retryIndex, delays.length - 1);
    const base = delays[index];
    const jitter = 1 + (Math.random() * 2 - 1) * limits.retryJitter;
    retryIndex++;
    nextRetryAt = now() + base * jitter;
    if (room && playerId && token) intent = { mode: 'resume' };
    setStatus('reconnecting', 'retrying');
  }

  function sendPing() {
    const at = now();
    const id = pingId++;
    pings.set(id, at);
    send({ type: 'ping', id, clientMs: at });
    lastPingAt = at;
    for (const [ping, sentAt] of pings) {
      if (at - sentAt > limits.socketDeadMs) pings.delete(ping);
    }
  }

  function transitionAllowed() {
    const at = now();
    const elapsed = Math.max(0, at - transitionUpdatedAt) / 1000;
    transitionTokens = Math.min(
      limits.transitionBurst,
      transitionTokens + elapsed * limits.transitionPerSecond,
    );
    transitionUpdatedAt = at;
    if (transitionTokens < 1) return false;
    transitionTokens -= 1;
    return true;
  }

  function sendPresence(immediate = false) {
    if (status !== 'joined' || !pendingState) return false;
    const state = pendingState;
    const key = stateKey(state);
    const transition = transitionKey(state) !== lastTransitionKey;
    const isMoving = moving(state);
    const at = now();
    const due = immediate
      || lastSentAt < 0
      || (transition && transitionAllowed())
      || (isMoving && at - lastSentAt >= 1000 / limits.movingSendHz)
      || at - lastSentAt >= limits.idleRefreshMs;
    if (!due) return false;
    const sampleMs = pendingSampleMs;
    if (!send({
      type: 'presence', generation, seq: seq + 1, sampleMs, state,
    })) return false;
    seq++;
    lastSentAt = at;
    lastSentKey = key;
    lastStateKey = key;
    lastTransitionKey = transitionKey(state);
    pendingDirty = false;
    return true;
  }

  function publish(state, sampleMs = now()) {
    pendingState = state;
    pendingSampleMs = sampleMs;
    pendingDirty = true;
    if (status === 'joined') sendPresence();
  }

  // Party snapshots are published on change, not per frame. Repeating a
  // revision is a no-op so an idle roster costs no bandwidth.
  function publishParty(party) {
    if (status !== 'joined' || !party || typeof party !== 'object') return false;
    const revision = Number.isInteger(party.revision) ? party.revision : null;
    if (revision !== null && revision === lastPartyRevision) return false;
    if (!send({ type: 'party', party })) return false;
    if (revision !== null) lastPartyRevision = revision;
    return true;
  }

  function publishAvatar(avatar) {
    if (!avatar || typeof avatar !== 'object') return false;
    pendingAvatar = avatar;
    if (status !== 'joined') return false;
    const key = JSON.stringify({
      rigId: avatar.rigId ?? 'gen3-brendan',
      equipped: avatar.equipped ?? {},
      colors: avatar.colors ?? {},
    });
    if (key === lastAvatarKey) return false;
    if (!send({ type: 'avatar', avatar })) return false;
    lastAvatarKey = key;
    return true;
  }

  function flush() {
    if (!pendingDirty) return false;
    return sendPresence(true);
  }

  function simulateDrop() {
    if (!socket) return false;
    try { socket.close(4006, 'simulated drop'); } catch { /* ignore */ }
    return true;
  }

  function tick() {
    const at = now();
    // A suspended, throttled, or occluded page stops ticking at normal cadence
    // while the socket stays open. Wall-clock pong age is meaningless across
    // that gap, so rebase liveness timestamps instead of tearing down a healthy
    // connection or expiring before attempting a wake-up resume.
    const wasSuspended = lastTickAt > 0 && at - lastTickAt > 2500;
    if (wasSuspended) {
      lastPongAt = at;
      pings.clear();
      lastPingAt = 0;
      if (status === 'reconnecting' && reservationDeadline && at > reservationDeadline) {
        reservationDeadline = at + limits.handshakeTimeoutMs;
        nextRetryAt = at;
      }
    }
    lastTickAt = at;
    if (terminal) return;
    if (status === 'connecting' || status === 'handshaking') {
      if (at >= handshakeDeadline && handshakeDeadline > 0) {
        try { socket?.close(); } catch { /* ignore */ }
        socket = null;
        if (room && playerId && token) intent = { mode: 'resume' };
        scheduleRetry();
      }
      return;
    }
    if (status === 'reconnecting') {
      if (reservationDeadline && at > reservationDeadline) {
        fail('session_expired', 'reservation expired');
        return;
      }
      if (at >= nextRetryAt) openSocket('retrying');
      return;
    }
    if (status !== 'joined') return;

    if (socket && socket.bufferedAmount > limits.congestionBytes) {
      try { socket.close(4000, 'congested'); } catch { /* ignore */ }
      return;
    }
    if (lastPingAt === 0 || at - lastPingAt >= limits.pingIntervalMs) sendPing();
    if (pings.size && at - lastPongAt >= limits.socketDeadMs) {
      try { socket?.close(4000, 'socket dead'); } catch { /* ignore */ }
      return;
    }
    if (pendingDirty) sendPresence();
  }

  function start({ mode = 'join', roomCode = null } = {}) {
    terminal = false;
    retryIndex = 0;
    reservationDeadline = 0;
    lastError = null;
    intent = { mode, room: roomCode };
    if (mode === 'resume' && !(room && playerId && token)) {
      throw new Error('resume requires a previous session');
    }
    if (mode === 'join' && !roomCode) throw new Error('join requires a room code');
    if (mode === 'create') room = null;
    openSocket(mode);
  }

  function join(roomCode) {
    start({ mode: 'join', roomCode });
  }

  function create() {
    start({ mode: 'create' });
  }

  function resume() {
    start({ mode: 'resume' });
  }

  // A suspended tab stops processing messages, so pong timestamps go stale while
  // the socket is still healthy. Rebase the liveness clock when the page becomes
  // active again instead of tearing down a good connection, and trigger an
  // immediate reconnect attempt if the socket dropped while away.
  function noteActive() {
    const at = now();
    lastActivityAt = at;
    if (status === 'reconnecting' && !terminal) {
      if (reservationDeadline && at > reservationDeadline) {
        reservationDeadline = at + limits.handshakeTimeoutMs;
      }
      retryIndex = 0;
      nextRetryAt = at;
      openSocket('retrying');
      return true;
    }
    if (status !== 'joined') return false;
    lastPongAt = at;
    pings.clear();
    lastPingAt = 0;
    return true;
  }

  function stop({ leave = true } = {}) {
    terminal = true;
    intent = null;
    if (leave && socket?.readyState === 1) {
      try { send({ type: 'leave' }); } catch { /* ignore */ }
    }
    try { socket?.close(4000, 'client left'); } catch { /* ignore */ }
    socket = null;
    setStatus('disconnected', 'left');
  }

  function getMetrics() {
    const best = offsetSamples[0];
    const jitterMs = rttHistory.length > 1
      ? Math.max(...rttHistory) - Math.min(...rttHistory)
      : null;
    return {
      state: status,
      room,
      playerId,
      generation,
      revision,
      name: selfName,
      members,
      self: playerId ? members.find((member) => member.playerId === playerId) ?? null : null,
      seq,
      rttMs: best?.rttMs ?? null,
      jitterMs,
      interpolationDelayMs: limits.interpolationDelayMs,
      offsetMs: best?.offsetMs ?? null,
      clockReady: offsetSamples.length > 0,
      bytesSent,
      bytesReceived,
      lastError,
      lastCloseReason,
      lastActivityAt,
    };
  }

  // The run side-channel uses the existing room capability token; it does not
  // create accounts or expose the secret through diagnostics/roster snapshots.
  // Keep credentials available across transient reconnects so a brief presence
  // hiccup does not tear down the run channel or discard queued run events.
  function getRunCredentials() {
    if (terminal || status === 'disconnected' || status === 'closed' || !room || !playerId || !token) return null;
    return { room, playerId, token };
  }

  function serverNow() {
    const best = offsetSamples[0];
    if (!best) return null;
    return now() + best.offsetMs;
  }

  return {
    start,
    join,
    create,
    resume,
    noteActive,
    stop,
    tick,
    publish,
    publishParty,
    publishAvatar,
    flush,
    simulateDrop,
    getMetrics,
    getRunCredentials,
    serverNow,
    get status() { return status; },
    get room() { return room; },
  };
}
