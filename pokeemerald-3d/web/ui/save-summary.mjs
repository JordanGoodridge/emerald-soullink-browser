// Browser-safe summary of an Emerald-family 128 KiB flash image.
//
// The library needs a player name, play time and map before booting the engine.
// This module reads only the validated save sectors and never mutates bytes.

import {
  SAVE_BLOCK1_SIZE,
  SAVE_SECTOR_DATA_SIZES,
  SAVE_SECTORS_PER_SLOT,
  FLASH_SECTOR_SIZE,
  SAVE_SECTOR_SIGNATURE,
  VANILLA_SAVE_SECTOR_DATA_SIZES,
  hasValidEmeraldSaveSlot,
} from '../packs/shared/save-codec-emerald.mjs';

const SECTOR_SIZE = FLASH_SECTOR_SIZE;
const BLOCK1_CHUNK_SIZE = 0x0f80;

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function decodeName(bytes) {
  let out = '';
  for (const byte of bytes) {
    if (byte === 0x00 || byte === 0xff) break;
    if (byte >= 0xbb && byte <= 0xd4) out += String.fromCharCode(byte - 0xbb + 65);
    else if (byte >= 0xd5 && byte <= 0xee) out += String.fromCharCode(byte - 0xd5 + 97);
    else if (byte >= 0xa1 && byte <= 0xaa) out += String.fromCharCode(byte - 0xa1 + 48);
    else if (byte === 0xae) out += '-';
    else if (byte === 0xad) out += '.';
    else out += '?';
  }
  return out;
}

function sectorOffsets(bytes, slot) {
  const offsets = [];
  const first = slot * SAVE_SECTORS_PER_SLOT;
  for (let i = 0; i < SAVE_SECTORS_PER_SLOT; i++) {
    const offset = (first + i) * SECTOR_SIZE;
    const id = u16(bytes, offset + 0x0ff4);
    if (id < SAVE_SECTORS_PER_SLOT) offsets[id] = offset;
  }
  return offsets;
}

function readBlock(bytes, slot, sectorDataSizes) {
  const sectors = sectorOffsets(bytes, slot);
  if (!sectors[0]) return null;
  const saveBlock1 = new Uint8Array(SAVE_BLOCK1_SIZE);
  for (let id = 1; id <= 4; id++) {
    if (sectors[id] === undefined) return null;
    const size = Math.min(
      sectorDataSizes[id],
      saveBlock1.length - (id - 1) * BLOCK1_CHUNK_SIZE,
    );
    saveBlock1.set(bytes.subarray(sectors[id], sectors[id] + size), (id - 1) * BLOCK1_CHUNK_SIZE);
  }
  return {
    saveBlock1,
    saveBlock2: bytes.subarray(sectors[0]),
  };
}

/**
 * @param {Uint8Array} bytes
 * @returns {{valid: boolean, slot?: number, player?: object, reason?: string}}
 */
export function readSaveSummary(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 128 * 1024) {
    return { valid: false, reason: 'not a 128 KiB save' };
  }

  for (const [slot, sizes] of [
    [0, SAVE_SECTOR_DATA_SIZES],
    [1, SAVE_SECTOR_DATA_SIZES],
    [0, VANILLA_SAVE_SECTOR_DATA_SIZES],
    [1, VANILLA_SAVE_SECTOR_DATA_SIZES],
  ]) {
    if (!hasValidEmeraldSaveSlot(bytes, slot, sizes)) continue;
    const blocks = readBlock(bytes, slot, sizes);
    if (!blocks) continue;
    const { saveBlock1, saveBlock2 } = blocks;
    const playTimeHours = u16(saveBlock2, 0x0e);
    const playTimeMinutes = saveBlock2[0x10];
    return {
      valid: true,
      slot,
      player: {
        name: decodeName(saveBlock2.subarray(0, 8)),
        gender: saveBlock2[8] === 0 ? 'male' : saveBlock2[8] === 1 ? 'female' : 'unknown',
        trainerId: u32(saveBlock2, 0x0a) % 65536,
        playTimeHours,
        playTimeMinutes,
        playTimeTotalMinutes: playTimeHours * 60 + playTimeMinutes,
        map: { group: saveBlock1[0x04], num: saveBlock1[0x05] },
        position: { x: u16(saveBlock1, 0), y: u16(saveBlock1, 2) },
        continueMap: { group: saveBlock1[0x0c], num: saveBlock1[0x0d] },
      },
    };
  }

  return { valid: false, reason: 'no valid save slot' };
}

export { SAVE_SECTOR_SIGNATURE };
