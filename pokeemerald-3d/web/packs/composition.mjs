// Instantiate a loaded pack's adapters at one explicit composition boundary.
// The shell provides dependencies per seam; this module knows nothing about
// individual game IDs or adapter implementation details.

const FACTORIES = Object.freeze({
  runtime: 'createRuntime',
  scene: 'createScene',
  saves: 'createSaveCodec',
  world: 'createWorldModel',
  run: 'createRunAdapter',
  party: 'createPartyAdapter',
  rules: 'createRulesAdapter',
});

export function createPackAdapter(loadedPack, name, context = {}) {
  const factoryName = FACTORIES[name];
  if (!factoryName) throw new TypeError(`unknown pack adapter seam: ${name}`);
  const module = loadedPack?.adapters?.[name];
  if (!module) return null;
  if (typeof module[factoryName] !== 'function') {
    throw new TypeError(`pack ${loadedPack.entry?.id ?? 'unknown'}: ${name} adapter must export ${factoryName}()`);
  }
  return module[factoryName](context);
}

export function createPackAdapters(loadedPack, contexts = {}) {
  const adapters = loadedPack?.adapters;
  if (!adapters) throw new TypeError('createPackAdapters requires a loaded pack with adapters');

  const services = {};
  for (const name of Object.keys(FACTORIES)) {
    // Some adapters depend on seam-specific data that is not available at the
    // first composition step (run needs generated map data; rules needs the
    // already-created run runtime). Defer those factories until the owner has
    // their complete context instead of invoking them with an empty object.
    services[name] = Object.hasOwn(contexts, name)
      ? createPackAdapter(loadedPack, name, contexts[name])
      : null;
  }
  return Object.freeze(services);
}
