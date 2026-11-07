// Emerald runtime seam.
//
// The shared implementation is extracted from the current shell in Phase A.
// Keeping this file thin is deliberate: a pack supplies configuration and a
// factory, not a second copy of the engine lifecycle.

export function createRuntime(context) {
  return context.shared.createEmeraldRuntime(context);
}
