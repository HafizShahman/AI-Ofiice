#!/usr/bin/env python3
"""Draws the AI Office logo (the hexagon from the top bar) and writes the icon set Tauri needs.
   python3 apps/desktop/make-icons.py   (needs Pillow; the output is committed)"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "src-tauri" / "icons"
S = 1024
BG, CYAN = (11, 18, 32, 255), (34, 211, 238, 255)


def hexagon(cx, cy, r):
    return [(cx + r * math.cos(math.radians(60 * i - 90)), cy + r * math.sin(math.radians(60 * i - 90))) for i in range(6)]


def draw() -> Image.Image:
    big = Image.new("RGBA", (S * 2, S * 2), (0, 0, 0, 0))  # 2x for smooth edges
    d = ImageDraw.Draw(big)
    d.rounded_rectangle((0, 0, S * 2 - 1, S * 2 - 1), radius=S * 0.46, fill=BG)
    c = S
    d.line(hexagon(c, c, S * 0.62) + [hexagon(c, c, S * 0.62)[0]], fill=CYAN, width=int(S * 0.075), joint="curve")
    d.polygon(hexagon(c, c, S * 0.27), fill=CYAN)
    return big.resize((S, S), Image.LANCZOS)


img = draw()
OUT.mkdir(parents=True, exist_ok=True)
for name, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512)]:
    img.resize((size, size), Image.LANCZOS).save(OUT / name)
img.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.save(OUT / "icon.icns")
print("icons written to", OUT)
