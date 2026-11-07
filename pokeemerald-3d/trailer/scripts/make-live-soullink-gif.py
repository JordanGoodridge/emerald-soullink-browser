"""Cut a real-time, normally controlled SoulLink recording into a Discord GIF.

Usage: python trailer/scripts/make-live-soullink-gif.py build/live-trailer-.../
The input directory must be produced by record-live-soullink.mjs.
"""

import json
import subprocess
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


REPO = Path(__file__).resolve().parents[2]
OUTPUT = REPO / "trailer/public/soullink-discord.gif"
if len(sys.argv) != 2:
    raise SystemExit("Pass the output directory printed by record-live-soullink.mjs")
SOURCE = Path(sys.argv[1]).resolve()
evidence = json.loads((SOURCE / "session.json").read_text())
if evidence["participants"]["actors"] != 3:
    raise SystemExit("The recorded game did not show three other players")
if not (SOURCE / "gameplay.webm").exists():
    raise SystemExit("Missing real-time gameplay.webm")

FRAMES = SOURCE / "gif-frames"
FRAMES.mkdir(exist_ok=True)
subprocess.run([
    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(SOURCE / "gameplay.webm"),
    "-vf", "fps=10", str(FRAMES / "frame-%04d.png"),
], check=True)
gameplay = sorted(FRAMES.glob("frame-*.png"))[:120]
if len(gameplay) < 50:
    raise SystemExit(f"Recording is too short: {len(gameplay)} frames")


def font(size, bold=False):
    path = Path("C:/Windows/Fonts") / ("arialbd.ttf" if bold else "arial.ttf")
    return ImageFont.truetype(str(path), size) if path.exists() else ImageFont.load_default()


def layout(width, image, label, detail):
    height = round(width * .75)
    top = round(width * .092)
    image = image.convert("RGB")
    image.thumbnail((width - 16, height - top - 16), Image.Resampling.LANCZOS)
    frame = Image.new("RGB", (width, height), (7, 19, 23))
    frame.paste(image, ((width - image.width) // 2,
                        top + (height - top - image.height) // 2))
    draw = ImageDraw.Draw(frame)
    draw.text((18, 8), label, font=font(round(width * .042), True), fill=(245, 244, 228))
    draw.text((18, round(width * .059)), detail, font=font(round(width * .020)),
              fill=(103, 220, 175))
    return frame


def render(width, colors):
    scenes = []
    for index, path in enumerate(gameplay):
        if index == 25:
            scenes.append((SOURCE / "settings.png", "Run settings", "Wild / trainers / gyms / starters", 1200))
        if index == 70:
            scenes.append((SOURCE / "party.png", "Linked parties", "Four players, four independent teams", 1200))
        if index == 95:
            scenes.append((SOURCE / "tracker.png", "Run tracker", "Linked encounters by area", 1200))
        scenes.append((path, "Multiplayer SoulLink", "Recorded from the running browser game", 100))

    images = []
    durations = []
    samples = []
    for index, (path, label, detail, duration) in enumerate(scenes):
        with Image.open(path) as image:
            frame = layout(width, image, label, detail)
        images.append(frame)
        durations.append(duration)
        if index % 10 == 0 or duration > 100:
            samples.append(frame)

    columns = 4
    height = round(width * .75)
    palette_sheet = Image.new("RGB", (width * columns,
                                      height * ((len(samples) + columns - 1) // columns)))
    for index, frame in enumerate(samples):
        palette_sheet.paste(frame, ((index % columns) * width, (index // columns) * height))
    palette = palette_sheet.quantize(colors=colors, method=Image.Quantize.MEDIANCUT)
    indexed = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image in images]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    indexed[0].save(OUTPUT, save_all=True, append_images=indexed[1:],
                    duration=durations, loop=0, optimize=True, disposal=2)
    return OUTPUT.stat().st_size, sum(durations)


for width, colors in [(640, 96), (560, 80), (480, 64)]:
    size, duration = render(width, colors)
    if size <= 9_500_000:
        print(f"Wrote {OUTPUT} ({width}px, {duration / 1000:.1f}s, {size / 1e6:.2f} MB)")
        break
else:
    raise SystemExit(f"GIF still exceeds 9.5 MB: {size / 1e6:.2f} MB")
