// Compatibility wrapper for the extracted Emerald world model.
//
// Existing presence tests and callers import `createGameAdapter`; the shared
// implementation now lives in `web/packs/shared/world-emerald.mjs` so a pack
// can inject its appearance mapping without changing presence semantics.

export {
  createEmeraldWorldModel as createGameAdapter,
  frameFor,
  layoutName,
  worldKey,
} from '../packs/shared/world-emerald.mjs';
