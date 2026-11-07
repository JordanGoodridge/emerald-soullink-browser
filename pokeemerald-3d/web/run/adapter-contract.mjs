// Shared validation for per-pack run adapters and their capability claims.

export const RUN_ENFORCEMENT_LEVELS = Object.freeze(['none', 'observe', 'enforce']);

export function validateRunAdapter(adapter, { mode = 'soullink' } = {}) {
  const errors = [];
  if (!adapter || typeof adapter !== 'object') return { ok: false, errors: ['adapter must be an object'] };
  if (typeof adapter.id !== 'string' || !adapter.id) errors.push('id is required');
  if (!Array.isArray(adapter.modes) || !adapter.modes.includes(mode)) errors.push(`mode ${mode} is unsupported`);
  for (const method of ['areaKey', 'areaLabel', 'isWildArea', 'sectionId', 'speciesTable', 'trainerKind']) {
    if (typeof adapter[method] !== 'function') errors.push(`${method} must be a function`);
  }
  if (adapter.saveSlot !== 'soulrun') errors.push('saveSlot must be soulrun for SoulLink mode');

  const capabilities = adapter.capabilities ?? {};
  for (const key of ['encounter', 'captureGate', 'faintRelease', 'reviveGate']) {
    if (!RUN_ENFORCEMENT_LEVELS.includes(capabilities[key])) errors.push(`capabilities.${key} is invalid`);
  }
  if (mode === 'soullink'
      && (capabilities.encounter !== 'enforce' || capabilities.captureGate !== 'enforce')) {
    errors.push('SoulLink requires enforced encounter and capture gates');
  }
  return { ok: errors.length === 0, errors };
}
