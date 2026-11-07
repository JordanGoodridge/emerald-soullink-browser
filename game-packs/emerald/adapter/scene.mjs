// Emerald scene seam.
//
// Emerald produces the shared emerald-scene-v1 buffers (HD-2D and classic).
// The presenter itself stays shared; this adapter only hands it the frame.

export function createScene(context) {
  return context.shared.createEmeraldScene(context);
}
