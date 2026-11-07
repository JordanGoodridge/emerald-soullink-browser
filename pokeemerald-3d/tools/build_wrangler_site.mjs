#!/usr/bin/env node
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const output = 'dist/cloudflare';
const files = [
  ['web/index.html', `${output}/index.html`],
  ['web/style.css', `${output}/web/style.css`],
  ['web/app.js', `${output}/web/app.js`],
  ['web/presenter.js', `${output}/web/presenter.js`],
  ['build/wasm/pokeemerald.wasm', `${output}/build/wasm/pokeemerald.wasm`],
];

await rm(output, { recursive: true, force: true });

for (const [source, destination] of files) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

console.log(`prepared Cloudflare static assets in ${output}`);
