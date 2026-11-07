// SoulLink pregame lobby, run settings controls, run channel connection,
// starter choice dialog, and quick-start coordinator extracted from app.js.

import { createRunClient } from './client.mjs';
import { lobbyScreenPolicy } from './lobby-screen-policy.mjs';
import { buildPostRunSummary } from './post-run-model.mjs';
import { MUTUALLY_EXCLUSIVE_RANDOMIZER_PAIRS } from './run-settings.mjs';
import { starterChoicesForRun } from './starter-choices.mjs';
import { downloadPostRunPoster, renderPostRunSummaryInto } from '../ui/post-run-view.mjs';
import { renderStarterChoiceCards } from '../ui/starter-picker.mjs';
import { getEmeraldSpeciesInfo } from '../packs/shared/species-names-emerald.mjs';
import { libraryUrl } from '../packs/registry.mjs';

export function createRunSetupCoordinator({
  automate = false,
  soulLinkPregameRequested = false,
  elements = {},
  presence,
  presenceLobby,
  getPackManifest = () => null,
  getRunSettings = () => null,
  setRunSettings = () => {},
  getRunRuntime = () => null,
  getRunAdapter = () => null,
  getRunApi = () => null,
  getSaveStore = () => null,
  getLobbySaveStore = () => null,
  getSoulLinkBaseSaveBytes = () => null,
  getInstance = () => null,
  getMemoryReady = () => false,
  setQuickStartInFlight = () => {},
  clearInputState = () => {},
  loadFlashSave = () => {},
  saveFlashIfChanged = () => false,
  updateSaveActionLabels = () => {},
  runFrames = () => {},
  observeRunArea = () => {},
  showFatalError = () => {},
  onRenderPartyPanelIfOpen = () => {},
  lobbyCoordinator,
} = {}) {
  const {
    statusEl,
    runSetupFieldset,
    runModeNote,
    runStartButton,
    groupWipeDialog,
    groupWipeScreen,
    groupWipeReason,
    groupWipeMembers,
    runReadyButton,
    runRestartButton,
    presenceDefaultHead,
    soulLinkPregameHeader,
    soulLinkPregameBackButton,
    soulLinkPregameStatus,
    savedSoulLinkPanel,
    presenceFields,
    presenceActions,
    runOptionInputs = {},
    starterChoiceDialog,
    starterChoiceList,
    starterChoiceSeed,
  } = elements;

  let runClient = null;
  let runCredentialKey = '';
  let runConnectionStatus = 'disconnected';
  let runStartPending = false;
  let runQuickStartPromise = null;
  let pendingStarterChoice = null;
  let soulLinkNewRunSelected = false;
  let selectedSavedSoulLink = null;
  let savedSoulLinkRestoreRunId = null;

  function renderRunSetup() {
    if (!runSetupFieldset || !runModeNote) return;
    const setupPolicy = lobbyScreenPolicy('soullink');
    const room = presence.getSnapshot();
    const runRuntime = getRunRuntime();
    const runSettings = getRunSettings();
    const packManifest = getPackManifest();
    const shared = runRuntime?.peekState?.() ?? runRuntime?.state();
    const connected = room.status === 'joined';
    const roomHostPlayerId = room.members?.[0]?.playerId ?? null;
    const isHost = shared?.hostPlayerId
      ? shared.hostPlayerId === room.playerId
      : room.isRoomCreator === true || roomHostPlayerId === room.playerId;
    const modeSupported = Boolean(packManifest?.run?.modes?.includes('soullink'));
    const onSoulLinkRoute = runSettings?.mode === 'soullink';
    const active = Boolean(shared && shared.status !== 'closed');
    runModeNote.hidden = !modeSupported || onSoulLinkRoute || document.body.dataset.standardLobby === 'true';
    if (!modeSupported) {
      runModeNote.textContent = 'This installed game pack does not support multiplayer Nuzlocke runs.';
    } else if (!onSoulLinkRoute) {
      runModeNote.textContent = 'Open Multiplayer Nuzlocke / SoulLink from the library to start or join a rules-based run.';
    }
    const runChoiceMade = soulLinkNewRunSelected || Boolean(selectedSavedSoulLink);
    if (soulLinkPregameRequested && runChoiceMade) {
      if (savedSoulLinkPanel) savedSoulLinkPanel.hidden = connected;
      if (presenceFields) presenceFields.hidden = connected;
      if (presenceActions) presenceActions.hidden = false;
      const createButton = document.querySelector('#presence-create');
      const joinButton = document.querySelector('#presence-join');
      const leaveButton = document.querySelector('#presence-leave');
      if (createButton) createButton.hidden = connected;
      if (joinButton) joinButton.hidden = connected;
      if (leaveButton) leaveButton.hidden = !connected;
    }
    runSetupFieldset.hidden = !modeSupported || !onSoulLinkRoute || !setupPolicy.showSettings
      || (!runChoiceMade && !active && !automate);
    const options = shared?.options ?? runSettings ?? {};
    const wipePending = shared?.status === 'wipe_pending';
    const victoryPending = shared?.status === 'victory';
    const postRunOpen = wipePending || victoryPending;
    const activeMembers = shared?.members?.filter((member) => member.active !== false) ?? [];
    const allReady = activeMembers.length > 0 && activeMembers.every((member) => member.ready === true);
    const savedMembers = selectedSavedSoulLink?.runState?.members ?? [];
    const liveNames = (room.members ?? []).map((member) => member.name);
    const savedNames = savedMembers.map((member) => member.name);
    const savedPlayersMatch = Boolean(selectedSavedSoulLink
      && liveNames.length === savedNames.length
      && new Set(liveNames).size === liveNames.length
      && new Set(savedNames).size === savedNames.length
      && savedNames.every((name) => typeof name === 'string' && liveNames.includes(name)));
    if (soulLinkPregameStatus && soulLinkPregameRequested) {
      const roomLine = connected
        ? `Connected · room ${room.room} · ${room.members?.length ?? 0}/4. `
        : '';
      soulLinkPregameStatus.textContent = !connected
        ? selectedSavedSoulLink
          ? 'Run selected. Create a room to host it, or enter the host’s room code and join. Everyone must select their own saved copy.'
          : 'Create a room for a new run, or join a friend. Select a saved run below to resume.'
        : selectedSavedSoulLink
          ? active
            ? `${roomLine}Saved run restored; loading your assigned save.`
            : isHost
              ? savedPlayersMatch
                ? `${roomLine}Saved player names match. Start the run to restore the checkpoint.`
                : `${roomLine}The lobby needs the same players, using these exact saved names: ${savedNames.join(', ')}.`
              : savedPlayersMatch
                ? `${roomLine}Waiting for the host to restore the saved checkpoint.`
                : `${roomLine}This lobby needs the same players, using these exact saved names: ${savedNames.join(', ')}.`
          : active
            ? `${roomLine}The host started the run. Choose your starter to enter the game.`
            : isHost
              ? `${roomLine}${(room.members?.length ?? 0) < 2 ? 'Waiting for one more player before Start is available.' : 'Host: set options and start when ready.'}`
              : `${roomLine}Waiting for the host to start.`;
    }
    if (soulLinkPregameBackButton) soulLinkPregameBackButton.hidden = active;
    for (const [key, input] of Object.entries(runOptionInputs)) {
      if (input) {
        input.checked = options[key] === true;
        input.disabled = !connected || !isHost || active || Boolean(selectedSavedSoulLink);
      }
    }
    if (runStartButton) {
      const playerCount = room.members?.length ?? 0;
      const playersDoNotMatchSavedRun = selectedSavedSoulLink
        ? !savedPlayersMatch
        : setupPolicy.requireMultiplePlayersToStart && playerCount < 2;
      runStartButton.hidden = !runChoiceMade || active;
      runStartButton.disabled = !runChoiceMade || active || playersDoNotMatchSavedRun
        || (setupPolicy.requireRoomToStart && !connected)
        || (setupPolicy.hostOnlyStart && !isHost)
        || (setupPolicy.requireRoomToStart && !runClient?.attached);
      runStartButton.textContent = isHost ? 'Start run' : 'Waiting for host';
    }
    const note = document.querySelector('#presence-run-settings-note');
    if (note) {
      note.textContent = selectedSavedSoulLink
        ? `Saved settings · ${selectedSavedSoulLink.runState?.seed ?? 'unknown seed'} · locked`
        : soulLinkPregameRequested
          ? 'Shared seed and category toggles; enabled randomization is per player.'
          : active
            ? `Run seed ${shared.seed} · settings locked for this run.`
            : isHost ? 'Host chooses shared settings and the run seed. Enabled randomization differs by player.'
              : 'The room host chooses shared rules and randomizer settings.';
    }

    if (groupWipeScreen) groupWipeScreen.hidden = !postRunOpen;
    if (postRunOpen && groupWipeMembers) {
      const outcome = victoryPending ? 'victory' : 'wipe';
      if (groupWipeDialog) groupWipeDialog.dataset.outcome = outcome;
      if (groupWipeScreen) groupWipeScreen.dataset.outcome = outcome;
      const kickerEl = groupWipeScreen?.querySelector?.('#group-wipe-kicker, .group-wipe-kicker');
      const titleEl = groupWipeScreen?.querySelector?.('#group-wipe-title');
      const summaryBodyEl = groupWipeScreen?.querySelector?.('#post-run-summary-body');
      const summary = buildPostRunSummary({
        run: shared,
        localPlayerId: room.playerId,
        parties: presence.getParties?.() ?? {},
        speciesInfoFor: getEmeraldSpeciesInfo,
        regionMap: getRunAdapter()?.regionMap ?? null,
      });
      if (kickerEl) kickerEl.textContent = summary.kicker;
      if (titleEl) titleEl.textContent = summary.title;
      if (summaryBodyEl) renderPostRunSummaryInto(summaryBodyEl, summary);
      const roomMembers = new Map((room.members ?? []).map((member) => [member.playerId, member]));
      groupWipeMembers.replaceChildren();
      for (const member of shared.members ?? []) {
        if (member.active === false) continue;
        const item = document.createElement('li');
        const name = document.createElement('strong');
        name.textContent = `${member.name}${member.playerId === room.playerId ? ' (you)' : ''}`;
        const connection = roomMembers.get(member.playerId)?.connection ?? 'disconnected';
        const state = document.createElement('span');
        state.textContent = `${connection} · ${member.ready ? 'Ready' : 'Not ready'}`;
        item.className = 'group-wipe-member';
        state.className = 'group-wipe-member-state';
        item.append(name, state);
        groupWipeMembers.append(item);
      }
      groupWipeReason.textContent = victoryPending
        ? summary.subtitle
        : (summary.wipeDetail?.reason
            ? `${summary.wipeDetail.reason} Pokémon in the PC do not prevent a wipe.`
            : 'No living Pokémon remain in the active party. Pokémon in the PC do not prevent a wipe.');
      runReadyButton.hidden = !activeMembers.some((member) => member.playerId === room.playerId);
      const self = activeMembers.find((member) => member.playerId === room.playerId);
      runReadyButton.disabled = !self || self.ready === true || !runClient?.attached;
      runReadyButton.textContent = self?.ready ? 'You’re ready' : 'I’m ready';
      runRestartButton.hidden = !isHost;
      runRestartButton.disabled = !isHost || !allReady || !runClient?.attached;
      runRestartButton.textContent = 'Start new run';
    }
  }

  function updateRunConnection() {
    const runRuntime = getRunRuntime();
    const runSettings = getRunSettings();
    if (!runRuntime || !['soullink', 'standard'].includes(runSettings?.mode)) {
      lobbyCoordinator.clearLobbySnapshotQueue();
      runClient?.stop();
      runClient = null;
      runCredentialKey = '';
      renderRunSetup();
      return;
    }
    const credentials = presence.getRunCredentials?.();
    if (!credentials) {
      lobbyCoordinator.clearLobbySnapshotQueue();
      runClient?.stop({ sendLeave: false });
      runClient = null;
      runCredentialKey = '';
      renderRunSetup();
      return;
    }
    const signature = `${credentials.room}/${credentials.playerId}/${credentials.token}`;
    if (signature === runCredentialKey) return;
    runCredentialKey = signature;
    const runUrl = new URL(presence.url);
    runUrl.pathname = '/run';
    if (!runClient) {
      runClient = createRunClient({
        url: runUrl.href,
        ...credentials,
        onState: (nextState) => {
          if (getRunSettings()?.mode === 'standard') {
            renderRunSetup();
            return;
          }
          const currentRuntime = getRunRuntime();
          const previous = currentRuntime?.state();
          const continuing = nextState?.members?.some((member) => member.playerId === credentials.playerId && member.active !== false);
          if ((nextState?.status === 'wipe_pending' || nextState?.status === 'victory')
              && groupWipeDialog && !groupWipeDialog.open) {
            groupWipeDialog.showModal();
          } else if (groupWipeDialog?.open && nextState?.status === 'active'
              && previous?.runId !== nextState.runId) {
            groupWipeDialog.close();
          }
          const restoringSavedLobby = Boolean(selectedSavedSoulLink && nextState
            && savedSoulLinkRestoreRunId !== nextState.runId);
          if (restoringSavedLobby) savedSoulLinkRestoreRunId = nextState.runId;
          const shouldQuickStart = !selectedSavedSoulLink && nextState?.status === 'active'
            && continuing
            && !runQuickStartPromise
            && (runStartPending
              || (previous && previous.runId !== nextState.runId)
              || !getSaveStore()?.hasRecord()
              || currentRuntime?.cachedRunId !== nextState.runId);
          currentRuntime?.syncSnapshot(nextState, credentials.playerId);
          renderRunSetup();
          if (nextState && !restoringSavedLobby) void lobbyCoordinator.syncLobbyPersistence(nextState, credentials);
          if (restoringSavedLobby) {
            void lobbyCoordinator.restoreOwnSavedLobbySlot(selectedSavedSoulLink, nextState, credentials).catch((error) => {
              console.error('saved SoulLink restore failed', error);
              showFatalError(error, 'Unable to resume SoulLink');
            });
          }
          if (shouldQuickStart) {
            runStartPending = false;
            runQuickStartPromise = quickStartSoulRun(nextState).catch((error) => {
              console.error(error);
              showFatalError(error, 'Unable to start SoulLink run');
            }).finally(() => { runQuickStartPromise = null; });
          }
        },
        onError: (error) => {
          runStartPending = false;
          console.warn('run connection:', error.message);
          if (String(error.message).startsWith('lobby_transfer_') || selectedSavedSoulLink) statusEl.textContent = error.message;
          if (selectedSavedSoulLink) renderRunSetup();
        },
        onLobbyMessage: (message) => { void lobbyCoordinator.handleLobbyMessage(message); },
        onStatus: (status) => {
          runConnectionStatus = status.status;
          renderRunSetup();
          lobbyCoordinator.renderStandardLobbyScreen();
          if (status.status === 'attached' && getRunSettings()?.mode === 'standard'
            && lobbyCoordinator.currentLobbyHostPlayerId() === credentials.playerId) {
            lobbyCoordinator.queueLobbySnapshotBroadcast();
          }
          lobbyCoordinator.updateLobbySaveControls();
        },
      });
      runRuntime.setTransport({
        send: (event) => runClient?.sendEvent(event),
        isReady: () => Boolean(runClient?.attached),
      });
      runClient.start();
    } else {
      runClient.updateCredentials(credentials);
    }
  }

  function chooseStarterForPlayer(runState) {
    if (pendingStarterChoice) {
      if (pendingStarterChoice.runId === runState?.runId) return pendingStarterChoice.promise;
      pendingStarterChoice.resolve(null);
      pendingStarterChoice = null;
    }
    const runAdapter = getRunAdapter();
    const instance = getInstance();
    const localPlayerId = presence.getRunCredentials?.()?.playerId ?? presence.getSnapshot().playerId;
    const choices = starterChoicesForRun(
      { ...runState, localPlayerId },
      runAdapter.speciesTable(instance.exports),
      runAdapter.starterChoices,
    );
    let resolveChoice;
    const promise = new Promise((resolve) => { resolveChoice = resolve; });
    pendingStarterChoice = { runId: runState?.runId ?? null, promise, resolve: resolveChoice };
    renderStarterChoiceCards({
      listEl: starterChoiceList,
      seedEl: starterChoiceSeed,
      seed: runState.seed,
      choices,
      speciesInfoFor: getEmeraldSpeciesInfo,
      onSelect: ({ species, index }) => {
        const pending = pendingStarterChoice;
        if (!pending) return;
        pendingStarterChoice = null;
        starterChoiceDialog.close();
        pending.resolve({ species, index });
      },
    });
    if (!starterChoiceDialog.open) starterChoiceDialog.showModal();
    starterChoiceList.querySelector('button')?.focus();
    return promise;
  }

  async function quickStartSoulRun(runState) {
    const runAdapter = getRunAdapter();
    const instance = getInstance();
    if (!runAdapter || !runState || !Number.isSafeInteger(runState.seed) && typeof runState.seed !== 'string') {
      throw new Error('run adapter or seed is unavailable');
    }
    if (!instance?.exports || !getMemoryReady()) {
      throw new Error('The game has not started, so SoulLink quick-start cannot load a save. Resolve the game startup error and reload.');
    }
    const choice = await chooseStarterForPlayer(runState);
    if (!choice) return null;
    clearInputState();

    const starterSpecies = choice.species;
    setQuickStartInFlight(true);
    let quickStarted = false;
    try {
      quickStarted = Boolean(runAdapter.quickStartFromBase?.({
        starterSpecies,
        baseSaveBytes: getSoulLinkBaseSaveBytes(),
        loadBaseSave: (bytes) => loadFlashSave(bytes),
        exports: instance.exports,
        runFrames,
        options: runState.options ?? getRunSettings(),
      }));
    } finally {
      setQuickStartInFlight(false);
    }
    if (!quickStarted) throw new Error('Emerald could not load the SoulLink base save and replace its starter');
    observeRunArea();
    if (!saveFlashIfChanged(true)) throw new Error('Soulrun save could not be persisted');
    statusEl.textContent = 'SoulLink run ready';
    finishSoulLinkPregame();
    return { starterSpecies };
  }

  function startSelectedSoulLinkRun() {
    const runSettings = getRunSettings();
    const runRuntime = getRunRuntime();
    if (runSettings?.mode !== 'soullink' || !runRuntime || !runClient?.attached) return;
    if (selectedSavedSoulLink) {
      if (runClient.restoreRun({ runState: selectedSavedSoulLink.runState })) {
        runStartButton.disabled = true;
        if (soulLinkPregameStatus) soulLinkPregameStatus.textContent = 'Loading the saved run…';
      } else {
        statusEl.textContent = 'The saved run could not be sent to the room.';
      }
      return;
    }
    try {
      const patch = Object.fromEntries(
        Object.entries(runOptionInputs)
          .filter(([, input]) => Boolean(input))
          .map(([key, input]) => [key, input.checked]),
      );
      if (typeof patch.rareCandyPartyLevelCeiling === 'boolean') {
        patch.infiniteRareCandies = patch.rareCandyPartyLevelCeiling;
      }
      setRunSettings(runRuntime.configure(patch));
      updateSaveActionLabels();
      const sent = getRunApi()?.start();
      if (!sent) throw new Error('the host could not send the SoulLink run settings');
      renderRunSetup();
    } catch (error) {
      statusEl.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  function enterSoulLinkPregame() {
    if (!soulLinkPregameRequested) return;
    document.body.dataset.soulLinkPregame = 'true';
    if (presenceDefaultHead) presenceDefaultHead.hidden = true;
    if (soulLinkPregameHeader) soulLinkPregameHeader.hidden = false;
    if (soulLinkPregameBackButton) soulLinkPregameBackButton.hidden = false;
    const toggle = document.querySelector('#presence-toggle');
    if (toggle) toggle.hidden = true;
    soulLinkNewRunSelected = true;
    selectedSavedSoulLink = null;
    if (savedSoulLinkPanel) savedSoulLinkPanel.hidden = false;
    if (presenceFields) presenceFields.hidden = false;
    if (presenceActions) presenceActions.hidden = false;
    if (savedSoulLinkPanel) void lobbyCoordinator.renderSavedSoulLinkLobbies().catch((error) => {
      statusEl.textContent = `Saved lobbies could not be loaded: ${error.message}`;
    });
    presenceLobby.open();
    renderRunSetup();
  }

  function finishSoulLinkPregame() {
    if (document.body.dataset.soulLinkPregame !== 'true') return;
    document.body.dataset.soulLinkPregame = 'false';
    if (presenceDefaultHead) presenceDefaultHead.hidden = false;
    if (soulLinkPregameHeader) soulLinkPregameHeader.hidden = true;
    if (soulLinkPregameBackButton) soulLinkPregameBackButton.hidden = true;
    const toggle = document.querySelector('#presence-toggle');
    if (toggle) toggle.hidden = false;
    presenceLobby.close();
    lobbyCoordinator.updateLobbySaveControls();
    const url = new URL(location.href);
    url.searchParams.delete('pregame');
    history.replaceState(history.state, '', url);
  }

  function leaveSoulLinkPregame() {
    if (getRunRuntime()?.state()?.status === 'active') return;
    presence.leave();
    const url = new URL(libraryUrl(location.href));
    url.searchParams.delete('mode');
    url.searchParams.delete('pregame');
    location.assign(url);
  }

  function init() {
    starterChoiceDialog?.addEventListener('cancel', (event) => {
      event.preventDefault();
    });

    groupWipeDialog?.addEventListener('cancel', (event) => {
      event.preventDefault();
    });

    const downloadPosterButton = groupWipeScreen?.querySelector?.('#run-download-poster');
    downloadPosterButton?.addEventListener('click', () => {
      const shared = getRunRuntime()?.peekState?.() ?? getRunRuntime()?.state?.();
      if (!shared) return;
      const room = presence.getSnapshot();
      const summary = buildPostRunSummary({
        run: shared,
        localPlayerId: room.playerId,
        parties: presence.getParties?.() ?? {},
        speciesInfoFor: getEmeraldSpeciesInfo,
        regionMap: getRunAdapter()?.regionMap ?? null,
      });
      downloadPostRunPoster(summary);
    });

    soulLinkPregameBackButton?.addEventListener('click', leaveSoulLinkPregame);

    for (const [key, input] of Object.entries(runOptionInputs)) {
      input?.addEventListener('change', () => {
        const runRuntime = getRunRuntime();
        if (!runRuntime || runRuntime.state()) return;
        try {
          const patch = { [key]: input.checked };
          if (input.checked) {
            for (const [firstKey, secondKey] of MUTUALLY_EXCLUSIVE_RANDOMIZER_PAIRS) {
              const counterpartKey = key === firstKey ? secondKey : key === secondKey ? firstKey : null;
              if (counterpartKey) {
                patch[counterpartKey] = false;
                if (runOptionInputs[counterpartKey]) {
                  runOptionInputs[counterpartKey].checked = false;
                }
              }
            }
          }
          if (key === 'rareCandyPartyLevelCeiling') {
            patch.infiniteRareCandies = input.checked;
          }
          setRunSettings(runRuntime.configure(patch));
          renderRunSetup();
          onRenderPartyPanelIfOpen();
        } catch {
          // Keep UI responsive if run settings are already locked.
        }
      });
    }

    runStartButton?.addEventListener('click', startSelectedSoulLinkRun);
    runRestartButton?.addEventListener('click', () => {
      if (!runClient?.attached) return;
      const result = getRunApi()?.restart();
      if (!result) statusEl.textContent = 'The host restart request could not be sent.';
    });
    runReadyButton?.addEventListener('click', () => {
      if (!runClient?.attached) return;
      void (async () => {
        try {
          try {
            if (getLobbySaveStore()) {
              await lobbyCoordinator.saveLobbySlot(false, { allowExistingFlashWhenBusy: true });
            } else {
              saveFlashIfChanged(true);
            }
          } catch (saveError) {
            // When a Group Wipe occurs while a player is mid-battle, WasmCanSaveGame()
            // blocks in-engine saving; never let slot-save failure block readiness.
            console.warn('Ready slot save skipped while game is busy:', saveError);
          }
          const result = getRunApi()?.ready();
          if (!result?.accepted) throw new Error(`Ready was rejected: ${result?.reason ?? 'unknown error'}`);
        } catch (error) {
          statusEl.textContent = error instanceof Error ? error.message : String(error);
        }
      })();
    });
  }

  return {
    get runClient() { return runClient; },
    get runConnectionStatus() { return runConnectionStatus; },
    get selectedSavedSoulLink() { return selectedSavedSoulLink; },
    setSelectedSavedSoulLink(record) { selectedSavedSoulLink = record; },
    setSoulLinkNewRunSelected(value) { soulLinkNewRunSelected = Boolean(value); },
    setRunStartPending(value) { runStartPending = Boolean(value); },
    init,
    renderRunSetup,
    updateRunConnection,
    chooseStarterForPlayer,
    quickStartSoulRun,
    enterSoulLinkPregame,
    finishSoulLinkPregame,
    leaveSoulLinkPregame,
  };
}
