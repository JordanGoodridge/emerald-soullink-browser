// Lobby UI for the optional presence feature. It is intentionally a thin
// view over the runtime snapshot; no socket, WASM or renderer access lives
// here, so the panel can be closed without touching gameplay.

import { mapNameFor as defaultMapNameFor } from './map-names.mjs';
import { awayLabel, memberFreshness } from './member-status.mjs';

const STATUS_LABELS = {
  disconnected: 'Not connected',
  connecting: 'Connecting…',
  handshaking: 'Joining room…',
  joined: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
};

export function describePresence(state) {
  if (!state) return 'Not connected';
  if (state.lastError) {
    if (state.lastError.code === 'run_in_progress') {
      return 'This run has started. To continue it, load its saved run in a new room.';
    }
    const detail = state.lastError.detail ? `: ${state.lastError.detail}` : '';
    return `${state.lastError.code || 'error'}${detail}`;
  }
  if (state.status === 'joined') {
    return `${STATUS_LABELS.joined} — room ${state.room ?? '????'} — ${state.playerCount}/4 players`;
  }
  return STATUS_LABELS[state.status] ?? state.status;
}

function activityLabel(activity) {
  switch (activity) {
  case 'overworld': return 'walking';
  case 'dialogue': return 'in dialogue';
  case 'menu': return 'in menu';
  case 'battle': return 'in battle';
  case 'cutscene': return 'in a cutscene';
  case 'unsupported': return 'area not supported';
  case 'loading': return 'loading';
  default: return activity || 'away';
  }
}

export function lobbyHint(state) {
  if (!state) return '';
  if (state.avatarStatus === 'error') {
    return 'Avatar art could not load, so other players will be hidden.';
  }
  if (state.avatarStatus === 'loading') {
    return 'Loading trainer sprites…';
  }
  if (state.status === 'joined') {
    if (state.activity === 'unsupported') {
      return 'This area cannot show other players yet. Only the clean outdoor 3D view is supported.';
    }
    if (!state.clockReady) return 'Syncing clocks for smooth movement…';
    return 'Walk around in the same outdoor area to see each other.';
  }
  if (state.status === 'reconnecting') {
    const close = state.lastClose;
    const detail = close?.reason || close?.code;
    return detail ? `Reconnecting (${detail})…` : 'Reconnecting…';
  }
  // A terminal reconnect failure keeps the room code so rejoining is one click.
  if (state.lastError && state.room) {
    return `Disconnected (${state.lastError.code}). Press Join room to rejoin ${state.room}.`;
  }
  return '';
}

export function createLobby({
  runtime,
  document: doc = globalThis.document,
  locationSearch = globalThis.location?.search ?? '',
  mapNameFor = defaultMapNameFor,
} = {}) {
  const panel = doc.querySelector('#presence-panel');
  const toggle = doc.querySelector('#presence-toggle');
  const close = doc.querySelector('#presence-close');
  const statusEl = doc.querySelector('#presence-status');
  const nameInput = doc.querySelector('#presence-name');
  const roomInput = doc.querySelector('#presence-room');
  const createButton = doc.querySelector('#presence-create');
  const joinButton = doc.querySelector('#presence-join');
  const leaveButton = doc.querySelector('#presence-leave');
  const roomCodeEl = doc.querySelector('#presence-room-code');
  const rosterEl = doc.querySelector('#presence-roster');
  const hintEl = doc.querySelector('#presence-hint');

  if (!panel || !toggle || !statusEl) {
    return { open() {}, close() {}, destroy() {} };
  }

  let current = runtime.getSnapshot();
  let renderQueued = false;
  let resolveMapName = typeof mapNameFor === 'function' ? mapNameFor : defaultMapNameFor;

  function setMapNameFor(next) {
    if (typeof next === 'function') resolveMapName = next;
  }

  function open() {
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = 'Hide friends';
    if (!nameInput.value) nameInput.value = current.name;
  }

  function closePanel() {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = 'Play with friends';
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render(current);
    });
  }

  function render(state) {
    current = state;
    statusEl.textContent = describePresence(state);
    statusEl.classList.toggle('error', Boolean(state.lastError));
    panel.dataset.status = state.status;

    const joined = state.status === 'joined';
    const busy = state.status === 'connecting' || state.status === 'handshaking' || state.status === 'reconnecting';
    createButton.disabled = joined || busy;
    joinButton.disabled = joined || busy;
    leaveButton.disabled = !joined && !busy;
    nameInput.disabled = joined;
    roomInput.disabled = joined;

    roomCodeEl.textContent = joined && state.room ? `Room code: ${state.room}` : '';
    roomCodeEl.hidden = !joined;

    const members = state.members ?? [];
    rosterEl.replaceChildren();
    for (const member of members) {
      const item = doc.createElement('li');
      const name = doc.createElement('strong');
      const isSelf = member.playerId === state.playerId;
      name.textContent = member.name + (isSelf ? ' (you)' : '');
      const meta = doc.createElement('span');
      // The local row is the live adapter frame, not whatever the server last
      // echoed back, so it stays accurate while the network is quiet.
      const memberState = isSelf
        ? { activity: state.activity, world: state.world, pose: state.pose }
        : (member.latest?.state ?? null);
      const freshness = isSelf
        ? { stale: false }
        : memberFreshness(member, {
          serverNowMs: state.serverNowMs,
          visibleSnapshotAgeMs: state.visibleSnapshotAgeMs,
        });
      const world = memberState?.world ?? memberState?.battleAnchor?.world ?? null;
      const mapName = resolveMapName(world);
      const connection = member.connection === 'connected' ? '' : ` · ${member.connection}`;
      item.classList.toggle('stale', freshness.stale);
      if (freshness.stale) {
        meta.textContent = awayLabel(mapName);
      } else {
        const where = isSelf ? 'you' : (mapName ?? 'elsewhere');
        meta.textContent = `${where} · ${activityLabel(memberState?.activity)}${connection}`;
      }
      item.append(name, meta);
      rosterEl.append(item);
    }
    if (!members.length) {
      const item = doc.createElement('li');
      item.className = 'presence-empty';
      item.textContent = joined ? 'Waiting for players…' : 'Create or join a room to see friends here.';
      rosterEl.append(item);
    }

    let hint = '';
    if (!joined && state.lastError && state.room) {
      roomInput.value = state.room;
    }
    hint = lobbyHint(state);
    hintEl.textContent = hint;
    hintEl.hidden = !hint;
  }

  function submitName() {
    const name = nameInput.value.trim();
    if (name) runtime.setName(name);
    return name;
  }

  function handleCreate() {
    submitName();
    runtime.createRoom();
  }

  function handleJoin() {
    submitName();
    const room = roomInput.value.trim().toUpperCase();
    if (!runtime.joinRoom(room)) {
      render(runtime.getSnapshot());
    }
  }

  function handleLeave() {
    runtime.leave();
  }

  toggle.addEventListener('click', () => {
    if (panel.hidden) open();
    else closePanel();
  });
  close?.addEventListener('click', closePanel);
  createButton.addEventListener('click', handleCreate);
  joinButton.addEventListener('click', handleJoin);
  leaveButton.addEventListener('click', handleLeave);
  roomInput.addEventListener('input', () => {
    roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8);
  });
  roomInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleJoin();
  });
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runtime.setName(nameInput.value);
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) closePanel();
  });

  nameInput.value = current.name;
  const unsubscribe = runtime.subscribe((state) => {
    current = state;
    queueRender();
  });

  const search = new URLSearchParams(locationSearch);
  if (search.get('presence') === '1' || search.get('presenceAuto')) open();

  return {
    open,
    close: closePanel,
    setMapNameFor,
    destroy() { unsubscribe(); },
  };
}
