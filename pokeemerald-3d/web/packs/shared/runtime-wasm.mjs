// Shared WASM runtime helpers.
//
// The engine's BIOS/graphics imports are implemented once here, with explicit
// names. Unknown imports currently return 0 to preserve the existing Emerald
// behaviour while the 2B link spike is adding new imports; the pack loader and
// conformance work will tighten this to a reviewed allowlist.
//
// The view provider is supplied by the composition root so this module never
// owns the engine's memory or input state.

const moduleCache = new Map();

export async function loadWasmModule(
  url,
  { fetchImpl = fetch, expectedSha256 = null } = {},
) {
  if (!url) throw new Error('loadWasmModule requires a module URL');
  if (!moduleCache.has(url)) {
    moduleCache.set(url, (async () => {
      const response = await fetchImpl(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`wasm request failed: ${response.status} ${url}`);
      const bytes = await response.arrayBuffer();
      return { bytes, module: await WebAssembly.compile(bytes) };
    })());
  }
  const loaded = await moduleCache.get(url);
  const expected = String(expectedSha256 ?? '').replace(/^sha256:/i, '').toLowerCase();
  if (expected && expected !== 'pending') {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error(`SHA-256 verification is unavailable for ${url}`);
    const digest = new Uint8Array(await subtle.digest('SHA-256', loaded.bytes));
    const actual = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) throw new Error(`WASM digest mismatch for ${url} (expected ${expected}, got ${actual})`);
  }
  return loaded;
}

export function clearWasmModuleCache() {
  moduleCache.clear();
}

// Pack runtime lifecycle for the existing source-WASM ABI. The shell supplies
// import construction; the adapter supplies the manifest identity/resource.
// Keeping this in the shared WASM layer lets pack adapters stay declarative
// while making the selected pack, rather than app.js, own module resolution.
export function createWasmRuntime({ manifest, manifestUrl, importsFor, fetchImpl = fetch } = {}) {
  if (!manifest?.runtime?.module?.url) throw new Error('WASM runtime requires runtime.module.url');
  if (typeof importsFor !== 'function') throw new Error('WASM runtime requires importsFor(module, options)');
  const moduleUrl = new URL(manifest.runtime.module.url, manifestUrl ?? globalThis.location?.href).href;
  let instance = null;
  const startExport = manifest.runtime.entry?.[0] ?? 'AgbMain';
  const frameExport = manifest.runtime.entry?.[1] ?? 'WasmRunFrame';
  return {
    moduleUrl,
    get exports() { return instance?.exports ?? null; },
    async instantiate(options = {}) {
      const { bytes, module } = await loadWasmModule(moduleUrl, {
        fetchImpl,
        expectedSha256: manifest.runtime.module.sha256,
      });
      options.validateModule?.(module);
      const moduleExports = new Set(WebAssembly.Module.exports(module).map((item) => item.name));
      for (const name of manifest.runtime.requiredExports ?? []) {
        if (!moduleExports.has(name)) throw new Error(`WASM runtime is missing required export ${name}`);
      }
      instance = await WebAssembly.instantiate(module, importsFor(module, options));
      const memoryBytes = instance.exports.memory?.buffer?.byteLength ?? 0;
      const minimumMemory = manifest.runtime.initialMemoryBytes ?? 0;
      if (minimumMemory && memoryBytes < minimumMemory) {
        instance = null;
        throw new Error(`WASM runtime memory is ${memoryBytes} bytes; requires ${minimumMemory}`);
      }
      return { bytes, module, instance, memory: instance.exports.memory };
    },
    start() {
      if (!instance) throw new Error('WASM runtime is not instantiated');
      const start = instance.exports[startExport];
      if (typeof start !== 'function') throw new Error(`WASM runtime is missing start export ${startExport}`);
      start();
    },
    step() {
      if (!instance) throw new Error('WASM runtime is not instantiated');
      const runFrame = instance.exports[frameExport];
      if (typeof runFrame !== 'function') throw new Error(`WASM runtime is missing frame export ${frameExport}`);
      runFrame();
    },
    dispose() {
      instance = null;
    },
  };
}

export function dispatchRunImport(name, args = [], hooks = {}) {
  const hook = hooks?.[name];
  if (typeof hook === 'function') return hook(...args);
  // These safe defaults preserve ordinary gameplay when run mode is not wired.
  if (name === 'WasmRunRandomSpecies') return args[1] ?? 0;
  if (name === 'WasmRunAllowCapture' || name === 'WasmRunAllowItemEffect') return 1;
  return undefined;
}

export function createWasmHelpers(getViews) {
  const views = () => {
    const value = getViews();
    if (!value?.u8 || !value?.u16 || !value?.u32) {
      throw new Error('WASM memory views are not initialized');
    }
    return value;
  };

  function copy(src, dst, count, size, fill) {
    const { u8 } = views();
    for (let i = 0; i < count; i++) {
      const from = fill ? src : src + i * size;
      u8.set(u8.subarray(from, from + size), dst + i * size);
    }
  }

  function lz77(src, dst) {
    const { u8 } = views();
    const size = u8[src + 1] | (u8[src + 2] << 8) | (u8[src + 3] << 16);
    let s = src + 4;
    let d = dst;
    const end = dst + size;
    while (d < end) {
      const flags = u8[s++];
      for (let bit = 7; bit >= 0 && d < end; bit--) {
        if (flags & (1 << bit)) {
          const pair = (u8[s] << 8) | u8[s + 1];
          s += 2;
          let length = (pair >> 12) + 3;
          const disp = (pair & 0xfff) + 1;
          while (length-- && d < end) {
            u8[d] = u8[d - disp];
            d++;
          }
        } else {
          u8[d++] = u8[s++];
        }
      }
    }
  }

  function rl(src, dst) {
    const { u8 } = views();
    const size = u8[src + 1] | (u8[src + 2] << 8) | (u8[src + 3] << 16);
    let s = src + 4;
    let d = dst;
    const end = dst + size;
    while (d < end) {
      const flag = u8[s++];
      if (flag & 0x80) {
        let count = (flag & 0x7f) + 3;
        const value = u8[s++];
        while (count-- && d < end) u8[d++] = value;
      } else {
        let count = (flag & 0x7f) + 1;
        while (count-- && d < end) u8[d++] = u8[s++];
      }
    }
  }

  function readCString(ptr) {
    const { u8 } = views();
    let out = '';
    while (u8[ptr]) out += String.fromCharCode(u8[ptr++]);
    return out;
  }

  function readS16(ptr) {
    const { u16 } = views();
    return u16[ptr >> 1] << 16 >> 16;
  }

  function readS32(ptr) {
    const { u16 } = views();
    return (u16[ptr >> 1] | (u16[(ptr + 2) >> 1] << 16)) | 0;
  }

  function writeS16(ptr, value) {
    const { u16 } = views();
    u16[ptr >> 1] = value & 0xffff;
  }

  function writeS32(ptr, value) {
    const { u16 } = views();
    u16[ptr >> 1] = value & 0xffff;
    u16[(ptr + 2) >> 1] = (value >> 16) & 0xffff;
  }

  function affineTerms(xScale, yScale, rotation) {
    const angle = rotation * Math.PI * 2 / 0x10000;
    const sin = Math.sin(angle) * 256;
    const cos = Math.cos(angle) * 256;
    return {
      pa: cos * xScale / 256,
      pb: -sin * xScale / 256,
      pc: sin * yScale / 256,
      pd: cos * yScale / 256,
    };
  }

  function bgAffineSet(src, dest, count) {
    const { u16 } = views();
    for (let i = 0; i < count; i++) {
      const s = src + i * 20;
      const d = dest + i * 16;
      const texX = readS32(s);
      const texY = readS32(s + 4);
      const scrX = readS16(s + 8);
      const scrY = readS16(s + 10);
      const { pa, pb, pc, pd } = affineTerms(readS16(s + 12), readS16(s + 14), u16[(s + 16) >> 1]);
      const a = pa | 0;
      const b = pb | 0;
      const c = pc | 0;
      const e = pd | 0;
      writeS16(d, a);
      writeS16(d + 2, b);
      writeS16(d + 4, c);
      writeS16(d + 6, e);
      writeS32(d + 8, (texX - scrX * a - scrY * b) | 0);
      writeS32(d + 12, (texY - scrX * c - scrY * e) | 0);
    }
  }

  function objAffineSet(src, dest, count, offset) {
    const { u16 } = views();
    for (let i = 0; i < count; i++) {
      const s = src + i * 6;
      const d = dest + i * offset * 4;
      const { pa, pb, pc, pd } = affineTerms(readS16(s), readS16(s + 2), u16[(s + 4) >> 1]);
      writeS16(d, pa | 0);
      writeS16(d + offset, pb | 0);
      writeS16(d + offset * 2, pc | 0);
      writeS16(d + offset * 3, pd | 0);
    }
  }

  function copyOamMatrices(src, dest, dummy, oamCount, oamLimit) {
    const { u16, u32 } = views();
    const dummyWord0 = u32[dummy >> 2];
    const dummyWord1 = u32[(dummy + 4) >> 2];
    for (let entry = oamCount; entry < oamLimit; entry++) {
      const output = (dest + entry * 8) >> 2;
      u32[output] = dummyWord0;
      u32[output + 1] = dummyWord1;
    }
    for (let matrix = 0; matrix < 32; matrix++) {
      const source = (src + matrix * 8) >> 1;
      const output = (dest + matrix * 32 + 6) >> 1;
      u16[output] = u16[source];
      u16[output + 4] = u16[source + 1];
      u16[output + 8] = u16[source + 2];
      u16[output + 12] = u16[source + 3];
    }
  }

  function createImports(module, { runHooks = {} } = {}) {
    const env = {};
    for (const item of WebAssembly.Module.imports(module)) {
      if (item.kind !== 'function') continue;
      env[item.name] = (...args) => {
        if (item.name.startsWith('WasmRun')) {
          const result = dispatchRunImport(item.name, args, runHooks);
          if (result !== undefined) return result;
          return 0;
        }
        switch (item.name) {
          case 'CpuSet': return copy(args[0], args[1], args[2] & 0x1fffff, (args[2] >>> 26) & 1 ? 4 : 2, (args[2] >>> 24) & 1);
          case 'CpuFastSet': return copy(args[0], args[1], args[2] & 0x1fffff, 4, (args[2] >>> 24) & 1);
          case 'LZ77UnCompWram':
          case 'LZ77UnCompVram': return lz77(args[0], args[1]);
          case 'RLUnCompWram':
          case 'RLUnCompVram': return rl(args[0], args[1]);
          case 'BgAffineSet': return bgAffineSet(args[0], args[1], args[2]);
          case 'ObjAffineSet': return objAffineSet(args[0], args[1], args[2], args[3]);
          case 'WasmCopyOamMatrices': return copyOamMatrices(args[0], args[1], args[2], args[3], args[4]);
          case 'Div': return args[1] ? (args[0] / args[1]) | 0 : 0;
          case 'Sqrt': return Math.sqrt(args[0]) | 0;
          // GBA BIOS angle units: a full turn is 0x10000.
          case 'ArcTan2': return (Math.atan2(args[0], args[1]) * 0x8000 / Math.PI) & 0xffff;
          case 'strcmp': return readCString(args[0]).localeCompare(readCString(args[1]));
          default: return 0;
        }
      };
    }
    return { env };
  }

  return {
    createImports,
    readS16,
    readS32,
    writeS16,
    writeS32,
  };
}
