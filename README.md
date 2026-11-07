# Emerald SoulLink Browser

Play 2–4 player Emerald SoulLink and Nuzlocke runs in the browser on top of [`tripplyons/pokeemerald-wasm`](https://github.com/tripplyons/pokeemerald-wasm).

This repo only contains the multiplayer server, browser UI, and a patch (`patches/pokeemerald-wasm.patch`). The game files are downloaded from `pokeemerald-wasm` when you run `.\install.ps1`.

---

## Features

### Online Multiplayer & Lobbies
- **Room Codes:** Host a room, share a 6-character code (or link), and pick rules in the lobby.
- **See Friends in the Overworld:** Up to 4 players walk, run, bike, jump ledges, and surf on the same map in 3D/HD-2D or Classic 2D.
- **Live Party & Map View:** Inspect anyone's current party, HP, and moves, see an icon over their head when they're in a battle, and press `M` to see everyone on the Hoenn map.
- **Starter Draft & Quick-Start:** Everyone picks from 3 starters in the lobby and spawns directly on Route 101 with the Pokedex, Running Shoes, and 5 Poke Balls (skips the truck/Birch intro).
- **Save Sync & Resume:** Saves and run progress sync across players automatically. You can close the game and resume the lobby later, export `.ptnuzlocke` backups, or let a friend take over an open player slot.

### SoulLink & Nuzlocke Rules (Enforced in the Game)
- **First Encounter & Dupes Clause:** Only the first encounter per route can be caught. Throwing a ball on an already-used route or a duplicate species is blocked in battle and refunds your ball.
- **Linked Catches:** Catches on the same route link together across all players.
- **Shared Deaths:** If one player's mon faints in battle or from poison, all mons linked to it across every player's party and PC are automatically deleted after the battle. Revives are disabled on dead mons.
- **Linked PC Lock:** You can't box a linked party member unless the lobby host turns on independent PC boxing.
- **Party Wipes & Run Morgue:** If any player's active party wipes, the whole group wipes (mons sitting in the PC don't save you). Ending a run by wiping or beating the Champion shows a summary screen with your Gym split times, Hall of Fame team, and a **Run Morgue** of every death and who caused it.

### Randomizer, Level Caps & QoL Toggles
- **Randomizer:** Shared seed across all players. Separate toggles for wild encounters, regular trainers, Gym Leaders / Elite Four / Champion, and starters.
- **Gym Level Caps:** Stops EXP gain and Rare Candies at the next Gym Leader's highest-level mon.
- **Party Level Sync & Auto-Level:** Leveling up one mon can sync the rest of your party up to match it, and newly caught mons automatically level up to your party.
- **QoL Toggles:** Infinite Rare Candies, start with Max Money (`999,999`), and a built-in **Move Relearner** menu.

### Other Games
- **Emerald** is the main focus and supports all SoulLink, Nuzlocke, and randomizer features.
- **Emerald Kaizo** has basic support (boots in Standard mode with saves and overworld player visibility, no SoulLink hooks). Other ROM hacks might be added later.

---

## Hosting & Playing Online with Friends

Once you've built the game, you can host a multiplayer lobby in two ways:

### Option 1: Direct Host (LAN, Tailscale / Radmin VPN, or Port Forwarding)
`.\serve-local.ps1` starts both the game server (port `8000`) and the multiplayer relay (port `8787`):
```powershell
powershell -ExecutionPolicy Bypass -File .\serve-local.ps1
```
- **Same PC:** Open `http://localhost:8000`
- **Friends on LAN / Tailscale / Radmin VPN / Port-Forwarded IP:** Have everyone open `http://<your-ip>:8000`, click **Play with friends** -> **Multiplayer Nuzlocke / SoulLink**, and join the same 6-character room code.

### Option 2: Free Cloudflare Quick Tunnel (No VPN or Port Forwarding)
If you want a public `https://` link anyone can click without setting up VPNs or router port forwarding:

1. Download [`cloudflared-windows-amd64.exe`](https://github.com/cloudflare/cloudflared/releases/latest) and put it at `.toolchain\cloudflared.exe`.
2. Run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy/start-temp-tunnel.ps1 -Build
   ```
3. Send the printed `https://<random-words>.trycloudflare.com/` link to your friends. Everyone opens that same link and joins your 6-character room code.

---

## Local Install & Build

Requires Node 22+, Git, and MSYS2 UCRT64 at `.toolchain/msys64`.

```powershell
# 1. Download upstream pokeemerald-wasm and apply our patch
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 2. Build the WASM file
powershell -ExecutionPolicy Bypass -File .\build-wasm.ps1

# 3. Start local server at http://localhost:8000
powershell -ExecutionPolicy Bypass -File .\serve-local.ps1
```

To test 4 players locally on one PC in separate Chrome tabs:
```powershell
cd pokeemerald-3d
node tools/presence_launcher.mjs --count 4
```

---

## Controls

Switch between **Arrow keys** and **WASD** in **Settings**:

| Action | Arrow Keys | WASD |
|---|---|---|
| Move | Arrow keys | `W` `A` `S` `D` |
| A / B | `Z` / `X` | `Z` / `X` |
| Start / Select | `Enter` / `Shift` | `Enter` / `Shift` |
| L / R | `Q` / `E` | `Q` / `E` |
| Map / Menu | `M` / `Esc` | `M` / `Esc` |

---

## Dev Notes

If you edit any upstream C/Makefile files inside `pokeemerald-3d/`, save your changes back to `patches/pokeemerald-wasm.patch` before committing:
```powershell
node tools/save-upstream-patch.mjs
```
