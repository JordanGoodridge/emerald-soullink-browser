// In-game secondary sheets (People Map, Party & SoulLink Pairs, Move Relearner,
// Nuzlocke Run Tracker) and Run Notice banner controller extracted from app.js.

import { buildPartyPanel } from '../presence/party-panel-model.mjs';
import { renderPartyPanelInto } from './party-panel.mjs';
import { renderRunTrackerInto } from './run-tracker.mjs';
import { renderPeopleMapInto } from './people-map-view.mjs';
import { moveRelearnerChoicesForMon, populateMoveRelearnerDialog } from './move-relearner-view.mjs';
import { buildRunTracker } from '../run/tracker-model.mjs';
import { describeRunNotice } from '../run/notice-model.mjs';

export function createGameplaySheetsController({
  elements = {},
  settings,
  presence,
  getPartyAdapter = () => null,
  getPartySnapshot = () => ({ availability: 'unavailable', members: [], revision: 0 }),
  onRefreshPartySnapshotNow = () => {},
  getMoveHistoryStore = () => null,
  getRunAdapter = () => null,
  getRunRuntime = () => null,
  getRunSettings = () => null,
  getInstance = () => null,
  getPackManifestUrl = () => null,
  getSelectedMapNameFor = () => () => null,
  saveFlashIfChanged = () => false,
} = {}) {
  const {
    statusEl,
    peopleMapDialog,
    peopleMapSummary,
    peopleMapBody,
    partyPanelDialog,
    partyPanelSummary,
    partyPanelBody,
    moveRelearnerDialog,
    moveRelearnerPokemon,
    moveRelearnerChoice,
    moveRelearnerSlot,
    moveRelearnerStatus,
    moveRelearnerTeachButton,
    runTrackerDialog,
    runTrackerSummary,
    runTrackerBody,
    runNotice,
    runNoticeTitle,
    runNoticeDetail,
    runNoticeDismissButton,
  } = elements;

  let lastPeopleMapRender = 0;
  let lastPartyPanelRender = 0;
  let moveRelearnerContext = null;
  let runNoticeTimer = null;

  function renderPeopleMap() {
    renderPeopleMapInto({
      bodyEl: peopleMapBody,
      summaryEl: peopleMapSummary,
      snapshot: presence.getSnapshot(),
      nameFor: getSelectedMapNameFor(),
      regionMap: getRunAdapter()?.regionMap,
      packManifestUrl: getPackManifestUrl(),
    });
  }

  function togglePeopleMap(force) {
    if (!peopleMapDialog) return false;
    const shouldOpen = typeof force === 'boolean' ? force : !peopleMapDialog.open;
    if (!shouldOpen) {
      if (peopleMapDialog.open) peopleMapDialog.close();
      return false;
    }
    if (!settings.get().peopleMap) return false;
    renderPeopleMap();
    lastPeopleMapRender = performance.now();
    if (!peopleMapDialog.open && typeof peopleMapDialog.showModal === 'function') {
      peopleMapDialog.showModal();
    }
    return true;
  }

  function maybeRefreshPeopleMap(now) {
    if (!peopleMapDialog?.open) return;
    if (now - lastPeopleMapRender < 400) return;
    lastPeopleMapRender = now;
    renderPeopleMap();
  }

  function readRelearnerMon(index) {
    return getPartyAdapter()?.readMoveRelearnerMon?.(index) ?? null;
  }

  function moveRelearnerChoicesFor(mon) {
    return moveRelearnerChoicesForMon({
      mon,
      moveHistoryStore: getMoveHistoryStore(),
      partyAdapter: getPartyAdapter(),
    });
  }

  function updateMoveRelearnerTeachButton() {
    if (!moveRelearnerTeachButton) return;
    const hasChoice = Boolean(moveRelearnerChoice?.value);
    const hasSlot = Number.isInteger(Number(moveRelearnerSlot?.value))
      && moveRelearnerSlot?.value !== '';
    moveRelearnerTeachButton.disabled = !moveRelearnerContext || !hasChoice || !hasSlot;
  }

  function isMoveRelearnerEnabled() {
    const runRuntime = getRunRuntime();
    const activeOptions = (runRuntime?.peekState?.() ?? runRuntime?.state?.())?.options ?? runRuntime?.settings ?? getRunSettings();
    return activeOptions?.moveRelearner !== false;
  }

  function openMoveRelearner(partyIndex) {
    if (!isMoveRelearnerEnabled() || !moveRelearnerDialog) return false;
    const mon = readRelearnerMon(partyIndex);
    if (!mon) return false;
    getMoveHistoryStore()?.remember(mon.personality, mon.moves);
    const choices = moveRelearnerChoicesFor(mon);
    moveRelearnerContext = { partyIndex, personality: mon.personality, species: mon.species };
    populateMoveRelearnerDialog({
      mon,
      partyMember: getPartySnapshot().members?.[partyIndex],
      choices,
      partyAdapter: getPartyAdapter(),
      pokemonEl: moveRelearnerPokemon,
      choiceSelectEl: moveRelearnerChoice,
      slotSelectEl: moveRelearnerSlot,
      statusEl: moveRelearnerStatus,
    });
    updateMoveRelearnerTeachButton();
    moveRelearnerDialog.showModal();
    return true;
  }

  function teachMoveRelearnerChoice() {
    if (!isMoveRelearnerEnabled() || !moveRelearnerContext || !moveRelearnerChoice?.value) return;
    const context = moveRelearnerContext;
    const mon = readRelearnerMon(context.partyIndex);
    const move = Number(moveRelearnerChoice.value);
    const slot = Number(moveRelearnerSlot?.value);
    if (!mon || mon.personality !== context.personality || mon.species !== context.species) {
      moveRelearnerStatus.textContent = 'That Pokémon changed. Close and reopen the move relearner.';
      return;
    }
    if (!Number.isInteger(slot) || slot < 0 || slot >= 4
      || !moveRelearnerChoicesFor(mon).some((choice) => choice.move === move)) {
      moveRelearnerStatus.textContent = 'That move or move slot is no longer available.';
      return;
    }
    if (!getPartyAdapter()?.setMove?.(context.partyIndex, slot, move)) {
      moveRelearnerStatus.textContent = 'The game could not replace that move. Try opening the move relearner again.';
      return;
    }
    getMoveHistoryStore()?.remember(mon.personality, [...mon.moves, move]);
    onRefreshPartySnapshotNow();
    const saved = saveFlashIfChanged(true);
    moveRelearnerDialog.close();
    moveRelearnerContext = null;
    renderPartyPanel();
    lastPartyPanelRender = performance.now();
    if (!saved) statusEl.textContent = 'Move changed, but the game save could not be written. Save again before leaving.';
  }

  function renderPartyPanel() {
    if (!partyPanelBody || !partyPanelSummary) return;
    const snapshot = presence.getSnapshot();
    const partyAdapter = getPartyAdapter();
    const runRuntime = getRunRuntime();
    const runAdapter = getRunAdapter();
    const instance = getInstance();
    const runState = runRuntime?.peekState?.() ?? runRuntime?.state?.() ?? null;
    const model = buildPartyPanel({
      self: { playerId: snapshot.playerId, party: getPartySnapshot() },
      members: snapshot.members ?? [],
      parties: presence.getParties?.() ?? {},
      links: runState?.links ?? {},
      areas: runState?.areas ?? {},
      areaLabelFor: (areaKey) => {
        const area = runState?.areas?.[areaKey];
        if (area?.label) return area.label;
        const sectionId = area?.sectionId;
        return runAdapter?.areaLabel?.(areaKey, { sectionId }, instance?.exports) ?? null;
      },
      speciesNameFor: (id) => partyAdapter?.speciesName?.(id) ?? null,
      serverNowMs: snapshot.serverNowMs,
      visibleSnapshotAgeMs: snapshot.visibleSnapshotAgeMs,
      nameFor: getSelectedMapNameFor(),
    });
    model.runTracker = buildRunTracker({
      run: runState,
      presence: snapshot,
      regionMap: runAdapter?.regionMap ?? null,
    });

    const playerCount = model.players.length;
    const linkCount = model.links.length;
    partyPanelSummary.textContent = playerCount
      ? `${playerCount} player${playerCount === 1 ? '' : 's'} · ${linkCount} SoulLink bond${linkCount === 1 ? '' : 's'}`
      : 'Not connected';

    renderPartyPanelInto(partyPanelBody, model, document, {
      moveRelearnerEnabled: isMoveRelearnerEnabled()
        && typeof instance?.exports?.WasmRunRelearnableMoveCount === 'function'
        && typeof instance?.exports?.WasmRunSetPartyMove === 'function',
      onOpenMoveRelearner: openMoveRelearner,
      onOpenRunTracker: runTrackerDialog
        ? () => {
            if (partyPanelDialog?.open) partyPanelDialog.close();
            openRunTracker();
          }
        : null,
    });
  }

  function currentRunTracker() {
    const snapshot = presence.getSnapshot();
    const runRuntime = getRunRuntime();
    return buildRunTracker({
      run: runRuntime?.peekState?.() ?? runRuntime?.state?.() ?? null,
      presence: snapshot,
      regionMap: getRunAdapter()?.regionMap ?? null,
    });
  }

  function renderRunTracker() {
    if (!runTrackerBody) return;
    const tracker = currentRunTracker();
    const summary = tracker.summary ?? {};
    if (runTrackerSummary) {
      const playerCount = tracker.players?.length ?? 0;
      const modeLabel = playerCount > 1 ? `SoulLink · ${playerCount} players` : 'Nuzlocke run';
      const totalAreas = summary.total ?? 0;
      runTrackerSummary.textContent = totalAreas > 0
        ? `${modeLabel} · ${summary.visited ?? 0} of ${totalAreas} areas visited`
        : `${modeLabel} · ${summary.visited ?? 0} visited`;
    }
    const partyAdapter = getPartyAdapter();
    const runAdapter = getRunAdapter();
    const runRuntime = getRunRuntime();
    const instance = getInstance();
    renderRunTrackerInto(runTrackerBody, tracker, document, {
      speciesNameFor: (id) => partyAdapter?.speciesName?.(id) ?? null,
      currentArea: (() => {
        const sectionId = runAdapter?.sectionId?.({}, instance?.exports);
        if (!Number.isInteger(sectionId)) return null;
        const key = runAdapter?.areaKey?.({ sectionId }, { exports: instance?.exports });
        const area = (runRuntime?.peekState?.() ?? runRuntime?.state?.())?.areas?.[key];
        const ownClaim = area?.claims?.[runRuntime?.localPlayerId];
        const currentStatus = area?.status === 'void' ? 'encounter missed'
          : area?.status === 'dead' ? 'encounter lost'
            : ownClaim?.status === 'caught' ? 'encounter claimed'
              : ownClaim ? 'encounter in progress' : 'encounter available';
        return {
          label: runAdapter?.areaLabel?.(key, { sectionId }, instance?.exports) ?? key ?? `Area ${sectionId}`,
          status: currentStatus,
        };
      })(),
    });
  }

  function openRunTracker() {
    if (!runTrackerDialog) return false;
    renderRunTracker();
    if (!runTrackerDialog.open) runTrackerDialog.showModal();
    return true;
  }

  function showRunNotice({ title, detail }) {
    if (!runNotice || !runNoticeTitle || !runNoticeDetail || !title) return;
    runNoticeTitle.textContent = title;
    runNoticeDetail.textContent = detail ?? '';
    runNotice.hidden = false;
    if (runNoticeTimer) clearTimeout(runNoticeTimer);
    runNoticeTimer = setTimeout(() => { runNotice.hidden = true; runNoticeTimer = null; }, 6500);
  }

  function handleRunNotice(notice) {
    const copy = describeRunNotice(notice, { speciesNameFor: (id) => getPartyAdapter()?.speciesName?.(id) ?? null });
    if (copy) showRunNotice(copy);
  }

  function openPartyPanel() {
    if (!partyPanelDialog) return false;
    renderPartyPanel();
    lastPartyPanelRender = performance.now();
    if (!partyPanelDialog.open && typeof partyPanelDialog.showModal === 'function') {
      partyPanelDialog.showModal();
    }
    return true;
  }

  function maybeRefreshPartyPanel(now) {
    if (!partyPanelDialog?.open) return;
    if (now - lastPartyPanelRender < 500) return;
    lastPartyPanelRender = now;
    renderPartyPanel();
  }

  function maybeRefreshRunTracker(now) {
    if (!runTrackerDialog?.open || now - lastPartyPanelRender < 500) return;
    lastPartyPanelRender = now;
    renderRunTracker();
  }

  function maybeRefreshAll(now = performance.now()) {
    maybeRefreshPeopleMap(now);
    maybeRefreshPartyPanel(now);
    maybeRefreshRunTracker(now);
  }

  function init() {
    moveRelearnerChoice?.addEventListener('change', updateMoveRelearnerTeachButton);
    moveRelearnerSlot?.addEventListener('change', updateMoveRelearnerTeachButton);
    moveRelearnerTeachButton?.addEventListener('click', teachMoveRelearnerChoice);
    moveRelearnerDialog?.addEventListener('close', () => { moveRelearnerContext = null; });

    runNoticeDismissButton?.addEventListener('click', () => {
      if (runNoticeTimer) clearTimeout(runNoticeTimer);
      runNoticeTimer = null;
      if (runNotice) runNotice.hidden = true;
    });
  }

  return {
    init,
    renderPeopleMap,
    togglePeopleMap,
    openMoveRelearner,
    renderPartyPanel,
    openPartyPanel,
    renderRunTracker,
    openRunTracker,
    showRunNotice,
    handleRunNotice,
    maybeRefreshAll,
  };
}
