/*
 * The host broadcasts its lobby record whenever the record's authority advances.
 * That high-water mark must be scoped to one room: a client that joins a
 * different room starts that room's authority at zero, so a mark carried over
 * from a previous room would starve every participant of host snapshots and
 * leave them stuck on their own participant-local copy.
 */
export function createRoomScopedFloor() {
  let floor = { room: null, revision: -1 };
  const revisionFor = (room) => (floor.room === room ? floor.revision : -1);
  return {
    revisionFor,
    shouldBroadcast(room, authorityRevision) {
      if (typeof room !== 'string' || !room) return false;
      if (!Number.isSafeInteger(authorityRevision) || authorityRevision < 0) return false;
      return authorityRevision > revisionFor(room);
    },
    commit(room, authorityRevision) {
      if (typeof room !== 'string' || !room) throw new Error('lobby broadcast floor needs a room code');
      if (!Number.isSafeInteger(authorityRevision) || authorityRevision < 0) {
        throw new Error('lobby broadcast floor needs a non-negative authority revision');
      }
      floor = { room, revision: authorityRevision };
    },
  };
}
