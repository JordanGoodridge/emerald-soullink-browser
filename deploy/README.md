# Deployment (`deploy/`)

## Cloudflare Quick Tunnel (`start-temp-tunnel.ps1`)

Requires `cloudflared-windows-amd64.exe` at `.toolchain\cloudflared.exe`.

```powershell
powershell -ExecutionPolicy Bypass -File deploy/start-temp-tunnel.ps1 -Build
```

| Port | Process | Role |
|---|---|---|
| `8090` | `deploy/serve-dist.mjs` | Serves `pokeemerald-3d/dist` and proxies `/presence` and `/run` WebSocket upgrades to `127.0.0.1:8787` |
| `8787` | `server/src/server.mjs` | Loopback WebSocket server for presence rooms and SoulLink state |

Pass `-RestartRelay` if `server/src/server.mjs` changed. Every player must use the same `https://*.trycloudflare.com/` URL.

## Static Bundle (`build-dist.mjs`)

```powershell
node deploy/build-dist.mjs
```

Writes the static bundle and packaged game packs to `pokeemerald-3d/dist`.
