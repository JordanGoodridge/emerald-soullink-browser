#!/usr/bin/env node
// End-to-end presence verification: boots the real browser build in four
// independent headless Chrome pages, joins them to one room and checks that
// each client sees the other three actors, movement, map transitions,
// unsupported avatar states, leave/rejoin and presenter recreation.
//
// Usage:
//   node tools/presence_e2e.mjs [--no-build] [--keep-browser] [--headed]
//
// The runner starts its own room relay and static web server on ephemeral
// ports, so it does not disturb a locally running `serve-local.ps1`.
// Screenshots and a machine-readable summary are written to
// `presence-e2e-output/`.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { startServer as startRoomService } from '../../server/src/server.mjs';
import { saveRecordKey } from '../web/save-store.mjs';

let GAME_ID = 'emerald';
let SOULLINK_MODE = false;
const saveFormatFor = (id) => id === 'emerald-kaizo' ? 'emerald-kaizo-flash-128k' : 'emerald-flash-128k';
const expectedSaveKey = (profile) => saveRecordKey({
  gameId: GAME_ID,
  formatId: saveFormatFor(GAME_ID),
  formatVersion: 1,
  profile,
  slot: SOULLINK_MODE ? 'soulrun' : 'main',
});

let OUTPUT_DIR = resolve('presence-e2e-output');
const ROUTE103 = { group: 0, num: 18, layout: 'layout_13' };
const OLDALE = { group: 0, num: 10, layout: 'layout_b' };
const INTERIORS = [
  { name: 'house', group: 1, num: 0 },
  { name: 'center', group: 2, num: 2 },
  { name: 'mart', group: 2, num: 4 },
  { name: 'rustboro-gym', group: 11, num: 3 },
  { name: 'mauville-gym', group: 10, num: 0 },
  { name: 'aqua-hideout', group: 24, num: 24 },
  { name: 'department-store', group: 13, num: 16 },
];
const VIEW_WIDTH = 240;
const VIEW_HEIGHT = 160;
const RENDER_SCALE = 4;
const SELF_SCREEN = { x: 120, y: 88 };

const PLAYERS = [
  { key: 'A', name: 'Ash', tile: { x: 10, y: 8 }, profile: 'presence-e2e-a' },
  { key: 'B', name: 'Misty', tile: { x: 12, y: 8 }, profile: 'presence-e2e-b' },
  { key: 'C', name: 'Brock', tile: { x: 10, y: 10 }, profile: 'presence-e2e-c' },
  { key: 'D', name: 'Gary', tile: { x: 12, y: 10 }, profile: 'presence-e2e-d' },
];

function usage() {
  console.error('usage: node tools/presence_e2e.mjs [--no-build] [--keep-browser] [--headed] [--game=emerald|emerald-kaizo] [--soullink] [--soullink-only] [--trailer-captures] [--trailer-motion] [--output-dir=path]');
  process.exit(2);
}

function parseArgs(argv) {
  const options = { build: true, keepBrowser: false, headed: false, game: 'emerald', soullink: false, soullinkOnly: false, trailerCaptures: false, trailerMotion: false, outputDir: 'presence-e2e-output' };
  for (const arg of argv) {
    if (arg === '--no-build') options.build = false;
    else if (arg === '--keep-browser') options.keepBrowser = true;
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--soullink') options.soullink = true;
    else if (arg === '--soullink-only') { options.soullink = true; options.soullinkOnly = true; }
    else if (arg === '--trailer-captures') options.trailerCaptures = true;
    else if (arg === '--trailer-motion') options.trailerMotion = true;
    else if (arg.startsWith('--game=')) options.game = arg.slice('--game='.length);
    else if (arg.startsWith('--output-dir=')) options.outputDir = arg.slice('--output-dir='.length);
    else usage();
  }
  return options;
}

function log(message) {
  const line = `[presence-e2e] ${message}`;
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

function assert(condition, message, detail = null) {
  if (condition) return;
  const suffix = detail === null ? '' : ` (${JSON.stringify(detail)})`;
  throw new Error(`${message}${suffix}`);
}

function browserPath() {
  const candidates = [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Chrome/Chromium not found; set CHROME_BIN to a browser executable');
  return found;
}

function run(command, args, { cwd = resolve('.'), env = process.env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function buildWasm() {
  if (process.platform === 'win32') {
    await run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', resolve('..', 'build-wasm.ps1')]);
  } else {
    await run('make', ['wasm']);
  }
}

async function startWebServer() {
  const child = spawn(process.execPath, ['web/server.mjs'], {
    cwd: resolve('.'),
    env: { ...process.env, PORT: '0' },
  });
  return await withTimeout(new Promise((resolveStart, reject) => {
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      const match = text.match(/http:\/\/localhost:(\d+)/);
      if (match) resolveStart({ child, url: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[web] ${chunk}`));
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`web server exited before ready with ${code}`)));
  }), 15000, 'starting wasm web server');
}

async function startBrowser(userDataDir, headed) {
  const args = [
    headed ? '--headless=old' : '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-unsafe-webgpu',
    '--window-size=960,720',
    'about:blank',
  ].filter((arg) => arg !== '--headless=old');
  const child = spawn(browserPath(), args);
  return await withTimeout(new Promise((resolveStart, reject) => {
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolveStart({ child, browserWs: match[1] });
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`browser exited before ready with ${code}`)));
  }), 20000, 'starting headless Chrome');
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
    const handler = this.handlers.get(message.method);
    if (handler) handler(message.params);
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return await withTimeout(new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
    }), 30000, method);
  }

  close() {
    this.socket.close();
  }
}

async function newPage(browserWs) {
  const endpoint = new URL(browserWs);
  const response = await fetch(`http://${endpoint.host}/json/new`, { method: 'PUT' });
  const target = await response.json();
  return new Cdp(target.webSocketDebuggerUrl);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const exception = details.exception?.description || details.exception?.value;
    const location = `${details.url || '<anonymous>'}:${details.lineNumber ?? 0}:${details.columnNumber ?? 0}`;
    throw new Error([details.text, exception, location].filter(Boolean).join('\n'));
  }
  return result.result.value;
}

async function waitFor(cdp, expression, label, timeoutMs = 20000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await evaluate(cdp, expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function chooseStarter(client, choiceIndex) {
  await waitFor(client.cdp,
    "document.querySelector('#starter-choice-dialog')?.open===true",
    `${client.player.key} starter choice dialog`, 30000);
  return await evaluate(client.cdp, `(()=>{
    const button=document.querySelector('#starter-choice-list button[data-choice-index="${choiceIndex}"]');
    if(!button) throw new Error('starter choice is missing');
    const species=Number(button.dataset.species);
    button.click();
    return species;
  })()`);
}

async function navigateAndReady(cdp, url) {
  cdp.on('Runtime.consoleAPICalled', (params) => {
    const text = params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' ');
    if (text) process.stdout.write(`[page ${params.type}] ${text}\n`);
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    const text = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text;
    if (text) process.stderr.write(`[page exception] ${text}\n`);
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp, 'Boolean(window.pokeemerald?.automation)', 'page automation API', 30000);
  await evaluate(cdp, '(async()=>{await window.pokeemerald.automation.ready; return true;})()');
}

async function navigateAndWaitForStatus(cdp, url, text, timeoutMs = 15000) {
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp,
    `(()=>{const el=document.querySelector('#status');return Boolean(el && el.textContent.includes(${JSON.stringify(text)}));})()`,
    `page status containing ${text}`, timeoutMs);
  return await evaluate(cdp, `(()=>({
    text: document.querySelector('#status')?.textContent ?? '',
    hasGame: Boolean(window.pokeemerald),
    hasAutomation: Boolean(window.pokeemerald?.automation),
  }))()`);
}

async function startPlayer(cdp, player) {
  await evaluate(cdp, `(async()=>{
    const au = window.pokeemerald.automation;
    au.startNewGame();
    au.runToFrame(au.state().frame + 120);
    au.warp(${ROUTE103.group}, ${ROUTE103.num}, ${player.tile.x}, ${player.tile.y});
    au.runToFrame(au.state().frame + 180);
    const p = window.pokeemerald.presence;
    // One headless Chrome window has one foreground tab. Force every automation
    // client visible so background peers do not publish away; the away path is
    // exercised explicitly later with setAway().
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    } catch { /* ignore */ }
    p.setAway(false);
    window.clearInterval(window.__presenceKeepAlive);
    window.__presenceKeepAlive = setInterval(() => {
      try { p.tick(); } catch (error) { window.__presenceKeepAliveError = String(error); }
    }, 250);
    return true;
  })()`);
  const state = await waitFor(cdp, `(()=>{
    const au = window.pokeemerald.automation;
    const p = window.pokeemerald.presence;
    const s = au.state();
    return s.x === ${player.tile.x} && s.y === ${player.tile.y}
      && s.mapGroup === ${ROUTE103.group} && s.mapNum === ${ROUTE103.num}
      && p.state().activity === 'overworld'
      && p.state().world?.layoutId === '${ROUTE103.layout}';
  })()`, `player ${player.key} starting on Route 103`, 20000);
  assert(state, `player ${player.key} did not reach Route 103`);
}

async function snapshot(cdp) {
  return await evaluate(cdp, `(()=>{
    const au = window.pokeemerald.automation;
    const p = window.pokeemerald.presence;
    const options = p.frameOptions();
    return {
      state: au.state(),
      presence: p.state(),
      self: p.diagnostics().self,
      selfScreen: p.diagnostics().selfScreen,
      remote: p.diagnostics().remoteActors,
      mapped: options.remoteActors,
      draw: au.state().remoteDrawActors,
      vertices: au.state().remoteDrawVertices,
    };
  })()`);
}

function peerStateExpression(playerId, predicate) {
  const id = JSON.stringify(playerId);
  return `(()=>{
    const p=window.pokeemerald.presence;
    const s=p.state();
    const m=s.members.find((member)=>member.playerId===${id});
    const actor=p.frameOptions().remoteActors.find((entry)=>entry.playerId===${id});
    const game=window.pokeemerald.automation.state();
    return m&&(${predicate})?{visible:m.visible,world:m.latest?.state?.world,pose:m.latest?.state?.pose,actor,draw:game.remoteDrawActors}:null;
  })()`;
}

async function waitForPeer(cdp, playerId, predicate, label, timeoutMs = 10000) {
  return await waitFor(cdp, peerStateExpression(playerId, predicate), label, timeoutMs);
}

async function waitForRemoteDrawCount(cdp, count, label, timeoutMs = 10000) {
  return await waitFor(cdp,
    `(()=>window.pokeemerald.automation.state().remoteDrawActors===${count}?true:null)()`,
    label, timeoutMs);
}

async function capture(cdp, name) {
  const dataUrl = await evaluate(cdp, 'window.pokeemerald.automation.screenshot()');
  const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const file = resolve(OUTPUT_DIR, 'screenshots', `${name}.png`);
  await writeFile(file, png);
  return file;
}

async function capturePage(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const file = resolve(OUTPUT_DIR, 'screenshots', `${name}.png`);
  await writeFile(file, Buffer.from(result.data, 'base64'));
  return file;
}

async function setViewport(cdp, width, height, mobile = false) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
}

async function clearViewport(cdp) {
  await cdp.send('Emulation.clearDeviceMetricsOverride');
}

function actorFor(snap, playerId) {
  return snap.mapped.find((actor) => actor.playerId === playerId);
}

function memberFor(snap, playerId) {
  const member = snap.presence.members.find((candidate) => candidate.playerId === playerId);
  if (!member) return undefined;
  return {
    playerId: member.playerId,
    name: member.name,
    connection: member.connection,
    generation: member.generation,
    visible: member.visible,
    ...(member.latest?.state ?? {}),
  };
}

function observedAt(snap, actorId) {
  const actor = snap.remote.find((candidate) => candidate.playerId === actorId);
  return actor?.pose ?? null;
}

async function leaveAndRejoin(client, room) {
  await evaluate(client.cdp, '(async()=>{const p=window.pokeemerald.presence;p.leave();return true;})()');
  await waitFor(client.cdp, 'window.pokeemerald.presence.state().members.length === 0', `${client.player.key} leave`, 10000);
  await evaluate(client.cdp, `(async()=>{
    const p = window.pokeemerald.presence;
    p.joinRoom('${room}');
    return true;
  })()`);
  await waitFor(client.cdp,
    `(()=>{const p=window.pokeemerald.presence;const s=p.state();return s.status==='joined'&&s.members.length===4&&p.frameOptions().remoteActors.length===3;})()`,
    `${client.player.key} rejoin`, 20000);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  GAME_ID = options.game;
  SOULLINK_MODE = options.soullink;
  OUTPUT_DIR = resolve(options.outputDir);
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(resolve(OUTPUT_DIR, 'screenshots'), { recursive: true });
  const summary = {
    startedAt: new Date().toISOString(),
    options,
    steps: [],
    screenshots: [],
    checks: [],
    ok: false,
  };
  const consoleLog = [];
  const originalLog = console.log;
  const originalError = console.error;
  const captureLog = (line) => consoleLog.push(line);
  console.log = (...args) => { const line = args.join(' '); captureLog(line); originalLog(...args); };
  console.error = (...args) => { const line = args.join(' '); captureLog(line); originalError(...args); };

  let browser = null;
  let web = null;
  let room = null;
  let userDataDir = null;
  const clients = [];
  const extraClients = [];

  const step = (name, detail = {}) => {
    summary.steps.push({ name, at: new Date().toISOString(), ...detail });
    log(name);
  };
  const check = (name, condition, detail = null) => {
    summary.checks.push({ name, ok: Boolean(condition), detail });
    if (!condition) throw new Error(`${name}${detail === null ? '' : `: ${JSON.stringify(detail)}`}`);
  };

  try {
    if (options.build) {
      step('build wasm');
      await buildWasm();
    }

    step('start room service and web server');
    room = await startRoomService({
      port: 0,
      host: '127.0.0.1',
      log: { log: (line) => log(`room: ${line}`), error: (line, error) => log(`room error: ${line} ${error || ''}`) },
    });
    web = await startWebServer();
    userDataDir = await mkdtemp(resolve(tmpdir(), 'pokeemerald-presence-e2e-'));
    browser = await startBrowser(userDataDir, options.headed);
    summary.roomUrl = room.url;
    summary.webUrl = web.url;
    log(`room ${room.url} web ${web.url}`);

    step('open four clients');
    for (const player of PLAYERS) {
      const cdp = await newPage(browser.browserWs);
      const params = new URLSearchParams({
        automate: '1',
        presence: '1',
        presenceUrl: room.url,
        presenceName: player.name,
        saveProfile: player.profile,
        renderScale: String(RENDER_SCALE),
        view: 'hd2d',
        game: GAME_ID,
      });
      if (options.soullink) {
        params.set('mode', 'soullink');
        params.set('pregame', '1');
      }
      clients.push({ player, cdp, url: `${web.url}/?${params}` });
      await navigateAndReady(cdp, `${web.url}/?${params}`);
      await startPlayer(cdp, player);
      log(`client ${player.key} ready at Route 103 (${player.tile.x},${player.tile.y})`);
    }

    step('verify per-profile save isolation');
    const saveKeys = [];
    for (const client of clients) {
      const key = await evaluate(client.cdp, 'window.pokeemerald.automation.state().saveStorageKey');
      saveKeys.push(key);
      check(`save profile ${client.player.key} uses its own localStorage key`,
        typeof key === 'string' && key.includes(client.player.profile) && !saveKeys.slice(0, -1).includes(key),
        { profile: client.player.profile, actual: key });
    }
    check('four distinct save profiles coexist on one origin', new Set(saveKeys).size === 4, saveKeys);

    step('create room and join four clients');
    await evaluate(clients[0].cdp, '(async()=>{window.pokeemerald.presence.createRoom();return true;})()');
    const roomCode = await waitFor(clients[0].cdp,
      `(()=>{const s=window.pokeemerald.presence.state();return s.status==='joined'&&s.room||null;})()`,
      'room creation', 10000);
    summary.room = roomCode;
    for (const client of clients.slice(1)) {
      await evaluate(client.cdp, `(async()=>{window.pokeemerald.presence.joinRoom('${roomCode}');return true;})()`);
    }
    for (const client of clients) {
      await waitFor(client.cdp,
        `(()=>{const p=window.pokeemerald.presence;const s=p.state();return s.status==='joined'&&s.room==='${roomCode}'&&s.members.length===4&&p.frameOptions().remoteActors.length===3;})()`,
        `${client.player.key} joined four-player room`, 25000);
      client.playerId = await evaluate(client.cdp, 'window.pokeemerald.presence.state().playerId');
      await evaluate(client.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
    }
    await Promise.all(clients.map((client) => waitForRemoteDrawCount(
      client.cdp, 3, `${client.player.key} draws all initial remote actors`)));

    if (options.soullinkOnly) {
      if (options.trailerMotion) {
        step('capture four players moving outdoors in the same room');
        const directions = [
          ['right', 'left'], ['left', 'right'], ['down', 'up'], ['up', 'down'],
        ];
        const positions = clients.map(() => new Set());
        for (let frame = 0; frame < 36; frame++) {
          for (const [index, client] of clients.entries()) {
            const direction = directions[index][Math.floor(frame / 6) % 2];
            const position = await evaluate(client.cdp, `(()=>{
              const au=window.pokeemerald.automation;
              for (const button of ['up','down','left','right']) au.setButton(button,button==='${direction}');
              au.runToFrame(au.state().frame+4);
              return [window.pokeemerald.instance.exports.WasmPresenceXPx(),window.pokeemerald.instance.exports.WasmPresenceYPx()];
            })()`);
            positions[index].add(position.join(','));
          }
          await delay(65);
          summary.screenshots.push(await capture(clients[0].cdp,
            `trailer-outdoor-${String(frame).padStart(3, '0')}`));
        }
        for (const client of clients) {
          await evaluate(client.cdp, `(()=>{
            const au=window.pokeemerald.automation;
            for (const button of ['up','down','left','right']) au.setButton(button,false);
            au.runToFrame(au.state().frame+24);
          })()`);
        }
        check('outdoor footage shows four moving clients on the same map',
          positions.every((sample) => sample.size > 1),
          positions.map((sample) => sample.size));
      }
      step('start an Emerald SoulLink run and verify randomized linked starters');
      for (const client of clients) {
        await waitFor(client.cdp, "window.pokeemerald.run?.connection==='attached'", `${client.player.key} run channel attached`, 10000);
        await evaluate(client.cdp, 'window.pokeemerald.automation.quickStart(1, 0)');
        const seededMain = await evaluate(client.cdp, 'window.pokeemerald.automation.seedMainSaveFromSoulrun()');
        check(`${client.player.key} has an independent baseline main-save record`, seededMain.seeded, seededMain);
        await waitFor(client.cdp,
          "document.querySelector('#presence-run-settings')?.hidden===false",
          `${client.player.key} sees SoulLink run setup`, 10000);
      }
      const mainSaveBaselines = await Promise.all(clients.map((client) => evaluate(client.cdp,
        'window.pokeemerald.automation.mainSaveInfo()')));
      const hostSetup = await evaluate(clients[0].cdp, `(()=>({
        startHidden:document.querySelector('#run-start').hidden,
        startDisabled:document.querySelector('#run-start').disabled,
        allowLinkedPcBoxingChecked:document.querySelector('#run-allow-linked-pc').checked,
        settingsTextColors:{
          legend:getComputedStyle(document.querySelector('#presence-run-settings legend')).color,
          option:getComputedStyle(document.querySelector('#run-randomize-wild').parentElement).color,
          note:getComputedStyle(document.querySelector('#presence-run-settings-note')).color,
        },
        settingsDisabled:Object.values({
          wild:document.querySelector('#run-randomize-wild'),
          trainers:document.querySelector('#run-randomize-trainers'),
          gyms:document.querySelector('#run-randomize-gyms'),
          starters:document.querySelector('#run-randomize-starters'),
          pc:document.querySelector('#run-allow-linked-pc'),
        }).some((input)=>input.disabled),
      }))()`);
      const guestSetup = await evaluate(clients[1].cdp, `(()=>({
        startHidden:document.querySelector('#run-start').hidden,
        startDisabled:document.querySelector('#run-start').disabled,
        settingsDisabled:Object.values({
          wild:document.querySelector('#run-randomize-wild'),
          trainers:document.querySelector('#run-randomize-trainers'),
          gyms:document.querySelector('#run-randomize-gyms'),
          starters:document.querySelector('#run-randomize-starters'),
          pc:document.querySelector('#run-allow-linked-pc'),
        }).every((input)=>input.disabled),
      }))()`);
      check('only the room host can select SoulLink settings and start the run',
        !hostSetup.startHidden&&!hostSetup.startDisabled&&!hostSetup.settingsDisabled
        &&!guestSetup.startHidden&&guestSetup.startDisabled&&guestSetup.settingsDisabled,{hostSetup,guestSetup});
      check('SoulLink starts with independent linked Pokémon boxing enabled',
        hostSetup.allowLinkedPcBoxingChecked===true,
        hostSetup.allowLinkedPcBoxingChecked);
      check('SoulLink run settings use readable library theme colors',
        hostSetup.settingsTextColors.legend==='rgb(13, 107, 78)'
          &&hostSetup.settingsTextColors.option==='rgb(21, 37, 64)',
        hostSetup.settingsTextColors);
      if (options.trailerCaptures) {
        summary.screenshots.push(await capturePage(clients[0].cdp, 'trailer-soullink-lobby'));
        await evaluate(clients[0].cdp, `(()=>{
          for(const id of ['run-randomize-wild','run-randomize-trainers','run-randomize-gyms','run-randomize-starters'])
            document.querySelector('#'+id).checked=true;
          document.querySelector('#run-allow-linked-pc').checked=false;
          return true;
        })()`);
        summary.screenshots.push(await capturePage(clients[0].cdp, 'trailer-randomizer-settings'));
      }
      await evaluate(clients[0].cdp, `(()=>{
        for (const id of ['run-randomize-wild','run-randomize-trainers','run-randomize-gyms','run-randomize-starters'])
          document.querySelector('#'+id).checked=true;
        document.querySelector('#run-allow-linked-pc').checked=false;
        document.querySelector('#run-start').click();
      })()`);
      await waitFor(clients[0].cdp,
        "document.querySelector('#starter-choice-dialog')?.open===true&&document.querySelectorAll('#starter-choice-list button[data-species]').length===3",
        'live SoulLink starter choices for screenshot');
      const liveStarterView = await evaluate(clients[0].cdp, `(()=>{
        const dialog=document.querySelector('#starter-choice-dialog');
        const choices=[...document.querySelectorAll('#starter-choice-list button')];
        return {open:dialog.open,seed:document.querySelector('#starter-choice-seed').textContent,
          choices:choices.map(button=>({label:button.querySelector('strong')?.textContent,
            dex:button.querySelector('.starter-choice-dex')?.textContent,
            sprite:button.querySelector('img.starter-choice-sprite')?.getAttribute('src'),
            species:Number(button.dataset.species),choice:button.querySelector('.starter-choice-number')?.textContent}))};
      })()`);
      check('live SoulLink starter dialog shows three numbered species choices',
        liveStarterView.open&&liveStarterView.choices.length===3
          &&liveStarterView.choices.every((choice,index)=>choice.choice===`Choice ${index+1}`
            &&Boolean(choice.label)&&!choice.label.startsWith('Pokémon #')
            &&Boolean(choice.sprite)&&choice.sprite.startsWith('/graphics/pokemon/')),liveStarterView);
      summary.screenshots.push(await capturePage(clients[0].cdp, 'starter-choice-live'));
      const choices = await Promise.all(clients.map(async (client, index) => ({
        species: await chooseStarter(client, index % 3),
        choices: await evaluate(client.cdp, `Array.from(document.querySelectorAll('#starter-choice-list button'),b=>Number(b.dataset.species))`),
      })));
      check('each player receives an independent seed-derived starter list',
        new Set(choices.map((choice) => JSON.stringify(choice.choices))).size === clients.length
          && choices.every((choice) => choice.choices.length === 3
            && new Set(choice.choices).size === 3&&choice.choices.includes(choice.species)), choices);
      for (const client of clients) {
        await waitFor(client.cdp, `(()=>{
          const run=window.pokeemerald.run.state();
          const game=window.pokeemerald.automation.state();
          return run?.status==='active'&&game.mapGroup===1&&game.mapNum===4
            &&window.pokeemerald.automation.runParty().length===1;
        })()`, `${client.player.key} quick-started into SoulLink`, 30000);
      }
      if (options.trailerMotion) {
        step('capture four real SoulLink players moving together');
        const start = await Promise.all(clients.map((client) => evaluate(client.cdp,
          'window.pokeemerald.instance.exports.WasmPresenceXPx()')));
        const directions = [
          ['right', 'left'], ['left', 'right'], ['down', 'up'], ['up', 'down'],
        ];
        const observed = clients.map(() => new Set());
        for (let frame = 0; frame < 48; frame++) {
          for (const [index, client] of clients.entries()) {
            const phase = Math.floor(frame / 8) % 2;
            const direction = directions[index][phase];
            const position = await evaluate(client.cdp, `(()=>{
              const au=window.pokeemerald.automation;
              for (const button of ['up','down','left','right']) au.setButton(button,button==='${direction}');
              au.runToFrame(au.state().frame+4);
              return [window.pokeemerald.instance.exports.WasmPresenceXPx(),window.pokeemerald.instance.exports.WasmPresenceYPx()];
            })()`);
            observed[index].add(position.join(','));
          }
          await delay(65);
          summary.screenshots.push(await capture(clients[0].cdp,
            `trailer-motion-${String(frame).padStart(3, '0')}`));
        }
        for (const client of clients) {
          await evaluate(client.cdp, `(()=>{
            const au=window.pokeemerald.automation;
            for (const button of ['up','down','left','right']) au.setButton(button,false);
            au.runToFrame(au.state().frame+24);
          })()`);
        }
        check('trailer shows actual four-client movement',
          observed.every((positions) => positions.size > 1),
          {start,distinctPositions:observed.map((positions) => positions.size)});
      }
      const initialRunStates = await Promise.all(clients.map((client) => evaluate(client.cdp, 'window.pokeemerald.run.state()')));
      const initialRunId = initialRunStates[0].runId;
      check('all players share the same initial run ID', initialRunStates.every((state) => state.runId === initialRunId), initialRunStates.map((state) => state.runId));
      check('all players share the selected randomizer options and seed',
        initialRunStates.every((state) => state.seed === initialRunStates[0].seed
          && JSON.stringify(state.options) === JSON.stringify(initialRunStates[0].options)
          && state.options.randomizeWild && state.options.randomizeTrainers
          && state.options.randomizeGyms && state.options.randomizeStarters
          && state.options.allowLinkedPcBoxing === false),
        initialRunStates.map(({ seed, options }) => ({ seed, options })));
      const randomSpeciesByPlayer = await Promise.all(clients.map((client) => evaluate(client.cdp, `(()=>{
        const au=window.pokeemerald.automation;
        const kinds=[0,1,2,5];
        const first=kinds.map((kind)=>au.runSpeciesProbe(kind,25,0x534c,7));
        const repeat=kinds.map((kind)=>au.runSpeciesProbe(kind,25,0x534c,7));
        return {first,stable:JSON.stringify(first)===JSON.stringify(repeat)};
      })()`)));
      const perCategoryDiversity=[0,1,2,3].map((index)=>
        new Set(randomSpeciesByPlayer.map((result)=>result.first[index])).size);
      check('wild, trainer, Gym and starter randomization use stable per-player streams',
        randomSpeciesByPlayer.every((result)=>result.stable)&&perCategoryDiversity.every((count)=>count>1),
        {randomSpeciesByPlayer,perCategoryDiversity});
      for (const client of clients) {
        await waitFor(client.cdp,
          "!document.querySelector('#lobby-save-controls').hidden&&document.querySelector('#lobby-save-status').textContent.includes('player saves')",
          `${client.player.key} has a local IndexedDB lobby replica`);
      }
      const hostLobbyActions = await evaluate(clients[0].cdp, `({
        save:!document.querySelector('#member-save-slot').hidden,
        saveDisabled:document.querySelector('#member-save-slot').disabled,
        download:!document.querySelector('#lobby-download').hidden,
        downloadDisabled:document.querySelector('#lobby-download').disabled,
        status:document.querySelector('#lobby-save-status').textContent,
      })`);
      const guestLobbyActions = await evaluate(clients[1].cdp, `({
        save:!document.querySelector('#member-save-slot').hidden,
        download:!document.querySelector('#lobby-download').hidden,
      })`);
      check('everyone can save now; only the host can download a backup',
        hostLobbyActions.save&&hostLobbyActions.download
          &&!hostLobbyActions.saveDisabled&&hostLobbyActions.downloadDisabled
          &&hostLobbyActions.status.includes('waiting for the others')
          &&guestLobbyActions.save&&!guestLobbyActions.download,
        {hostLobbyActions,guestLobbyActions});
      for (const client of clients) {
        const localSlotState=await evaluate(client.cdp, `(async()=>{
          const {createLobbySaveStore}=await import('/web/run/lobby-store.mjs');
          const p=window.pokeemerald.presence.state();
          const store=createLobbySaveStore({namespace:'emerald/${client.player.profile}',
            validateSave:async ({saveBytes})=>saveBytes.length===131072});
          const record=await store.load(p.room);
          await store.close();
          return {player:p.playerId,buttonHidden:document.querySelector('#member-save-slot').hidden,
            buttonDisabled:document.querySelector('#member-save-slot').disabled,
            members:window.pokeemerald.run.state().members.map(m=>({playerId:m.playerId,slot:m.slot})),
            slots:Object.fromEntries(Object.entries(record.slots).map(([k,v])=>[k,v.ownerPlayerId]))};
        })()`);
        check(`${client.player.key} has one owned IndexedDB slot before saving`,
          !localSlotState.buttonHidden&&!localSlotState.buttonDisabled
            &&Object.values(localSlotState.slots).filter((owner)=>owner===localSlotState.player).length===1,
          localSlotState);
        await evaluate(client.cdp, "document.querySelector('#save-profile').click()");
        await waitFor(client.cdp,
          "document.querySelector('#save-profile-dialog').open&&document.querySelector('#save-game-now').disabled===false",
          `${client.player.key} Save game dialog is ready`);
        await evaluate(client.cdp, "document.querySelector('#save-game-now').click()");
        await waitFor(client.cdp,
          "document.querySelector('#save-profile-hint').textContent.includes('player slot saved')",
          `${client.player.key} Save game also commits their lobby slot`,15000);
        const saveResult = await evaluate(client.cdp, `(async()=>{
          const p=window.pokeemerald.presence.state();
          const {createLobbySaveStore}=await import('/web/run/lobby-store.mjs');
          const store=createLobbySaveStore({namespace:'emerald/${client.player.profile}',
            validateSave:async ({saveBytes})=>saveBytes.length===131072});
          const record=await store.load(p.room);
          const slot=Object.values(record.slots).find((entry)=>entry.ownerPlayerId===p.playerId);
          await store.close();
          const result={lobby:document.querySelector('#lobby-save-status').textContent,
            hint:document.querySelector('#save-profile-hint').textContent,
            localSave:window.pokeemerald.automation.runSaveInfo(),
            slotSaved:Boolean(slot?.saveBytes),slotBytes:slot?.saveBytes?.length??0};
          document.querySelector('#save-profile-dialog').close();
          return result;
        })()`);
        check(`${client.player.key} Save game stores their own valid game image in the lobby slot`,
          saveResult.hint.includes('player slot saved')&&saveResult.slotSaved&&saveResult.slotBytes===131072,
          saveResult);
      }
      await waitFor(clients[0].cdp,
        "document.querySelector('#lobby-save-status').textContent.includes('4 of 4 player saves')",
        'host replica receives all four committed slot saves',20000);
      const archiveReady = await evaluate(clients[0].cdp, `({
        status:document.querySelector('#lobby-save-status').textContent,
          saveDisabled:document.querySelector('#member-save-slot').disabled,
        downloadDisabled:document.querySelector('#lobby-download').disabled,
      })`);
      check('host can archive only after every assigned member slot is committed',
        !archiveReady.saveDisabled&&!archiveReady.downloadDisabled,archiveReady);
      await evaluate(clients[0].cdp, `(()=>{
        const original=URL.createObjectURL.bind(URL);
        URL.createObjectURL=(blob)=>{window.__lobbyBackupBlob=blob;return original(blob);};
        document.querySelector('#lobby-download').click();
        return true;
      })()`);
      await waitFor(clients[0].cdp, 'Boolean(window.__lobbyBackupBlob)', 'host .ptlobby download is prepared');
      const hostBundle = await evaluate(clients[0].cdp, `(async()=>{
        const blob=window.__lobbyBackupBlob;
        const value=JSON.parse(await blob.text());
        const saved=Object.values(value.slots).filter((slot)=>slot.saveBytes!==null).length;
        return {mime:blob.type,filename:document.querySelector('#lobby-download').textContent,
          format:value.format,revision:value.revision,slotCount:Object.keys(value.slots).length,saved};
      })()`);
      check('host downloadable .ptlobby includes shared run state and all four slot saves',
        hostBundle.mime==='application/json'&&hostBundle.format==='poketech-lobby-save'
          &&hostBundle.slotCount===4&&hostBundle.saved===4,hostBundle);
      for (const client of clients.slice(1)) {
        await waitFor(client.cdp,
            "document.querySelector('#lobby-save-status').textContent.includes('4 of 4 player saves')",
          `${client.player.key} acknowledged the full host replica`,30000);
      }
      await evaluate(clients[0].cdp, `(async()=>{
        window.confirm=()=>true;
        const bundle=JSON.parse(await window.__lobbyBackupBlob.text());
        bundle.settings.importProbe='ptlobby-ui-roundtrip';
        const file=new File([JSON.stringify(bundle)],'roundtrip.ptlobby',{type:'application/json'});
        const data=new DataTransfer();data.items.add(file);
        const input=document.querySelector('#lobby-import');input.files=data.files;
        input.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      })()`);
      const importedLobby = await waitFor(clients[0].cdp, `(async()=>{
        const {createLobbySaveStore}=await import('/web/run/lobby-store.mjs');
        const store=createLobbySaveStore({namespace:'emerald/${clients[0].player.profile}',
          validateSave:async ({saveBytes})=>saveBytes.length===131072});
        const record=await store.load(window.pokeemerald.presence.state().room);
        await store.close();
        return record?.settings?.importProbe==='ptlobby-ui-roundtrip'&&Object.values(record.slots).filter(s=>s.saveBytes).length===4
          ?{imported:true,revision:record.revision,slotCount:Object.keys(record.slots).length}:null;
      })()`, 'host .ptlobby import validates and restores the local lobby container',15000);
      check('host Import .ptlobby round-trips all four validated slot saves',
        importedLobby.imported&&importedLobby.slotCount===4,importedLobby);
      for (const client of clients) {
        const save = await evaluate(client.cdp, 'window.pokeemerald.automation.runSaveInfo()');
        const mainSave = await evaluate(client.cdp, 'window.pokeemerald.automation.mainSaveInfo()');
        const party = await evaluate(client.cdp, 'window.pokeemerald.automation.runParty()');
        check(`${client.player.key} uses a valid isolated soulrun save`, save.valid && save.key.endsWith('/soulrun'), save);
        const mainIndex = clients.indexOf(client);
        check(`${client.player.key} main-save record remains byte-identical`,
          mainSave.exists && mainSave.key === mainSaveBaselines[mainIndex].key
            && mainSave.hash === mainSaveBaselines[mainIndex].hash,
          { before: mainSaveBaselines[mainIndex], after: mainSave });
        check(`${client.player.key} starts with their selected level-5 starter`,
          party.length === 1 && party[0].level === 5 && party[0].species === choices[clients.indexOf(client)].species,
          { party, selected: choices[clients.indexOf(client)].species });
        await waitFor(client.cdp,
          `window.pokeemerald.run.state().links['link:emerald:gift:starter']?.members.some(m=>m.playerId==='${client.playerId}')`,
          `${client.player.key} receives their starter link before PC policy check`);
        const pcGate = await evaluate(client.cdp, `(()=>{
          const e=window.pokeemerald.instance.exports;
          const pid=((((e.WasmRunPartyPidHi(0)&0xffff)<<16)|(e.WasmRunPartyPidLo(0)&0xffff))>>>0);
          const before=window.pokeemerald.automation.runParty();
          const allowed=window.pokeemerald.automation.canBoxRunPartyMon(0);
          const moved=window.pokeemerald.automation.tryBoxRunPartyMon(0);
          const after=window.pokeemerald.automation.runParty();
          return {pid,allowed,moved,before,after,stillBoxed:window.pokeemerald.automation.runBoxHasPid(pid)};
        })()`);
        check(`${client.player.key} PC move is denied without changing its linked party or box`,
          pcGate.allowed===false&&pcGate.moved===false
            &&pcGate.before.length===1&&pcGate.after.length===1
            &&pcGate.before[0].species===pcGate.after[0].species&&!pcGate.stillBoxed,
          pcGate);
      }
      const linkedStarterResult = await waitFor(clients[0].cdp,
        `window.pokeemerald.run.state().links['link:emerald:gift:starter']?.members.length===4`,
        'all four starter gifts link', 15000).catch(async () => ({
        states: await Promise.all(clients.map((client) => evaluate(client.cdp, `(()=>{const s=window.pokeemerald.run.state();return {status:s?.status,links:Object.keys(s?.links??{}),areas:s?.areas,events:s?.events?.slice(-8)};})()`))),
      }));
      check('all four starter gifts link', !linkedStarterResult.states, linkedStarterResult.states ?? null);
      const starterLink = await evaluate(clients[0].cdp, "window.pokeemerald.run.state().links['link:emerald:gift:starter']");
      check('starter link records all four player-specific species', starterLink.members.length === 4
        && starterLink.members.every((member) => Number.isInteger(member.species)), starterLink.members);
      await evaluate(clients[0].cdp, "document.querySelector('#game-menu-party').click()");
      await waitFor(clients[0].cdp, "document.querySelector('#party-panel')?.open===true", 'run tracker party panel opens');
      const trackerText = await evaluate(clients[0].cdp, "document.querySelector('#party-panel-body').textContent");
      check('Party panel renders run areas, linked pairs and an empty graveyard',
        trackerText.includes('Run tracker')&&trackerText.includes('Linked pairs')&&trackerText.includes('Graveyard (0)'),
        trackerText.slice(-600));
      await evaluate(clients[0].cdp, "document.querySelector('#party-panel').close()");
      const randomization = await evaluate(clients[0].cdp, `(()=>{
        const au=window.pokeemerald.automation;
        const speciesCount=window.pokeemerald.instance.exports.WasmRunSpeciesCount();
        const samples=(kind)=>Array.from({length:1600},(_,slot)=>au.runSpeciesProbe(kind,25,18,slot));
        return {
          speciesCount,
          wild:samples(0),
          trainers:samples(1),
          gyms:samples(2),
          elite:samples(3),
          champions:samples(4),
        };
      })()`);
      check('true randomizer uses all 386 eligible internal species (excluding retired Old Unown)',
        randomization.speciesCount === 386, randomization.speciesCount);
      check('wild and trainer contexts produce varied species, including Kyogre',
        new Set(randomization.wild).size > 1 && new Set(randomization.trainers).size > 1 && randomization.wild.includes(382),
        { wildDistinct: new Set(randomization.wild).size, trainerDistinct: new Set(randomization.trainers).size, wildHasKyogre: randomization.wild.includes(382) });
      const runOwnedSpecies = await evaluate(clients[0].cdp,
        '(()=>{const s=window.pokeemerald.run.state();return s.options.dupesClause?s.ownedSpecies[s.members.find(m=>m.playerId===window.pokeemerald.presence.state().playerId).playerId]:[];})()');
      check('wild randomizer rerolls local dupes before encounter creation',
        randomization.wild.every((species) => !runOwnedSpecies.includes(species)),
        { ownedSpecies: runOwnedSpecies, matchingWildResults: randomization.wild.filter((species) => runOwnedSpecies.includes(species)) });
      check('capture-gate test seeds one ball explicitly',
        await evaluate(clients[0].cdp, 'window.pokeemerald.instance.exports.WasmRunDebugAddItem(4, 1)') === 1,
        'test-only ball');
      const blockedCapture = await evaluate(clients[0].cdp, `(()=>{
        const au=window.pokeemerald.automation;
        for(const species of ${JSON.stringify(randomization.wild)}){
          const result=au.runCaptureProbe(18,species,0x12345678);
          if(result.before.caught===0)return result;
        }
        return null;
      })()`);
      check('unclaimed-area capture gate rejects the throw without consuming balls or mutating Pokédex',
        blockedCapture !== null && blockedCapture.captureBlocked === 1
          && blockedCapture.before.pokeballs > 0
          && blockedCapture.before.pokeballs === blockedCapture.after.pokeballs
          && blockedCapture.before.caught === 0 && blockedCapture.after.caught === 0,
        blockedCapture);
      if (options.trailerCaptures) {
        summary.screenshots.push(await capturePage(clients[0].cdp, 'trailer-capture-gate'));
      }
      const wildSectionId = await evaluate(clients[0].cdp, 'window.pokeemerald.instance.exports.WasmRunMapSection()');
      const wildAreaKey = `emerald:section:${wildSectionId}`;
      for (const client of clients) {
        const generated = await evaluate(client.cdp, 'window.pokeemerald.automation.createWildParty(25, 4, 0)');
        const playerId = client.playerId;
        await waitFor(client.cdp,
          `window.pokeemerald.run.state().areas['${wildAreaKey}']?.claims?.['${playerId}']?.status==='claimed'`,
          `${client.player.key} wild claim is present before capture`, 10000);
        const captured = await evaluate(client.cdp, 'window.pokeemerald.automation.acceptRunWildCapture()');
        const captureState = captured.result === 2 ? await evaluate(client.cdp, `(()=>{
          const s=window.pokeemerald.run.state();
          const section=window.pokeemerald.instance.exports.WasmRunMapSection();
          const area=s.areas['emerald:section:'+section];
          const player=window.pokeemerald.presence.state().playerId;
          return {section,player,area,options:s.options,party:window.pokeemerald.automation.runParty()};
        })()`) : null;
        check(`${client.player.key} accepts and records its claimed wild encounter`,
          generated.length === 1 && captured.result !== 2
            && captured.party.some((pokemon) => pokemon.species === generated[0].species),
          { wild: generated[0], captureResult: captured.result, captureState });
      }
      await waitFor(clients[0].cdp,
        `window.pokeemerald.run.state().links['link:${wildAreaKey}']?.members.length===4`,
        'four caught wild Pokémon become a complete link', 15000);
      if (options.trailerCaptures) {
        for (const client of clients) {
          await evaluate(client.cdp, '(()=>{window.pokeemerald.party.setShared(true);return window.pokeemerald.party.read()})()');
        }
        await evaluate(clients[0].cdp, "document.querySelector('#menu-toggle').click(); document.querySelector('#game-menu-party').click()");
        summary.screenshots.push(await capturePage(clients[0].cdp, 'trailer-linked-party'));
        await evaluate(clients[0].cdp, "document.querySelector('#party-panel .party-run-tracker').scrollIntoView({block:'start'})");
        summary.screenshots.push(await capturePage(clients[0].cdp, 'trailer-run-tracker'));
        await evaluate(clients[0].cdp, "document.querySelector('#party-panel').close()");
      }
      check('gym, Elite Four and Champion teams each have distinct seeded pools',
        [randomization.gyms, randomization.elite, randomization.champions].every((pool) => new Set(pool).size > 1),
        [randomization.gyms, randomization.elite, randomization.champions].map((pool) => new Set(pool).size));
      const secondLeaderAce = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.setRunBadgeCount(1)');
      const firstLeaderAce = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.setRunBadgeCount(0)');
      check('Gym cap advances from the undefeated leader ace after a badge',
        secondLeaderAce === 19 && firstLeaderAce === 15,
        { firstLeaderAce, secondLeaderAce });
      const wildTeam = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.createWildParty(25, 4, 1)');
      check('wild-slot generator randomizes species and preserves its authored level',
        wildTeam.length === 1 && wildTeam[0].species > 0 && wildTeam[0].level === 4, wildTeam);
      const roxanneTeam = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.createTrainerParty(265)');
      check('Gym Leader party generator randomizes every species and preserves levels/count',
        roxanneTeam.length === 3 && roxanneTeam.every((mon) => mon.species > 0)
          && roxanneTeam.map((mon) => mon.level).sort().join(',') === '12,12,15', roxanneTeam);
      const sidneyTeam = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.createTrainerParty(261)');
      check('Elite Four party generator randomizes every species and preserves levels/count',
        sidneyTeam.length === 5 && sidneyTeam.every((mon) => mon.species > 0)
          && sidneyTeam.map((mon) => mon.level).sort((a,b)=>a-b).join(',') === '46,46,48,48,49', sidneyTeam);
      const wallaceTeam = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.createTrainerParty(335)');
      check('Champion party generator randomizes every species and preserves levels/count',
        wallaceTeam.length === 6 && wallaceTeam.every((mon) => mon.species > 0)
          && wallaceTeam.map((mon) => mon.level).sort((a,b)=>a-b).join(',') === '55,56,56,56,57,58', wallaceTeam);
      summary.screenshots.push(await capture(clients[0].cdp, 'soullink-starters'));

      step('verify a starter faint kills and safely releases every linked party member');
      await evaluate(clients[0].cdp, 'window.pokeemerald.automation.debugFaintRunPartySlot(0)');
      await waitFor(clients[0].cdp, `window.pokeemerald.run.state().links['link:emerald:gift:starter']?.status==='dead'`, 'local starter link death', 15000);
      for (const client of clients.slice(1)) {
        await waitFor(client.cdp, `window.pokeemerald.run.state().links['link:emerald:gift:starter']?.status==='dead'`, `${client.player.key} receives linked death`);
        await evaluate(client.cdp, 'window.pokeemerald.automation.processRunSafePoint()');
        check(`${client.player.key} releases its linked starter at safe point`,
          (await evaluate(client.cdp, 'window.pokeemerald.automation.runParty()')).length === 1);
      }
      check('the first faint is recorded for all four linked starters', (await evaluate(clients[0].cdp, 'window.pokeemerald.run.state().deaths.length')) === 4);

      step('verify captured wild encounters also become an N-way link and share death');
      await evaluate(clients[0].cdp, 'window.pokeemerald.automation.debugFaintRunPartySlot(0)');
      await waitFor(clients[0].cdp,
        `(()=>{const s=window.pokeemerald.run.state();return s.status==='wipe_pending'&&s.links['link:${wildAreaKey}']?.status==='dead';})()`,
        'captured wild link death triggers the party wipe', 15000);
      for (const client of clients.slice(1)) {
        await waitFor(client.cdp, `window.pokeemerald.run.state().links['link:${wildAreaKey}']?.status==='dead'`, `${client.player.key} receives wild-link death`);
        await evaluate(client.cdp, 'window.pokeemerald.automation.processRunSafePoint()');
        check(`${client.player.key} releases its caught wild partner at safe point`,
          (await evaluate(client.cdp, 'window.pokeemerald.automation.runParty()')).length === 0);
      }
      check('both starter and caught-wild links are fully recorded dead',
        (await evaluate(clients[0].cdp, 'window.pokeemerald.run.state().deaths.length')) === 8);

      step('verify all-continuing-player readiness barrier');
      await waitFor(clients[1].cdp, "window.pokeemerald.run.state().status==='wipe_pending'", 'wipe state reaches peers');
      await evaluate(clients[0].cdp, "document.querySelector('#run-ready').click()");
      await waitFor(clients[0].cdp, `(()=>{const s=window.pokeemerald.run.state();return s.status==='wipe_pending'&&s.runId==='${initialRunId}';})()`, 'one ready does not restart', 10000);
      check('one player ready cannot reset the run', (await evaluate(clients[2].cdp, 'window.pokeemerald.run.state().runId')) === initialRunId);
      const restartPermissions = await Promise.all(clients.map((client) => evaluate(client.cdp, `({
        visible:!document.querySelector('#run-restart').hidden,
        enabled:!document.querySelector('#run-restart').disabled,
        dialogOpen:document.querySelector('#group-wipe-dialog').open,
        friendsPanelHidden:document.querySelector('#presence-panel').hidden,
      })`)));
      check('dedicated Group Wipe screen appears and restart is host-only while others are not ready',
        restartPermissions[0].visible&& !restartPermissions[0].enabled
        &&restartPermissions.every((permission)=>permission.dialogOpen&&permission.friendsPanelHidden)
        &&restartPermissions.slice(1).every((permission)=>!permission.visible),
        restartPermissions);
      for (const client of clients.slice(1)) await evaluate(client.cdp, "document.querySelector('#run-ready').click()");
      await waitFor(clients[0].cdp, "document.querySelector('#run-restart').disabled===false", 'host restart unlocks after all active players ready');
      check('only the host receives the enabled restart action',
        (await evaluate(clients[0].cdp, '!document.querySelector(\'#run-restart\').hidden'))
        &&(await evaluate(clients[0].cdp, '!document.querySelector(\'#run-restart\').disabled'))
        &&(await evaluate(clients[1].cdp, 'document.querySelector(\'#run-restart\').hidden')));

      step('verify dedicated Group Wipe responsive desktop and mobile layout');
      await waitFor(clients[0].cdp,
        "document.querySelector('#group-wipe-dialog')?.open===true"
        +"&&document.querySelector('#run-ready')?.textContent.includes('ready')",
        'host sees the dedicated Group Wipe screen',10000);
      const initialWipeActions = await evaluate(clients[0].cdp, `(()=>{
        const screen=document.querySelector('#group-wipe-screen').getBoundingClientRect();
        const ready=document.querySelector('#run-ready').getBoundingClientRect();
        const restart=document.querySelector('#run-restart').getBoundingClientRect();
        return {readyVisible:ready.top>=screen.top&&ready.bottom<=screen.bottom,
          restartVisible:restart.top>=screen.top&&restart.bottom<=screen.bottom};
      })()`);
      check('desktop Group Wipe exposes its actions without extra scrolling',
        initialWipeActions.readyVisible&&initialWipeActions.restartVisible, initialWipeActions);
      await delay(200);
      summary.screenshots.push(await capturePage(clients[0].cdp, 'group-wipe-desktop'));
      await evaluate(clients[0].cdp, "document.querySelector('#run-restart').scrollIntoView({block:'center'})");
      await delay(150);
      const desktopLayout = await evaluate(clients[0].cdp, `(()=>{
        const dialog=document.querySelector('#group-wipe-dialog');
        const restart=document.querySelector('#run-restart');
        const rect=restart.getBoundingClientRect();
        return {innerWidth, innerHeight, scrollWidth:document.documentElement.scrollWidth,
          dialogOpen:dialog.open, dialogWidth:dialog.getBoundingClientRect().width,
          restartVisible:!restart.hidden, restartRect:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},
          members:document.querySelectorAll('#group-wipe-members li').length,
          reason:document.querySelector('#group-wipe-reason').textContent};
      })()`);
      check('Group Wipe clearly explains party-only loss and lists every continuing player',
        desktopLayout.dialogOpen&&desktopLayout.members===4
          &&desktopLayout.reason.includes('PC do not prevent a wipe')
          &&desktopLayout.scrollWidth<=desktopLayout.innerWidth+1,
        desktopLayout);
      check('desktop Group Wipe keeps the host restart action fully scrollable into view',
        desktopLayout.restartVisible
          &&desktopLayout.restartRect.top>=0
          &&desktopLayout.restartRect.bottom<=desktopLayout.innerHeight,
        desktopLayout.restartRect);
      await setViewport(clients[0].cdp, 390, 844, true);
      await delay(350);
      await evaluate(clients[0].cdp, "document.querySelector('#group-wipe-screen').scrollTop=0");
      await delay(150);
      summary.screenshots.push(await capturePage(clients[0].cdp, 'group-wipe-mobile'));
      await evaluate(clients[0].cdp, "document.querySelector('#run-restart').scrollIntoView({block:'center'})");
      await delay(200);
      const mobileLayout = await evaluate(clients[0].cdp, `(()=>{
        const restart=document.querySelector('#run-restart');
        const ready=document.querySelector('#run-ready');
        const restartRect=restart.getBoundingClientRect();
        const readyRect=ready.getBoundingClientRect();
        return {innerWidth, innerHeight, scrollWidth:document.documentElement.scrollWidth,
          restartInView:restartRect.left>=-1&&restartRect.right<=innerWidth+1&&restartRect.width>0,
          restartVerticallyVisible:restartRect.top>=0&&restartRect.bottom<=innerHeight,
          readyInView:readyRect.left>=-1&&readyRect.right<=innerWidth+1&&readyRect.width>0,
          restartLabel:restart.textContent};
      })()`);
      check('mobile Group Wipe has no horizontal overflow and keeps host controls reachable',
        mobileLayout.scrollWidth<=mobileLayout.innerWidth+1
          &&mobileLayout.restartInView&&mobileLayout.readyInView,
        mobileLayout);
      check('mobile Group Wipe fits the host restart action inside the viewport once scrolled',
        mobileLayout.restartVerticallyVisible,
        mobileLayout);
      await clearViewport(clients[0].cdp);
      await delay(250);
      await evaluate(clients[0].cdp, "document.querySelector('#run-restart').click()");
      const restartedChoices = await Promise.all(clients.map(async (client, index) => ({
        species: await chooseStarter(client, (index + 1) % 3),
        choices: await evaluate(client.cdp, `Array.from(document.querySelectorAll('#starter-choice-list button'),b=>Number(b.dataset.species))`),
      })));
      check('restart gives every player a new independent starter list',
        new Set(restartedChoices.map((choice) => JSON.stringify(choice.choices))).size === clients.length
          && restartedChoices.every((choice) => choice.choices.length === 3
            && new Set(choice.choices).size === 3&&choice.choices.includes(choice.species)), restartedChoices);
      const nextStates = await Promise.all(clients.map((client) => waitFor(client.cdp,
        `(()=>{const s=window.pokeemerald.run.state();const g=window.pokeemerald.automation.state();return s.status==='active'&&s.runId!=='${initialRunId}'&&g.mapGroup===1&&g.mapNum===4&&window.pokeemerald.automation.runParty().length===1?s:null;})()`,
        `${client.player.key} restarted`, 30000)));
      check('all players restart into the same new run', nextStates.every((state) => state.runId === nextStates[0].runId), nextStates.map((state) => state.runId));
      check('restart shares its fresh seed and preserves the host randomizer settings',
        nextStates.every((state) => state.seed === nextStates[0].seed
          && JSON.stringify(state.options) === JSON.stringify(nextStates[0].options)
          && state.seed !== initialRunStates[0].seed
          && state.options.randomizeWild && state.options.randomizeTrainers
          && state.options.randomizeGyms && state.options.randomizeStarters
          && state.options.allowLinkedPcBoxing === false),
        nextStates.map(({ seed, options }) => ({ seed, options })));
      for (const [index, client] of clients.entries()) {
        const party = await evaluate(client.cdp, 'window.pokeemerald.automation.runParty()');
        const save = await evaluate(client.cdp, 'window.pokeemerald.automation.runSaveInfo()');
        check(`${client.player.key} keeps their independent starter choice after restart`,
          party.length === 1 && party[0].species === restartedChoices[index].species
          && save.valid && save.key.endsWith('/soulrun'),
          { party, selected: restartedChoices[index].species, save });
        check(`${client.player.key} retains the host's linked-PC policy after restart`,
          (await evaluate(client.cdp, 'window.pokeemerald.automation.canBoxRunPartyMon(0)')) === false);
      }
      for (const [index, client] of clients.entries()) {
        const mainSave = await evaluate(client.cdp, 'window.pokeemerald.automation.mainSaveInfo()');
        check(`${client.player.key} main save remains isolated after a full run reset`,
          mainSave.exists && mainSave.hash === mainSaveBaselines[index].hash,
          { before: mainSaveBaselines[index], after: mainSave });
      }
      step('verify safe-point releases continue across compacted party slots');
      await evaluate(clients[0].cdp, 'window.pokeemerald.automation.addRunPartyMon(25, 6, 0x11111111)');
      await evaluate(clients[0].cdp, 'window.pokeemerald.automation.addRunPartyMon(133, 7, 0x22222222)');
      const threeMemberParty = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.runParty()');
      check('multi-slot release fixture has three Pokémon', threeMemberParty.length === 3, threeMemberParty);
      const firstPid = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.queueRunRelease(0)');
      const secondPid = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.queueRunRelease(1)');
      check('release fixture uses distinct personality identities', firstPid !== secondPid, [firstPid, secondPid]);
      const remainingParty = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.processRunSafePoint()');
      check('safe-point loop releases adjacent members after party compaction',
        remainingParty.length === 1 && remainingParty[0].species === 133, remainingParty);
      const boxedPid = 0x33334444;
      check('PC release fixture is stored before applying the void/death release',
        await evaluate(clients[0].cdp, `window.pokeemerald.automation.debugBoxMon(133, 7, ${boxedPid})`));
      await evaluate(clients[0].cdp, `window.pokeemerald.automation.queueRunReleasePid(${boxedPid})`);
      await evaluate(clients[0].cdp, 'window.pokeemerald.automation.processRunSafePoint()');
      check('safe-point release also scans and removes linked Pokémon from boxed storage',
        !(await evaluate(clients[0].cdp, `window.pokeemerald.automation.runBoxHasPid(${boxedPid})`)));
      step('verify Rare Candy obeys the living-party and current Gym ace ceilings');
      await evaluate(clients[0].cdp, 'window.pokeemerald.automation.addRunPartyMon(25, 8, 0x44444444)');
      const topPartyCandy = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.useRunRareCandy(1)');
      check('Rare Candy cannot raise the highest-level living party member',
        topPartyCandy.used === false && topPartyCandy.before === 8 && topPartyCandy.after === 8,
        topPartyCandy);
      const belowPartyCeilingCandy = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.useRunRareCandy(0)');
      check('Rare Candy can raise a lower party member without exceeding its leader ace',
        belowPartyCeilingCandy.used === true && belowPartyCeilingCandy.before === 7 && belowPartyCeilingCandy.after === 8,
        belowPartyCeilingCandy);
      await evaluate(clients[0].cdp, 'window.pokeemerald.automation.addRunPartyMon(133, 15, 0x55555555)');
      await evaluate(clients[0].cdp, 'window.pokeemerald.automation.addRunPartyMon(1, 20, 0x66666666)');
      const atGymCapCandy = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.useRunRareCandy(2)');
      check('Rare Candy cannot raise a Pokémon at the current Gym Leader ace cap',
        atGymCapCandy.used === false && atGymCapCandy.before === 15 && atGymCapCandy.after === 15,
        atGymCapCandy);
      const overCapCandy = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.useRunRareCandy(3)');
      check('Rare Candy cannot raise a Pokémon above the Gym cap',
        overCapCandy.used === false && overCapCandy.before === 20 && overCapCandy.after === 20,
        overCapCandy);
      check('Rare Candy refill test seeds one candy explicitly',
        await evaluate(clients[0].cdp, 'window.pokeemerald.instance.exports.WasmRunDebugAddItem(68, 1)') === 1,
        'test-only Rare Candy');
      const unlimitedCandy = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.consumeAndRefillRunCandy()');
      check('run-scoped Candy refill restores the consumed Rare Candy',
        unlimitedCandy.refilled && unlimitedCandy.before === 1 && unlimitedCandy.after === 1,
        unlimitedCandy);
      await evaluate(clients[0].cdp, 'window.pokeemerald.automation.addRunPartyMon(25, 14, 0x77777777)');
      const cappedExp = await evaluate(clients[0].cdp,
        'window.pokeemerald.automation.applyRunExpGain(4, 0xffffffff)');
      check('one huge battle EXP award cannot advance a Pokémon past the next leader ace',
        cappedExp.level === 15 && cappedExp.party.level === 15, cappedExp);
      const repeatedExp = await evaluate(clients[0].cdp,
        'window.pokeemerald.automation.applyRunExpGain(4, 0xffffffff)');
      check('repeated EXP awards remain clamped at the ace cap',
        repeatedExp.level === 15 && repeatedExp.party.level === 15, repeatedExp);

      step('verify the host allow-linked-PC option performs a real party-to-PC placement');
      for (const client of clients) await evaluate(client.cdp, 'window.pokeemerald.presence.leave()');
      for (const client of clients) {
        await waitFor(client.cdp, "(()=>{const s=window.pokeemerald.presence.state();return s.status!=='joined'&&s.members.length===0;})()",
          `${client.player.key} left first test room`);
      }
      await evaluate(clients[0].cdp, 'window.pokeemerald.presence.createRoom()');
      const allowRoom = await waitFor(clients[0].cdp,
        `(()=>{const s=window.pokeemerald.presence.state();return s.status==='joined'&&s.room||null;})()`,
        'new room for linked-PC allow setting');
      for (const client of clients.slice(1)) {
        await evaluate(client.cdp, `window.pokeemerald.presence.joinRoom('${allowRoom}')`);
      }
      for (const client of clients) {
        await waitFor(client.cdp, `(()=>{
          const p=window.pokeemerald.presence.state();
          return p.status==='joined'&&p.room==='${allowRoom}'&&p.members.length===4
            &&window.pokeemerald.run.connection==='attached';
        })()`, `${client.player.key} joined allow-policy room`);
        client.playerId = await evaluate(client.cdp, 'window.pokeemerald.presence.state().playerId');
        await evaluate(client.cdp, `(()=>{
          if(document.querySelector('#presence-panel').hidden) document.querySelector('#presence-toggle').click();
          return true;
        })()`);
      }
      await waitFor(clients[0].cdp,
        "document.querySelector('#presence-run-settings')?.hidden===false&&document.querySelector('#run-start').disabled===false",
        'host can configure second SoulLink run');
      await evaluate(clients[0].cdp, `(()=>{
        document.querySelector('#run-allow-linked-pc').checked=true;
        document.querySelector('#run-start').click();
        return true;
      })()`);
      const allowStarterChoices = await Promise.all(clients.map((client, index) => chooseStarter(client, index % 3)));
      const allowRunStates = await Promise.all(clients.map((client) => waitFor(client.cdp, `(()=>{
        const s=window.pokeemerald.run.state();
        return s?.status==='active'&&s.options.allowLinkedPcBoxing===true
          &&window.pokeemerald.automation.runParty().length===1?s:null;
      })()`, `${client.player.key} started allow-PC run`, 30000)));
      check('host allow-PC setting and new seed are shared by the second run',
        allowRunStates.every((state) => state.seed===allowRunStates[0].seed
          &&state.options.allowLinkedPcBoxing===true),
        allowRunStates.map(({seed,options})=>({seed,allowLinkedPcBoxing:options.allowLinkedPcBoxing})));
      step('verify a missed linked encounter voids the area and safely releases the caught partner');
      const missedSection = await evaluate(clients[0].cdp, 'window.pokeemerald.instance.exports.WasmRunMapSection()');
      const missedArea = `emerald:section:${missedSection}`;
      const caughtBeforeMiss = await evaluate(clients[0].cdp, `(()=>{
        const wild=window.pokeemerald.automation.createWildParty(25,4,0);
        const caught=window.pokeemerald.automation.acceptRunWildCapture();
        const state=window.pokeemerald.run.state();
        return {wild:wild[0],caught,area:state.areas['${missedArea}']};
      })()`);
      check('first player catches the new area encounter before a partner misses',
        caughtBeforeMiss.caught.result!==2
          &&caughtBeforeMiss.area.claims[clients[0].playerId]?.status==='caught',caughtBeforeMiss);
      const missedClaim = await evaluate(clients[1].cdp, `(()=>{
        const api=window.pokeemerald.automation;
        const playerId=window.pokeemerald.presence.state().playerId;
        const section=window.pokeemerald.instance.exports.WasmRunMapSection();
        const areaKey='emerald:section:'+section;
        for(let slot=0;slot<32;slot++){
          const wild=api.createWildParty(133,4,slot);
          const claim=window.pokeemerald.run.state().areas[areaKey]?.claims?.[playerId];
          if(claim?.status==='claimed') return {areaKey,claim,wild,slot};
        }
        return {areaKey,claim:window.pokeemerald.run.state().areas[areaKey]?.claims?.[playerId]??null};
      })()`);
      check('second player has an active claim before intentionally missing the encounter',
        missedClaim.claim?.status==='claimed',missedClaim);
      await evaluate(clients[1].cdp, 'window.pokeemerald.automation.processRunSafePoint()');
      const voidWait = await Promise.all(clients.map(async (client) => await waitFor(client.cdp,
        `window.pokeemerald.run.state().areas['${missedClaim.areaKey}']?.status==='void'`,
        `${client.player.key} sees missed area voided`,10000).catch(async () => ({
          failed: true,
          snapshot: await evaluate(client.cdp, `(()=>{
            const s=window.pokeemerald.run.state();
            return {connection:window.pokeemerald.run.connection,status:s?.status,revision:s?.revision,
              area:s?.areas['${missedClaim.areaKey}'],recent:s?.events.slice(-8)};
          })()`),
        }))));
      check('missed encounter is authoritatively voided on all clients',
        voidWait.every((result)=>!result?.failed),voidWait);
      const caughtPartner = await evaluate(clients[0].cdp, `window.pokeemerald.run.state().areas['${missedClaim.areaKey}'].claims['${clients[0].playerId}']`);
      const releasedParty = await evaluate(clients[0].cdp, 'window.pokeemerald.automation.processRunSafePoint()');
      check('missed linked encounter permanently releases the already-caught partner at safe point',
        caughtPartner.status==='void'&&releasedParty.length===1
          &&releasedParty[0].species===allowStarterChoices[0],
        {caughtPartner,releasedParty,expectedStarter:allowStarterChoices[0]});
      if (options.trailerCaptures) {
        for (const client of clients) {
          await evaluate(client.cdp, '(()=>{window.pokeemerald.party.setShared(true);return window.pokeemerald.party.read()})()');
        }
        await evaluate(clients[0].cdp, "document.querySelector('#menu-toggle').click(); document.querySelector('#game-menu-party').click()");
        await evaluate(clients[0].cdp, "document.querySelector('#party-panel .party-run-tracker').scrollIntoView({block:'start'})");
        summary.screenshots.push(await capturePage(clients[0].cdp, 'trailer-missed-encounter'));
        await evaluate(clients[0].cdp, "document.querySelector('#party-panel').close()");
      }
      for (const client of clients) {
        await evaluate(client.cdp, "document.querySelector('#member-save-slot').click()");
        await waitFor(client.cdp,
           "document.querySelector('#lobby-save-status').textContent.includes('1 of 4 player saves')",
          `${client.player.key} commits current-room slot before handoff`,15000);
      }
      await waitFor(clients[0].cdp,
         "document.querySelector('#lobby-save-status').textContent.includes('4 of 4 player saves')",
        'current host commits every member save before host migration',20000);
      for (const client of clients.slice(1)) {
        const replica = await waitFor(client.cdp,
           "document.querySelector('#lobby-save-status').textContent.includes('4 of 4 player saves')"
          +"?true:(()=>{throw new Error(document.querySelector('#lobby-save-status').textContent)})()",
          `${client.player.key} receives all current-room saves before host migration`,30000).catch(async (error) => ({
          error: error.message,
          stored: await evaluate(client.cdp, `(async()=>{
            const dbs=await indexedDB.databases();const out=[];
            for(const entry of dbs){
              const db=await new Promise((res,rej)=>{const r=indexedDB.open(entry.name);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
              if(!db.objectStoreNames.contains('lobbies')){out.push({name:entry.name,stores:[...db.objectStoreNames]});db.close();continue;}
              const rows=await new Promise((res,rej)=>{const tx=db.transaction('lobbies','readonly');const q=tx.objectStore('lobbies').getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
              out.push({name:entry.name,rows:rows.map(r=>({room:r.roomCode,host:r.hostPlayerId,rev:r.revision,auth:r.authorityRevision,
                run:r.runState?.runId??null,saved:Object.values(r.slots).filter(s=>s.saveBytes).length,
                owners:Object.fromEntries(Object.entries(r.slots).map(([i,s])=>[i,s.ownerPlayerId]))}))});
              db.close();
            }
            const st=window.pokeemerald.presence.state();
            return {app:window.pokeemerald.presence.lobbyReplica(),room:st.room,members:(st.members??[]).map(m=>m.playerId),dbs:out};
          })()`),
        }));
        check(`${client.player.key} replica holds all four current-room slot images`, replica === true, replica);
      }
      step('capture responsive Friends lobby views');
      await evaluate(clients[0].cdp, "document.querySelector('#lobby-save-status').scrollIntoView({block:'center'})");
      await delay(200);
      summary.screenshots.push(await capturePage(clients[0].cdp, 'friends-lobby-desktop'));
      const lobbyDesktop = await evaluate(clients[0].cdp, `(()=>{
        const panel=document.querySelector('#presence-panel').getBoundingClientRect();
        const status=document.querySelector('#lobby-save-status');
        const rect=status.getBoundingClientRect();
        return {innerWidth,innerHeight,scrollWidth:document.documentElement.scrollWidth,
          panelLeft:panel.left,panelRight:panel.right,status:status.textContent,
          statusRect:{top:rect.top,bottom:rect.bottom}};
      })()`);
      check('desktop Friends lobby keeps the replicated slot status inside the panel viewport',
        lobbyDesktop.scrollWidth<=lobbyDesktop.innerWidth+1
          &&lobbyDesktop.panelLeft>=-1&&lobbyDesktop.panelRight<=lobbyDesktop.innerWidth+1
           &&lobbyDesktop.status.includes('4 of 4 player saves')
          &&lobbyDesktop.statusRect.top>=0
          &&lobbyDesktop.statusRect.bottom<=lobbyDesktop.innerHeight,
        lobbyDesktop);
      await setViewport(clients[0].cdp, 390, 844, true);
      await delay(350);
      await evaluate(clients[0].cdp, "document.querySelector('#lobby-save-status').scrollIntoView({block:'center'})");
      await delay(200);
      summary.screenshots.push(await capturePage(clients[0].cdp, 'friends-lobby-mobile'));
      const lobbyMobile = await evaluate(clients[0].cdp, `(()=>{
        const panel=document.querySelector('#presence-panel').getBoundingClientRect();
        const rect=document.querySelector('#lobby-save-status').getBoundingClientRect();
        return {innerWidth,innerHeight,scrollWidth:document.documentElement.scrollWidth,
          docHeight:document.documentElement.scrollHeight,
          shellHeight:document.querySelector('.shell')?.getBoundingClientRect().height??null,
          panelLeft:panel.left,panelRight:panel.right,panelBottom:panel.bottom,
          statusRect:{top:rect.top,bottom:rect.bottom}};
      })()`);
      check('mobile Friends lobby keeps the slot status reachable without horizontal overflow',
        lobbyMobile.scrollWidth<=lobbyMobile.innerWidth+1
          &&lobbyMobile.panelLeft>=-1&&lobbyMobile.panelRight<=lobbyMobile.innerWidth+1
          &&lobbyMobile.statusRect.top>=0
          &&lobbyMobile.statusRect.bottom<=lobbyMobile.innerHeight,
        lobbyMobile);
      check('mobile shell covers the whole viewport height',
        lobbyMobile.docHeight>=lobbyMobile.innerHeight-1,
        lobbyMobile);
      await clearViewport(clients[0].cdp);
      await delay(250);
      const allowedMoves = await Promise.all(clients.map((client) => evaluate(client.cdp, `(()=>{
        const e=window.pokeemerald.instance.exports;
        const pid=((((e.WasmRunPartyPidHi(0)&0xffff)<<16)|(e.WasmRunPartyPidLo(0)&0xffff))>>>0);
        const allowed=window.pokeemerald.automation.canBoxRunPartyMon(0);
        const moved=window.pokeemerald.automation.tryBoxRunPartyMon(0);
        return {pid,allowed,moved,party:window.pokeemerald.automation.runParty(),boxed:window.pokeemerald.automation.runBoxHasPid(pid)};
      })()`)));
      check("host allow-PC setting permits each player's real independent party-to-PC move",
        allowedMoves.every((result)=>result.allowed&&result.moved&&result.party.length===0&&result.boxed),allowedMoves);
      step('verify in-lobby slot takeover swaps only after a committed prior save');
      const slotClaimUi = await evaluate(clients[1].cdp, `(()=>{
        document.querySelector('.lobby-more-options').open=true;
        const select=document.querySelector('#lobby-slot-claim');
        select.value='slot-1';
        const button=document.querySelector('#lobby-slot-claim-button');
        const result={hidden:document.querySelector('#lobby-slot-claim-label').hidden,
          disabled:button.disabled, options:Array.from(select.options).map(option=>option.value)};
        button.click();
        return result;
      })()`);
      check('member can request another member’s committed slot',
        !slotClaimUi.hidden&&!slotClaimUi.disabled&&slotClaimUi.options.includes('slot-1'),slotClaimUi);
      for (const client of clients) {
        await waitFor(client.cdp, `(async()=>{
          const {createLobbySaveStore}=await import('/web/run/lobby-store.mjs');
          const store=createLobbySaveStore({namespace:'emerald/${client.player.profile}',
            validateSave:async ({saveBytes})=>saveBytes.length===131072});
          const record=await store.load(window.pokeemerald.presence.state().room);
          await store.close();
          return record?.slots['slot-1']?.ownerPlayerId==='${clients[1].playerId}'
            &&record?.slots['slot-2']?.ownerPlayerId==='${clients[0].playerId}'
            ? {owners:Object.fromEntries(Object.entries(record.slots).map(([id,slot])=>[id,slot.ownerPlayerId]))}:null;
        })()`, `${client.player.key} receives unique slot swap with save images preserved`,20000);
      }
      const reassignedSaves = await Promise.all(clients.slice(0,2).map((client) => evaluate(client.cdp, 'window.pokeemerald.automation.runSaveInfo()')));
      check('both takeover participants remain on isolated SoulLink save records',
        reassignedSaves.every((save)=>save.valid&&save.key.endsWith('/soulrun')),reassignedSaves);
      step('verify host failover uses the synced participant-local lobby replica');
      const successorPlayerId = clients[1].playerId;
      await evaluate(clients[0].cdp, 'window.pokeemerald.presence.leave()');
      await waitFor(clients[1].cdp,
        `window.pokeemerald.run.state().hostPlayerId==='${successorPlayerId}'`,
        'room host handoff updates the shared run authority',15000);
      const successorLobby = await evaluate(clients[1].cdp, `(async()=>{
        const {createLobbySaveStore}=await import('/web/run/lobby-store.mjs');
        const store=createLobbySaveStore({namespace:'emerald/${clients[1].player.profile}',
          validateSave:async ({saveBytes})=>saveBytes.length===131072});
        const row=await store.load(window.pokeemerald.presence.state().room);
        await store.close();
        return {hostPlayerId:row?.hostPlayerId,saved:Object.values(row?.slots??{}).filter(slot=>slot.saveBytes).length,
          hasAuthority:row?.authorityRevision>0};
      })()`);
      check('successor is host of a converged local replica with every saved slot',
        successorLobby.hostPlayerId===successorPlayerId&&successorLobby.saved===4&&successorLobby.hasAuthority,
        successorLobby);
      await waitFor(clients[1].cdp,
        "!document.querySelector('#lobby-download').hidden&&document.querySelector('#lobby-download').disabled===false",
        'successor gets host backup authority',10000);
      check('departed host loses the backup action',
        (await evaluate(clients[0].cdp,"document.querySelector('#lobby-download').hidden"))===true);
      summary.screenshots.push(await capture(clients[0].cdp, 'soullink-ready-reset'));
      summary.ok = true;
      summary.completedAt = new Date().toISOString();
      await writeFile(resolve(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
      await writeFile(resolve(OUTPUT_DIR, 'console.log'), `${consoleLog.join('\n')}\n`);
      log(`PASS — ${summary.checks.length} SoulLink checks, ${summary.screenshots.length} screenshots`);
      return;
    }

    step('verify four-player roster and screen mapping');
    const initial = {};
    for (const client of clients) {
      await evaluate(client.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
      const snap = await snapshot(client.cdp);
      initial[client.player.key] = snap;
      check(`${client.player.key} roster has four members`, snap.presence.members.length === 4, snap.presence.members.length);
      check(`${client.player.key} store has three remote actors`, snap.remote.length === 3, snap.remote.length);
      check(`${client.player.key} maps three remote actors`, snap.mapped.length === 3, snap.mapped.length);
      check(`${client.player.key} presenter draws three remote quads`, snap.draw === 3, snap.draw);
      check(`${client.player.key} presenter draws eighteen vertices`, snap.vertices === 18, snap.vertices);
      for (const other of PLAYERS) {
        if (other.key === client.player.key) continue;
        const otherClient = clients.find((candidate) => candidate.player.key === other.key);
        const member = memberFor(snap, otherClient.playerId);
        check(`${client.player.key} sees ${other.key} as visible`, member?.visible === true, member);
        const observer = snap.self.pose;
        const expectedX = SELF_SCREEN.x + ((other.tile.x * 16 + 8) - observer.xPx);
        const expectedY = SELF_SCREEN.y + ((other.tile.y * 16 + 16) - observer.yPx);
        const actor = actorFor(snap, otherClient.playerId);
        check(`${client.player.key} maps ${other.key} at expected screen position`,
          actor && actor.screenX === expectedX && actor.screenY === expectedY,
          { expected: { x: expectedX, y: expectedY }, actor });
      }
      summary.screenshots.push(await capture(client.cdp, `initial-${client.player.key}`));
    }
    check('no duplicate remote player ids', new Set(initial.A.remote.map((actor) => actor.playerId)).size === 3);
    const freshnessSnap = initial.A.presence;
    const freshMember = freshnessSnap.members.find((member) => member.playerId === clients[1].playerId);
    const freshAge = freshMember?.latest ? freshnessSnap.serverNowMs - freshMember.latest.receivedMs : null;
    check('presence snapshot exposes the freshness clock',
      Boolean(freshnessSnap.clockReady)
        && Number.isFinite(freshnessSnap.serverNowMs)
        && freshnessSnap.visibleSnapshotAgeMs > 0,
      { clockReady: freshnessSnap.clockReady, now: freshnessSnap.serverNowMs, limit: freshnessSnap.visibleSnapshotAgeMs });
    check('live peers sit inside the freshness window',
      Number.isFinite(freshAge) && freshAge >= 0 && freshAge <= freshnessSnap.visibleSnapshotAgeMs,
      { ageMs: freshAge, limit: freshnessSnap.visibleSnapshotAgeMs });

    step('verify smooth one-tile walk, facing, flip and animation on a peer');
    const b = clients[1];
    const a = clients[0];
    const c = clients[2];
    const d = clients[3];
    const bId = b.playerId;
    const cId = c.playerId;
    const dId = d.playerId;
    const bStart = await snapshot(b.cdp);
    const startPx = bStart.self.pose.xPx;
    await evaluate(b.cdp, `(()=>{
      const au = window.pokeemerald.automation;
      const ex = window.pokeemerald.instance.exports;
      window.__walkSamples = [];
      au.setButton('right', true);
      for (let i = 0; i < 6; i++) {
        au.runToFrame(au.state().frame + 2);
        ex.WasmPresenceRefresh();
        window.__walkSamples.push({ f: au.state().frame, x: ex.WasmPresenceXPx(), y: ex.WasmPresenceYPx() });
      }
      return true;
    })()`);
    await delay(450);
    const midWalk = await snapshot(a.cdp);
    const midActor = actorFor(midWalk, b.playerId);
    check('peer sees B facing right while walking', observedAt(midWalk, midActor?.playerId)?.facing === 'right', observedAt(midWalk, midActor?.playerId));
    check('peer mirrors the right-facing avatar', midActor?.hFlip === true, midActor);
    check('peer receives a mid-step walk or idle pose', ['walk', 'idle'].includes(observedAt(midWalk, midActor?.playerId)?.motion), observedAt(midWalk, midActor?.playerId));
    await evaluate(b.cdp, `(()=>{
      const au = window.pokeemerald.automation;
      au.setButton('right', false);
      au.runToFrame(au.state().frame + 24);
      return true;
    })()`);
    const samples = await evaluate(b.cdp, 'window.__walkSamples');
    const endPx = startPx + 16;
    check('walk samples move smoothly between tiles',
      samples.some((sample) => sample.x > startPx && sample.x < endPx),
      { startPx, endPx, samples });
    const bMoved = await waitFor(b.cdp,
      `(()=>{const s=window.pokeemerald.automation.state();const p=window.pokeemerald.presence;return s.x===${PLAYERS[1].tile.x + 1}&&s.y===${PLAYERS[1].tile.y}&&p.diagnostics().self.pose.xPx===${endPx}&&p.diagnostics().self.pose.facing==='right'?{x:p.diagnostics().self.pose.xPx}:null;})()`,
      'B completes the right step', 10000);
    check('B publishes the integrated destination pixel', bMoved.x === endPx, bMoved);
    await waitForPeer(a.cdp, bId,
      'actor?.screenX===168&&actor?.screenY===88&&game.remoteDrawActors===3',
      'A renders B at the completed right-step position');
    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
    const afterRight = await snapshot(a.cdp);
    const afterRightActor = actorFor(afterRight, bId);
    check('peer maps B one tile to the right', afterRightActor?.screenX === 168 && afterRightActor?.screenY === 88,
      { actor: afterRightActor, self: afterRight.self, member: memberFor(afterRight, bId) });
    check('peer keeps the right-facing flip at rest', afterRightActor?.hFlip === true, afterRightActor);
    summary.screenshots.push(await capture(a.cdp, 'after-right-walk'));

    step('verify left walk returns B and clears the flip');
    await evaluate(b.cdp, `(()=>{const au=window.pokeemerald.automation;au.setButton('left',true);au.runToFrame(au.state().frame+10);au.setButton('left',false);au.runToFrame(au.state().frame+24);return true;})()`);
    await waitForPeer(a.cdp, bId,
      'actor?.screenX===152&&actor?.screenY===88&&game.remoteDrawActors===3',
      'A renders B after the left step');
    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
    const afterLeft = await snapshot(a.cdp);
    const leftActor = actorFor(afterLeft, bId);
    check('peer maps B back to the original tile', leftActor?.screenX === 152 && leftActor?.screenY === 88, leftActor);
    check('peer does not flip the left-facing avatar', leftActor?.hFlip === false, leftActor);

    step('verify vertical movement');
    await evaluate(d.cdp, `(()=>{const au=window.pokeemerald.automation;au.setButton('up',true);au.runToFrame(au.state().frame+10);au.setButton('up',false);au.runToFrame(au.state().frame+24);return true;})()`);
    await waitFor(d.cdp, `(()=>{const s=window.pokeemerald.automation.state();return s.x===${PLAYERS[3].tile.x}&&s.y===${PLAYERS[3].tile.y - 1};})()`, 'D completes the up step', 10000);
    await waitForPeer(a.cdp, dId,
      "actor?.screenX===152&&actor?.screenY===104&&m.latest?.state?.pose?.facing==='up'",
      'A renders D after the upward step');
    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
    const afterUp = await snapshot(a.cdp);
    const upActor = actorFor(afterUp, dId);
    const upPose = observedAt(afterUp, dId);
    check('peer maps D one tile up', upActor?.screenX === 152 && upActor?.screenY === 104, upActor);
    check('peer observes D facing up', upPose?.facing === 'up', upPose);
    check('peer uses the up-facing idle layer', upActor?.layer === 1, upActor);

    step('verify map transition visibility and epoch');
    const cBefore = await snapshot(c.cdp);
    await evaluate(c.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${OLDALE.group},${OLDALE.num},10,10);au.runToFrame(au.state().frame+180);return true;})()`);
    await waitFor(c.cdp,
      `(()=>{const s=window.pokeemerald.presence.state();const au=window.pokeemerald.automation.state();return au.mapGroup===${OLDALE.group}&&au.mapNum===${OLDALE.num}&&s.world?.layoutId==='${OLDALE.layout}'&&s.activity==='overworld';})()`,
      'C arrives in Oldale', 15000);
    await waitForPeer(a.cdp, cId,
      `m.visible===true&&m.latest?.state?.world?.mapNum===${OLDALE.num}`,
      'A receives C on connected Oldale');
    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
    const oldaleA = await snapshot(a.cdp);
    const cMember = memberFor(oldaleA, cId);
    check('C epoch advances on the map transition', cMember?.epoch > cBefore.self.epoch,
      { before: cBefore.self.epoch, after: cMember?.epoch, members: oldaleA.presence.members.map((member) => ({ playerId: member.playerId, name: member.name, epoch: member.epoch, visible: member.visible })) });
    check('C stays visible across a directly connected border', cMember?.visible === true, cMember);
    check('the connected peer is off screen but still placed',
      (actorFor(oldaleA, cId)?.screenY ?? -1) > 160, actorFor(oldaleA, cId));
    check('Route 103 presenter drops to two remote quads', oldaleA.draw === 2, oldaleA.draw);
    const cOldale = await snapshot(c.cdp);
    check('C sees the Route 103 peers only as off-screen border actors',
      cOldale.mapped.length === 3 && cOldale.mapped.every((actor) => actor.crossBorder), cOldale.mapped);
    check('C places the border peers outside its viewport',
      cOldale.mapped.every((actor) => actor.screenY < 0), cOldale.mapped);
    summary.screenshots.push(await capture(a.cdp, 'map-transition-border'));

    step('verify unconnected maps stay hidden');
    await evaluate(c.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(0,17,10,10);au.runToFrame(au.state().frame+180);return true;})()`);
    await waitFor(c.cdp,
      "(()=>{const au=window.pokeemerald.automation.state();return au.mapNum===17&&window.pokeemerald.presence.state().activity==='overworld';})()",
      'C arrives on Route 102', 15000);
    await waitForPeer(a.cdp, cId,
      `m.visible===false&&m.latest?.state?.world?.mapNum===17`,
      'A receives C on unconnected Route 102');
    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
    const route102A = await snapshot(a.cdp);
    check('an unconnected map stays hidden', actorFor(route102A, cId) === undefined, actorFor(route102A, cId));
    check('an unconnected peer leaves the draw list', route102A.draw === 2, route102A.draw);

    await evaluate(c.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${ROUTE103.group},${ROUTE103.num},10,10);au.runToFrame(au.state().frame+180);return true;})()`);
    await waitFor(c.cdp,
      `(()=>{const s=window.pokeemerald.presence.state();const au=window.pokeemerald.automation.state();return au.mapNum===${ROUTE103.num}&&s.world?.layoutId==='${ROUTE103.layout}'&&s.activity==='overworld';})()`,
      'C returns to Route 103', 15000);
    await waitForPeer(a.cdp, cId,
      `m.visible===true&&m.latest?.state?.world?.mapNum===${ROUTE103.num}`,
      'A receives C back on Route 103');
    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
    const returned = await snapshot(a.cdp);
    check('C reappears after returning to Route 103', memberFor(returned, cId)?.visible === true, memberFor(returned, cId));
    check('Route 103 presenter returns to three remote quads', returned.draw === 3, returned.draw);

    step('verify interior presence for house, Center and Mart');
    for (const room of INTERIORS) {
      await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${room.group},${room.num},4,5);au.runToFrame(au.state().frame+180);return true;})()`);
      await evaluate(c.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${room.group},${room.num},6,5);au.runToFrame(au.state().frame+180);return true;})()`);
      const insideProbe = `(()=>{const s=window.pokeemerald.presence.state();const au=window.pokeemerald.automation.state();return au.mapGroup===${room.group}&&au.mapNum===${room.num}&&s.activity==='overworld'&&window.pokeemerald.instance.exports.WasmPresenceFieldKind()===2;})()`;
      await waitFor(a.cdp, insideProbe, `A inside the ${room.name}`, 20000);
      await waitFor(c.cdp, insideProbe, `C inside the ${room.name}`, 20000);
      const interiorReady = `m.latest?.state?.world?.mapGroup===${room.group}&&m.latest?.state?.world?.mapNum===${room.num}`;
      await Promise.all([
        waitForPeer(a.cdp, c.playerId, interiorReady, `A receives C inside ${room.name}`),
        waitForPeer(c.cdp, a.playerId, interiorReady, `C receives A inside ${room.name}`),
      ]);
      await evaluate(a.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
      await evaluate(c.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
      await Promise.all([
        waitFor(a.cdp, 'window.pokeemerald.automation.state().flatRemoteDraws>=1', `A composites C inside ${room.name}`),
        waitFor(c.cdp, 'window.pokeemerald.automation.state().flatRemoteDraws>=1', `C composites A inside ${room.name}`),
      ]);
      const roomState = '(()=>{const s=window.pokeemerald.automation.state();return {flat:s.flatRemoteDraws,remote:s.remoteDrawActors,scene:s.sceneKind};})()';
      const aInside = await evaluate(a.cdp, roomState);
      const cInside = await evaluate(c.cdp, roomState);
      check(`A composites C inside the ${room.name}`, aInside.flat >= 1, aInside);
      check(`C composites A inside the ${room.name}`, cInside.flat >= 1, cInside);
      check(`A uses the flat path inside the ${room.name}`, aInside.scene === 0 && aInside.flat >= 1, aInside);
      summary.screenshots.push(await capture(a.cdp, `interior-${room.name}`));
    }
    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${ROUTE103.group},${ROUTE103.num},${PLAYERS[0].tile.x},${PLAYERS[0].tile.y});au.runToFrame(au.state().frame+180);return true;})()`);
    await evaluate(c.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${ROUTE103.group},${ROUTE103.num},10,10);au.runToFrame(au.state().frame+180);return true;})()`);
    await waitFor(a.cdp,
      `(()=>{const s=window.pokeemerald.presence.state();return s.world?.layoutId==='${ROUTE103.layout}'&&s.activity==='overworld';})()`,
      'A returns outdoors', 20000);
    await waitForPeer(a.cdp, cId,
      `actor!==undefined&&m.visible===true&&m.latest?.state?.world?.mapNum===${ROUTE103.num}`,
      'A restores C outdoors after the interior matrix');
    await evaluate(a.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
    const afterInteriors = await snapshot(a.cdp);
    check('outdoor presence restores after leaving interiors',
      actorFor(afterInteriors, cId) !== undefined && afterInteriors.draw === 3,
      { draw: afterInteriors.draw });

    step('verify cross-border peers render in both directions');
    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${ROUTE103.group},${ROUTE103.num},10,21);au.runToFrame(au.state().frame+160);return true;})()`);
    await evaluate(c.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${OLDALE.group},${OLDALE.num},10,0);au.runToFrame(au.state().frame+160);return true;})()`);
    await waitFor(a.cdp,
      `(()=>{const s=window.pokeemerald.presence.state();return s.world?.mapNum===${ROUTE103.num};})()`,
      'A waits on the Route 103 border', 20000);
    await waitFor(c.cdp,
      `(()=>{const s=window.pokeemerald.presence.state();return s.world?.mapNum===${OLDALE.num};})()`,
      'C stands in Oldale', 20000);
    await waitForPeer(a.cdp, cId,
      'actor?.crossBorder===true',
      'A renders C across the south border');
    await evaluate(a.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
    const borderA = await snapshot(a.cdp);
    const borderActor = actorFor(borderA, cId);
    check('A renders the peer across the south border', borderActor?.crossBorder === true, borderActor);
    check('cross-border peer is one tile below the local footpoint',
      borderActor?.screenX === borderA.selfScreen?.x
        && borderActor?.screenY === borderA.selfScreen?.y + 16, borderActor);
    summary.screenshots.push(await capture(a.cdp, 'cross-border-south'));

    await evaluate(c.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${OLDALE.group},${OLDALE.num},10,15);au.runToFrame(au.state().frame+160);return true;})()`);
    await waitForPeer(a.cdp, cId,
      `m.latest?.state?.world?.mapNum===${OLDALE.num}&&Number.isFinite(m.latest?.state?.pose?.yPx)&&(actor===undefined||actor.screenY>160)`,
      'A receives C at the far Oldale border');
    await evaluate(a.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
    const farBorder = await snapshot(a.cdp);
    const farActor = actorFor(farBorder, cId);
    check('distant cross-border peer is off screen', farActor === undefined || farActor.screenY > 160,
      farActor);
    const crossArrow = await evaluate(a.cdp,
      "(()=>[...document.querySelectorAll('.remote-arrow')].map((el)=>el.textContent).filter((text)=>text.includes('Brock')))()");
    check('cross-border peers never produce edge arrows', crossArrow.length === 0, crossArrow);

    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${OLDALE.group},${OLDALE.num},10,0);au.runToFrame(au.state().frame+160);return true;})()`);
    await evaluate(c.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${ROUTE103.group},${ROUTE103.num},10,21);au.runToFrame(au.state().frame+160);return true;})()`);
    await waitForPeer(c.cdp, a.playerId,
      'actor?.crossBorder===true',
      'C renders A across the reverse border');
    await evaluate(c.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
    const borderC = await snapshot(c.cdp);
    check('the reverse direction also renders across the border',
      actorFor(borderC, a.playerId)?.crossBorder === true, actorFor(borderC, a.playerId));

    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${ROUTE103.group},${ROUTE103.num},${PLAYERS[0].tile.x},${PLAYERS[0].tile.y});au.runToFrame(au.state().frame+160);return true;})()`);
    await evaluate(c.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${ROUTE103.group},${ROUTE103.num},10,10);au.runToFrame(au.state().frame+160);return true;})()`);
    await waitFor(a.cdp,
      `(()=>{const s=window.pokeemerald.presence.state();return s.world?.mapNum===${ROUTE103.num};})()`,
      'A back on Route 103 after the border trip', 15000);
    await waitFor(a.cdp,
      `(()=>{const m=window.pokeemerald.presence.state().members.find((member)=>member.playerId==='${cId}');return Boolean(m&&m.visible&&m.latest?.state?.world?.mapNum===${ROUTE103.num});})()`,
      'C back on Route 103 after the border trip', 15000);
    await waitForPeer(a.cdp, cId,
      `m.visible===true&&m.latest?.state?.world?.mapNum===${ROUTE103.num}&&actor!==undefined`,
      'A receives C back from the border trip');

    step('verify off-screen peer indicators');
    await evaluate(c.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${ROUTE103.group},${ROUTE103.num},1,1);au.runToFrame(au.state().frame+150);return true;})()`);
    await waitFor(a.cdp,
      `(()=>{const m=window.pokeemerald.presence.state().members.find((member)=>member.playerId==='${cId}');return Boolean(m&&m.visible&&m.latest?.state?.pose&&m.latest.state.pose.xPx<=32);})()`,
      'C reaches the far corner', 10000);
    await waitFor(a.cdp, "document.querySelector('.remote-arrow')?true:null",
      'off-screen peer indicator appears');
    await evaluate(a.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
    const arrow = await evaluate(a.cdp, "(()=>{const el=document.querySelector('.remote-arrow');return el?{text:el.textContent,edge:el.dataset.edge}:null;})()");
    check('off-screen peer shows an edge arrow', Boolean(arrow), { arrow, mapped: (await snapshot(a.cdp)).mapped });
    check('edge arrow carries the peer name', Boolean(arrow && arrow.text.includes('Brock')), arrow);
    check('edge arrow picks a screen edge', ['up', 'left'].includes(arrow?.edge), arrow);
    summary.screenshots.push(await capture(a.cdp, 'offscreen-arrow'));
    await evaluate(c.cdp, `(()=>{const au=window.pokeemerald.automation;au.warp(${ROUTE103.group},${ROUTE103.num},10,10);au.runToFrame(au.state().frame+150);return true;})()`);
    await waitForPeer(a.cdp, cId,
      `actor!==undefined&&m.visible===true&&m.latest?.state?.pose?.xPx===168`,
      'A sees C return from the far corner');

    step('verify unsupported bike and surf states hide a peer');
    for (const mode of ['mach-bike', 'surfing']) {
      await evaluate(d.cdp, `(()=>{const au=window.pokeemerald.automation;au.setAvatar('${mode}');au.runToFrame(au.state().frame+80);return true;})()`);
      await waitFor(d.cdp, `window.pokeemerald.presence.state().activity==='unsupported'`, `D ${mode} unsupported`, 10000);
      await waitForPeer(a.cdp, dId,
        'm.visible===false',
        `A hides D while ${mode}`);
      await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
      const hidden = await snapshot(a.cdp);
      check(`peer hides D while ${mode}`, memberFor(hidden, dId)?.visible === false, memberFor(hidden, dId));
      check(`presenter drops D while ${mode}`, actorFor(hidden, dId) === undefined && hidden.draw === 2, { draw: hidden.draw, mapped: hidden.mapped });
      if (mode === 'mach-bike') summary.screenshots.push(await capture(a.cdp, 'unsupported-bike-hidden'));
      await evaluate(d.cdp, `(()=>{const au=window.pokeemerald.automation;au.setAvatar('on-foot');au.runToFrame(au.state().frame+120);return true;})()`);
      await waitFor(d.cdp, `window.pokeemerald.presence.state().activity!=='unsupported'`, `D ${mode} restore`, 10000);
      await waitForPeer(a.cdp, dId,
        'm.visible===true&&actor!==undefined',
        `A renders D after ${mode}`);
    }
    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
    const restored = await snapshot(a.cdp);
    check('peer restores D after on-foot', actorFor(restored, dId) !== undefined && restored.draw === 3, { draw: restored.draw });

    step('verify background-tab away hides and restores a peer');
    const aId = a.playerId;
    await evaluate(a.cdp, 'window.pokeemerald.presence.setAway(true)');
    await waitFor(a.cdp, `window.pokeemerald.presence.state().activity==='away'`, 'A away state', 5000);
    const awaySelf = await snapshot(a.cdp);
    check('away clears the local pose', awaySelf.self.pose === null, awaySelf.self);
    for (const peer of clients.slice(1)) {
      await waitFor(peer.cdp,
        `(()=>{const p=window.pokeemerald.presence;const actors=p.frameOptions().remoteActors;const s=p.state();const m=s.members.find((member)=>member.playerId==='${aId}');return m&&m.latest?.state?.activity==='away'&&m.visible===false&&actors.length===2?true:null;})()`,
        `${peer.player.key} observes A away`, 10000);
      const awaySnap = await snapshot(peer.cdp);
      check(`${peer.player.key} hides A while away`, memberFor(awaySnap, aId)?.visible === false, memberFor(awaySnap, aId));
      check(`${peer.player.key} drops A from the away draw list`, actorFor(awaySnap, aId) === undefined, awaySnap.mapped);
    }

    await evaluate(a.cdp, 'window.pokeemerald.presence.setAway(false)');
    await waitFor(a.cdp, `window.pokeemerald.presence.state().activity==='overworld'`, 'A visible again', 5000);
    for (const peer of clients.slice(1)) {
      await waitFor(peer.cdp,
        `(()=>{const p=window.pokeemerald.presence;const actors=p.frameOptions().remoteActors;const s=p.state();const m=s.members.find((member)=>member.playerId==='${aId}');return m&&m.visible===true&&actors.length===3?true:null;})()`,
        `${peer.player.key} observes A return`, 10000);
    }
    const backSelf = await snapshot(a.cdp);
    check('A returns with a valid pose', backSelf.self.pose !== null, backSelf.self);
    const backPeer = await snapshot(clients[1].cdp);
    check('A is restored exactly once after away', backPeer.remote.filter((actor) => actor.playerId === aId).length === 1, backPeer.remote);
    summary.screenshots.push(await capture(a.cdp, 'away-restored'));

    step('verify a dropped socket resumes the same player');
    const beforeDrop = await snapshot(a.cdp);
    const beforeGeneration = beforeDrop.presence.generation;
    const beforePlayerId = beforeDrop.presence.playerId;
    const beforeMembers = beforeDrop.presence.members.length;
    check('A has a connection generation before the drop', beforeGeneration > 0, beforeGeneration);
    const dropped = await evaluate(a.cdp, 'window.pokeemerald.presence.simulateDrop()');
    check('simulated drop closes A socket', dropped === true, dropped);
    const resumed = await waitFor(a.cdp,
      `(()=>{const s=window.pokeemerald.presence.state();return s.status==='joined'&&s.generation>${beforeGeneration}?s:null;})()`,
      'A resumes after the socket drop', 20000);
    check('resume keeps the same player id', resumed.playerId === beforePlayerId, { before: beforePlayerId, after: resumed.playerId });
    check('resume keeps the same room', resumed.room === roomCode, { expected: roomCode, actual: resumed.room });
    check('resume increments the generation', resumed.generation > beforeGeneration, { before: beforeGeneration, after: resumed.generation });
    for (const peer of clients.slice(1)) {
      await waitFor(peer.cdp,
        `(()=>{const p=window.pokeemerald.presence;const s=p.state();const m=s.members.find((member)=>member.playerId==='${beforePlayerId}');return s.members.length===${beforeMembers}&&m?.connection==='connected'&&p.frameOptions().remoteActors.length===3?true:null;})()`,
        `${peer.player.key} observes A resume`, 20000);
    }
    const afterDrop = await snapshot(a.cdp);
    const afterDropPeer = await snapshot(clients[1].cdp);
    check('resume does not duplicate A', afterDropPeer.remote.filter((actor) => actor.playerId === beforePlayerId).length === 1, afterDropPeer.remote);
    check('A draws three remote actors after resume', afterDrop.draw === 3, afterDrop.draw);
    summary.screenshots.push(await capture(a.cdp, 'socket-resumed'));

    step('verify leave and rejoin does not duplicate actors');
    await evalLeaveAndCheck(a, clients.slice(1), roomCode, summary);
    await leaveAndRejoin(a, roomCode);
    await Promise.all(clients.map(async (client) => {
      await evaluate(client.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
      await waitForRemoteDrawCount(client.cdp, 3, `${client.player.key} redraws peers after rejoin`);
    }));
    for (const client of clients) {
      await evaluate(client.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
      const snap = await snapshot(client.cdp);
      check(`${client.player.key} has four unique players after rejoin`,
        snap.presence.members.length === 4 && new Set(snap.presence.members.map((member) => member.playerId)).size === 4,
        snap.presence.members.map((member) => member.playerId));
      check(`${client.player.key} draws three actors after rejoin`, snap.draw === 3, snap.draw);
    }

    step('verify presenter recreation keeps presence state');
    const beforeRecreate = await snapshot(a.cdp);
    const recreated = await evaluate(a.cdp, '(async()=>{const au=window.pokeemerald.automation;return await au.simulateDeviceLoss();})()');
    check('presenter recreation was recorded', recreated.presenterRecreations >= 1, recreated);
    check('runtime did not stop on device loss', recreated.runtimeStopped === false, recreated);
    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
    await waitForRemoteDrawCount(a.cdp, 3, 'presenter redraws peers after recreation');
    const afterRecreate = await snapshot(a.cdp);
    check('presence remains joined after presenter recreation', afterRecreate.presence.status === 'joined', afterRecreate.presence.status);
    check('remote actors survive presenter recreation', afterRecreate.mapped.length === 3, afterRecreate.mapped);
    check('presenter redraws three remote quads after recreation', afterRecreate.draw === 3, afterRecreate.draw);
    check('remote draw count did not regress', afterRecreate.draw >= beforeRecreate.draw, { before: beforeRecreate.draw, after: afterRecreate.draw });
    summary.screenshots.push(await capture(a.cdp, 'presenter-recreated'));

    step('verify a battle peer leaves a stationary marker');
    await evaluate(a.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
    const viewerBefore = await snapshot(a.cdp);
    const beforeMarker = actorFor(viewerBefore, dId);
    await evaluate(d.cdp, `(()=>{const au=window.pokeemerald.automation;au.startWildBattle({species:263,level:3});au.runToFrame(au.state().frame + 200);return true;})()`);
    await waitFor(d.cdp, `window.pokeemerald.presence.state().activity==='battle'`, 'D enters a real battle', 25000);
    check('battle peer was visible before the battle', beforeMarker !== undefined, beforeMarker);

    await waitFor(a.cdp,
      `(()=>{const o=window.pokeemerald.presence.frameOptions();return (o.remoteActors||[]).some(x=>x.playerId==='${dId}'&&x.marker==='battle');})()`,
      'A sees a battle marker for D', 20000);
    await evaluate(a.cdp, `(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()`);
    const markerView = await snapshot(a.cdp);
    const markerActor = markerView.mapped.find((actor) => actor.playerId === dId);
    const receivedAnchor = memberFor(markerView, dId)?.battleAnchor;
    check('viewer draws D as a battle marker', markerActor?.marker === 'battle', markerActor);
    check('battle marker stays on the field draw list', markerView.draw === 3, markerView.draw);
    check('battle marker keeps the last field position',
      markerActor?.screenX === beforeMarker?.screenX && markerActor?.screenY === beforeMarker?.screenY,
      { marker: markerActor, before: beforeMarker, anchor: receivedAnchor?.pose });
    const badgeCount = await evaluate(a.cdp, "document.querySelectorAll('.remote-badge').length");
    check('battle badge is visible', badgeCount >= 1, badgeCount);
    summary.screenshots.push(await capture(a.cdp, 'battle-marker'));

    const ended = await evaluate(d.cdp, `(()=>{
      const au = window.pokeemerald.automation;
      const ex = window.pokeemerald.instance.exports;
      const press = (name) => {
        au.setButton(name, true);
        au.runToFrame(au.state().frame + 6);
        au.setButton(name, false);
        au.runToFrame(au.state().frame + 120);
      };
      let presses = 0;
      while (ex.WasmPresenceFieldKind() === 3 && presses < 24) { press('a'); presses++; }
      return { presses, kind: ex.WasmPresenceFieldKind(), activity: ex.WasmPresenceActivity() };
    })()`);
    check('real battle ends back on the field', ended.kind !== 3, ended);
    await waitFor(d.cdp, `window.pokeemerald.presence.state().activity==='overworld'`, 'D returns to the field', 20000);
    await waitFor(a.cdp,
      `(()=>{const o=window.pokeemerald.presence.frameOptions();const a=(o.remoteActors||[]).find(x=>x.playerId==='${dId}');return a&&!a.marker;})()`,
      'A sees D live again', 20000);
    await evaluate(a.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
    const returnedFromBattle = await snapshot(a.cdp);
    const liveActor = actorFor(returnedFromBattle, dId);
    check('battle return replaces the marker with a live actor', Boolean(liveActor) && !liveActor.marker, liveActor);
    check('battle return restores three remote quads', returnedFromBattle.draw === 3, returnedFromBattle.draw);
    summary.screenshots.push(await capture(a.cdp, 'battle-return'));

    await evaluate(d.cdp, `(()=>{const au=window.pokeemerald.automation;au.startWildBattle({species:263,level:3});au.runToFrame(au.state().frame + 200);return true;})()`);
    await waitFor(d.cdp, `window.pokeemerald.presence.state().activity==='battle'`, 'D enters a second battle', 25000);
    await waitFor(a.cdp,
      `(()=>{const o=window.pokeemerald.presence.frameOptions();return (o.remoteActors||[]).some(x=>x.playerId==='${dId}'&&x.marker==='battle');})()`,
      'A sees the second battle marker', 20000);
    await navigateAndReady(d.cdp, d.url);
    await waitFor(a.cdp,
      `(()=>{const s=window.pokeemerald.presence.state();const m=s.members.find(x=>x.playerId==='${dId}');return !m||m.connection!=='connected';})()`,
      'D drops out of the room', 20000);
    await evaluate(a.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
    const clearedMarker = await snapshot(a.cdp);
    check('battle marker clears when the peer drops', actorFor(clearedMarker, dId) === undefined && clearedMarker.draw === 2,
      { draw: clearedMarker.draw, mapped: clearedMarker.mapped });
    summary.screenshots.push(await capture(a.cdp, 'battle-marker-cleared'));

    await evaluate(d.cdp, `window.pokeemerald.presence.joinRoom('${roomCode}')`);
    await waitFor(a.cdp,
      "window.pokeemerald.presence.state().members.filter(m=>m.connection==='connected').length===4",
      'D rejoins the room', 20000);

    step('verify cutscene peers freeze as ghosts');
    await evaluate(a.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
    const beforeScene = await snapshot(a.cdp);
    const beforeSceneActor = actorFor(beforeScene, cId);
    check('cutscene peer is live before the scene', Boolean(beforeSceneActor) && !beforeSceneActor.marker, beforeSceneActor);

    await evaluate(c.cdp, '(()=>{const au=window.pokeemerald.automation;au.presenceCutscene(true);au.runToFrame(au.state().frame+40);return true;})()');
    await waitFor(c.cdp, `window.pokeemerald.presence.state().activity==='cutscene'`, 'C enters a cutscene', 10000);
    await waitFor(a.cdp,
      `(()=>{const o=window.pokeemerald.presence.frameOptions();return (o.remoteActors||[]).some(x=>x.playerId==='${cId}'&&x.marker==='cutscene');})()`,
      'A sees C as a cutscene ghost', 20000);
    await evaluate(a.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
    const sceneView = await snapshot(a.cdp);
    const ghost = actorFor(sceneView, cId);
    check('cutscene peer keeps a frozen ghost', ghost?.marker === 'cutscene' && ghost?.busy === true, ghost);
    check('cutscene ghost stays at the last footpoint',
      ghost?.screenX === beforeSceneActor?.screenX && ghost?.screenY === beforeSceneActor?.screenY,
      { ghost, before: beforeSceneActor });
    const sceneBadges = await evaluate(a.cdp,
      "(()=>[...document.querySelectorAll('.remote-badge')].map((el)=>el.textContent))()");
    check('cutscene badge says In cutscene', sceneBadges.includes('In cutscene'), sceneBadges);
    summary.screenshots.push(await capture(a.cdp, 'cutscene-ghost'));

    await evaluate(c.cdp, '(()=>{const au=window.pokeemerald.automation;au.presenceCutscene(false);au.runToFrame(au.state().frame+80);return true;})()');
    await waitFor(c.cdp, `window.pokeemerald.presence.state().activity==='overworld'`, 'C returns from the cutscene', 10000);
    await waitFor(a.cdp,
      `(()=>{const o=window.pokeemerald.presence.frameOptions();const x=(o.remoteActors||[]).find((actor)=>actor.playerId==='${cId}');return Boolean(x&&!x.marker);})()`,
      'A sees C live after the cutscene', 20000);
    await evaluate(a.cdp, '(()=>{const au=window.pokeemerald.automation;au.runToFrame(au.state().frame+2);return true;})()');
    await waitForRemoteDrawCount(a.cdp, beforeScene.draw, 'live peer draw list restores after cutscene');
    const afterScene = await snapshot(a.cdp);
    const liveAgain = actorFor(afterScene, cId);
    check('cutscene return restores a live peer', Boolean(liveAgain) && !liveAgain.marker, liveAgain);
    check('cutscene return restores the remote draw list',
      afterScene.draw === beforeScene.draw, { before: beforeScene.draw, after: afterScene.draw });

    step('verify room isolation and four-client capacity');
    const fifthCdp = await newPage(browser.browserWs);
    const fifth = { player: { key: 'E', name: 'Fifth' }, cdp: fifthCdp };
    extraClients.push(fifth);
    const fifthParams = new URLSearchParams({
      automate: '1', presence: '1', presenceUrl: room.url, presenceName: 'Fifth',
      saveProfile: 'presence-e2e-e', renderScale: String(RENDER_SCALE), game: GAME_ID,
    });
    await navigateAndReady(fifthCdp, `${web.url}/?${fifthParams}`);
    await evaluate(fifthCdp, `(async()=>{window.pokeemerald.presence.joinRoom('${roomCode}');return true;})()`);
    await waitFor(fifthCdp,
      `(()=>{const e=window.pokeemerald.presence.state().lastError;return e&&e.code==='room_full'?e:null;})()`,
      'fifth client rejected for capacity', 10000);
    const fifthState = await evaluate(fifthCdp, 'window.pokeemerald.presence.state()');
    check('fifth client is rejected with room_full', fifthState.lastError?.code === 'room_full', fifthState.lastError);
    for (const client of clients) {
      const snap = await snapshot(client.cdp);
      check(`${client.player.key} still has four players after capacity rejection`, snap.presence.members.length === 4, snap.presence.members.length);
    }

    await evaluate(fifthCdp, `(async()=>{const p=window.pokeemerald.presence;p.leave();p.createRoom();return true;})()`);
    const secondRoom = await waitFor(fifthCdp,
      `(()=>{const s=window.pokeemerald.presence.state();return s.status==='joined'&&s.room&&s.room!=='${roomCode}'?s.room:null;})()`,
      'second room creation', 10000);
    check('second room has a different code', secondRoom !== roomCode, { first: roomCode, second: secondRoom });
    const firstRoomState = await evaluate(clients[0].cdp, 'window.pokeemerald.presence.state()');
    check('first room is unaffected by second room', firstRoomState.room === roomCode && firstRoomState.members.length === 4,
      { room: firstRoomState.room, members: firstRoomState.members.length });
    summary.secondRoom = secondRoom;

    if (options.soullink) {
      step('start an Emerald SoulLink run and verify linked randomized starters');
      for (const client of clients) {
        await waitFor(client.cdp, "window.pokeemerald.run?.connection==='attached'", `${client.player.key} run channel attached`, 10000);
      }
      await evaluate(clients[1].cdp, 'window.pokeemerald.run.start({})');
      const fullRunStarterChoices = await Promise.all(clients.map((client, index) => chooseStarter(client, index % 3)));
      for (const client of clients) {
        await waitFor(client.cdp, `(()=>{
          const run=window.pokeemerald.run.state();
          const game=window.pokeemerald.automation.state();
          return run?.status==='active'&&game.mapGroup===1&&game.mapNum===4
            &&window.pokeemerald.automation.runParty().length===1;
        })()`, `${client.player.key} quick-started into SoulLink`, 30000);
      }
      const initialRunStates = await Promise.all(clients.map((client) => evaluate(client.cdp, 'window.pokeemerald.run.state()')));
      const initialRunId = initialRunStates[0].runId;
      check('all four players share the server-issued run ID', initialRunStates.every((state) => state.runId === initialRunId), initialRunStates.map((state) => state.runId));
      for (const client of clients) {
        const save = await evaluate(client.cdp, 'window.pokeemerald.automation.runSaveInfo()');
        const party = await evaluate(client.cdp, 'window.pokeemerald.automation.runParty()');
        check(`${client.player.key} uses a valid isolated soulrun save`, save.valid && save.key.endsWith('/soulrun'), save);
        check(`${client.player.key} starts with a level-5 fully randomized starter`, party.length === 1 && party[0].level === 5 && party[0].species > 0, party);
      }
      const starterLinked = await waitFor(clients[0].cdp,
        `window.pokeemerald.run.state().links['link:emerald:gift:starter']?.members.length===4`,
        'all four randomized starter gifts are linked', 15000).catch(async () => ({
        diagnostics: await Promise.all(clients.map((client) => evaluate(client.cdp, `(()=>{
          const s=window.pokeemerald.run.state();
          return {player:s.localPlayerId,revision:s.revision,runId:s.runId,
            members:s.members.map(m=>m.playerId),
            area:s.areas['emerald:gift:starter']??null,
            links:s.links,
            events:s.events.slice(-12)};
        })()`))),
      }));
      check('four clients share one fully linked starter encounter', !starterLinked.diagnostics, starterLinked.diagnostics);
       const starterLink = await evaluate(clients[0].cdp, "window.pokeemerald.run.state().links['link:emerald:gift:starter']");
      check('starter link records four players and their individual species', starterLink.members.length === 4
        && starterLink.members.every((member) => Number.isInteger(member.species)), starterLink.members);
      summary.screenshots.push(await capture(clients[0].cdp, 'soullink-starters'));

      step('verify wipe restart waits for all continuing players to ready');
      await evaluate(clients[0].cdp, 'window.pokeemerald.run.testWipe()');
      await waitFor(clients[1].cdp, "window.pokeemerald.run.state().status==='wipe_pending'", 'wipe state reaches all clients');
      await evaluate(clients[0].cdp, "document.querySelector('#run-ready').click()");
      await waitFor(clients[0].cdp, `(()=>{const s=window.pokeemerald.run.state();return s.status==='wipe_pending'&&s.runId==='${initialRunId}';})()`, 'first readiness does not restart');
      check('one ready player cannot reset the group', (await evaluate(clients[2].cdp, 'window.pokeemerald.run.state().runId')) === initialRunId);
      for (const client of clients.slice(1)) {
        await evaluate(client.cdp, "document.querySelector('#run-ready').click()");
      }
      await waitFor(clients[1].cdp, "document.querySelector('#run-restart').disabled===false", 'host restart control enables after readiness');
      await evaluate(clients[1].cdp, "document.querySelector('#run-restart').click()");
      await waitFor(clients[0].cdp, `(()=>{const s=window.pokeemerald.run.state();const g=window.pokeemerald.automation.state();return s.status==='active'&&s.runId!=='${initialRunId}'&&g.mapGroup===1&&g.mapNum===4&&window.pokeemerald.automation.runParty().length===1;})()`, 'all-ready reset starts the next quick run', 30000);
      const nextStates = await Promise.all(clients.map((client) => waitFor(client.cdp,
        `(()=>{const s=window.pokeemerald.run.state();const g=window.pokeemerald.automation.state();return s.status==='active'&&s.runId!=='${initialRunId}'&&g.mapGroup===1&&g.mapNum===4&&window.pokeemerald.automation.runParty().length===1?s:null;})()`,
        `${client.player.key} restarted into the same new run`, 30000)));
      check('all continuing players received the same new run identity', nextStates.every((state) => state.runId === nextStates[0].runId), nextStates.map((state) => state.runId));
      summary.screenshots.push(await capture(clients[0].cdp, 'soullink-ready-reset'));
    }

    step('verify single-player boot with presence disabled');
    const soloCdp = await newPage(browser.browserWs);
    const solo = { player: { key: 'S', name: 'Solo' }, cdp: soloCdp };
    extraClients.push(solo);
    const soloParams = new URLSearchParams({
      automate: '1',
      saveProfile: 'presence-e2e-solo',
      renderScale: String(RENDER_SCALE),
      view: 'hd2d',
      game: GAME_ID,
    });
    await navigateAndReady(soloCdp, `${web.url}/?${soloParams}`);
    await startPlayer(soloCdp, { key: 'S', tile: { x: 10, y: 8 } });
    const soloBefore = await snapshot(soloCdp);
    check('presence stays disconnected without a room join', soloBefore.presence.status === 'disconnected', soloBefore.presence.status);
    check('presence has no members with presence off', soloBefore.presence.playerCount === 0, soloBefore.presence.playerCount);
    check('single-player world still renders without presence', soloBefore.draw === 0 && soloBefore.state.sceneKind === 1, { draw: soloBefore.draw, scene: soloBefore.state.sceneKind });
    await evaluate(soloCdp, `(()=>{const au=window.pokeemerald.automation;au.setButton('right',true);au.runToFrame(au.state().frame+10);au.setButton('right',false);au.runToFrame(au.state().frame+24);return true;})()`);
    const soloAfter = await snapshot(soloCdp);
    check('single-player movement still works with presence off',
      soloAfter.state.x === 11 && soloAfter.presence.status === 'disconnected',
      { x: soloAfter.state.x, status: soloAfter.presence.status });

    step('verify save-profile ownership guard');
    const duplicateCdp = await newPage(browser.browserWs);
    extraClients.push({ player: { key: 'X', name: 'Duplicate' }, cdp: duplicateCdp });
    const duplicateParams = new URLSearchParams({
      automate: '1',
      saveProfile: PLAYERS[0].profile,
      renderScale: String(RENDER_SCALE),
      game: GAME_ID,
    });
    if (options.soullink) duplicateParams.set('mode', 'soullink');
    const duplicate = await navigateAndWaitForStatus(duplicateCdp, `${web.url}/?${duplicateParams}`, 'open in another tab', 15000);
    check('second tab with the same save profile is blocked', duplicate.hasGame === false, duplicate);
    check('blocked tab explains the profile conflict', duplicate.text.includes('open in another tab'), duplicate.text);
    const firstAfterDuplicate = await evaluate(clients[0].cdp, 'window.pokeemerald.presence.state()');
    check('original tab keeps its room after the blocked duplicate',
      firstAfterDuplicate.status === 'joined' && firstAfterDuplicate.room === roomCode, firstAfterDuplicate);
    duplicateCdp.close();

    step('verify closing the save-profile owner releases the lock');
    try { await clients[0].cdp.send('Page.close'); } catch { /* tab is already gone */ }
    const ownerLockName = `pokeemerald.save-profile:${expectedSaveKey(PLAYERS[0].profile)}`;
    await waitFor(clients[1].cdp, `(async()=>{
      const locks=await navigator.locks.query();
      const isOwnerLock=(lock)=>lock.name===${JSON.stringify(ownerLockName)};
      return !locks.held.some(isOwnerLock)&&!locks.pending.some(isOwnerLock);
    })()`, 'save-profile Web Lock is released', 10000);
    const reacquireCdp = await newPage(browser.browserWs);
    extraClients.push({ player: { key: 'R', name: 'Reacquire' }, cdp: reacquireCdp });
    const reacquireParams = new URLSearchParams({
      automate: '1',
      saveProfile: PLAYERS[0].profile,
      renderScale: String(RENDER_SCALE),
      game: GAME_ID,
    });
    if (options.soullink) reacquireParams.set('mode', 'soullink');
    await navigateAndReady(reacquireCdp, `${web.url}/?${reacquireParams}`);
    const reacquired = await evaluate(reacquireCdp, 'window.pokeemerald.automation.state()');
    check('closing the owner tab releases the save profile',
      reacquired.saveStorageKey === expectedSaveKey(PLAYERS[0].profile),
      reacquired.saveStorageKey);

    step('write summary');
    summary.ok = true;
    summary.completedAt = new Date().toISOString();
    await writeFile(resolve(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    await writeFile(resolve(OUTPUT_DIR, 'console.log'), `${consoleLog.join('\n')}\n`);
    log(`PASS — ${summary.checks.length} checks, ${summary.screenshots.length} screenshots`);
    log(`output: ${OUTPUT_DIR}`);
  } catch (error) {
    summary.ok = false;
    summary.error = error.stack || String(error);
    summary.completedAt = new Date().toISOString();
    try {
      await writeFile(resolve(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
      await writeFile(resolve(OUTPUT_DIR, 'console.log'), `${consoleLog.join('\n')}\n`);
    } catch { /* best effort */ }
    throw error;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    for (const client of [...clients, ...extraClients]) {
      try { client.cdp.close(); } catch { /* ignore */ }
    }
    if (browser?.child && !options.keepBrowser) browser.child.kill();
    if (web?.child) web.child.kill();
    if (room) await room.close();
    if (userDataDir && !options.keepBrowser) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function evalLeaveAndCheck(a, peers, roomCode) {
  await evaluate(a.cdp, '(async()=>{window.pokeemerald.presence.leave();return true;})()');
  await waitFor(a.cdp, 'window.pokeemerald.presence.state().members.length === 0', 'A leaves the room', 10000);
  for (const peer of peers) {
    await waitFor(peer.cdp,
      `(()=>{const p=window.pokeemerald.presence;const s=p.state();return s.members.length===3&&p.frameOptions().remoteActors.length===2;})()`,
      `${peer.player.key} observes A leaving`, 15000);
  }
}

main().catch(async (error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
