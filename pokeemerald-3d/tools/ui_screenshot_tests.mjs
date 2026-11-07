#!/usr/bin/env node
// Small dependency-free visual smoke suite for the real browser UI.
// Run with --update only when intentionally approving new screenshot baselines.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const baselineDir = resolve(root, 'web/ui/screenshot-baselines');
const outputDir = resolve(root, 'ui-screenshot-output');
const update = process.argv.includes('--update');
const cases = [
  { name: 'library.desktop', url: '/?library=1', width: 1280, height: 900, ready: "document.querySelectorAll('#library-games .library-card').length > 0", assert: "document.querySelector('#library-title')?.textContent === 'Library'", ignore: '.library-cover img' },
  { name: 'library.mobile', url: '/?library=1', width: 390, height: 844, ready: "document.querySelectorAll('#library-games .library-card').length > 0", assert: "document.querySelector('#library-title')?.textContent === 'Library'", ignore: '.library-cover img' },
  { name: 'run-mode.desktop', url: '/?library=1', width: 1280, height: 900, ready: "document.querySelectorAll('#library-games .library-card').length > 0", setup: "document.querySelector('#library-games .library-card')?.click()", after: "document.querySelector('#run-mode-dialog')?.open === true", assert: "document.querySelectorAll('#run-mode-dialog [data-run-mode]:not([hidden])').length === 2", clip: '#run-mode-dialog' },
  { name: 'run-mode.mobile', url: '/?library=1', width: 390, height: 844, ready: "document.querySelectorAll('#library-games .library-card').length > 0", setup: "document.querySelector('#library-games .library-card')?.click()", after: "document.querySelector('#run-mode-dialog')?.open === true", assert: "document.querySelectorAll('#run-mode-dialog [data-run-mode]:not([hidden])').length === 2", clip: '#run-mode-dialog' },
  { name: 'saved-runs.desktop', url: '/?library=1', width: 1280, height: 900, ready: "document.querySelectorAll('#library-games .library-card').length > 0", setup: "document.documentElement.dataset.boot='play';document.body.dataset.mode='play';document.querySelector('#play-shell').hidden=false;const panel=document.querySelector('#presence-panel');panel.hidden=false;panel.querySelector('#presence-default-head').hidden=true;panel.querySelector('#soul-link-pregame-header').hidden=false;panel.querySelector('#soullink-saved-lobbies').hidden=false;const list=panel.querySelector('#soullink-saved-lobby-list');list.replaceChildren(...['Jordan + Micky','Jordan + Micky'].map(name=>{const li=document.createElement('li');li.className='soullink-saved-lobby-item';li.innerHTML='<div class=\"soullink-saved-lobby-info\"><strong>'+name+'</strong><small>Seed 1443768173 · 2/2 player saves · Saved 10/25/26, 12:41 AM</small></div><button type=\"button\" class=\"saved-lobby-resume\">Resume</button><button type=\"button\" class=\"saved-lobby-delete\">Delete</button>';return li}));panel.querySelectorAll(':scope > .presence-fields,:scope > .presence-actions,:scope > .presence-roster,:scope > .presence-hint,:scope > .presence-run-mode-note,:scope > .presence-run-settings,:scope > .presence-lobby-save').forEach(el=>el.hidden=true)", assert: "document.querySelectorAll('#soullink-saved-lobby-list .soullink-saved-lobby-item > button').length === 4", clip: '#presence-panel' },
  { name: 'saved-runs.mobile', url: '/?library=1', width: 390, height: 844, ready: "document.querySelectorAll('#library-games .library-card').length > 0", setup: "document.documentElement.dataset.boot='play';document.body.dataset.mode='play';document.querySelector('#play-shell').hidden=false;const panel=document.querySelector('#presence-panel');panel.hidden=false;panel.querySelector('#presence-default-head').hidden=true;panel.querySelector('#soul-link-pregame-header').hidden=false;panel.querySelector('#soullink-saved-lobbies').hidden=false;const list=panel.querySelector('#soullink-saved-lobby-list');list.replaceChildren(...['Jordan + Micky','Jordan + Micky'].map(name=>{const li=document.createElement('li');li.className='soullink-saved-lobby-item';li.innerHTML='<div class=\"soullink-saved-lobby-info\"><strong>'+name+'</strong><small>Seed 1443768173 · 2/2 player saves · Saved 10/25/26, 12:41 AM</small></div><button type=\"button\" class=\"saved-lobby-resume\">Resume</button><button type=\"button\" class=\"saved-lobby-delete\">Delete</button>';return li}));panel.querySelectorAll(':scope > .presence-fields,:scope > .presence-actions,:scope > .presence-roster,:scope > .presence-hint,:scope > .presence-run-mode-note,:scope > .presence-run-settings,:scope > .presence-lobby-save').forEach(el=>el.hidden=true)", assert: "document.querySelectorAll('#soullink-saved-lobby-list .soullink-saved-lobby-item > button').length === 4", clip: '#presence-panel' },
  { name: 'settings.desktop', url: '/?library=1', width: 1280, height: 900, ready: "document.querySelectorAll('#library-games .library-card').length > 0", setup: "document.querySelector('#library-settings')?.click()", after: "document.querySelector('#settings-dialog')?.open === true", assert: "document.querySelectorAll('#settings-dialog .settings-group').length > 0", clip: '#settings-dialog' },
  { name: 'settings.mobile', url: '/?library=1', width: 390, height: 844, ready: "document.querySelectorAll('#library-games .library-card').length > 0", setup: "document.querySelector('#library-settings')?.click()", after: "document.querySelector('#settings-dialog')?.open === true", assert: "document.querySelectorAll('#settings-dialog .settings-group').length > 0", clip: '#settings-dialog' },
  { name: 'game-menu.desktop', url: '/?library=1', width: 1280, height: 900, ready: "document.querySelectorAll('#library-games .library-card').length > 0", setup: "document.documentElement.dataset.boot='play';document.querySelector('#play-shell').hidden=false;document.querySelector('#game-menu')?.showModal()", after: "document.querySelector('#game-menu')?.open === true", assert: "document.querySelectorAll('#game-menu .game-menu-actions button').length >= 5", clip: '#game-menu' },
  { name: 'game-menu.mobile', url: '/?library=1', width: 390, height: 844, ready: "document.querySelectorAll('#library-games .library-card').length > 0", setup: "document.documentElement.dataset.boot='play';document.querySelector('#play-shell').hidden=false;document.querySelector('#game-menu')?.showModal()", after: "document.querySelector('#game-menu')?.open === true", assert: "document.querySelectorAll('#game-menu .game-menu-actions button').length >= 5", clip: '#game-menu' },
  { name: 'save-profile.desktop', url: '/?library=1', width: 1280, height: 900, ready: "document.querySelectorAll('#library-games .library-card').length > 0", setup: "document.documentElement.dataset.boot='play';document.querySelector('#play-shell').hidden=false;document.querySelector('#save-profile-dialog')?.showModal()", after: "document.querySelector('#save-profile-dialog')?.open === true", assert: "!!document.querySelector('#save-profile-dialog .save-time-status') && !!document.querySelector('#save-profile-dialog #save-game-now')", clip: '#save-profile-dialog' },
  { name: 'save-profile.mobile', url: '/?library=1', width: 390, height: 844, ready: "document.querySelectorAll('#library-games .library-card').length > 0", setup: "document.documentElement.dataset.boot='play';document.querySelector('#play-shell').hidden=false;document.querySelector('#save-profile-dialog')?.showModal()", after: "document.querySelector('#save-profile-dialog')?.open === true", assert: "!!document.querySelector('#save-profile-dialog .save-time-status') && !!document.querySelector('#save-profile-dialog #save-game-now')", clip: '#save-profile-dialog' },
  { name: 'party.desktop', url: '/web/demo/party-panel.html?links=1', width: 1280, height: 900, ready: "document.querySelector('#party-panel')?.open === true", assert: "!!document.querySelector('#party-panel.themed-dialog:modal .party-links') && !!document.querySelector('.party-panel-form')", clip: '#party-panel' },
  { name: 'party.mobile', url: '/web/demo/party-panel.html?links=1', width: 390, height: 844, ready: "document.querySelector('#party-panel')?.open === true", assert: "!!document.querySelector('#party-panel.themed-dialog:modal .party-links') && !!document.querySelector('.party-panel-form')", clip: '#party-panel' },
  { name: 'run-tracker.desktop', url: '/web/demo/run-tracker.html', width: 1280, height: 900, ready: "document.documentElement.dataset.ready === 'true'", assert: "!!document.querySelector('#run-tracker-dialog.run-tracker-dialog:modal .run-tracker-current') && document.querySelectorAll('.run-tracker-list li').length >= 4", clip: '#run-tracker-dialog' },
  { name: 'run-tracker.mobile', url: '/web/demo/run-tracker.html', width: 390, height: 844, ready: "document.documentElement.dataset.ready === 'true'", assert: "!!document.querySelector('#run-tracker-dialog.run-tracker-dialog:modal .run-tracker-current') && document.querySelectorAll('.run-tracker-list li').length >= 4", clip: '#run-tracker-dialog' },
];

function chromePath() {
  const paths = [process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const path = paths.find(existsSync);
  if (!path) throw new Error('Chrome/Chromium not found; set CHROME_BIN');
  return path;
}

class Cdp {
  #id = 0; #pending = new Map();
  constructor(url) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolveReady, reject) => {
      this.socket.addEventListener('open', resolveReady, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data), pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.#id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return await new Promise((resolveSend, reject) => this.#pending.set(id, { resolve: resolveSend, reject }));
  }
  close() { this.socket.close(); }
}

function waitForLine(child, regex, label) {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out starting ${label}`)), 12000);
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(regex);
      if (match) { clearTimeout(timer); resolveReady(match); }
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`${label} exited early (${code})`)));
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise((resolveDone) => killer.once('exit', resolveDone));
  } else {
    child.kill('SIGTERM');
  }
  await new Promise((resolveDone) => child.once('close', resolveDone));
}

async function waitFor(cdp, expression, label) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (await evaluate(cdp, expression)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function comparePng(cdp, expected, actual, ignoredRects = []) {
  const a = expected.toString('base64'), b = actual.toString('base64');
  const ignore = JSON.stringify(ignoredRects);
  return await evaluate(cdp, `(() => {
    const load = (src) => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
    return Promise.all([load('data:image/png;base64,${a}'), load('data:image/png;base64,${b}')]).then(([a,b]) => {
      if (a.width !== b.width || a.height !== b.height) return { ratio: 1, reason: 'dimensions changed' };
      const c = document.createElement('canvas'); c.width = a.width; c.height = a.height;
      const x = c.getContext('2d', {willReadFrequently:true}); x.drawImage(a,0,0); const p=x.getImageData(0,0,c.width,c.height).data;
      x.clearRect(0,0,c.width,c.height); x.drawImage(b,0,0); const q=x.getImageData(0,0,c.width,c.height).data;
      const diff=x.createImageData(c.width,c.height); let n=0, skipped=0;
      for(let i=0;i<p.length;i+=4) {
        const pixel=i/4, px=pixel%c.width, py=Math.floor(pixel/c.width);
        if (${ignore}.some(r=>px>=r.x&&px<r.x+r.width&&py>=r.y&&py<r.y+r.height)) { skipped++; diff.data[i]=q[i]*0.35; diff.data[i+1]=q[i+1]*0.35; diff.data[i+2]=q[i+2]*0.35; diff.data[i+3]=255; continue; }
        const changed=Math.abs(p[i]-q[i])>16||Math.abs(p[i+1]-q[i+1])>16||Math.abs(p[i+2]-q[i+2])>16;
        if(changed) { n++; diff.data[i]=255; diff.data[i+1]=32; diff.data[i+2]=96; diff.data[i+3]=255; }
        else { diff.data[i]=q[i]*0.35; diff.data[i+1]=q[i+1]*0.35; diff.data[i+2]=q[i+2]*0.35; diff.data[i+3]=255; }
      }
      x.putImageData(diff,0,0);
      return {ratio:n/(a.width*a.height-skipped), changed:n, diff:x.canvas.toDataURL('image/png')};
    });
  })()`);
}

async function main() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  if (update) await mkdir(baselineDir, { recursive: true });
  const profile = await mkdtemp(resolve(tmpdir(), 'pokeemerald-ui-'));
  let server, browser;
  const results = [];
  try {
    server = spawn(process.execPath, ['web/server.mjs'], { cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
    const serverMatch = await waitForLine(server, /http:\/\/localhost:(\d+)/, 'web server');
    const url = `http://localhost:${serverMatch[1]}`;
    browser = spawn(chromePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsMatch = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out starting Chrome DevTools')), 12000);
      browser.stderr.on('data', (chunk) => {
        const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolveReady(match[1]); }
      });
      browser.once('error', reject);
      browser.once('exit', (code) => reject(new Error(`Chrome exited early (${code})`)));
    });
    for (const test of cases) {
      const endpoint = new URL(wsMatch);
      const target = await (await fetch(`http://${endpoint.host}/json/new`, { method: 'PUT' })).json();
      const cdp = new Cdp(target.webSocketDebuggerUrl);
      try {
        await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: test.width, height: test.height, deviceScaleFactor: 1, mobile: test.width < 500 });
        await cdp.send('Page.navigate', { url: `${url}${test.url}` });
        await waitFor(cdp, test.ready, `${test.name} to render`);
        if (test.setup) await evaluate(cdp, test.setup);
        if (test.after) await waitFor(cdp, test.after, `${test.name} state`);
        if (test.clip) await evaluate(cdp, 'document.activeElement?.blur()');
        if (!await evaluate(cdp, test.assert)) throw new Error(`${test.name}: content assertion failed`);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'none' });
        await evaluate(cdp, `document.documentElement.insertAdjacentHTML('beforeend','<style>*,:before,:after{animation:none!important;transition:none!important;caret-color:transparent!important}.library-card.pixel-frame:hover,.library-card.pixel-frame:focus-visible{transform:none!important;filter:none!important}</style>'); (async()=>{await document.fonts.ready; const images=[...document.images]; images.forEach(i=>i.loading='eager'); await Promise.all(images.map(i=>i.complete?Promise.resolve():new Promise(r=>{i.addEventListener('load',r,{once:true});i.addEventListener('error',r,{once:true})}))); await Promise.all(images.map(i=>i.decode().catch(()=>{}))); await new Promise(requestAnimationFrame)})()`);
        const params = { format: 'png', fromSurface: true };
        if (test.clip) {
          const rect = await evaluate(cdp, `(() => { const {x,y,width,height}=document.querySelector(${JSON.stringify(test.clip)}).getBoundingClientRect(); return {x,y,width,height}; })()`);
          if (rect.width <= 0 || rect.height <= 0) throw new Error(`${test.name}: screenshot target ${test.clip} has zero size`);
          params.clip = { ...rect, scale: 1 };
          params.captureBeyondViewport = true;
        }
        const { data } = await cdp.send('Page.captureScreenshot', params);
        const actual = Buffer.from(data, 'base64'), name = `${test.name}.png`;
        await writeFile(resolve(outputDir, name), actual);
        const baseline = resolve(baselineDir, name);
        if (update) { await writeFile(baseline, actual); results.push(`${test.name}: baseline updated`); }
        else {
          let expected;
          try { expected = await readFile(baseline); }
          catch { throw new Error(`${test.name}: baseline missing; run node tools/ui_screenshot_tests.mjs --update`); }
          const ignoredRects = test.ignore ? await evaluate(cdp, `([...document.querySelectorAll(${JSON.stringify(test.ignore)})].map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}}))`) : [];
          const diff = await comparePng(cdp, expected, actual, ignoredRects);
          if (diff.reason || diff.ratio > 0.002) {
            if (diff.diff) await writeFile(resolve(outputDir, `${test.name}.diff.png`), Buffer.from(diff.diff.split(',')[1], 'base64'));
            throw new Error(`${test.name}: ${diff.reason ?? `${(diff.ratio * 100).toFixed(2)}% pixels differ`}; actual and diff at ${outputDir}`);
          }
          results.push(`${test.name}: passed`);
        }
      } finally { cdp.close(); }
    }
    console.log(results.join('\n'));
    console.log(`${update ? 'Baselines' : 'Screenshots'}: ${update ? baselineDir : outputDir}`);
  } finally {
    await stop(browser); await stop(server);
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
