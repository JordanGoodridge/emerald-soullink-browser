// Emerald save seam.
//
// The codec validates and normalizes Emerald flash bytes. The shared save
// store owns keys, profiles, locks and flushing.

export function createSaveCodec(context) {
  return context.shared.createEmeraldSaveCodec(context);
}
