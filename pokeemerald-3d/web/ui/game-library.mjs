// Library screen: installed packs, newest local save and Continue/Play actions.
//
// The view knows only pack metadata and local save records. It never imports a
// game adapter or branches on a game ID.

import { listGames, loadIndex } from '../packs/registry.mjs';
import { loadManifest, resolveResourceUrl } from '../packs/loader.mjs';
import { latestRecordByGame, listLocalSaveRecords, recordBytes } from './save-records.mjs';
import { readSaveSummary } from './save-summary.mjs';
import { buildLibraryModel } from './library-model.mjs';

function coverHue(text) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function makeCover(doc, game, className = 'library-cover') {
  const frame = doc.createElement('div');
  frame.className = className;
  frame.style.setProperty('--cover-hue', String(coverHue(game.title)));
  if (game.cover) {
    const image = doc.createElement('img');
    image.src = game.cover;
    image.alt = '';
    image.loading = 'lazy';
    image.dataset.loadingCritical = '';
    const showFallback = () => {
      if (!frame.contains(image)) return;
      const fallback = doc.createElement('span');
      fallback.textContent = game.title;
      frame.replaceChildren(fallback);
    };
    image.addEventListener('error', showFallback, { once: true });
    image.addEventListener('library-image-error', showFallback, { once: true });
    frame.append(image);
  } else {
    const fallback = doc.createElement('span');
    fallback.textContent = game.title;
    frame.append(fallback);
  }
  return frame;
}

function makePill(doc, text, className = '') {
  const pill = doc.createElement('span');
  pill.className = `library-pill ${className}`.trim();
  pill.textContent = text;
  return pill;
}

async function loadMapNames({ gameId, indexUrl, baseUrl }) {
  try {
    const loaded = await loadManifest({ gameId, indexUrl, baseUrl, requireDigests: false });
    const resource = (loaded.manifest.resources ?? []).find((item) => item.id === 'map-names');
    let mapNames = null;
    if (resource?.url) {
      const response = await fetch(resolveResourceUrl(loaded.manifestUrl, resource), { cache: 'no-store' });
      if (response.ok) mapNames = await response.json();
    }
    return { mapNames, runModes: loaded.manifest.run?.modes ?? [] };
  } catch {
    return { mapNames: null, runModes: [] };
  }
}

export function createGameLibrary({
  document: doc = globalThis.document,
  indexUrl = '/game-packs/index.json',
  baseUrl = globalThis.location?.href,
  onOpen = null,
  onSettings = null,
  onCustomize = null,
} = {}) {
  const root = doc?.querySelector?.('#library');
  const errorEl = doc?.querySelector?.('#library-error');
  const heroEl = doc?.querySelector?.('#library-hero');
  const gamesEl = doc?.querySelector?.('#library-games');
  const emptyEl = doc?.querySelector?.('#library-empty');
  const savesEl = doc?.querySelector?.('#library-saves-list');
  const settingsButton = doc?.querySelector?.('#library-settings');
  const customizeButton = doc?.querySelector?.('#library-customize');
  const runModeDialog = doc?.querySelector?.('#run-mode-dialog');
  const runModeTitle = doc?.querySelector?.('#run-mode-title');
  const runModeClose = doc?.querySelector?.('#run-mode-close');
  const runModeCancel = doc?.querySelector?.('#run-mode-cancel');
  const runModeButtons = [...(runModeDialog?.querySelectorAll?.('[data-run-mode]') ?? [])];

  let destroyed = false;
  let model = null;
  let selectedGame = null;

  function setError(message = '') {
    if (!errorEl) return;
    errorEl.hidden = !message;
    errorEl.textContent = message;
  }

  function openGame(game) {
    const supportedModes = Array.isArray(game.runModes) ? game.runModes : [];
    if (runModeDialog && supportedModes.length) {
      selectedGame = game;
      if (runModeTitle) runModeTitle.textContent = `Choose how to play ${game.title}`;
      for (const button of runModeButtons) {
        const mode = button.dataset.runMode;
         // The public product has two entry points. Nuzlocke is offered only
         // as the multiplayer SoulLink route; the standalone rules mode is not
         // a library choice.
         button.hidden = mode === 'nuzlocke' || (mode !== 'standard' && !supportedModes.includes(mode));
      }
      runModeDialog.showModal();
      return;
    }
    if (typeof onOpen === 'function') {
      onOpen(game.id, game.hasSave ? game.record?.profile ?? '' : '', 'standard');
    }
  }

  runModeDialog?.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-run-mode]');
    if (!button || !selectedGame) return;
    const game = selectedGame;
    const mode = button.dataset.runMode;
    selectedGame = null;
    runModeDialog.close();
    if (typeof onOpen === 'function') {
      onOpen(game.id, game.hasSave ? game.record?.profile ?? '' : '', mode);
    }
  });
  runModeClose?.addEventListener('click', () => runModeDialog?.close());
  runModeCancel?.addEventListener('click', () => runModeDialog?.close());
  runModeDialog?.addEventListener('close', () => { selectedGame = null; });

  function renderHero(hero) {
    if (!heroEl) return;
    heroEl.replaceChildren();
    if (!hero) {
      heroEl.hidden = true;
      return;
    }
    heroEl.hidden = false;
    heroEl.classList.add('pixel-frame');

    const media = makeCover(doc, hero, 'library-hero-cover');
    const body = doc.createElement('div');
    body.className = 'library-hero-body';

    if (hero.hasSave) {
      body.append(makePill(doc, 'LAST PLAYED', 'library-pill-last'));
    }
    const title = doc.createElement('h2');
    title.textContent = hero.title;
    body.append(title);

    if (hero.location) {
      const location = doc.createElement('p');
      location.className = 'library-location';
      location.textContent = hero.location;
      body.append(location);
    }

    const meta = doc.createElement('p');
    meta.className = 'library-meta';
    if (hero.hasSave) {
      meta.textContent = hero.lastPlayedLabel ? `Played ${hero.lastPlayedLabel}` : 'Local save ready';
    } else {
      meta.textContent = 'No local save yet';
    }
    body.append(meta);

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'library-continue pixel-frame';
    const face = doc.createElement('span');
    face.className = 'pixel-frame-content library-continue-face';
    face.textContent = hero.hasSave ? 'Continue' : 'Play';
    button.append(face);
    button.addEventListener('click', () => openGame(hero));
    body.append(button);

    const note = doc.createElement('p');
    note.className = 'library-note';
    note.textContent = hero.hasSave ? 'Your latest save is ready.' : 'Start a new game.';
    body.append(note);

    const content = doc.createElement('div');
    content.className = 'pixel-frame-content library-hero-content';
    content.append(media, body);
    heroEl.append(content);
  }

  function renderGames(entries, hero) {
    if (!gamesEl) return;
    gamesEl.replaceChildren();
    for (const game of entries) {
      const card = doc.createElement('button');
      card.type = 'button';
      card.className = 'library-card pixel-frame';
      card.dataset.gameId = game.id;
      card.addEventListener('click', () => openGame(game));

      const media = makeCover(doc, game);
      const body = doc.createElement('div');
      body.className = 'library-card-body';
      const title = doc.createElement('strong');
      title.textContent = game.title;
      body.append(title);
      const content = doc.createElement('div');
      content.className = 'pixel-frame-content library-card-content';
      content.append(media, body);
      card.append(content);
      gamesEl.append(card);
    }
    if (emptyEl) emptyEl.hidden = entries.length > 0;
  }

  function renderSaves(records, games) {
    if (!savesEl) return;
    savesEl.replaceChildren();
    const titles = new Map(games.map((game) => [game.id, game.title]));
    for (const record of records) {
      const row = doc.createElement('div');
      row.className = 'library-save-row';
      const label = doc.createElement('span');
      const slotLabel = record.slot === 'main' ? 'Standard' : record.slot;
      label.textContent = `${titles.get(record.gameId) ?? record.gameId} · ${slotLabel} · ${record.profile || 'Default profile'}`;
      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'library-save-delete';
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete ${label.textContent} save`);
      remove.addEventListener('click', () => {
        const confirm = doc.defaultView?.confirm?.bind(doc.defaultView) ?? globalThis.confirm;
        if (typeof confirm !== 'function' || !confirm(`Delete the ${label.textContent} save? This cannot be undone.`)) return;
        try {
          globalThis.localStorage.removeItem(record.key);
          load();
        } catch {
          setError('Could not delete this save from browser storage.');
        }
      });
      row.append(label, remove);
      savesEl.append(row);
    }
    if (!records.length) {
      const note = doc.createElement('p');
      note.textContent = 'No local game saves in this browser.';
      savesEl.append(note);
    }
  }

  async function load() {
    setError('');
    try {
      const { index, indexUrl: resolvedIndexUrl } = await loadIndex({ indexUrl, baseUrl });
      const games = listGames(index)
        .filter((game) => !game.hidden)
        .map((game) => ({
          ...game,
          cover: game.cover ? new URL(game.cover, resolvedIndexUrl).href : null,
        }));
      const records = listLocalSaveRecords();
      const latest = latestRecordByGame(records.filter((record) => record.slot === 'main'));
      const summaries = {};
      const mapNames = {};
      await Promise.all(games.map(async (game) => {
        const record = latest.get(game.id);
        if (record) {
          const bytes = recordBytes(record);
          if (bytes) summaries[record.key] = readSaveSummary(bytes);
        }
        const metadata = await loadMapNames({
          gameId: game.id,
          indexUrl: resolvedIndexUrl,
          baseUrl: resolvedIndexUrl,
        });
        mapNames[game.id] = metadata?.mapNames ?? null;
        game.runModes = metadata?.runModes ?? [];
      }));
      if (destroyed) return;
      model = buildLibraryModel({ games, records, summaries, mapNames });
      renderHero(model.hero);
      renderGames(model.games, model.hero);
      renderSaves(records, games);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(message);
      if (heroEl) heroEl.hidden = true;
      if (gamesEl) gamesEl.replaceChildren();
      if (emptyEl) emptyEl.hidden = false;
    }
  }

  function show() {
    if (root) root.hidden = false;
    if (doc?.body) doc.body.dataset.mode = 'library';
  }

  function hide() {
    if (root) root.hidden = true;
    if (doc?.body) doc.body.dataset.mode = 'play';
  }

  settingsButton?.addEventListener('click', () => {
    if (typeof onSettings === 'function') onSettings();
  });
  customizeButton?.addEventListener('click', () => {
    if (typeof onCustomize === 'function') onCustomize(model?.hero?.id ?? 'emerald');
  });

  return {
    load,
    show,
    hide,
    showError(message) {
      setError(message);
    },
    get model() { return model; },
    destroy() { destroyed = true; },
  };
}
