// Emerald party seam.
//
// Exposes the read-only party as a game-agnostic party snapshot for the shared
// party transport and UI. Party reading stays engine-specific here; the shared
// shell owns publication, privacy and presentation.

export function createPartyAdapter(context = {}) {
  return context.shared.createEmeraldPartyModel(context);
}
