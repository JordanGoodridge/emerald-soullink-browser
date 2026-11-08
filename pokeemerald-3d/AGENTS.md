# `pokeemerald-3d` Decomp & WASM Port Rules

This directory contains the `pokeemerald` C decompilation and WebAssembly port (`build/wasm/pokeemerald.wasm`).
*(For the full file inventory, `#if WASM` line index, and auto-wired C $\leftrightarrow$ JS hook contracts, see the root `AGENTS.md`.)*

## 1. Decomp & `#if WASM` Principles
- **Preserve vanilla source & assets:** Prefer WASM wrappers (`src/wasm_*.c`, `include/wasm/`), browser glue (`web/`), or generators (`tools/`) over editing vanilla C files.
- **Minimal `#if WASM` guards:** When a vanilla C file needs WASM behavior, isolate the exact change with `#if WASM` and keep it minimal.
- **Fix root causes, not individual content:** Fix shared conversion/runtime/build layers rather than patching one-off maps, scripts, or assets.
- **Keep generated outputs untracked:** Verify `.gitignore` before committing so build outputs, `.wasm` binaries, or replay artifacts (`wasm-replay-output/`) are never committed.

## 2. Headless WASM Replay (`tools/wasm_replay.mjs`)
To capture deterministic canvas screenshots and console/error logs at exact `WasmRunFrame()` ticks:
```sh
node tools/wasm_replay.mjs path/to/events.txt --no-build
```
- Omit `--no-build` if `build/wasm/pokeemerald.wasm` needs rebuilding (or run `.\build-wasm.ps1` from the repo root first).
- Event format (`tools/wasm_replays/`): `<frame> screenshot <name>` or `<frame> button <a|b|select|start|right|left|up|down|r|l> <on|off>`.
- Outputs to `wasm-replay-output/` (`screenshots/*.png`, `console.log`, `errors.log`, `summary.json`).
