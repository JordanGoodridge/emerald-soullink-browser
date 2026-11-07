#!/usr/bin/env node
// Interactive four-player presence launcher.
//
// Starts a private room relay and static web server, opens one real Chrome
// window with N tabs, creates a room in the first tab, joins the rest, and
// (by default) starts each player on Route 103 so they can walk around
// together immediately.
//
// Usage:
//   node tools/presence_launcher.mjs [--count 2..4] [--names A,B,C,D]
//        [--profile-prefix play-] [--profile-dir DIR] [--no-demo]
//        [--game=game-id] [--build|--no-build] [--headless] [--smoke]
//
// Run from pokeemerald-3d/ (the script also works from the repository root).
// Press Ctrl+C to stop the relay, web server and browser.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startServer as startRoomService } from '../../server/src/server.mjs';
import { normalizeName } from '../web/presence/protocol.mjs';

const GAME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(GAME_ROOT);

const ROUTE103 = { group: 0, num: 18, layout: 'layout_13' };
const START_TILES = [
  { x: 10, y: 8 },
  { x: 12, y: 8 },
  { x: 10, y: 10 },
  { x: 12, y: 10 },
];
const DEFAULT_NAMES = ['Ash', 'Misty', 'Brock', 'Gary'];
const MAX_PLAYERS = 4;

function usage(exitCode = 2, error = null) {
  if (error) console.error(`error: ${error}`);
  console.error(`usage: node tools/presence_launcher.mjs [options]

  --count N              players to launch (2-4, default 4)
  --names A,B,C,D        display names (default Ash,Misty,Brock,Gary)
  --profile-prefix P     save-profile prefix (default play-)
  --profile-dir DIR      persistent Chrome profile; saves survive restarts
  --game ID              installed game id (default: Emerald)
  --no-demo              do not start a new game; leave clients at the title
  --build                rebuild the WASM before launching
  --no-build             fail instead of building when the WASM is missing
  --headless             run Chrome headless (for smoke testing)
  --smoke                verify the session, then exit 0
  -h, --help             show this help`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    count: MAX_PLAYERS,
    names: null,
    profilePrefix: 'play-',
    profileDir: null,
    demo: true,
    demoExplicit: false,
    build: null,
    headless: false,
    smoke: false,
    game: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--count') options.count = Number(argv[++index]);
    else if (arg === '--names') options.names = String(argv[++index] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
    else if (arg === '--profile-prefix') options.profilePrefix = String(argv[++index] ?? '');
    else if (arg === '--profile-dir') options.profileDir = String(argv[++index] ?? '');
    else if (arg === '--no-demo') { options.demo = false; options.demoExplicit = true; }
    else if (arg === '--demo') { options.demo = true; options.demoExplicit = true; }
    else if (arg === '--build') options.build = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--smoke') options.smoke = true;
    else if (arg.startsWith('--game=')) options.game = arg.slice('--game='.length);
    else if (arg === '--help' || arg === '-h') usage(0);
    else usage(2, `unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.count) || options.count < 2 || options.count > MAX_PLAYERS) {
    usage(2, `--count must be an integer from 2 to ${MAX_PLAYERS} (the room limit)`);
  }
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(options.profilePrefix)) {
    usage(2, '--profile-prefix must be 1-20 characters of A-Z, a-z, 0-9, _ or -');
  }
  if (options.names && options.names.length > options.count) {
    usage(2, `--names has ${options.names.length} names but --count is ${options.count}`);
  }
  if (options.profileDir && !options.demoExplicit) options.demo = false;

  const names = [];
  for (let index = 0; index < options.count; index += 1) {
    const requested = options.names?.[index] ?? DEFAULT_NAMES[index] ?? `Player ${index + 1}`;
    const normalized = normalizeName(requested);
    if (!normalized) usage(2, `invalid display name: ${requested}`);
    names.push(normalized);
  }
  options.names = names;
  options.profiles = names.map((_, index) => `${options.profilePrefix}${index + 1}`);
  return options;
}

function log(message) {
  console.log(`[play] ${message}`);
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
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Chrome/Chromium/Edge not found; set CHROME_BIN to a browser executable');
  return found;
}

function run(command, args, { cwd = GAME_ROOT } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function buildWasm() {
  if (process.platform === 'win32') {
    await run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', resolve(GAME_ROOT, '..', 'build-wasm.ps1')]);
  } else {
    await run('make', ['wasm']);
  }
}

async function startWebServer() {
  const child = spawn(process.execPath, ['web/server.mjs'], {
    cwd: GAME_ROOT,
    env: { ...process.env, PORT: '0' },
  });
  return await withTimeout(new Promise((resolveStart, reject) => {
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
      if (match) resolveStart({ child, url: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[web] ${chunk}`));
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`web server exited before ready with ${code}`)));
  }), 15000, 'starting wasm web server');
}

async function startBrowser(userDataDir, { headless }) {
  const args = [
    headless ? '--headless=new' : '--new-window',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-unsafe-webgpu',
    '--window-size=1280,900',
    'about:blank',
  ];
  const child = spawn(browserPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return await withTimeout(new Promise((resolveStart, reject) => {
    child.stderr.on('data', (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolveStart({ child, browserWs: match[1] });
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`browser exited before ready with ${code}`)));
  }), 20000, 'starting Chrome');
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

async function navigate(cdp, url) {
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  cdp.on('Runtime.exceptionThrown', (params) => {
    const text = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text;
    if (text) process.stderr.write(`[page exception] ${text}\n`);
  });
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp, 'Boolean(window.pokeemerald?.presence?.createRoom)', 'presence API', 30000);
}

// Only one tab in a one-window demo can be foregrounded. Keep every client
// treated as visible so the background players do not publish `away`.
async function forceVisible(cdp) {
  await evaluate(cdp, `(()=>{
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    } catch { /* ignore */ }
    window.pokeemerald.presence.setAway(false);
    return true;
  })()`);
}

async function startDemoPlayer(cdp, tile) {
  await evaluate(cdp, `(()=>{
    const game = window.pokeemerald;
    game.instance.exports.WasmStartNewGameForAutomation();
    game.runFrames(120);
    const e = game.instance.exports;
    e.SetWarpDestination(${ROUTE103.group}, ${ROUTE103.num}, -1, ${tile.x}, ${tile.y});
    e.DoWarp();
    e.ResetInitialPlayerAvatarState();
    game.runFrames(180);
    game.presence.tick();
    return true;
  })()`);
  try {
    await waitFor(cdp, `(()=>{
      const s = window.pokeemerald.presence.state();
      return s.activity === 'overworld' && s.world?.layoutId === '${ROUTE103.layout}';
    })()`, 'player on Route 103', 25000);
  } catch (error) {
    const state = await evaluate(cdp, `(()=>{
      const s = window.pokeemerald.presence.state();
      return { status: s.status, activity: s.activity, world: s.world, pose: s.pose, lastError: s.lastError };
    })()`);
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  if (process.platform === 'win32' && child.pid) {
    return new Promise((resolveKill) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('exit', resolveKill);
      killer.on('error', resolveKill);
    });
  }
  child.kill();
  return Promise.resolve();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const wasmPath = resolve(GAME_ROOT, 'build', 'wasm', 'pokeemerald.wasm');
  if (!existsSync(wasmPath) && options.build === false) {
    throw new Error(`missing ${wasmPath}; run build-wasm.ps1 first`);
  }
  if (options.build === true || (options.build === null && !existsSync(wasmPath))) {
    log('building WASM (first launch can take a few minutes)');
    await buildWasm();
  }
  if (!existsSync(wasmPath)) throw new Error(`missing ${wasmPath}; run build-wasm.ps1 first`);

  let browser = null;
  let web = null;
  let room = null;
  let userDataDir = null;
  const clients = [];
  let shuttingDown = false;

  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const client of clients) {
      try { client.cdp.close(); } catch { /* ignore */ }
    }
    await killProcessTree(browser?.child);
    await killProcessTree(web?.child);
    try { await room?.close(); } catch { /* ignore */ }
    if (userDataDir && !options.profileDir) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
    process.exit(code);
  };
  process.on('SIGINT', () => { log('stopping'); shutdown(0); });
  process.on('SIGTERM', () => shutdown(0));

  try {
    log(`starting relay and web server for ${options.count} players`);
    room = await startRoomService({
      port: 0,
      host: '127.0.0.1',
      log: { log: (line) => log(`relay: ${line}`), error: (line, error) => log(`relay error: ${line} ${error || ''}`) },
    });
    web = await startWebServer();

    if (options.profileDir) {
      userDataDir = resolve(options.profileDir);
      await mkdir(userDataDir, { recursive: true });
    } else {
      userDataDir = await mkdtemp(resolve(tmpdir(), 'pokeemerald-play-'));
    }
    browser = await startBrowser(userDataDir, { headless: options.headless });
    browser.child.on('exit', () => { if (!shuttingDown) { log('browser closed'); shutdown(0); } });

    const baseParams = (index) => new URLSearchParams({
      presence: '1',
      presenceUrl: room.url,
      presenceName: options.names[index],
      saveProfile: options.profiles[index],
      renderScale: '4',
      view: 'hd2d',
      game: options.game || 'emerald',
    });

    log('opening host tab');
    const hostCdp = await newPage(browser.browserWs);
    clients.push({ name: options.names[0], profile: options.profiles[0], cdp: hostCdp });
    await navigate(hostCdp, `${web.url}/?${baseParams(0)}`);
    await forceVisible(hostCdp);
    await evaluate(hostCdp, '(async()=>{window.pokeemerald.presence.createRoom();return true;})()');
    const roomCode = await waitFor(hostCdp,
      `(()=>{const s=window.pokeemerald.presence.state();return s.status==='joined'&&s.room?s.room:null;})()`,
      'room creation', 15000);
    log(`room ${roomCode}`);

    log(`opening ${options.count - 1} guest tab${options.count === 2 ? '' : 's'}`);
    for (let index = 1; index < options.count; index += 1) {
      const cdp = await newPage(browser.browserWs);
      clients.push({ name: options.names[index], profile: options.profiles[index], cdp });
      await navigate(cdp, `${web.url}/?${baseParams(index)}`);
      await forceVisible(cdp);
      await evaluate(cdp, `(async()=>{window.pokeemerald.presence.joinRoom('${roomCode}');return true;})()`);
    }

    for (const client of clients) {
      await waitFor(client.cdp,
        `(()=>{const s=window.pokeemerald.presence.state();return s.status==='joined'&&s.room==='${roomCode}'&&s.members.length===${options.count};})()`,
        `${client.name} joined the room`, 25000);
      log(`${client.name} joined (profile ${client.profile})`);
    }

    if (options.demo) {
      log('starting new games on Route 103');
      await Promise.all(clients.map((client, index) => startDemoPlayer(client.cdp, START_TILES[index])));
      for (const client of clients) {
        await waitFor(client.cdp,
          `(()=>{const p=window.pokeemerald.presence;return p.frameOptions().remoteActors.length===${options.count - 1};})()`,
          `${client.name} sees ${options.count - 1} remote player(s)`, 25000);
      }
    }

    log('');
    log(`room code: ${roomCode}`);
    log(`game:      ${web.url}`);
    log(`relay:     ${room.url}`);
    log(`players:   ${clients.map((client) => client.name).join(', ')}`);
    log(options.demo
      ? 'all players are on Route 103 — switch tabs and walk around.'
      : 'clients are connected; load or start a game in each tab.');
    log('press Ctrl+C to stop the servers and close the browser.');

    if (options.smoke) {
      log('smoke check passed');
      await shutdown(0);
      return;
    }
    await new Promise(() => {});
  } catch (error) {
    console.error(error.stack || String(error));
    await shutdown(1);
  }
}

main();
