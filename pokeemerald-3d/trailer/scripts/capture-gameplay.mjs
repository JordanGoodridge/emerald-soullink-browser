#!/usr/bin/env node
import {copyFile, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import process from 'node:process';

const trailerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(trailerDir, '..');
const tmpDir = resolve(repoDir, 'build/capture-battle-pyramid');
const replayOutput = resolve(tmpDir, 'replay');
const generatedRoute = resolve(tmpDir, 'route.txt');
const frameDir = resolve(tmpDir, 'frames');
const output = resolve(trailerDir, 'public/gameplay/walking.mp4');
const readmeOutput = resolve(trailerDir, 'public/gameplay/walking-readme.mp4');
const noBuild = process.argv.includes('--no-build');
const seconds = 12;
const fps = 30;
const renderScale = 8;
const visualSettings = {shading: 0.50, perspective: 0.50, zoom: 1.00};

const run = (command, args, cwd = repoDir) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, {cwd, stdio: 'inherit'});
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)));
});

await rm(tmpDir, {recursive: true, force: true});
await mkdir(frameDir, {recursive: true});

const basePath = resolve(repoDir, 'tools/wasm_replays/hd2d_world_views.txt');
const base = (await readFile(basePath, 'utf8'))
  .split(/\r?\n/)
  .filter((line) => !/^\s*\d+\s+(screenshot|probe)\b/.test(line))
  .join('\n');
const frameMatches = [...base.matchAll(/^\s*(\d+)\s+/gm)].map((match) => Number(match[1]));
const setup = Math.max(...frameMatches) + 120;
const start = setup + 120;
const sampleCount = seconds * fps;
const transitionSampleCount = 4 * fps;
const stopWalkingSample = 216;
const talkSample = 230;
const stopWalking = start + stopWalkingSample * 2;
const talk = start + talkSample * 2;
const events = [
  base,
  '',
  '# Deterministic Battle Pyramid walking capture generated at 30fps.',
  `${setup - 1} encounters off`,
  `${setup} warp 26 14 58 34`,
  `${setup + 1} view classic`,
  `${setup + 2} running-shoes on`,
  `${start} button up on`,
  `${start} view hd2d animated`,
];

for (let index = 0; index < sampleCount; index++) {
  const frame = start + index * 2;
  events.push(`${frame} screenshot battle-pyramid-walking-${String(index).padStart(4, '0')}`);
  events.push(`${frame} probe state`);
}
const end = start + sampleCount * 2;
events.push(
  `${stopWalking} button up off`,
  `${talk} button a on`,
  `${talk + 2} button a off`,
  `${end} probe state`,
);
await writeFile(generatedRoute, events.join('\n') + '\n');

const replayArgs = [
  'tools/wasm_replay.mjs', generatedRoute, replayOutput, `--render-scale=${renderScale}`,
  `--shading=${visualSettings.shading}`, `--perspective=${visualSettings.perspective}`, `--zoom=${visualSettings.zoom}`,
];
if (noBuild) replayArgs.push('--no-build');
await run('node', replayArgs);

const errors = (await readFile(resolve(replayOutput, 'errors.log'), 'utf8')).trim();
if (errors) throw new Error(`Replay browser errors:\n${errors}`);

const summary = JSON.parse(await readFile(resolve(replayOutput, 'summary.json'), 'utf8'));
if (summary.renderScale !== renderScale) {
  throw new Error(`Expected render scale ${renderScale}, got ${summary.renderScale}`);
}
const invalidScaleFrame = summary.screenshots.find(({state}) =>
  state.renderScale !== renderScale
  || state.outputWidth !== 240 * renderScale
  || state.outputHeight !== 160 * renderScale);
if (invalidScaleFrame) throw new Error(`Unexpected render dimensions in ${invalidScaleFrame.file}`);
for (const [setting, expected] of Object.entries(visualSettings)) {
  if (summary[setting] !== expected) throw new Error(`Expected ${setting} ${expected}, got ${summary[setting]}`);
}

const statesByFrame = new Map(
  summary.probes.filter((probe) => probe.name === 'state').map((probe) => [probe.frame, probe.result]),
);
const states = Array.from({length: sampleCount + 1}, (_, index) => statesByFrame.get(start + index * 2));
if (states.some((state) => !state)) throw new Error('Missing Battle Pyramid path probe');
if (states.some((state) => !state.runningShoes)) throw new Error('Running shoes were unavailable during the capture');
for (let index = 0; index < states.length; index++) {
  const progress = Math.min(index / transitionSampleCount, 1);
  const blend = progress * progress * (3 - 2 * progress);
  const expected = {
    renderedShadingStrength: visualSettings.shading * blend,
    renderedPerspectiveStrength: visualSettings.perspective * blend,
    renderedZoomStrength: visualSettings.zoom * blend,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (Math.abs(states[index][field] - value) > 1e-6) {
      throw new Error(`Expected ${field} ${value} at capture frame ${index}, got ${states[index][field]}`);
    }
  }
  const expectedTransition = index < transitionSampleCount ? 'hd2d' : null;
  if (states[index].visualModeTransition !== expectedTransition) {
    throw new Error(`Expected view transition ${expectedTransition} at capture frame ${index}, got ${states[index].visualModeTransition}`);
  }
}

let progress = 0;
let lastChange = 0;
let maxIdle = 0;
for (let index = 1; index <= stopWalkingSample; index++) {
  const previous = states[index - 1];
  const current = states[index];
  if (current.mapGroup === previous.mapGroup && current.mapNum === previous.mapNum) {
    progress += Math.max(0, previous.y - current.y);
  }
  if (current.x !== previous.x || current.y !== previous.y
      || current.mapGroup !== previous.mapGroup || current.mapNum !== previous.mapNum) {
    const changedAt = index * 2;
    maxIdle = Math.max(maxIdle, changedAt - lastChange);
    lastChange = changedAt;
  }
}
maxIdle = Math.max(maxIdle, stopWalkingSample * 2 - lastChange);
if (progress < 24 || maxIdle > 60) {
  throw new Error(`Battle Pyramid path appears blocked (progress ${progress}/24, longest idle ${maxIdle}/60 frames)`);
}

const finalState = states.at(-1);
const expectedEnd = {mapGroup: 26, mapNum: 25, x: 7, y: 13};
for (const [field, expected] of Object.entries(expectedEnd)) {
  if (finalState[field] !== expected) throw new Error(`Expected final ${field} ${expected}, got ${finalState[field]}`);
}

const screenshots = (await readdir(resolve(replayOutput, 'screenshots')))
  .filter((name) => name.includes('-battle-pyramid-walking-'))
  .sort();
if (screenshots.length !== sampleCount) {
  throw new Error(`Expected ${sampleCount} frames, found ${screenshots.length}`);
}
for (let index = 0; index < screenshots.length; index++) {
  await copyFile(
    resolve(replayOutput, 'screenshots', screenshots[index]),
    resolve(frameDir, `frame-${String(index).padStart(4, '0')}.png`),
  );
}
await run('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps),
  '-i', resolve(frameDir, 'frame-%04d.png'),
  '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
], trailerDir);
await run('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps),
  '-i', resolve(frameDir, 'frame-%04d.png'),
  '-vf', 'scale=960:640:flags=lanczos',
  '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', readmeOutput,
], trailerDir);
console.log(`Wrote trailer/public/gameplay/walking.mp4 and walking-readme.mp4 (${sampleCount} frames each)`);
