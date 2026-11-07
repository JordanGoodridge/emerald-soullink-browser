#!/usr/bin/env node
// Record a fresh SoulLink run through normal UI buttons and browser key events.
// No ?automate=1, debug exports, manual warps or emulated-frame stepping.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer as startRoomService } from '../../../server/src/server.mjs';
import { launchBrowser, newPage, installDiagnostics, navigate, evaluate, waitFor,
  captureScreenshot, delay, stopProcess } from '../../../.agents/skills/multi-client-browser-game-e2e/scripts/cdp-session.mjs';

const gameDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(gameDir, 'build', `live-trailer-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const profiles = resolve(process.env.LOCALAPPDATA || gameDir, 'Temp', 'opencode');
const names = ['Ash', 'Misty', 'Brock', 'Gary'];
const arrows = [
  { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
];

if (!existsSync(resolve(gameDir, 'build/wasm/pokeemerald.wasm'))) {
  throw new Error('Build the WASM game first.');
}
await mkdir(output, { recursive: true });
await mkdir(profiles, { recursive: true });
let room;
let web;
const browsers = [];
const browserProfiles = [];
const pages = [];

async function startWeb() {
  const child = spawn(process.execPath, ['web/server.mjs'], {
    cwd: gameDir, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return await new Promise((resolveStart, reject) => {
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
      if (match) resolveStart({ child, url: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`web server exited: ${code}`)));
  });
}

async function visible(page) {
  // Background tabs must keep publishing position; this does not change game state.
  await evaluate(page, `(()=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
    Object.defineProperty(document,'hidden',{configurable:true,get:()=> false});
    document.dispatchEvent(new Event('visibilitychange'));
    window.pokeemerald.presence.setAway(false);
  })()`);
}

async function key(page, button, down) {
  await page.send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp', key: button.key, code: button.code,
    windowsVirtualKeyCode: button.windowsVirtualKeyCode,
    nativeVirtualKeyCode: button.windowsVirtualKeyCode,
  });
}

try {
  room = await startRoomService({ port: 0, host: '127.0.0.1' });
  web = await startWeb();
  for (let index = 0; index < 4; index++) {
    const profile = await mkdtemp(resolve(profiles, 'poke-live-trailer-'));
    browserProfiles.push(profile);
    const browser = await launchBrowser({ userDataDir: profile,
      extraArgs: ['--window-size=1100,800'] });
    browsers.push(browser);
    const page = await newPage(browser.browserWs);
    pages.push(page);
    await installDiagnostics(page, { onException: (text) => console.error(`[${names[index]}] ${text}`) });
    const params = new URLSearchParams({
      game: 'emerald', mode: 'soullink', pregame: '1', presence: '1',
      presenceUrl: room.url, presenceName: names[index],
      saveProfile: `live-trailer-${index}`, renderScale: '4', view: 'hd2d',
    });
    await navigate(page, `${web.url}/?${params}`);
    await waitFor(page, "window.pokeemerald?.presence&&document.querySelector('#presence-create')&&!document.querySelector('#presence-panel').hidden", `${names[index]} pregame ready`, 60000);
    await visible(page);
    console.log(`${names[index]} ready`);
  }

  await evaluate(pages[0], "document.querySelector('#presence-create').click()");
  const code = await waitFor(pages[0], "(()=>{const s=window.pokeemerald.presence.state();return s.status==='joined'?s.room:null})()", 'host room', 15000);
  for (const page of pages.slice(1)) {
    await evaluate(page, `(()=>{
      const input=document.querySelector('#presence-room');
      input.value=${JSON.stringify(code)};
      input.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#presence-join').click();
    })()`);
  }
  for (const page of pages) await waitFor(page,
    "window.pokeemerald.presence.state().members.length===4", 'four room members', 20000);
  await captureScreenshot(pages[0], resolve(output, 'lobby.png'));

  await evaluate(pages[0], `(()=>{
    for (const id of ['run-randomize-wild','run-randomize-trainers','run-randomize-gyms','run-randomize-starters']) {
      const input=document.querySelector('#'+id);
      if (!input.checked) input.click();
    }
  })()`);
  await captureScreenshot(pages[0], resolve(output, 'settings.png'));
  await waitFor(pages[0], "!document.querySelector('#run-start').disabled", 'host Start run available', 20000);
  await evaluate(pages[0], "document.querySelector('#run-start').click()");
  for (const page of pages) {
    await waitFor(page, "document.querySelector('#starter-choice-dialog').open&&document.querySelectorAll('#starter-choice-list button').length===3", 'starter selection', 30000);
    await evaluate(page, "document.querySelector('#starter-choice-list button').click()");
  }
  for (const page of pages) await waitFor(page,
    "document.body.dataset.soulLinkPregame==='false'&&window.pokeemerald.run.state()?.status==='active'&&!document.querySelector('#starter-choice-dialog').open",
    'normal SoulLink gameplay ready', 60000);
  await pages[0].send('Page.bringToFront');
  const participants = await waitFor(pages[0], `(()=>{
    const presence=window.pokeemerald.presence;
    const actors=presence.frameOptions().remoteActors.length;
    return actors===3?{room:presence.state().room,actors,mode:document.body.dataset.soulLinkPregame}:null;
  })()`, 'three visible players after starting SoulLink', 25000)
    .catch(async (error) => {
      const state = await evaluate(pages[0], `(()=>({
        state:window.pokeemerald.presence.state(),
        actors:window.pokeemerald.presence.frameOptions().remoteActors.length,
        game:window.pokeemerald.run.state()?.status,
        status:document.querySelector('#status')?.textContent,
      }))()`);
      throw new Error(`${error.message}: ${JSON.stringify(state)}`);
    });
  await writeFile(resolve(output, 'session.json'), JSON.stringify({ participants, names, capture: 'real-time canvas; normal UI and CDP keyboard input' }, null, 2));

  // The canvas is recorded in real time; unlike the previous prototype these
  // are not replay screenshots or game frames advanced by an automation hook.
  const recording = await evaluate(pages[0], `(()=>{
    const stream=document.querySelector('#screen').captureStream(15);
    const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error('MediaRecorder has no WebM encoder');
    const chunks=[];
    const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:3500000});
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    window.__liveTrailer={recorder,chunks,stream,mime};
    recorder.start(500);
    return {mime,started:recorder.state};
  })()`);
  console.log('recording', recording);
  for (let cycle = 0; cycle < 8; cycle++) {
    const keys = [arrows[cycle % 2], arrows[(cycle + 1) % 2], arrows[2 + cycle % 2], arrows[3 - cycle % 2]];
    await Promise.all(pages.map((page, i) => key(page, keys[i], true)));
    await delay(1200);
    await Promise.all(pages.map((page, i) => key(page, keys[i], false)));
    await delay(350);
  }
  const result = await evaluate(pages[0], `(async()=>{
    const {recorder,chunks,stream}=window.__liveTrailer;
    await new Promise(resolve=>{recorder.onstop=resolve;recorder.stop()});
    stream.getTracks().forEach(track=>track.stop());
    const blob=new Blob(chunks,{type:recorder.mimeType});
    const data=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob)});
    return {bytes:blob.size,data};
  })()`);
  if (result.bytes < 10000) throw new Error(`No meaningful live video captured (${result.bytes} bytes)`);
  await writeFile(resolve(output, 'gameplay.webm'), Buffer.from(result.data.split(',')[1], 'base64'));
  console.log(`Saved real-time gameplay: ${output}/gameplay.webm (${result.bytes} bytes)`);

  await evaluate(pages[0], "document.querySelector('#menu-toggle').click();document.querySelector('#game-menu-party').click()");
  await captureScreenshot(pages[0], resolve(output, 'party.png'));
  await evaluate(pages[0], "document.querySelector('#party-panel .party-run-tracker')?.scrollIntoView({block:'start'})");
  await captureScreenshot(pages[0], resolve(output, 'tracker.png'));
  console.log('DONE', output);
} finally {
  for (const page of pages) try { page.close(); } catch { /* closed */ }
  for (const browser of browsers) await browser.close();
  await stopProcess(web?.child);
  if (room) await room.close();
  for (const profile of browserProfiles) await rm(profile, { recursive: true, force: true });
}
