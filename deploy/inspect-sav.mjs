// Inspects an Emerald flash save (.sav) against the browser build's rules.
//
//   node deploy/inspect-sav.mjs "C:\path\to\pokeemerald.sav"
//
// Reports size, erased state, per-sector signatures/checksums for both the
// current and vanilla sector layouts, and basic player state.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SECTOR_SIZE = 4096;
const SECTORS_PER_SLOT = 14;
const SIGNATURE = 0x08012025;

const CURRENT = [0x0f2c, 0x0f80, 0x0f80, 0x0f80, 0x0f0c, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0];
const VANILLA = [0x0f2c, 0x0f80, 0x0f80, 0x0f80, 0x0f08, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0];

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function checksum(b, offset, size) {
  let sum = 0;
  let i = 0;
  for (; i + 3 < size; i += 4) sum = (sum + u32(b, offset + i)) >>> 0;
  for (; i < size; i++) sum = (sum + (b[offset + i] << ((i & 3) * 8))) >>> 0;
  return ((sum >>> 16) + (sum & 0xffff)) & 0xffff;
}

function slotReport(b, slot, sizes) {
  const first = slot * SECTORS_PER_SLOT;
  const sectors = [];
  let valid = true;
  for (let i = 0; i < SECTORS_PER_SLOT; i++) {
    const offset = (first + i) * SECTOR_SIZE;
    const id = u16(b, offset + 0x0ff4);
    const stored = u16(b, offset + 0x0ff6);
    const signature = u32(b, offset + 0x0ff8);
    const size = sizes[id];
    const computed = size === undefined ? null : checksum(b, offset, size);
    const ok = signature === SIGNATURE && size !== undefined && stored === computed;
    if (!ok) valid = false;
    sectors.push({ sector: first + i, id, signature, stored, computed, ok });
  }
  return { slot, valid, sectors };
}

function decodeName(bytes) {
  let out = '';
  for (const byte of bytes) {
    if (byte === 0x00 || byte === 0xFF) break;
    if (byte >= 0xbb && byte <= 0xd4) out += String.fromCharCode(byte - 0xbb + 65);
    else if (byte >= 0xd5 && byte <= 0xee) out += String.fromCharCode(byte - 0xd5 + 97);
    else if (byte >= 0xa1 && byte <= 0xaa) out += String.fromCharCode(byte - 0xa1 + 48);
    else if (byte === 0xae) out += '-';
    else if (byte === 0xad) out += '.';
    else out += '?';
  }
  return out;
}

function playerFrom(b, slot, sizes) {
  const first = slot * SECTORS_PER_SLOT;
  const sectors = [];
  for (let i = 0; i < SECTORS_PER_SLOT; i++) {
    const offset = (first + i) * SECTOR_SIZE;
    const id = u16(b, offset + 0x0ff4);
    if (id < SECTORS_PER_SLOT) sectors[id] = offset;
  }
  const block1 = new Uint8Array(0x3d8c);
  for (let id = 1; id <= 4; id++) {
    if (sectors[id] === undefined) return null;
    const size = Math.min(sizes[id], block1.length - (id - 1) * 0x0f80);
    block1.set(b.subarray(sectors[id], sectors[id] + size), (id - 1) * 0x0f80);
  }
  const saveBlock1 = block1;
  const b2 = sectors[0] === undefined ? null : b.subarray(sectors[0]);
  if (!b2) return null;
  return {
    name: decodeName(b2.subarray(0, 8)),
    gender: b2[8] === 0 ? 'male' : b2[8] === 1 ? 'female' : `unknown(${b2[8]})`,
    trainerId: u32(b2, 0x0a) % 65536,
    playTimeHours: u16(b2, 0x0e),
    playTimeMinutes: b2[0x10],
    map: { group: saveBlock1[0x04], num: saveBlock1[0x05] },
    position: { x: u16(saveBlock1, 0x00), y: u16(saveBlock1, 0x02) },
    continueMap: { group: saveBlock1[0x0c], num: saveBlock1[0x0d] },
  };
}

const args = process.argv.slice(2);
const gameArg = args.find((arg) => arg.startsWith('--game='));
const gameId = gameArg ? gameArg.slice('--game='.length) : 'emerald';
const path = args.find((arg) => !arg.startsWith('--'));
if (!path) {
  console.error('usage: node deploy/inspect-sav.mjs <file.sav> [--game=emerald|emerald-kaizo]');
  process.exit(2);
}

let expectedBytes = 128 * 1024;
let formatId = 'emerald-flash-128k';
try {
  const manifest = JSON.parse(await readFile(join(repo, 'game-packs', gameId, 'manifest.json'), 'utf8'));
  expectedBytes = manifest.saves.bytes;
  formatId = manifest.saves.formatId;
} catch {
  console.warn(`warning: no manifest for game ${gameId}; using the Emerald layout`);
}

const bytes = new Uint8Array(await readFile(path));
console.log(`game:   ${gameId} (${formatId})`);
console.log(`file:   ${path}`);
console.log(`size:   ${bytes.length} bytes ${bytes.length === expectedBytes ? '(correct)' : `(WRONG, expected ${expectedBytes})`}`);

let erased = 0;
for (const byte of bytes) if (byte === 0xff) erased++;
console.log(`erased: ${erased}/${bytes.length} bytes are 0xFF${erased === bytes.length ? '  <-- completely blank image' : ''}`);

for (const [label, sizes] of [['current build', CURRENT], ['vanilla layout', VANILLA]]) {
  for (const slot of [0, 1]) {
    const report = slotReport(bytes, slot, sizes);
    const bad = report.sectors.filter((s) => !s.ok);
    console.log(`\n${label}, slot ${slot === 0 ? 'A' : 'B'}: ${report.valid ? 'VALID' : 'invalid'} (${SECTORS_PER_SLOT - bad.length}/${SECTORS_PER_SLOT} sectors)`);
    for (const sector of bad) {
      console.log(`  sector ${sector.sector}: id=${sector.id} sig=0x${sector.signature.toString(16).padStart(8, '0')} stored=0x${sector.stored.toString(16)} computed=${sector.computed === null ? 'n/a' : '0x' + sector.computed.toString(16)}`);
    }
    if (report.valid) {
      const player = playerFrom(bytes, slot, sizes);
      console.log(`  player: ${JSON.stringify(player)}`);
    }
  }
}
