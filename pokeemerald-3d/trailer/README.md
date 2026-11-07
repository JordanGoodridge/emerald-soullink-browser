# Battle Pyramid walking capture

A twelve-second Battle Pyramid walking capture at 1920 × 1280 and 30 fps. The view transition completes after four seconds, leaving eight seconds fully zoomed out in the 3D view. The player walks inside and greets the attendant at the end.

## Re-record

```sh
# From the repository root. Omit --no-build after gameplay changes.
make wasm
node trailer/scripts/capture-gameplay.mjs --no-build
```

The script verifies the capture dimensions, visual settings, path movement, and final map position before writing `trailer/public/gameplay/walking.mp4` and the 960 × 640 README encode at `trailer/public/gameplay/walking-readme.mp4`. Temporary replay frames live under `build/capture-battle-pyramid/`.

## SoulLink Discord GIF

`public/soullink-discord.gif` is cut from an actual real-time, four-browser SoulLink session. The recorder creates a room using the visible controls, starts a fresh run, selects starters, and moves the four characters with ordinary browser key events. It records the game canvas with `MediaRecorder`, not emulated replay frames or debug warps. The short settings, party and tracker inserts are screenshots from that same run. The players are scripted browser clients, **not four human players**, and this cut does not show a live encounter, failed catch, release or group wipe.

To record a new session and regenerate the GIF (from `pokeemerald-3d/`):

```sh
node trailer/scripts/record-live-soullink.mjs
python trailer/scripts/make-live-soullink-gif.py build/live-trailer-<timestamp>
```

Use the exact output path printed by the recorder. The second command needs Pillow (`python -m pip install Pillow`) and FFmpeg. The local recorder launches four independent Chrome profiles and a private relay, not four separate networks. The GIF maker stays under 9.5 MB for Discord.
