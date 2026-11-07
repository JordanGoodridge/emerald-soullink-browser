// Emerald world/presence seam.
//
// Reads the typed WASM presence exports and publishes the shared world model.
// Presence transport and rendering remain shared systems.

export function createWorldModel(context) {
  return context.shared.createEmeraldWorldModel(context);
}
