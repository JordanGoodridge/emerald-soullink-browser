#!/usr/bin/env node
// Two-pack architecture E2E.
//
// Proves:
// - Emerald and the hidden test-emerald fixture boot under separate game IDs;
// - the same profile label gets distinct save record keys;
// - an explicit unknown game produces a named error and opens the selector.
//
//   node tools/game_packs_e2e.mjs [--base-url=http://127.0.0.1:8091] [--headed]

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { startServer as startRunRelay } from '../server/src/server.mjs';

const gameRoot = existsSync(resolve('web', 'server.mjs')) ? resolve('.') : resolve('pokeemerald-3d');
const OUTPUT = resolve(gameRoot, 'pack-e2e-output');
const args = new Set(process.argv.slice(2));
const headed = args.has('--headed');
const baseArg = process.argv.find((arg) => arg.startsWith('--base-url='));
const baseUrl = baseArg ? baseArg.slice('--base-url='.length).replace(/\/$/, '') : null;

function log(message) {
  const line = `[pack-e2e] ${message}`;
  console.log(line);
  return line;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

function browserPath() {
  const candidates = [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Chrome/Chromium not found; set CHROME_BIN');
  return found;
}

async function startServer() {
  const child = spawn(process.execPath, ['web/server.mjs'], {
    cwd: gameRoot,
    env: { ...process.env, PORT: '0' },
  });
  return await withTimeout(new Promise((resolveStart, reject) => {
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
      if (match) resolveStart({ child, url: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[web] ${chunk}`));
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`web server exited ${code}`)));
  }), 15000, 'web server');
}

async function startBrowser(userDataDir) {
  const child = spawn(browserPath(), [
    headed ? '--headless=old' : '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--enable-unsafe-webgpu',
    '--window-size=960,720',
    'about:blank',
  ].filter((arg) => arg !== '--headless=old'), { stdio: ['ignore', 'ignore', 'pipe'] });
  return await withTimeout(new Promise((resolveStart, reject) => {
    child.stderr.on('data', (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolveStart({ child, browserWs: match[1] });
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`browser exited ${code}`)));
  }), 20000, 'browser');
}

class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolveReady, reject) => {
      this.socket.addEventListener('open', resolveReady, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.receive(JSON.parse(event.data)));
  }

  receive(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    this.handlers.get(message.method)?.(message.params);
  }

  on(method, handler) { this.handlers.set(method, handler); }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return await withTimeout(new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
    }), 30000, method);
  }

  close() { this.socket.close(); }
}

async function newPage(browserWs) {
  const endpoint = new URL(browserWs);
  const response = await fetch(`http://${endpoint.host}/json/new`, { method: 'PUT' });
  const target = await response.json();
  return new Cdp(target.webSocketDebuggerUrl);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(cdp, expression, label, timeoutMs = 30000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await evaluate(cdp, expression);
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(150);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function navigateAndReady(cdp, url) {
  cdp.on('Runtime.exceptionThrown', (params) => console.error('[page error]', params.exceptionDetails?.text));
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp, 'Boolean(window.pokeemerald?.automation?.ready)', 'automation API');
  await evaluate(cdp, '(async()=>{await window.pokeemerald.automation.ready;return true;})()');
  return await evaluate(cdp, 'window.pokeemerald.automation.state()');
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });
  const summary = { checks: [], startedAt: new Date().toISOString() };
  let server = null;
  let relay = null;
  let browser = null;
  let guestBrowser = null;
  let cdp = null;
  let guestCdp = null;
  let userDataDir = null;
  let guestUserDataDir = null;
  const check = (name, ok, detail = null) => {
    summary.checks.push({ name, ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) throw new Error(`${name}${detail ? ` (${JSON.stringify(detail)})` : ''}`);
  };

  try {
    relay = await startRunRelay({ port: 0, host: '127.0.0.1', log: { log() {}, error() {} } });
    server = baseUrl ? { url: baseUrl, child: { kill() {} } } : await startServer();
    userDataDir = await mkdtemp(resolve(tmpdir(), 'poketech-pack-e2e-'));
    browser = await startBrowser(userDataDir);
    cdp = await newPage(browser.browserWs);

    await cdp.send('Page.navigate', { url: `${server.url}/?presenceUrl=${encodeURIComponent(relay.url)}` });
    const library = await waitFor(cdp, `(() => {
      const cards = [...document.querySelectorAll('#library-games .library-card')];
      if (!document.querySelector('#library') || document.querySelector('#library').hidden || cards.length < 2) return null;
      return {
        games: cards.map((card) => card.dataset.gameId),
        playHidden: document.querySelector('#play-shell')?.hidden === true,
        hasGameDialog: Boolean(document.querySelector('#game-dialog')),
      };
    })()`, 'library cards');
    check('the bare URL opens the installed-game library', library.playHidden === true
      && library.games.includes('emerald') && library.games.includes('emerald-kaizo'), library);
    const loaderHidden = await waitFor(cdp,
      `document.querySelector('#library-loader')?.hidden === true`, 'initial library loader to finish');
    check('the startup loader clears after library artwork is ready', loaderHidden === true, loaderHidden);
    const loaderAsset = await evaluate(cdp, `(() => {
      const image = document.querySelector('#library-loader .pokeball');
      return { loaded: image?.complete === true && image.naturalWidth > 0, width: image?.naturalWidth ?? 0 };
    })()`);
    check('the Poké Ball loader sprite is served and decoded', loaderAsset.loaded, loaderAsset);
    const libraryFooter = await evaluate(cdp, `(() => {
      const footer = document.querySelector('.library-footer');
      const footerRect = footer.getBoundingClientRect();
      const range = document.createRange();
      range.selectNode(document.querySelector('.library-footer > span'));
      const textRect = range.getBoundingClientRect();
      return {
        footerCenter: footerRect.left + footerRect.width / 2,
        textCenter: textRect.left + textRect.width / 2,
      };
    })()`);
    check('the library footer prompt is centered in its layout',
      Math.abs(libraryFooter.footerCenter - libraryFooter.textCenter) < 1, libraryFooter);
    check('the old game picker dialog is gone', library.hasGameDialog === false, library.hasGameDialog);
    check('hidden test packs are not in the library',
      !library.games.includes('test-emerald') && !library.games.includes('test-classic'), library.games);

    const libraryRunModes = await evaluate(cdp, `(()=>{
      document.querySelector('#library-games [data-game-id="emerald"]').click();
      const dialog=document.querySelector('#run-mode-dialog');
      const content=dialog.querySelector(':scope > .dialog-frame');
      const button=dialog.querySelector('[data-run-mode=standard]');
      return {
        open:dialog.open,
        modes:Array.from(dialog.querySelectorAll('[data-run-mode]:not([hidden])')).map(button=>button.dataset.runMode),
        contentZIndex:Number.parseInt(getComputedStyle(content).zIndex,10),
        frameOverlayZIndex:Number.parseInt(getComputedStyle(dialog,'::after').zIndex,10),
        titleColor:getComputedStyle(dialog.querySelector('h2')).color,
        choiceColor:getComputedStyle(button).color,
      };
    })()`);
    check('Emerald library action offers only Standard Play and multiplayer Nuzlocke / SoulLink',
      libraryRunModes.open
        &&JSON.stringify(libraryRunModes.modes.sort())===JSON.stringify(['soullink','standard']),
      libraryRunModes);
    check('run-mode dialog content layers above its frame and keeps readable library text',
      libraryRunModes.contentZIndex>libraryRunModes.frameOverlayZIndex
        &&libraryRunModes.titleColor==='rgb(21, 37, 64)'
        &&libraryRunModes.choiceColor==='rgb(21, 37, 64)',
      libraryRunModes);
    await evaluate(cdp, "document.querySelector('#run-mode-dialog [data-run-mode=standard]').click()");
    const chosenStandard = await waitFor(cdp,
      "new URL(location.href).searchParams.get('mode')==='standard'&&new URL(location.href).searchParams.get('lobby')==='1'&&new URL(location.href).searchParams.get('game')==='emerald'",
      'library Standard choice opens its local lobby route',30000);
    check('selecting Standard Play opens its one-player lobby route',
      chosenStandard===true,await evaluate(cdp,'location.href'));
    const standardLobbyReady = await waitFor(cdp, `(()=>{
      const settings=document.querySelector('#standard-lobby-settings');
      const start=document.querySelector('#standard-lobby-start');
      return document.body.dataset.standardLobby==='true'&&!settings.hidden&&!start.disabled
        ? {settings:settings.textContent,inputs:settings.querySelectorAll('input').length,
            startText:start.textContent,status:document.querySelector('#standard-lobby-status').textContent}
        : null;
    })()`, 'Standard one-player lobby displays its Standard-only settings and enabled start button',30000);
    check('Standard lobby shows ordinary-save settings and permits solo start without SoulLink rule controls',
      standardLobbyReady.inputs===0&&standardLobbyReady.settings.toLowerCase().includes('main save')
        &&standardLobbyReady.startText==='Start Standard Play',standardLobbyReady);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const standardMobileLayout = await evaluate(cdp, `(()=>{
      const panel=document.querySelector('#presence-panel').getBoundingClientRect();
      document.querySelector('#standard-lobby-start').scrollIntoView({block:'end'});
      const start=document.querySelector('#standard-lobby-start').getBoundingClientRect();
      return {panel:{left:panel.left,right:panel.right,top:panel.top,bottom:panel.bottom},
        viewport:{width:innerWidth,height:innerHeight},panelVisible:!document.querySelector('#presence-panel').hidden,
        start:{top:start.top,bottom:start.bottom},
        hasSettings:!document.querySelector('#standard-lobby-settings').hidden,
        startText:document.querySelector('#standard-lobby-start').textContent,
        scrollHeight:document.querySelector('#presence-panel').scrollHeight};
    })()`);
    check('Standard lobby settings and start action fit the mobile modal viewport',
      standardMobileLayout.panelVisible&&standardMobileLayout.hasSettings
        &&standardMobileLayout.panel.left>=0&&standardMobileLayout.panel.right<=standardMobileLayout.viewport.width
        &&standardMobileLayout.panel.top>=0&&standardMobileLayout.panel.bottom<=standardMobileLayout.viewport.height
        &&standardMobileLayout.start.top>=0&&standardMobileLayout.start.bottom<=standardMobileLayout.viewport.height
        &&standardMobileLayout.startText==='Start Standard Play',standardMobileLayout);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await evaluate(cdp, "document.querySelector('#standard-lobby-start').click();true");
    await waitFor(cdp, 'Boolean(window.pokeemerald?.instance?.exports)', 'Standard game boots after starting the local lobby',30000);
    const standardStarted = await evaluate(cdp, `({
      lobbyHidden:document.body.dataset.standardLobby!=='true',
      mode:window.pokeemerald.run.settings.mode,
      saveSlot:window.pokeemerald.run.settings.saveSlot,
      runState:window.pokeemerald.run.state(),
      presence:window.pokeemerald.presence.diagnostics(),
    })`);
    check('starting the offline Standard lobby enters ordinary Emerald without a room or run state',
      standardStarted.lobbyHidden&&standardStarted.mode==='standard'&&standardStarted.saveSlot==='main'
        &&standardStarted.runState===null&&standardStarted.presence.status==='disconnected'
        &&standardStarted.presence.bytesSent===0,standardStarted);
    await cdp.send('Page.navigate', {
      url: `${server.url}/?library=1&presenceUrl=${encodeURIComponent(relay.url)}`,
    });
    await waitFor(cdp, "!document.querySelector('#library').hidden", 'library reopens for SoulLink selection');
    await waitFor(cdp,
      "Boolean(document.querySelector('#library-games [data-game-id=emerald]'))",
      'Emerald card reloads for SoulLink selection');
    await evaluate(cdp, `(()=>{
      document.querySelector('#library-games [data-game-id="emerald"]').click();
      document.querySelector('#run-mode-dialog [data-run-mode=soullink]').click();
      return true;
    })()`);
    const chosenSoulLink = await waitFor(cdp,
      "new URL(location.href).searchParams.get('mode')==='soullink'&&new URL(location.href).searchParams.get('game')==='emerald'",
      'library SoulLink choice reloads into its distinct mode',30000);
    check('selecting SoulLink from the library enters the multiplayer route',
      chosenSoulLink===true,await evaluate(cdp,'location.href'));

    const pregameReady = await waitFor(cdp, `(()=>{
      const panel=document.querySelector('#presence-panel');
      return document.body.dataset.soulLinkPregame==='true'
        &&panel&&!panel.hidden
        &&document.querySelector('#soul-link-pregame-header')?.hidden===false;
    })()`, 'SoulLink opens its pregame lobby instead of the game start screen', 30000);
    check('SoulLink selection opens the focused pregame lobby', pregameReady === true);
    const resumePanel = await evaluate(cdp, `(()=>({
      heading:document.querySelector('#soullink-saved-lobbies h3')?.textContent.trim(),
      empty:document.querySelector('#soullink-saved-lobby-list')?.textContent.trim(),
      createRoomHidden:document.querySelector('#presence-create').hidden,
    }))()`);
    check('pregame labels the saved-run area and allows room creation/join',
      resumePanel.heading==='Resume a run'&&!resumePanel.createRoomHidden,resumePanel);
    const pregameFrame = await evaluate(cdp, `(()=>({
      normalHeader:getComputedStyle(document.querySelector('#presence-default-head')).display,
      gameControls:[...document.querySelectorAll('#play-shell > :not(.ambient):not(#presence-panel)')]
        .filter(element=>getComputedStyle(element).display!=='none').map(element=>element.id||element.className),
      panelRect:document.querySelector('#presence-panel').getBoundingClientRect().toJSON(),
    }))()`);
    check('pregame hides the game shell and replaces the Friends panel heading',
      pregameFrame.normalHeader==='none'&&pregameFrame.gameControls.length===0,
      pregameFrame);
    const saveBeforeRoom = await evaluate(cdp,
      "Object.keys(localStorage).filter(key=>key.endsWith('/soulrun'))");
    check('opening the pregame lobby has not created a SoulLink save', saveBeforeRoom.length === 0, saveBeforeRoom);
    await evaluate(cdp, "document.querySelector('#soul-link-pregame-back').click()");
    await waitFor(cdp,
      "document.body.dataset.mode==='library'&&!document.querySelector('#library').hidden",
      'Back to games leaves the pregame lobby', 30000);
    check('leaving before the host starts returns to the library without a SoulLink save',
      (await evaluate(cdp, "!Object.keys(localStorage).some(key=>key.endsWith('/soulrun'))"))===true);
    await evaluate(cdp, `(()=>{
      document.querySelector('#library-games [data-game-id="emerald"]').click();
      document.querySelector('#run-mode-dialog [data-run-mode=soullink]').click();
      return true;
    })()`);
    await waitFor(cdp,
      "document.body.dataset.soulLinkPregame==='true'&&document.querySelector('#soul-link-pregame-header')?.hidden===false",
      'SoulLink can be opened again after leaving pregame', 30000);
    await waitFor(cdp, 'Boolean(window.pokeemerald?.presence?.state)', 'SoulLink presence API after re-entry', 30000);
    await evaluate(cdp, `(()=>{
      document.querySelector('#presence-name').value='Lobby Host';
      document.querySelector('#presence-create').click();
      return true;
    })()`);
    const hostRoom = await waitFor(cdp,
      "window.pokeemerald.presence.state().status==='joined'",
      'pregame host creates a room', 20000);
    const hostRoomCode = await evaluate(cdp, 'window.pokeemerald.presence.state().room');
    const hostPlayerId = await evaluate(cdp, 'window.pokeemerald.presence.state().playerId');
    const hostWaitsForGuest = await waitFor(cdp, `(()=>{
      const setup=document.querySelector('#presence-run-settings');
      const start=document.querySelector('#run-start');
      return !setup.hidden&&start.disabled
        ? {disabled:start.disabled, message:document.querySelector('#soul-link-pregame-status').textContent}
        : null;
    })()`, 'host cannot start a one-player room', 20000);
    check('host Start waits until at least two players are connected',
      hostWaitsForGuest.disabled===true
        &&hostWaitsForGuest.message.includes('Waiting for one more player'),hostWaitsForGuest);
    guestUserDataDir = await mkdtemp(resolve(tmpdir(), 'poketech-soullink-guest-'));
    guestBrowser = await startBrowser(guestUserDataDir);
    guestCdp = await newPage(guestBrowser.browserWs);
    const guestUrl = new URL(`${server.url}/`);
    guestUrl.searchParams.set('game', 'emerald');
    guestUrl.searchParams.set('mode', 'soullink');
    guestUrl.searchParams.set('pregame', '1');
    guestUrl.searchParams.set('saveProfile', 'pregame-guest');
    guestUrl.searchParams.set('presenceUrl', relay.url);
    guestUrl.searchParams.set('presenceName', 'Lobby Guest');
    await guestCdp.send('Page.navigate', { url: guestUrl.toString() });
    await waitFor(guestCdp,
      "document.body.dataset.soulLinkPregame==='true'&&Boolean(window.pokeemerald?.presence?.state)",
      'guest opens the SoulLink pregame lobby', 30000);
    await evaluate(guestCdp, `(()=>{
      document.querySelector('#presence-room').value=${JSON.stringify(hostRoomCode)};
      document.querySelector('#presence-join').click();
      return true;
    })()`);
    await waitFor(guestCdp,
      `window.pokeemerald.presence.state().status==='joined'&&window.pokeemerald.presence.state().room==='${hostRoomCode}'`,
      'guest joins the pregame room', 20000);
    await evaluate(cdp, "document.querySelector('#run-start').scrollIntoView({block:'center'})");
    const lobbySetup = await waitFor(cdp, `(()=>{
      const start=document.querySelector('#run-start');
      const fieldset=document.querySelector('#presence-run-settings');
      return !fieldset.hidden&&!start.hidden&&!start.disabled
        ? {players:window.pokeemerald.presence.state().members.length,
            host:window.pokeemerald.presence.state().members[0]?.playerId,
            boxingChecked:document.querySelector('#run-allow-linked-pc').checked,
            lobbySaveHidden:document.querySelector('#lobby-save-controls').hidden,
            startRect:document.querySelector('#run-start').getBoundingClientRect().toJSON(),
            innerHeight}
        : null;
    })()`, 'pregame host sees shared settings and start action', 20000);
    const guestSetup = await waitFor(guestCdp, `(()=>{
      const start=document.querySelector('#run-start');
      const fieldset=document.querySelector('#presence-run-settings');
      return !fieldset.hidden&&start.disabled
        ? {players:window.pokeemerald.presence.state().members.length,
            settingsDisabled:[...fieldset.querySelectorAll('input')].every(input=>input.disabled)}
        : null;
    })()`, 'pregame guest sees host-owned setup', 20000);
    check('pregame lobby exposes host start/settings and guest read-only state',
      lobbySetup.players===2&&lobbySetup.host===hostPlayerId
        &&lobbySetup.boxingChecked===true
        &&lobbySetup.lobbySaveHidden===true
        &&lobbySetup.startRect.top>=0&&lobbySetup.startRect.bottom<=lobbySetup.innerHeight
        &&guestSetup.players===2&&guestSetup.settingsDisabled,
      {host: lobbySetup, guest: guestSetup, room: hostRoom});
    const pregameScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(resolve(OUTPUT, 'soullink-pregame.png'), Buffer.from(pregameScreenshot.data, 'base64'));
    const preStartSaveCounts = await Promise.all([cdp, guestCdp].map((page) =>
      evaluate(page, "Object.keys(localStorage).filter(key=>key.endsWith('/soulrun')).length")));
    check('joining the pregame room still does not create a SoulLink save',
      preStartSaveCounts.every((count)=>count===0), preStartSaveCounts);
    await evaluate(cdp, "document.querySelector('#run-start').click()");
    const starterChoices = await Promise.all([cdp, guestCdp].map((page) => waitFor(page, `(()=>{
      const dialog=document.querySelector('#starter-choice-dialog');
      const choices=[...document.querySelectorAll('#starter-choice-list button')].map(button=>button.dataset.species);
      const visible=dialog&&getComputedStyle(dialog).display!=='none'
        &&dialog.getBoundingClientRect().width>0&&dialog.getBoundingClientRect().height>0;
      return dialog?.open&&visible&&choices.length===3?choices:null;
    })()`, 'each pregame member receives the starter choices', 20000)));
    check('host Start gives each player a different starter-choice list from the shared run seed',
      JSON.stringify(starterChoices[0])!==JSON.stringify(starterChoices[1]), starterChoices);
    const saveWhileChoosing = await Promise.all([cdp, guestCdp].map((page) =>
      evaluate(page, "Object.keys(localStorage).filter(key=>key.endsWith('/soulrun')).length")));
    check('no SoulLink save is created until each player confirms a starter',
      saveWhileChoosing.every((count)=>count===0), saveWhileChoosing);
    await Promise.all([cdp, guestCdp].map((page) =>
      evaluate(page, "document.querySelector('#starter-choice-list button').click()")));
    const startedClients = await Promise.all([cdp, guestCdp].map((page) => waitFor(page, `(()=>({
      pregame:document.body.dataset.soulLinkPregame,
      saveKeys:Object.keys(localStorage).filter(key=>key.endsWith('/soulrun')),
      status:document.querySelector('#status').textContent,
    }))().pregame==='false'&&Object.keys(localStorage).some(key=>key.endsWith('/soulrun'))`,
    'starter selection creates the SoulLink save and enters gameplay', 30000).then(async()=>evaluate(page, `(()=>({
      pregame:document.body.dataset.soulLinkPregame,
      saveKeys:Object.keys(localStorage).filter(key=>key.endsWith('/soulrun')),
      lobbySaveHidden:document.querySelector('#lobby-save-controls').hidden,
      runStatus:window.pokeemerald.run.state()?.status,
      fatal:document.querySelector('#status').classList.contains('error'),
      starterSpecies:window.pokeemerald.instance.exports.WasmRunPartySpecies(0),
      map:[window.pokeemerald.instance.exports.WasmPresenceMapGroup(),window.pokeemerald.instance.exports.WasmPresenceMapNum()],
      balls:window.pokeemerald.instance.exports.WasmRunPokeballCount(),
      rareCandies:window.pokeemerald.instance.exports.WasmRunRareCandyCount(),
    }))()`))));
    check('choosing a starter creates each dedicated SoulLink save and exits pregame',
      startedClients.every((client,index)=>client.pregame==='false'
        &&client.saveKeys.length===1&&client.runStatus==='active'
        &&client.fatal===false
        &&client.lobbySaveHidden===false
        &&client.starterSpecies===Number(starterChoices[index][0])
        &&client.balls===5&&client.rareCandies===0
        &&JSON.stringify(client.map)===JSON.stringify([1,4])), startedClients);
    const startedScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(resolve(OUTPUT, 'soullink-started-from-base.png'), Buffer.from(startedScreenshot.data, 'base64'));
    await Promise.all([cdp, guestCdp].map((page) =>
      evaluate(page, `(()=>{
        const exports=window.pokeemerald.instance.exports;
        if(!exports.WasmRunDebugFaintPartySlot(0))throw new Error('party slot was empty');
        exports.WasmRunProcessSafePoint(0);
        return window.pokeemerald.run.state()?.status;
      })()`)));
    const wipeClients = await Promise.all([cdp, guestCdp].map((page) => waitFor(page, `(()=>{
      const dialog=document.querySelector('#group-wipe-dialog');
      const screen=document.querySelector('#group-wipe-screen');
      const panel=document.querySelector('#presence-panel');
      return window.pokeemerald.run.state()?.status==='wipe_pending'
        &&dialog.open&&!screen.hidden
        ? {status:window.pokeemerald.run.state().status,
            dialogOpen:dialog.open,panelHidden:panel.hidden,
            title:document.querySelector('#group-wipe-title').textContent,
            gameOver:document.querySelector('#status').textContent}
        : null;
    })()`, 'last-party faint activates the shared wipe barrier', 15000)));
    check('the final party faint reaches wipe-pending for both linked players',
      wipeClients.every((client)=>client.status==='wipe_pending'), wipeClients);
    check('the group-wipe controls are visible without opening Friends',
      wipeClients.every((client)=>client.dialogOpen&&client.panelHidden&&client.title==='Group wipe'), wipeClients);
    const wipeScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(resolve(OUTPUT, 'soullink-group-wipe.png'), Buffer.from(wipeScreenshot.data, 'base64'));
    await Promise.all([cdp, guestCdp].map((page) =>
      evaluate(page, 'window.pokeemerald.run.ready()')));
    await waitFor(cdp, `window.pokeemerald.run.state()?.members?.every(member=>member.ready===true)`,
      'both players ready for wipe reset', 15000);
    await evaluate(cdp, 'window.pokeemerald.run.restart()');
    const resetDialogs = await Promise.all([cdp, guestCdp].map((page) => waitFor(page, `(()=>{
      const result={open:document.querySelector('#starter-choice-dialog').open,
        wipeClosed:!document.querySelector('#group-wipe-dialog').open,
        status:window.pokeemerald.run.state()?.status};
      return result.open&&result.status==='active'?result:null;
    })()`, 'host reset returns both players to starter selection', 20000)));
    check('host reset starts a fresh run and returns both players to starter selection',
      resetDialogs.every((result)=>result && result.wipeClosed), resetDialogs);
    await evaluate(cdp, 'window.pokeemerald.presence.leave()');
    await evaluate(guestCdp, 'window.pokeemerald.presence.leave()');
    guestCdp.close();
    guestCdp = null;
    guestBrowser.child.kill();
    guestBrowser = null;

    const defaultGame = await navigateAndReady(cdp, `${server.url}/?automate=1&saveProfile=pack-e2e-default`);
    check('automation without ?game still boots the default Emerald pack',
      defaultGame.runtimeStopped === false
      && defaultGame.saveStorageKey.startsWith('pokeemerald.save.v2/emerald/'),
      defaultGame.saveStorageKey);

    const moveRelearnerDefault = await evaluate(cdp, `(()=>{
      document.querySelector('#settings').click();
      return document.querySelector('#settings-move-relearner').checked;
    })()`);
    check('move relearner is enabled by default', moveRelearnerDefault === true, moveRelearnerDefault);
    await evaluate(cdp, `(()=>{
      document.querySelector('#settings-move-relearner').checked=false;
      document.querySelector('#settings-move-relearner').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#settings-dialog button[value=cancel]').click();
      return true;
    })()`);
    await evaluate(cdp, 'window.pokeemerald.automation.startNewGame()');
    await evaluate(cdp, 'window.pokeemerald.runFrames(120)');
    await evaluate(cdp, 'window.pokeemerald.automation.quickStart(25, 0)');
    await evaluate(cdp, 'window.pokeemerald.automation.addRunPartyMon(1, 20, 0x22334455)');
    await waitFor(cdp,
      "window.pokeemerald.party.read().members.some(mon=>mon.species===1)",
      'party model observes the move-relearner test Pokémon');
    const bulbasaurMoveState = await evaluate(cdp, `(()=>{
      const e=window.pokeemerald.instance.exports;
      return {species:e.WasmRunPartySpecies(1),level:e.WasmRunPartyLevel(1),
        moveCount:e.WasmRunRelearnableMoveCount(1),
        moves:Array.from({length:4},(_,slot)=>e.WasmRunPartyMove(1,slot))};
    })()`);
    check('WASM exposes legal level-up moves for an Emerald Pokémon at its current level',
      bulbasaurMoveState.species===1&&bulbasaurMoveState.level===20&&bulbasaurMoveState.moveCount>0,
      bulbasaurMoveState);
    const bulbasaurRelearnNames = await evaluate(cdp, `(async()=>{
      const {moveName}=await import('/web/packs/shared/move-names-emerald.mjs');
      const e=window.pokeemerald.instance.exports;
      return Array.from({length:e.WasmRunRelearnableMoveCount(1)},(_,i)=>moveName(e.WasmRunRelearnableMoveAt(1,i)));
    })()`);
    check('level-up candidates do not include moves above the Pokémon current level',
      !bulbasaurRelearnNames.includes('SWEET SCENT'),bulbasaurRelearnNames);
    await evaluate(cdp, `(()=>{
      document.querySelector('#menu-toggle').click();
      document.querySelector('#game-menu-party').click();
      return true;
    })()`);
    await waitFor(cdp, "document.querySelector('#party-panel')?.open===true", 'move feature party panel opens');
    check('move relearner controls stay hidden when the setting is off',
      (await evaluate(cdp, "document.querySelectorAll('.party-slot-relearn').length"))===0);
    await evaluate(cdp, "document.querySelector('#party-panel button[value=cancel]').click()");
    await evaluate(cdp, `(()=>{
      document.querySelector('#settings').click();
      document.querySelector('#settings-move-relearner').checked=true;
      document.querySelector('#settings-move-relearner').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#settings-dialog button[value=cancel]').click();
      return true;
    })()`);
    await evaluate(cdp, `(()=>{
      document.querySelector('#menu-toggle').click();
      document.querySelector('#game-menu-party').click();
      return true;
    })()`);
    const relearnButtonPresent = await waitFor(cdp,
      "Boolean(document.querySelector('.party-slot[data-species=\"1\"] .party-slot-relearn'))",
      'enabled move relearner appears for the local Pokémon');
    check('enabling the setting adds a local-party relearning action', relearnButtonPresent === true);
    await evaluate(cdp, "document.querySelector('#party-panel button[value=cancel]').click()");
    await evaluate(cdp, `(()=>{
      document.querySelector('#settings').click();
      document.querySelector('#settings-move-relearner').checked=false;
      document.querySelector('#settings-move-relearner').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#settings-dialog button[value=cancel]').click();
      document.querySelector('#menu-toggle').click();
      document.querySelector('#game-menu-party').click();
      return true;
    })()`);
    await waitFor(cdp, "document.querySelector('#party-panel')?.open===true", 'disabled move relearner party panel opens');
    check('turning the move relearner off immediately removes its Party action',
      (await evaluate(cdp, "document.querySelectorAll('.party-slot-relearn').length"))===0);
    await evaluate(cdp, "document.querySelector('#party-panel button[value=cancel]').click()");
    await evaluate(cdp, `(()=>{
      document.querySelector('#settings').click();
      document.querySelector('#settings-move-relearner').checked=true;
      document.querySelector('#settings-move-relearner').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#settings-dialog button[value=cancel]').click();
      document.querySelector('#menu-toggle').click();
      document.querySelector('#game-menu-party').click();
      return true;
    })()`);
    await waitFor(cdp,
      "Boolean(document.querySelector('.party-slot[data-species=\"1\"] .party-slot-relearn'))",
      'reenabled move relearner action returns');

    // Seed a non-level-up move in the fixture mon, then ensure the app records
    // it when seen and offers it as a previously-known move after it is forgotten.
    const cutMoveId = 15;
    const seededPastMove = await evaluate(cdp,
      `window.pokeemerald.instance.exports.WasmRunSetPartyMove(1,3,${cutMoveId})`);
    check('WASM accepts a valid move replacement in a specific party slot', seededPastMove === 1, seededPastMove);
    await evaluate(cdp, "document.querySelector('.party-slot[data-species=\"1\"] .party-slot-relearn').click()");
    await waitFor(cdp, "document.querySelector('#move-relearner-dialog')?.open===true", 'move relearner dialog opens');
    const moveRelearnerScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(resolve(OUTPUT, 'move-relearner.png'), Buffer.from(moveRelearnerScreenshot.data, 'base64'));
    const moveRelearnerTextColors = await evaluate(cdp, `(()=>({
      description:getComputedStyle(document.querySelector('#move-relearner-dialog .presence-note')).color,
      pokemon:getComputedStyle(document.querySelector('#move-relearner-pokemon')).color,
      status:getComputedStyle(document.querySelector('#move-relearner-status')).color,
    }))()`);
    check('move relearner text uses the readable library palette',
      moveRelearnerTextColors.description==='rgb(93, 106, 128)'
        &&moveRelearnerTextColors.pokemon==='rgb(13, 107, 78)'
        &&moveRelearnerTextColors.status==='rgb(21, 37, 64)',moveRelearnerTextColors);
    const initialChoices = await evaluate(cdp, `Array.from(document.querySelectorAll('#move-relearner-choice option'),option=>({
      value:Number(option.value),label:option.textContent
    }))`);
    check('learned move appears in the eligible list but a currently-held move is excluded',
      initialChoices.some(choice=>choice.value>0)
        &&!initialChoices.some(choice=>choice.value===cutMoveId),initialChoices);
    const firstTeach = await evaluate(cdp, `(()=>{
      const choice=document.querySelector('#move-relearner-choice');
      const option=[...choice.options].find(option=>option.value);
      const move=Number(option?.value);
      choice.value=String(move);
      choice.dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#move-relearner-slot').value='0';
      document.querySelector('#move-relearner-slot').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#move-relearner-teach').click();
      return {move,before:${bulbasaurMoveState.moves[0]},after:window.pokeemerald.instance.exports.WasmRunPartyMove(1,0)};
    })()`);
    check('teaching replaces exactly the chosen move slot',
      firstTeach.move>0&&firstTeach.after===firstTeach.move&&firstTeach.after!==firstTeach.before,
      firstTeach);
    await waitFor(cdp, "document.querySelector('#move-relearner-dialog')?.open===false", 'move replacement commits');
    await evaluate(cdp, `window.pokeemerald.instance.exports.WasmRunSetPartyMove(1,3,10)`);
    await evaluate(cdp, "document.querySelector('.party-slot[data-species=\"1\"] .party-slot-relearn').click()");
    await waitFor(cdp, "document.querySelector('#move-relearner-dialog')?.open===true", 'previous move list reopens');
    const pastMoveChoice = await evaluate(cdp, `Array.from(document.querySelectorAll('#move-relearner-choice option'),option=>({
      value:Number(option.value),label:option.textContent
    })).find(option=>option.value===${cutMoveId})??null`);
    check('a previously held TM move remains relearnable after being forgotten',
      pastMoveChoice?.label.includes('previously known')===true,pastMoveChoice);
    await evaluate(cdp, `(()=>{
      document.querySelector('#move-relearner-choice').value='${cutMoveId}';
      document.querySelector('#move-relearner-slot').value='0';
      document.querySelector('#move-relearner-choice').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#move-relearner-slot').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#move-relearner-teach').click();
      return true;
    })()`);
    await waitFor(cdp,
      `window.pokeemerald.instance.exports.WasmRunPartyMove(1,0)===${cutMoveId}`,
      'previously known move is restored');
    check('WASM installs the previously held move into the selected slot',
      (await evaluate(cdp, `window.pokeemerald.instance.exports.WasmRunPartyMove(1,0)`))===cutMoveId);
    await evaluate(cdp, 'window.pokeemerald.automation.saveGame()');
    const historyReloadKey = await evaluate(cdp,
      "Object.keys(localStorage).find(key=>key.endsWith('/move-history.v1'))??null");
    check('forgotten-move history persists under the isolated save key', Boolean(historyReloadKey), historyReloadKey);
    const moveRelearnerUrl = await evaluate(cdp, 'location.href');
    await navigateAndReady(cdp, moveRelearnerUrl);
    const historyAfterReload = await evaluate(cdp, `(async()=>{
      const key=Object.keys(localStorage).find(candidate=>candidate.endsWith('/move-history.v1'));
      const {createMoveHistoryStore}=await import('/web/run/move-history.mjs');
      const store=createMoveHistoryStore({key,maxMoveId:354});
      return {key,remembered:Object.values(store.snapshot().pokemon).some(moves=>moves.includes(${cutMoveId}))};
    })()`);
    check('previously known move history is restored after a page reload',
      Boolean(historyAfterReload.key)&&historyAfterReload.remembered,historyAfterReload);
    const standardSoloLobby = await waitFor(cdp, `(async()=>{
      const {createLobbySaveStore}=await import('/web/run/lobby-store.mjs');
      const store=createLobbySaveStore({namespace:'emerald/pack-e2e-default'});
      const record=(await store.list()).find(item=>item.roomCode.startsWith('LOCAL-'));
      const result=record?{mode:record.mode,memberCount:record.members.length,runState:record.runState,
        slotOwner:record.slots['slot-1']?.ownerPlayerId,saveLength:record.slots['slot-1']?.saveBytes?.length??0}:null;
      await store.close();
      return result?.saveLength===131072?result:null;
    })()`, 'Standard solo lobby save survives page reload');
    check('Standard solo persists a one-member local lobby beside the ordinary main save',
      standardSoloLobby.mode==='standard'&&standardSoloLobby.memberCount===1
        &&standardSoloLobby.runState===null&&standardSoloLobby.slotOwner?.startsWith('local-')
        &&standardSoloLobby.saveLength===131072
        &&(await evaluate(cdp,"window.pokeemerald.run.settings.mode==='standard'&&window.pokeemerald.run.state()===null&&window.pokeemerald.automation.saveInfo().key.endsWith('/main')&&window.pokeemerald.presence.diagnostics().status==='disconnected'&&window.pokeemerald.presence.diagnostics().bytesSent===0"))===true,
      standardSoloLobby);

    const lobbyStoreCheck = await evaluate(cdp, `(async()=>{
      const {createLobbySaveStore,parseLobbyBundle}=await import('/web/run/lobby-store.mjs');
      const roomCode='TEST'+Date.now().toString(36);
      const validateSave=async ({gameId,formatId,formatVersion,saveBytes})=>
        gameId==='emerald'&&formatId==='emerald-flash-128k'&&formatVersion===1&&saveBytes.length===4;
      const store=createLobbySaveStore({validateSave});
      const localMainKeys=Object.keys(localStorage).filter((key)=>key.endsWith('/main')).sort();
      await store.create({roomCode,hostPlayerId:'host-player',members:[
        {playerId:'host-player',name:'Host'},{playerId:'guest-player',name:'Guest'},
      ],settings:{randomizeWild:true},runState:{runId:'run-a',seed:41,status:'active'},
      slotIds:['slot-1','slot-2']});
      const created=await store.load(roomCode);
      let outsiderRejected=false;
      try{await store.claimSlot({roomCode,slotId:'slot-1',playerId:'intruder',expectedRevision:created.revision});}
      catch(error){outsiderRejected=/not a lobby member/.test(error.message);}
      let stage='host-claim';
      try {
      const hostClaim=await store.claimSlot({roomCode,slotId:'slot-1',playerId:'host-player',expectedRevision:created.revision});
      stage='guest-claim';
      const guestClaim=await store.claimSlot({roomCode,slotId:'slot-2',playerId:'guest-player',expectedRevision:hostClaim.revision});
      stage='slot-save';
      const saved=await store.commitSlot({roomCode,slotId:'slot-1',playerId:'host-player',expectedRevision:hostClaim.slots['slot-1'].revision,
        gameId:'emerald',formatId:'emerald-flash-128k',formatVersion:1,saveBytes:new Uint8Array([1,2,3,4])});
      const guestSaved=await store.commitSlot({roomCode,slotId:'slot-2',playerId:'guest-player',expectedRevision:guestClaim.slots['slot-2'].revision,
        gameId:'emerald',formatId:'emerald-flash-128k',formatVersion:1,saveBytes:new Uint8Array([9,8,7,6])});
      let guestRejected=false;
      try{await store.commitSlot({roomCode,slotId:'slot-1',playerId:'guest-player',expectedRevision:saved.slots['slot-1'].revision,
        gameId:'emerald',formatId:'emerald-flash-128k',formatVersion:1,saveBytes:new Uint8Array([9,9,9,9])});}
      catch(error){guestRejected=/does not own/.test(error.message);}
      const flushedOwners=[];
      const takeover=await store.claimSlot({roomCode,slotId:'slot-1',playerId:'guest-player',expectedRevision:guestSaved.revision,
        flushPrevious:async ({slot,previousOwnerPlayerId})=>{
          flushedOwners.push(previousOwnerPlayerId);
          return {gameId:slot.gameId,formatId:slot.formatId,formatVersion:slot.formatVersion,
            saveBytes:previousOwnerPlayerId==='host-player'?new Uint8Array([5,6,7,8]):new Uint8Array([6,7,8,9])};
        }});
      let guestSharedRejected=false;
      try{await store.updateShared({roomCode,actorPlayerId:'guest-player',expectedRevision:takeover.revision,settings:{randomizeWild:false}});}
      catch(error){guestSharedRejected=/only the lobby host/.test(error.message);}
      const handedOff=await store.updateShared({roomCode,actorPlayerId:'host-player',expectedRevision:takeover.revision,hostPlayerId:'guest-player'});
      let oldHostRejected=false;
      try{await store.updateShared({roomCode,actorPlayerId:'host-player',expectedRevision:handedOff.revision,settings:{randomizeWild:false}});}
      catch(error){oldHostRejected=/only the lobby host/.test(error.message);}
      const afterHandoff=await store.updateShared({roomCode,actorPlayerId:'guest-player',expectedRevision:handedOff.revision,
        settings:{randomizeWild:false}});
      const replicaCode=roomCode+'R';
      const replica=await store.applyReplica({...handedOff,roomCode:replicaCode});
      const converged=await store.applyReplica({...afterHandoff,roomCode:replicaCode});
      let staleReplicaRejected=false;
      try{await store.applyReplica({...replica,roomCode:replicaCode,revision:replica.revision-1});}
      catch(error){staleReplicaRejected=/stale lobby authority revision/.test(error.message);}
      const bundle=await store.exportBundle(roomCode);
      const decoded=await parseLobbyBundle(bundle,{validateSave});
      const imported=await store.importBundle(bundle,{expectedRevision:afterHandoff.revision});
      let importConflictRejected=false;
      try{await store.importBundle(bundle,{expectedRevision:1});}
      catch(error){importConflictRejected=/explicit matching revision/.test(error.message);}
      let conflictRejected=false;
      try{await store.commitSlot({roomCode,slotId:'slot-1',playerId:'guest-player',expectedRevision:1,
        gameId:'emerald',formatId:'emerald-flash-128k',formatVersion:1,saveBytes:new Uint8Array([0,0,0,0])});}
      catch(error){conflictRejected=/revision conflict/.test(error.message);}
      const standardRoom=roomCode+'S';
      const standardCreated=await store.syncStandardRoom({roomCode:standardRoom,playerId:'host-player',hostPlayerId:'host-player',members:[
        {playerId:'host-player',name:'Host',slot:0},{playerId:'guest-player',name:'Guest',slot:1},
      ]});
      const standardHost=await store.commitSlot({roomCode:standardRoom,slotId:'slot-1',playerId:'host-player',expectedRevision:standardCreated.slots['slot-1'].revision,
        gameId:'emerald',formatId:'emerald-flash-128k',formatVersion:1,saveBytes:new Uint8Array([1,1,1,1])});
      const standardGuest=await store.commitSlot({roomCode:standardRoom,slotId:'slot-2',playerId:'guest-player',expectedRevision:standardHost.slots['slot-2'].revision,
        gameId:'emerald',formatId:'emerald-flash-128k',formatVersion:1,saveBytes:new Uint8Array([2,2,2,2])});
      const standardBackup=await parseLobbyBundle(await store.exportBundle(standardRoom),{validateSave});
      const mainKeysAfter=Object.keys(localStorage).filter((key)=>key.endsWith('/main')).sort();
      await store.close();
      return {
        roomCode,
        freshCreated:created.revision===1&&guestClaim.slots['slot-2'].ownerPlayerId==='guest-player',
        outsiderRejected,
        committed:saved.slots['slot-1'].saveBytes.join(',')==='1,2,3,4',
        guestRejected,
        takeoverOwner:takeover.slots['slot-1'].ownerPlayerId,
        takeoverImage:takeover.slots['slot-1'].saveBytes.join(',')==='5,6,7,8',
        swappedOwner:takeover.slots['slot-2'].ownerPlayerId,
        swappedImage:takeover.slots['slot-2'].saveBytes.join(',')==='6,7,8,9',
        flushedOwners:flushedOwners.sort(),
        guestSharedRejected,
        oldHostRejected,
        newHostCanUpdate:afterHandoff.hostPlayerId==='guest-player'&&afterHandoff.settings.randomizeWild===false,
        replicaConverged:converged.revision===afterHandoff.revision&&converged.settings.randomizeWild===false,
        staleReplicaRejected,
        backupRoundTrip:decoded.slots['slot-1'].saveBytes.join(',')==='5,6,7,8'
          &&decoded.runState.seed===41&&decoded.settings.randomizeWild===false,
        importRoundTrip:imported.revision===afterHandoff.revision,
        importConflictRejected,
        conflictRejected,
        standardPolicy:standardCreated.mode==='standard'&&standardCreated.runState===null
          &&Object.keys(standardCreated.settings).length===0,
        standardDistinctSlots:standardGuest.slots['slot-1'].saveBytes.join(',')==='1,1,1,1'
          &&standardGuest.slots['slot-2'].saveBytes.join(',')==='2,2,2,2'
          &&standardGuest.slots['slot-1'].ownerPlayerId!==standardGuest.slots['slot-2'].ownerPlayerId,
        standardBackup:standardBackup.mode==='standard'&&standardBackup.runState===null
          &&standardBackup.slots['slot-1'].saveBytes.join(',')==='1,1,1,1'
          &&standardBackup.slots['slot-2'].saveBytes.join(',')==='2,2,2,2',
        ordinaryMainSavesUnchanged:JSON.stringify(localMainKeys)===JSON.stringify(mainKeysAfter),
      };
      } catch(error) {
        const current=await store.load(roomCode);
        await store.close();
        return {stage,error:error.message,revision:current?.revision,slots:current?.slots};
      }
    })()`);
    check('IndexedDB lobby saves validate slots, commit before takeover, and export locally',
      lobbyStoreCheck.freshCreated&&lobbyStoreCheck.outsiderRejected
      &&lobbyStoreCheck.committed&&lobbyStoreCheck.guestRejected
      &&lobbyStoreCheck.takeoverOwner==='guest-player'&&lobbyStoreCheck.takeoverImage
      &&lobbyStoreCheck.swappedOwner==='host-player'&&lobbyStoreCheck.swappedImage
      &&JSON.stringify(lobbyStoreCheck.flushedOwners)===JSON.stringify(['guest-player','host-player'])
      &&lobbyStoreCheck.guestSharedRejected&&lobbyStoreCheck.oldHostRejected
      &&lobbyStoreCheck.newHostCanUpdate&&lobbyStoreCheck.replicaConverged&&lobbyStoreCheck.staleReplicaRejected
      &&lobbyStoreCheck.backupRoundTrip&&lobbyStoreCheck.importRoundTrip&&lobbyStoreCheck.importConflictRejected
      &&lobbyStoreCheck.conflictRejected
      &&lobbyStoreCheck.standardPolicy&&lobbyStoreCheck.standardDistinctSlots&&lobbyStoreCheck.standardBackup
      &&lobbyStoreCheck.ordinaryMainSavesUnchanged,lobbyStoreCheck);

    const standardHostUrl = new URL(`${server.url}/`);
    standardHostUrl.searchParams.set('automate', '1');
    standardHostUrl.searchParams.set('game', 'emerald');
    standardHostUrl.searchParams.set('mode', 'standard');
    standardHostUrl.searchParams.set('saveProfile', 'pack-e2e-standard-host');
    standardHostUrl.searchParams.set('presenceUrl', relay.url);
    await navigateAndReady(cdp, standardHostUrl.toString());
    await evaluate(cdp, 'window.pokeemerald.automation.startNewGame()');
    await evaluate(cdp, 'window.pokeemerald.runFrames(120)');
    await evaluate(cdp, 'window.pokeemerald.automation.quickStart(25, 0)');
    const standardRoomCreated = await evaluate(cdp, `(()=>{
      window.pokeemerald.presence.setName('Standard Host');
      return window.pokeemerald.presence.createRoom();
    })()`);
    check('Standard host creates a presence room without starting a shared run', standardRoomCreated === true);
    const standardRoomCode = await waitFor(cdp,
      "window.pokeemerald.presence.state().status==='joined'?window.pokeemerald.presence.state().room:null",
      'Standard host room');

    guestUserDataDir = await mkdtemp(resolve(tmpdir(), 'poketech-standard-guest-'));
    guestBrowser = await startBrowser(guestUserDataDir);
    guestCdp = await newPage(guestBrowser.browserWs);
    const standardGuestUrl = new URL(`${server.url}/`);
    standardGuestUrl.searchParams.set('automate', '1');
    standardGuestUrl.searchParams.set('game', 'emerald');
    standardGuestUrl.searchParams.set('mode', 'standard');
    standardGuestUrl.searchParams.set('saveProfile', 'pack-e2e-standard-guest');
    standardGuestUrl.searchParams.set('presenceUrl', relay.url);
    await navigateAndReady(guestCdp, standardGuestUrl.toString());
    await evaluate(guestCdp, 'window.pokeemerald.automation.startNewGame()');
    await evaluate(guestCdp, 'window.pokeemerald.runFrames(120)');
    await evaluate(guestCdp, 'window.pokeemerald.automation.quickStart(133, 1)');
    await evaluate(guestCdp, `(()=>{
      window.pokeemerald.presence.setName('Standard Guest');
      return window.pokeemerald.presence.joinRoom(${JSON.stringify(standardRoomCode)});
    })()`);
    await Promise.all([cdp, guestCdp].map((page) => waitFor(page, `(()=>{
      const presence=window.pokeemerald.presence.state();
      return presence.status==='joined'&&presence.room==='${standardRoomCode}'
        &&window.pokeemerald.run.connection==='attached'
        ? {mode:window.pokeemerald.run.settings.mode,state:window.pokeemerald.run.state(),
            saveKey:window.pokeemerald.automation.saveInfo().key,
            controlsHidden:document.querySelector('#lobby-save-controls').hidden}
        : null;
    })()`, 'Standard co-op participant attaches to the shared lobby')));
    check('both Standard co-op participants attach with no shared run or rules state',
      (await Promise.all([cdp, guestCdp].map((page) => evaluate(page, `({
        mode:window.pokeemerald.run.settings.mode,
        state:window.pokeemerald.run.state(),
        saveKey:window.pokeemerald.automation.saveInfo().key,
      })`)))).every((client) => client.mode === 'standard' && client.state === null && client.saveKey.endsWith('/main')));
    await Promise.all([cdp, guestCdp].map((page) => evaluate(page,
      "document.querySelector('#presence-toggle').click();true")));
    await Promise.all([cdp, guestCdp].map((page) => waitFor(page,
      "document.querySelector('#lobby-save-controls')?.hidden===false&&Boolean(document.querySelector('#member-save-slot'))",
      'Standard lobby save controls')));
    await Promise.all([cdp, guestCdp].map((page) => waitFor(page,
      "document.querySelector('#member-save-slot')?.disabled===false",
      'assigned Standard slot save button')));
    const standardNativeSave = await Promise.all([cdp, guestCdp].map((page) =>
      evaluate(page, 'window.pokeemerald.automation.saveGame()')));
    check('each Standard co-op player can write its own ordinary main save',
      standardNativeSave.every((result) => result === 1), standardNativeSave);
    await Promise.all([cdp, guestCdp].map((page) => evaluate(page,
      "document.querySelector('#member-save-slot').click();true")));
    let standardReplicas;
    try {
      standardReplicas = await Promise.all([cdp, guestCdp].map((page) => waitFor(page, `(()=>{
        const replica=window.pokeemerald.presence.lobbyReplica();
        return replica?.saved===2?replica:null;
      })()`, 'two distinct Standard slot saves replicate')));
    } catch (error) {
      const diagnostic = await Promise.all([cdp, guestCdp].map((page, index) => evaluate(page, `(async()=>{
        const {createLobbySaveStore}=await import('/web/run/lobby-store.mjs');
        const store=createLobbySaveStore({namespace:'emerald/pack-e2e-standard-${index === 0 ? 'host' : 'guest'}'});
        const record=await store.load('${standardRoomCode}');await store.close();
        const presence=window.pokeemerald.presence.state();
        const saveInfo=window.pokeemerald.automation.saveInfo();
        return {connection:window.pokeemerald.run.connection,room:presence.room,playerId:presence.playerId,
          members:presence.members.map(member=>({playerId:member.playerId,name:member.name,connection:member.connection})),
          lobbyReplica:window.pokeemerald.presence.lobbyReplica(),
          slots:Object.entries(record?.slots??{}).map(([id,slot])=>({id,owner:slot.ownerPlayerId,revision:slot.revision,saved:Boolean(slot.saveBytes)})),
          lobbyStatus:document.querySelector('#lobby-save-status')?.textContent,
          status:document.querySelector('#status')?.textContent,
          saveButton:{hidden:document.querySelector('#member-save-slot')?.hidden,disabled:document.querySelector('#member-save-slot')?.disabled},
          saveKey:saveInfo.key,hasRecord:saveInfo.hasRecord,lastError:saveInfo.lastError};
      })()`)));
      throw new Error(`${error.message}; Standard co-op diagnostic=${JSON.stringify(diagnostic)}`);
    }
    const standardSlotAudit = await Promise.all([cdp, guestCdp].map((page, index) => evaluate(page, `(async()=>{
      const {createLobbySaveStore}=await import('/web/run/lobby-store.mjs');
      const store=createLobbySaveStore({namespace:'emerald/pack-e2e-standard-${index === 0 ? 'host' : 'guest'}'});
      const record=await store.load('${standardRoomCode}');
      const slots=Object.entries(record.slots).filter(([,slot])=>slot.ownerPlayerId);
      const ownId=window.pokeemerald.presence.state().playerId;
      const own=slots.find(([,slot])=>slot.ownerPlayerId===ownId);
      const result={mode:record.mode,runState:record.runState,slotCount:slots.length,
        owners:slots.map(([,slot])=>slot.ownerPlayerId),ownId,ownSlot:own?.[0],
        bytes:own?.[1].saveBytes?.length??0,hash:own?.[1].saveBytes?Array.from(own[1].saveBytes.slice(0,32)).join(','):''};
      await store.close();
      return result;
    })()`)));
    check('Standard co-op stores separate player-owned save slots without SoulLink state',
      standardReplicas.every((replica) => replica.saved === 2)
        &&standardSlotAudit.every((audit) => audit.mode === 'standard' && audit.runState === null
          &&audit.slotCount === 2 && audit.bytes === 131072)
        &&standardSlotAudit[0].ownSlot !== standardSlotAudit[1].ownSlot,
      { standardReplicas, standardSlotAudit });
    await evaluate(cdp, `(()=>{
      const native=URL.createObjectURL.bind(URL);
      URL.createObjectURL=(blob)=>{window.__standardLobbyBackup=blob;return native(blob);};
      if(document.querySelector('#lobby-download').disabled)throw new Error('Standard lobby backup is disabled');
      document.querySelector('#lobby-download').click();
      return true;
    })()`);
    const standardBackup = await waitFor(cdp, `(async()=>{
      const blob=window.__standardLobbyBackup;
      if(!blob)return null;
      const text=await blob.text();
      const record=JSON.parse(text);
      return {mime:blob.type,format:record.format,mode:record.mode,runState:record.runState,
        slotCount:Object.values(record.slots).filter(slot=>slot.saveBytes).length,text};
    })()`, 'Standard lobby backup downloads both player slots');
    check('Standard lobby backup contains both individual saves and no run state',
      standardBackup.mime === 'application/json' && standardBackup.format === 'poketech-lobby-save'
        &&standardBackup.mode === 'standard' && standardBackup.runState === null && standardBackup.slotCount === 2,
      { ...standardBackup, text: undefined });
    await evaluate(cdp, `(async()=>{
      window.confirm=()=>true;
      const input=document.querySelector('#lobby-import');
      const file=new File([${JSON.stringify(standardBackup.text)}],'standard.ptlobby',{type:'application/json'});
      const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));return true;
    })()`);
    await waitFor(cdp, "document.querySelector('#status').textContent.includes('backup restored')",
      'Standard lobby backup imports through the shared lobby UI');
    await waitFor(guestCdp, "document.querySelector('#lobby-slot-claim-label')?.hidden===false",
      'Standard guest sees the saved host slot for takeover');
    await waitFor(guestCdp, "document.querySelector('#lobby-slot-claim-button')?.disabled===false",
      'Standard guest can request slot takeover');
    await evaluate(guestCdp, "document.querySelector('#lobby-slot-claim-button').click();true");
    try {
      await Promise.all([cdp, guestCdp].map((page, index) => waitFor(page, `(async()=>{
      const {createLobbySaveStore}=await import('/web/run/lobby-store.mjs');
      const store=createLobbySaveStore({namespace:'emerald/pack-e2e-standard-${index === 0 ? 'host' : 'guest'}'});
      const record=await store.load('${standardRoomCode}');await store.close();
      const owned=Object.entries(record?.slots??{}).filter(([,slot])=>slot.ownerPlayerId);
      const own=owned.find(([,slot])=>slot.ownerPlayerId===window.pokeemerald.presence.state().playerId);
      const targetSlot='${index === 0 ? 'slot-2' : 'slot-1'}';
      return record?.mode==='standard'&&record.runState===null&&owned.length===2
        &&own?.[0]===targetSlot&&owned.every(([,slot])=>slot.saveBytes)
        ?owned.map(([slotId,slot])=>[slotId,slot.ownerPlayerId]):null;
      })()`, 'Standard member slot takeover completes')));
    } catch (error) {
      const diagnostic=await Promise.all([cdp,guestCdp].map((page)=>evaluate(page, `(()=>({
        status:document.querySelector('#status')?.textContent,
        lobbyStatus:document.querySelector('#lobby-save-status')?.textContent,
        claimStatus:{disabled:document.querySelector('#lobby-slot-claim-button')?.disabled,
          hidden:document.querySelector('#lobby-slot-claim-label')?.hidden},
        replica:window.pokeemerald.presence.lobbyReplica(),
      }))()`)));
      throw new Error(`${error.message}; takeover diagnostic=${JSON.stringify(diagnostic)}`);
    }
    const standardAfterTakeover = await Promise.all([cdp, guestCdp].map((page, index) => evaluate(page, `(async()=>{
      const {createLobbySaveStore}=await import('/web/run/lobby-store.mjs');
      const store=createLobbySaveStore({namespace:'emerald/pack-e2e-standard-${index === 0 ? 'host' : 'guest'}'});
      const record=await store.load('${standardRoomCode}');await store.close();
      const ownId=window.pokeemerald.presence.state().playerId;
      const ownSlot=Object.entries(record.slots).find(([,slot])=>slot.ownerPlayerId===ownId)?.[0]??null;
      return {owners:Object.values(record.slots).map(slot=>slot.ownerPlayerId).filter(Boolean),ownId,ownSlot,
        names:record.members.map(member=>member.name),mode:record.mode,runState:record.runState};
    })()`)));
    check('Standard slot takeover preserves both save images and run-state isolation',
      standardAfterTakeover.every((record) => record.mode === 'standard' && record.runState === null
        &&record.names.length === 2 && record.owners.length === 2)
        &&standardAfterTakeover[0].ownSlot===standardSlotAudit[1].ownSlot
        &&standardAfterTakeover[1].ownSlot===standardSlotAudit[0].ownSlot,standardAfterTakeover);

    await Promise.all([cdp, guestCdp].map((page) => evaluate(page, 'window.pokeemerald.presence.leave()')));
    await Promise.all([cdp, guestCdp].map(async (page) => {
      await evaluate(page, "document.querySelector('#presence-toggle').click();true");
      await waitFor(page, "document.querySelector('#standard-saved-lobby-list li button')", 'saved Standard lobby resume action');
      await evaluate(page, "document.querySelector('#standard-saved-lobby-list li button').click();true");
    }));
    await evaluate(cdp, `(()=>{
      window.pokeemerald.presence.setName('Standard Host');
      return window.pokeemerald.presence.createRoom();
    })()`);
    const resumedRoomCode = await waitFor(cdp,
      "window.pokeemerald.presence.state().status==='joined'?window.pokeemerald.presence.state().room:null",
      'new Standard resume room');
    await evaluate(guestCdp, `(()=>{
      window.pokeemerald.presence.setName('Standard Guest');
      return window.pokeemerald.presence.joinRoom(${JSON.stringify(resumedRoomCode)});
    })()`);
    const standardResumed = await Promise.all([cdp, guestCdp].map((page) => waitFor(page, `(()=>{
      const presence=window.pokeemerald.presence.state();
      const replica=window.pokeemerald.presence.lobbyReplica();
      return presence.status==='joined'&&presence.room==='${resumedRoomCode}'
        &&replica?.saved===2&&window.pokeemerald.run.state()===null
        ? {room:presence.room,mode:window.pokeemerald.run.settings.mode,state:window.pokeemerald.run.state()}:null;
    })()`, 'Standard co-op resumes into the new room')));
    check('Standard co-op restores its per-player lobby into a fresh room with no run reducer',
      standardResumed.every((result) => result.room === resumedRoomCode && result.mode === 'standard' && result.state === null),
      standardResumed);
    await Promise.all([cdp, guestCdp].map((page) => evaluate(page, 'window.pokeemerald.presence.leave()')));
    guestCdp.close();
    guestCdp = null;
    guestBrowser.child.kill();
    guestBrowser = null;

    await navigateAndReady(cdp, `${server.url}/?automate=1&game=emerald&mode=nuzlocke&saveProfile=pack-e2e-legacy-mode`);
    const legacyMode = await evaluate(cdp, `({
      settingsMode:window.pokeemerald.run.settings.mode,
      state:window.pokeemerald.run.state(),
      saveSlot:window.pokeemerald.run.settings.saveSlot,
      saveKey:window.pokeemerald.automation.saveInfo().key,
    })`);
    check('legacy solo-Nuzlocke deep link falls back to Standard without activating rules',
      legacyMode.settingsMode==='standard'&&legacyMode.state===null
        &&legacyMode.saveSlot==='main'&&legacyMode.saveKey.endsWith('/main'),legacyMode);

    const emerald = await navigateAndReady(cdp, `${server.url}/?automate=1&game=emerald&saveProfile=pack-e2e`);
    check('Emerald boots under its game id', emerald.runtimeStopped === false, emerald.runtimeStopped);
    check('Emerald uses the Emerald save namespace',
      emerald.saveStorageKey.startsWith('pokeemerald.save.v2/emerald/'), emerald.saveStorageKey);

    const hud = await evaluate(cdp, `(() => ({
      speed: document.querySelector('#speed-select')?.value,
      menuButton: Boolean(document.querySelector('#menu-toggle')),
    }))()`);
    check('play mode exposes the always-visible HUD', hud.speed === '1' && hud.menuButton === true, hud);
    await evaluate(cdp, `(() => {
      const select = document.querySelector('#speed-select');
      select.value = '4';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const speed = await evaluate(cdp, `({ select: document.querySelector('#speed-select')?.value, label: document.querySelector('#speed-value')?.textContent })`);
    check('the HUD speed dropdown drives the game speed', speed.select === '4' && speed.label === '4.0x', speed);

    await evaluate(cdp, `document.querySelector('#menu-toggle').click()`);
    const menuOpen = await evaluate(cdp, `document.querySelector('#game-menu')?.open === true`);
    check('the hamburger opens the game menu', menuOpen === true, menuOpen);
    const menuPlacement = await evaluate(cdp, `(() => {
      const button = document.querySelector('#menu-toggle').getBoundingClientRect();
      const menu = document.querySelector('#game-menu').getBoundingClientRect();
      return {
        alignedRight: Math.abs(button.right - menu.right) < 2,
        belowWithGap: Math.abs(menu.top - button.bottom - 8) <= 1,
        inViewport: menu.left >= 0 && menu.right <= innerWidth && menu.top >= 0 && menu.bottom <= innerHeight,
        active: document.querySelector('#menu-toggle').getAttribute('aria-expanded') === 'true',
      };
    })()`);
    check('the menu aligns below its trigger and stays in the viewport',
      menuPlacement.alignedRight && menuPlacement.belowWithGap && menuPlacement.inViewport && menuPlacement.active,
      menuPlacement);
    const hudPalette = await evaluate(cdp, `(() => {
      const color = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      return {
        menuIvory: color('#game-menu > .game-menu-body', 'backgroundColor'),
        triggerEmerald: color('#menu-toggle > .pixel-frame-content', 'backgroundColor'),
        triggerIcon: color('#menu-toggle > .pixel-frame-content', 'color'),
        speedIvory: color('#speed-select', 'backgroundColor'),
        speedNavy: color('#speed-select', 'color'),
        corners: color('#game-menu', 'borderRadius'),
      };
    })()`);
    check('the HUD uses ivory, navy and emerald with square clipped frames',
      hudPalette.menuIvory === 'rgb(248, 245, 232)'
      && hudPalette.triggerEmerald === 'rgb(13, 107, 78)'
      && hudPalette.triggerIcon === 'rgb(248, 245, 232)'
      && hudPalette.speedIvory === 'rgb(248, 245, 232)'
      && hudPalette.speedNavy === 'rgb(21, 37, 64)'
      && hudPalette.corners === '0px', hudPalette);
    await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    const escapeDismissal = await evaluate(cdp, `({
      closed: document.querySelector('#game-menu')?.open === false,
      focusRestored: document.activeElement === document.querySelector('#menu-toggle'),
      collapsed: document.querySelector('#menu-toggle')?.getAttribute('aria-expanded') === 'false',
    })`);
    check('Escape closes the menu and restores focus to its trigger',
      escapeDismissal.closed && escapeDismissal.focusRestored && escapeDismissal.collapsed,
      escapeDismissal);
    await evaluate(cdp, `document.querySelector('#menu-toggle').click()`);
    await evaluate(cdp, `document.querySelector('#game-menu-resume').click()`);
    const menuClosed = await evaluate(cdp, `document.querySelector('#game-menu')?.open === false`);
    check('Resume closes the game menu', menuClosed === true, menuClosed);
    await evaluate(cdp, `document.querySelector('#menu-toggle').click(); document.querySelector('#game-menu-save').click()`);
    const saveOpen = await waitFor(cdp, `document.querySelector('#save-profile-dialog')?.open === true`, 'local save dialog');
    check('Save / Load opens the local save dialog', saveOpen === true, saveOpen);
    await evaluate(cdp, `document.querySelector('#save-profile-dialog').close()`);

    await evaluate(cdp, `document.querySelector('#menu-toggle').click(); document.querySelector('#game-menu-settings').click()`);
    const settingsOpen = await waitFor(cdp, `document.querySelector('#settings-dialog')?.open === true`, 'settings dialog');
    check('Settings opens from the game menu', settingsOpen === true, settingsOpen);
    await evaluate(cdp, `document.querySelector('#settings-dialog').close()`);

    await evaluate(cdp, `document.querySelector('#menu-toggle').click(); document.querySelector('#game-menu-friends').click()`);
    const friendsOpen = await waitFor(cdp, `document.querySelector('#presence-panel')?.hidden === false`, 'friends panel');
    check('Play with friends opens the presence panel', friendsOpen === true, friendsOpen);
    await evaluate(cdp, `document.querySelector('#presence-close').click()`);

    const kaizo = await navigateAndReady(cdp, `${server.url}/?automate=1&game=emerald-kaizo&saveProfile=pack-e2e`);
    check('emerald-kaizo boots under its game id', kaizo.runtimeStopped === false, kaizo.runtimeStopped);
    check('Kaizo uses its own save namespace and content version',
      kaizo.saveStorageKey.startsWith('pokeemerald.save.v2/emerald-kaizo/')
      && kaizo.contentVersion === 'emerald-kaizo-presence-v1',
      { key: kaizo.saveStorageKey, contentVersion: kaizo.contentVersion });

    const test = await navigateAndReady(cdp, `${server.url}/?automate=1&game=test-emerald&saveProfile=pack-e2e`);
    check('test-emerald boots under its game id', test.runtimeStopped === false, test.runtimeStopped);
    check('same profile label uses a different save namespace',
      test.saveStorageKey !== emerald.saveStorageKey
      && test.saveStorageKey.startsWith('pokeemerald.save.v2/test-emerald/'), test.saveStorageKey);

    const classic = await navigateAndReady(cdp, `${server.url}/?automate=1&game=test-classic&saveProfile=pack-e2e-classic`);
    check('test-classic boots with a classic-only pack', classic.runtimeStopped === false
      && classic.saveStorageKey.startsWith('pokeemerald.save.v2/test-classic/'), classic.saveStorageKey);
    const gating = await evaluate(cdp, `(() => ({
      mode: document.querySelector('#visual-mode')?.value,
      options: [...document.querySelectorAll('#visual-mode option')].map((option) => option.value),
      presenceHidden: document.querySelector('#presence-toggle')?.hidden === true,
    }))()`);
    check('classic-only pack hides 3D and presence-none hides friends',
      gating.mode === 'classic'
      && gating.options.length === 1
      && gating.options[0] === 'classic'
      && gating.presenceHidden === true,
      gating);

    await cdp.send('Page.navigate', { url: `${server.url}/?automate=1&game=toy-console&saveProfile=pack-e2e-classic` });
    await waitFor(cdp, 'Boolean(window.pokeemerald?.automation?.ready)', 'toy-console automation API');
    await evaluate(cdp, '(async()=>{await window.pokeemerald.automation.ready;return true;})()');
    const toyBoot = await evaluate(cdp, `(()=>{
      const a=window.pokeemerald.automation;
      a.runToFrame(2);
      const saved=a.saveGame();
      const after=a.saveInfo();
      return {status:document.querySelector('#status')?.textContent,
        game:document.querySelector('#game-current')?.textContent,
        key:after.key,valid:Boolean(after.hasRecord&&after.bytes&&atob(after.bytes).length===16),saved,
        memoryBytes:window.pokeemerald.memory?.buffer.byteLength,
        frame:a.frame(),presenceHidden:document.querySelector('#presence-toggle')?.hidden===true};
    })()`);
    check('toy-console fake engine cold-boots and steps without Emerald exports',
      toyBoot.status?.startsWith('running')&&toyBoot.game==='Toy Console (architecture fixture)'
        &&toyBoot.frame===2&&toyBoot.memoryBytes===65536&&toyBoot.presenceHidden,
      toyBoot);
    check('toy-console fake save codec and namespace work in the browser',
      toyBoot.saved===1&&toyBoot.valid
        &&toyBoot.key==='pokeemerald.save.v2/toy-console/toy-console-save/1/pack-e2e-classic/main',
      toyBoot);

    await cdp.send('Page.navigate', { url: `${server.url}/?game=does-not-exist` });
    const errorText = await waitFor(cdp,
      "document.querySelector('#library') && !document.querySelector('#library').hidden && document.querySelector('#library-error')?.textContent?.includes('does-not-exist') ? document.querySelector('#library-error').textContent : null",
      'unknown-game library error');
    check('unknown game reports a named library error', errorText.includes('does-not-exist'), errorText);
    const libraryVisible = await evaluate(cdp, "document.querySelector('#library')?.hidden === false && document.querySelector('#play-shell')?.hidden === true");
    check('unknown game returns to the library', libraryVisible === true, libraryVisible);

    await navigateAndReady(cdp, `${server.url}/?automate=1&game=emerald&saveProfile=pack-e2e`);
    await evaluate(cdp, `document.querySelector('#menu-toggle').click(); document.querySelector('#game-menu-change').click()`);
    const changed = await waitFor(cdp, `(() => {
      const library = document.querySelector('#library');
      if (!library || library.hidden || location.pathname !== '/' || document.body.dataset.mode !== 'library') return null;
      return { mode: document.body.dataset.mode, playHidden: document.querySelector('#play-shell')?.hidden };
    })()`, 'Change game returns to library');
    check('Change game returns to the library', changed.mode === 'library'
      && changed.playHidden === true, changed);

    summary.ok = true;
    summary.completedAt = new Date().toISOString();
    log(`PASS — ${summary.checks.length} checks`);
  } catch (error) {
    summary.ok = false;
    summary.error = error.message;
    log(`FAIL — ${error.message}`);
    process.exitCode = 1;
  } finally {
    await writeFile(resolve(OUTPUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    if (cdp) cdp.close();
    if (guestCdp) guestCdp.close();
    if (browser) browser.child.kill();
    if (guestBrowser) guestBrowser.child.kill();
    if (server) server.child.kill();
    if (relay) await relay.close();
    await delay(750);
    if (userDataDir) {
      try {
        await rm(userDataDir, { recursive: true, force: true });
      } catch {
        // Chrome can hold its profile lock briefly after SIGTERM; the temp
        // directory is safe to leave for the OS to clean up.
      }
    }
    if (guestUserDataDir) {
      try {
        await rm(guestUserDataDir, { recursive: true, force: true });
      } catch {
        // Chrome can hold its profile lock briefly after SIGTERM; leave cleanup to the OS.
      }
    }
  }
}

await main();
