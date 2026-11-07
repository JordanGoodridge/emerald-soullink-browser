// Emerald flash save codec.
//
// Pure byte validation, normalization and legacy repair. The shared save store
// owns storage keys, profiles, locks, flushing and export/import. Keeping this
// module free of DOM/storage/WASM dependencies lets it run in tests and in the
// pack validator.
//
// The byte layout is the reference Emerald layout used by pokeemerald-3d. A
// different game must use a different formatId even if its size is the same.

export const FLASH_BASE = 0x0e000000;
export const FLASH_SIZE = 128 * 1024;
export const FLASH_SECTOR_SIZE = 4096;
export const SAVE_SECTORS_PER_SLOT = 14;
export const SAVE_SECTOR_SIGNATURE = 0x08012025;
export const SAVE_SECTOR_DATA_SIZES = [
  0x0f2c,
  0x0f80, 0x0f80, 0x0f80, 0x0f0c,
  0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0,
];
export const VANILLA_SAVE_SECTOR_DATA_SIZES = [
  0x0f2c,
  0x0f80, 0x0f80, 0x0f80, 0x0f08,
  0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0,
];
export const LEGACY_WASM_SAVE_SECTOR_DATA_SIZES = [
  0x0f08,
  0x0f80, 0x0f80, 0x0f80, 0x0dc4,
  0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0,
];
export const LEGACY_WASM_FRONTEND_SAVE_SECTOR_DATA_SIZES = [
  0x0f08,
  0x0f80, 0x0f80, 0x0f80, 0x0dc0,
  0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0,
];
export const SAVE_BLOCK2_SIZE = 0x0f2c;
export const SAVE_BLOCK1_SIZE = 0x3d8c;
export const LEGACY_SAVE_BLOCK2_SIZE = 0x0f08;
export const LEGACY_SAVE_BLOCK1_SIZE = 0x3c44;
export const SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET = 0x0ac;
export const SAVE_BLOCK2_TRAINER_ID_OFFSET = 0x00a;
export const SAVE_BLOCK1_COINS_OFFSET = 0x494;
export const SAVE_BAG_POCKETS = [
  [0x560, 30, 99],
  [0x5d8, 30, 99],
  [0x650, 16, 99],
  [0x690, 64, 99],
  [0x790, 46, 999],
];

function readSaveU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readSaveU32(bytes, offset) {
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function writeSaveU16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function saveSectorChecksum(bytes, offset, size) {
  let sum = 0;
  let i = 0;
  for (; i + 3 < size; i += 4) sum = (sum + readSaveU32(bytes, offset + i)) >>> 0;
  for (; i < size; i++) sum = (sum + (bytes[offset + i] << ((i & 3) * 8))) >>> 0;
  return ((sum >>> 16) + (sum & 0xffff)) & 0xffff;
}

export function hasValidEmeraldSaveSlot(bytes, slot, sectorDataSizes) {
  let validSectorFlags = 0;
  const firstSector = slot * SAVE_SECTORS_PER_SLOT;

  for (let i = 0; i < SAVE_SECTORS_PER_SLOT; i++) {
    const sectorOffset = (firstSector + i) * FLASH_SECTOR_SIZE;
    const id = readSaveU16(bytes, sectorOffset + 0x0ff4);
    const checksum = readSaveU16(bytes, sectorOffset + 0x0ff6);
    const signature = readSaveU32(bytes, sectorOffset + 0x0ff8);
    const dataSize = sectorDataSizes[id];

    if (signature === SAVE_SECTOR_SIGNATURE
      && dataSize !== undefined
      && checksum === saveSectorChecksum(bytes, sectorOffset, dataSize)) {
      validSectorFlags |= 1 << id;
    }
  }

  return validSectorFlags === (1 << SAVE_SECTORS_PER_SLOT) - 1;
}

export function isValidEmeraldSave(bytes, sectorDataSizes) {
  return hasValidEmeraldSaveSlot(bytes, 0, sectorDataSizes)
    || hasValidEmeraldSaveSlot(bytes, 1, sectorDataSizes);
}

export function isValidCurrentBuildSave(bytes) {
  return isValidEmeraldSave(bytes, SAVE_SECTOR_DATA_SIZES)
    || isValidEmeraldSave(bytes, VANILLA_SAVE_SECTOR_DATA_SIZES);
}

function copyRange(dst, dstOffset, src, srcOffset, size) {
  dst.set(src.subarray(srcOffset, srcOffset + size), dstOffset);
}

function copyLegacyArray(dst, dstOffset, dstElementSize, src, srcOffset, srcElementSize, count) {
  for (let i = 0; i < count; i++) {
    copyRange(dst, dstOffset + i * dstElementSize, src, srcOffset + i * srcElementSize, srcElementSize);
  }
}

function readSlotSaveBlocks(bytes, slot, sectorDataSizes, saveBlock2Size, saveBlock1Size) {
  const saveBlock2 = new Uint8Array(saveBlock2Size);
  const saveBlock1 = new Uint8Array(saveBlock1Size);
  const firstSector = slot * SAVE_SECTORS_PER_SLOT;

  for (let i = 0; i < SAVE_SECTORS_PER_SLOT; i++) {
    const sectorOffset = (firstSector + i) * FLASH_SECTOR_SIZE;
    const id = readSaveU16(bytes, sectorOffset + 0x0ff4);
    const size = sectorDataSizes[id];
    if (size === undefined) continue;

    if (id === 0) {
      copyRange(saveBlock2, 0, bytes, sectorOffset, Math.min(size, saveBlock2.length));
    } else if (id >= 1 && id <= 4) {
      copyRange(saveBlock1, (id - 1) * 0x0f80, bytes, sectorOffset, Math.min(size, saveBlock1.length - (id - 1) * 0x0f80));
    }
  }

  return { saveBlock1, saveBlock2 };
}

function saveKeyScore(saveBlock1, key) {
  let score = (readSaveU32(saveBlock1, 0x490) ^ key) <= 999999 ? 20 : -20;

  for (const [offset, count, maxQuantity] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const itemOffset = offset + i * 4;
      const itemId = readSaveU16(saveBlock1, itemOffset);
      const quantity = (readSaveU16(saveBlock1, itemOffset + 2) ^ key) & 0xffff;
      if (itemId === 0) score += quantity === 0 ? 1 : -1;
      else if (itemId < 377 && quantity > 0 && quantity <= maxQuantity) score += 3;
      else score -= 3;
    }
  }

  return score;
}

function isLikelyLegacyWasmSaveBlock(blocks) {
  const legacyKey = readSaveU32(blocks.saveBlock2, 0x0a8);
  const currentKey = readSaveU32(blocks.saveBlock2, SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET);
  if (legacyKey === currentKey) return false;
  return saveKeyScore(blocks.saveBlock1, legacyKey) > saveKeyScore(blocks.saveBlock1, currentKey) + 20;
}

function isPlausibleBagQuantity(itemId, quantity, maxQuantity) {
  if (itemId === 0) return quantity === 0;
  return itemId < 377 && quantity > 0 && quantity <= maxQuantity;
}

function bagQuantityKeyScore(saveBlock1, key) {
  let score = 0;
  const keyLow = key & 0xffff;

  for (const [offset, count, maxQuantity] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const itemOffset = offset + i * 4;
      const itemId = readSaveU16(saveBlock1, itemOffset);
      const quantity = (readSaveU16(saveBlock1, itemOffset + 2) ^ keyLow) & 0xffff;
      if (isPlausibleBagQuantity(itemId, quantity, maxQuantity)) score += itemId === 0 ? 2 : 5;
      else score += itemId === 0 ? -2 : -5;
    }
  }

  return score;
}

function staleBagQuantityKey(saveBlock1, currentKey) {
  const currentKeyLow = currentKey & 0xffff;
  const candidates = new Set();

  for (const [offset, count] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const itemOffset = offset + i * 4;
      if (readSaveU16(saveBlock1, itemOffset) === 0) {
        const rawQuantity = readSaveU16(saveBlock1, itemOffset + 2);
        if (rawQuantity !== currentKeyLow) candidates.add(rawQuantity);
      }
    }
  }

  const currentScore = bagQuantityKeyScore(saveBlock1, currentKeyLow);
  let bestKey = currentKeyLow;
  let bestScore = currentScore;
  for (const candidate of candidates) {
    const score = bagQuantityKeyScore(saveBlock1, candidate);
    if (score > bestScore) {
      bestKey = candidate;
      bestScore = score;
    }
  }

  return bestKey !== currentKeyLow && bestScore > currentScore + 100 && bestScore > 100 ? bestKey : null;
}

function reencryptSaveBlock1Hword(saveBlock1, offset, oldKey, newKey) {
  const value = (readSaveU16(saveBlock1, offset) ^ oldKey) & 0xffff;
  writeSaveU16(saveBlock1, offset, value ^ newKey);
}

function repairStaleBagEncryption(blocks) {
  const currentKey = readSaveU32(blocks.saveBlock2, SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET);
  const currentKeyLow = currentKey & 0xffff;
  const oldKey = staleBagQuantityKey(blocks.saveBlock1, currentKey);
  if (oldKey === null) return null;

  const saveBlock1 = new Uint8Array(blocks.saveBlock1);
  let didRepair = false;
  for (const [offset, count, maxQuantity] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const quantityOffset = offset + i * 4 + 2;
      const itemId = readSaveU16(saveBlock1, quantityOffset - 2);
      const rawQuantity = readSaveU16(saveBlock1, quantityOffset);
      const currentQuantity = (rawQuantity ^ currentKeyLow) & 0xffff;
      const oldQuantity = (rawQuantity ^ oldKey) & 0xffff;
      if (isPlausibleBagQuantity(itemId, currentQuantity, maxQuantity)
          || !isPlausibleBagQuantity(itemId, oldQuantity, maxQuantity)) {
        continue;
      }

      reencryptSaveBlock1Hword(saveBlock1, quantityOffset, oldKey, currentKeyLow);
      didRepair = true;
    }
  }

  const rawCoins = readSaveU16(saveBlock1, SAVE_BLOCK1_COINS_OFFSET);
  const currentCoins = (rawCoins ^ currentKeyLow) & 0xffff;
  const oldCoins = (rawCoins ^ oldKey) & 0xffff;
  if (oldCoins <= 9999 && (currentCoins > 9999 || rawCoins === oldKey)) {
    writeSaveU16(saveBlock1, SAVE_BLOCK1_COINS_OFFSET, oldCoins ^ currentKeyLow);
    didRepair = true;
  }

  return didRepair ? { saveBlock1, saveBlock2: blocks.saveBlock2 } : null;
}

function migrateLegacySaveBlock2(src) {
  const dst = new Uint8Array(0x0f2c);
  copyRange(dst, 0, src, 0, 0x98);
  copyRange(dst, 0x98, src, 0x98, 5);
  copyRange(dst, 0xa0, src, 0x9e, 5);
  copyRange(dst, 0xa8, src, 0xa4, 0xe64);
  return dst;
}

function migrateLegacySaveBlock1(src) {
  const dst = new Uint8Array(0x3d8c);
  copyRange(dst, 0, src, 0, 0x848);
  copyLegacyArray(dst, 0x848, 8, src, 0x848, 7, 40);
  copyRange(dst, 0x988, src, 0x960, 0x166c - 0x960);
  copyLegacyArray(dst, 0x169c, 8, src, 0x1674, 6, 128);
  copyRange(dst, 0x1a9c, src, 0x1974, 0x2be0 - 0x1974);
  copyLegacyArray(dst, 0x2be0, 36, src, 0x2ab8, 34, 16);
  copyRange(dst, 0x2e20, src, 0x2cd8, 0x3150 - 0x2cd8);
  copyRange(dst, 0x3150, src, 0x3008, 85);
  copyRange(dst, 0x31a8, src, 0x305e, 11);
  copyRange(dst, 0x31b4, src, 0x306c, 20);
  copyRange(dst, 0x31c8, src, 0x3080, 21);
  copyRange(dst, 0x31e0, src, 0x3098, 0x3c44 - 0x3098);
  return dst;
}

function writeCurrentSaveSlot(out, source, slot, currentBlocks) {
  const firstSector = slot * SAVE_SECTORS_PER_SLOT;

  for (let i = 0; i < SAVE_SECTORS_PER_SLOT; i++) {
    const sectorOffset = (firstSector + i) * FLASH_SECTOR_SIZE;
    const id = readSaveU16(source, sectorOffset + 0x0ff4);
    const size = SAVE_SECTOR_DATA_SIZES[id];
    if (size === undefined) continue;

    out.fill(0, sectorOffset, sectorOffset + 0x0ff4);
    if (id === 0) {
      copyRange(out, sectorOffset, currentBlocks.saveBlock2, 0, size);
    } else if (id >= 1 && id <= 4) {
      copyRange(out, sectorOffset, currentBlocks.saveBlock1, (id - 1) * 0x0f80, size);
    } else {
      copyRange(out, sectorOffset, source, sectorOffset, size);
    }
    writeSaveU16(out, sectorOffset + 0x0ff6, saveSectorChecksum(out, sectorOffset, size));
  }
}

function writeMigratedSaveSlot(out, source, slot, blocks) {
  writeCurrentSaveSlot(out, source, slot, {
    saveBlock2: migrateLegacySaveBlock2(blocks.saveBlock2),
    saveBlock1: migrateLegacySaveBlock1(blocks.saveBlock1),
  });
}

function migrateLegacyWasmSave(bytes) {
  const out = new Uint8Array(bytes);
  let didMigrate = false;

  for (let slot = 0; slot < 2; slot++) {
    for (const legacySizes of [LEGACY_WASM_SAVE_SECTOR_DATA_SIZES, LEGACY_WASM_FRONTEND_SAVE_SECTOR_DATA_SIZES]) {
      if (!hasValidEmeraldSaveSlot(bytes, slot, legacySizes)) continue;
      const blocks = readSlotSaveBlocks(bytes, slot, legacySizes, LEGACY_SAVE_BLOCK2_SIZE, LEGACY_SAVE_BLOCK1_SIZE);
      if (!isLikelyLegacyWasmSaveBlock(blocks)) continue;
      writeMigratedSaveSlot(out, bytes, slot, blocks);
      didMigrate = true;
      break;
    }
  }

  return didMigrate ? out : null;
}

function repairStaleBagEncryptionSave(bytes) {
  const out = new Uint8Array(bytes);
  let didRepair = false;

  for (let slot = 0; slot < 2; slot++) {
    let sectorDataSizes = null;
    if (hasValidEmeraldSaveSlot(bytes, slot, SAVE_SECTOR_DATA_SIZES)) sectorDataSizes = SAVE_SECTOR_DATA_SIZES;
    else if (hasValidEmeraldSaveSlot(bytes, slot, VANILLA_SAVE_SECTOR_DATA_SIZES)) sectorDataSizes = VANILLA_SAVE_SECTOR_DATA_SIZES;
    if (!sectorDataSizes) continue;

    const blocks = readSlotSaveBlocks(bytes, slot, sectorDataSizes, SAVE_BLOCK2_SIZE, SAVE_BLOCK1_SIZE);
    const repaired = repairStaleBagEncryption(blocks);
    if (!repaired) continue;

    writeCurrentSaveSlot(out, bytes, slot, repaired);
    didRepair = true;
  }

  return didRepair ? out : null;
}

export function normalizeSaveForCurrentBuild(bytes) {
  const migrated = migrateLegacyWasmSave(bytes);
  if (migrated) return repairStaleBagEncryptionSave(migrated) ?? migrated;

  const repaired = repairStaleBagEncryptionSave(bytes);
  if (repaired) return repaired;

  return isValidCurrentBuildSave(bytes) ? bytes : null;
}

export function createEmeraldSaveCodec({ formatId = 'emerald-flash-128k', formatVersion = 1 } = {}) {
  return {
    formatId,
    formatVersion,
    bytes: FLASH_SIZE,
    validate(bytes) {
      if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'save is not a byte array' };
      if (bytes.length !== FLASH_SIZE) return { ok: false, reason: `expected ${FLASH_SIZE} bytes, got ${bytes.length}` };
      return isValidCurrentBuildSave(bytes)
        ? { ok: true }
        : { ok: false, reason: 'no valid Emerald save slot' };
    },
    normalize(bytes) {
      return normalizeSaveForCurrentBuild(bytes);
    },
    exportRaw(bytes) {
      return new Uint8Array(bytes);
    },
  };
}
