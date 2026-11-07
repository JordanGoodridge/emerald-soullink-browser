// Four-byte-format-independent save codec for the synthetic pack fixture.

export function createSaveCodec({ formatId = 'toy-console-save', formatVersion = 1 } = {}) {
  return {
    formatId,
    formatVersion,
    bytes: 16,
    validate(bytes) {
      return bytes instanceof Uint8Array && bytes.byteLength === 16
        ? { ok: true }
        : { ok: false, reason: 'toy-console saves must be 16 bytes' };
    },
    normalize(bytes) {
      return bytes instanceof Uint8Array && bytes.byteLength === 16 ? bytes : null;
    },
    exportRaw(bytes) { return new Uint8Array(bytes); },
  };
}
