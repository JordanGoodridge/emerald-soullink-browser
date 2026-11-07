// Saved SoulLink & Standard co-op lobby list DOM views and room-remapping helpers.

export function remapSavedLobbyToRoom(checkpoint, runState, room) {
  const savedMembers = checkpoint.runState?.members ?? [];
  const liveByName = new Map((runState.members ?? []).map((member) => [member.name, member]));
  const oldToNew = new Map(savedMembers.map((member) => [member.playerId, liveByName.get(member.name)?.playerId]));
  if ([...oldToNew.values()].some((playerId) => !playerId)) {
    throw new Error('saved lobby player names do not match the new room');
  }
  const members = runState.members.map((member) => ({
    playerId: member.playerId,
    name: member.name,
    connected: true,
    ready: member.ready === true,
    slot: member.slot,
  }));
  const slots = Object.fromEntries(Object.entries(checkpoint.slots).map(([slotId, slot]) => [slotId, {
    ...slot,
    ownerPlayerId: slot.ownerPlayerId ? oldToNew.get(slot.ownerPlayerId) ?? null : null,
  }]));
  return {
    ...checkpoint,
    roomCode: room,
    hostPlayerId: runState.hostPlayerId,
    revision: 1,
    runStateRevision: runState.revision,
    authorityRevision: 1,
    members,
    settings: runState.options,
    runState,
    slots,
    savedAt: Date.now(),
  };
}

export function remapStandardLobbyToRoom(checkpoint, room, currentRecord = null) {
  if (checkpoint.mode !== 'standard' || checkpoint.runState) {
    throw new Error('the selected backup is not a Standard lobby');
  }
  const savedMembers = checkpoint.members ?? [];
  const liveMembers = room.members ?? [];
  const savedNames = savedMembers.map((member) => member.name);
  const liveNames = liveMembers.map((member) => member.name);
  if (savedMembers.length !== liveMembers.length
    || new Set(savedNames).size !== savedNames.length
    || new Set(liveNames).size !== liveNames.length
    || savedNames.some((name) => !liveNames.includes(name))) {
    throw new Error('Standard lobby resume needs the same unique player names as the saved lobby');
  }
  const idMap = new Map(savedMembers.map((member) => [
    member.playerId,
    liveMembers.find((candidate) => candidate.name === member.name).playerId,
  ]));
  const members = liveMembers.map((member, index) => ({
    playerId: member.playerId,
    name: member.name,
    connected: member.connection === 'connected',
    slot: index,
  }));
  const slots = Object.fromEntries(Object.entries(checkpoint.slots).map(([slotId, slot]) => [slotId, {
    ...slot,
    ownerPlayerId: slot.ownerPlayerId ? idMap.get(slot.ownerPlayerId) ?? slot.ownerPlayerId : null,
  }]));
  const current = currentRecord?.roomCode === room.room ? currentRecord : null;
  return {
    ...checkpoint,
    roomCode: room.room,
    hostPlayerId: room.members[0].playerId,
    revision: (current?.revision ?? 0) + 1,
    authorityRevision: (current?.authorityRevision ?? 0) + 1,
    members,
    settings: {},
    runState: null,
    runStateRevision: 0,
    slots,
    savedAt: Date.now(),
  };
}

export function renderSavedSoulLinkLobbiesInto({
  listEl,
  records,
  selectedRoomCode,
  onSelectRecord,
  onDeleteRecord,
  doc = globalThis.document,
}) {
  if (!listEl) return;
  listEl.replaceChildren();
  if (!records.length) {
    const empty = doc.createElement('li');
    empty.className = 'presence-empty';
    empty.textContent = 'No multiplayer runs saved in this browser yet.';
    listEl.append(empty);
  }
  for (const record of records) {
    const item = doc.createElement('li');
    item.className = 'soullink-saved-lobby-item';
    const description = doc.createElement('div');
    description.className = 'soullink-saved-lobby-info';
    const names = record.members.map((member) => member.name).filter(Boolean).join(' + ') || 'Saved run';
    const title = doc.createElement('strong');
    title.textContent = names;
    const metadata = doc.createElement('small');
    const assigned = Object.values(record.slots).filter((slot) => slot.ownerPlayerId).length;
    const saved = Object.values(record.slots).filter((slot) => slot.ownerPlayerId && slot.saveBytes).length;
    const savedAt = Number.isFinite(record.savedAt) && record.savedAt > 0
      ? new Date(record.savedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : 'Saved locally';
    const seed = record.runState?.seed;
    metadata.textContent = `${seed === undefined ? 'Run checkpoint' : `Seed ${seed}`} · ${saved}/${assigned} player saves · Saved ${savedAt}`;
    description.append(title, metadata);

    const resume = doc.createElement('button');
    resume.type = 'button';
    resume.className = 'saved-lobby-resume';
    resume.dataset.resume = '';
    resume.textContent = selectedRoomCode === record.roomCode ? 'Selected' : 'Resume';
    resume.disabled = selectedRoomCode === record.roomCode;
    resume.addEventListener('click', () => {
      resume.textContent = 'Selected';
      for (const button of listEl.querySelectorAll('button[data-resume]')) {
        button.disabled = button !== resume;
      }
      onSelectRecord?.(record);
    });

    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'saved-lobby-delete';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => onDeleteRecord?.(record, names));

    item.append(description, resume, remove);
    listEl.append(item);
  }
}

export function renderSavedStandardLobbiesInto({
  listEl,
  records,
  selectedRoomCode,
  onSelectRecord,
  doc = globalThis.document,
}) {
  if (!listEl) return;
  listEl.replaceChildren();
  if (!records.length) {
    const empty = doc.createElement('li');
    empty.className = 'presence-empty';
    empty.textContent = 'No saved Standard co-op lobbies in this browser yet.';
    listEl.append(empty);
  }
  for (const record of records) {
    const item = doc.createElement('li');
    item.className = 'soullink-saved-lobby-item';
    const info = doc.createElement('div');
    info.className = 'soullink-saved-lobby-info';
    const title = doc.createElement('strong');
    title.textContent = record.members.map((member) => member.name).join(' + ') || 'Standard co-op';
    const saved = Object.values(record.slots).filter((slot) => slot.ownerPlayerId && slot.saveBytes).length;
    const assigned = Object.values(record.slots).filter((slot) => slot.ownerPlayerId).length;
    const detail = doc.createElement('small');
    const savedAt = record.savedAt
      ? new Date(record.savedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : 'Saved locally';
    detail.textContent = `${saved}/${assigned} player saves · Saved ${savedAt}`;
    info.append(title, detail);

    const resume = doc.createElement('button');
    resume.type = 'button';
    resume.textContent = selectedRoomCode === record.roomCode ? 'Selected' : 'Resume';
    resume.disabled = selectedRoomCode === record.roomCode;
    resume.addEventListener('click', () => {
      for (const button of listEl.querySelectorAll('button')) button.disabled = button !== resume;
      onSelectRecord?.(record);
    });
    item.append(info, resume);
    listEl.append(item);
  }
}
