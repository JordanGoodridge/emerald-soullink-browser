const RUN_HOOKS = Object.freeze({
  encounter: ['WasmRunOnEncounter'],
  captureGate: ['WasmRunAllowCapture'],
  faintRelease: ['WasmRunOnFaint', 'WasmRunShouldRelease'],
  reviveGate: ['WasmRunAllowItemEffect'],
  linkedPcBoxing: ['WasmRunAllowPcBoxing'],
});

export function createRulesAdapter({ manifest, runAdapter, runtime } = {}) {
  const support = manifest?.nuzlocke?.support ?? 'none';
  const modes = manifest?.run?.modes ?? [];
  const requiredHooks = manifest?.nuzlocke?.requiredHooks ?? [];
  if (support !== 'enforce' || manifest?.capabilities?.rules !== 'enforce') {
    throw new Error('Emerald RulesAdapter requires an enforced nuzlocke/rules manifest claim');
  }
  if (!modes.includes('nuzlocke') || !modes.includes('soullink')) {
    throw new Error('Emerald RulesAdapter requires solo Nuzlocke and SoulLink run modes');
  }
  if (!runtime || typeof runtime.bindExports !== 'function' || !runtime.hooks) {
    throw new Error('Emerald RulesAdapter requires the shared run runtime');
  }

  const capabilities = runAdapter?.capabilities ?? {};
  const enforcedHooks = [...requiredHooks];
  if (manifest?.run?.capabilities?.linkedPcBoxing === 'enforce') enforcedHooks.push('linkedPcBoxing');
  const missing = enforcedHooks.filter((hook) => {
    const hookFunctions = RUN_HOOKS[hook];
    return !hookFunctions || capabilities[hook] !== 'enforce' || hookFunctions.some((name) => typeof runtime.hooks[name] !== 'function');
  });
  if (missing.length) throw new Error(`Emerald RulesAdapter is missing enforced hooks: ${missing.join(', ')}`);
  if (manifest?.run?.capabilities?.linkedPcBoxing === 'enforce'
      && capabilities.linkedPcBoxing !== 'enforce') {
    throw new Error('Emerald RulesAdapter requires enforced linked-PC boxing capability');
  }
  const importIds = [...requiredHooks];
  if (manifest?.run?.capabilities?.linkedPcBoxing === 'enforce') importIds.push('linkedPcBoxing');
  const requiredImports = [...new Set(importIds.flatMap((hook) => RUN_HOOKS[hook]))];

  return Object.freeze({
    support,
    modes: Object.freeze([...modes]),
    validateImports(imports = []) {
      const names = new Set(imports.map((item) => typeof item === 'string' ? item : item?.name));
      const absent = requiredImports.filter((name) => !names.has(name));
      if (absent.length) throw new Error(`Emerald RulesAdapter requires WASM imports: ${absent.join(', ')}`);
      return true;
    },
    bind(accessors) {
      runtime.bindExports(accessors);
    },
    hooks() {
      return runtime.hooks;
    },
  });
}
