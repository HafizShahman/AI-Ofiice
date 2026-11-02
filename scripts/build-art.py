#!/usr/bin/env python3
"""Build the web art from Assets/: the room backdrop and every sprite props.json uses.

    npm run build:art        (needs Python 3 + Pillow: pip install pillow)

Writes apps/web/public/art/room.webp and apps/web/public/art/<group>/<name>.webp, plus
room-day.webp when Assets/room/bg-main-area-day.png exists (optional painted day backdrop).
Sprites are sized for their on-screen width (props.json `width`, % of the 2400 px room)
with headroom for zooming in, so the whole scene stays well under the PLAN §14 3 MB budget.
"""
import json
import math
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    raise SystemExit(
        'build-art needs Pillow for this python3. Install it with ONE of:\n'
        '  python3 -m pip install --user pillow      # Apple / python.org Python\n'
        '  brew install pillow                       # Homebrew Python ("externally-managed-environment" error)\n'
        'The built WebPs are committed, so you only need this after changing Assets/.'
    )

ROOT = Path(__file__).resolve().parent.parent
PROPS = ROOT / 'apps/web/src/scene/props.json'
OUT = ROOT / 'apps/web/public/art'
ROOM_SRC = ROOT / 'Assets/room/bg-main-area.png'
ROOM_DAY_SRC = ROOT / 'Assets/room/bg-main-area-day.png'
ROOM_W = 1920  # backdrop width in the browser
HEADROOM = 1.6  # sprite pixels per room pixel


def save(im: Image.Image, dest: Path, quality: int) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, 'WEBP', quality=quality, method=6)
    return dest.stat().st_size


def main() -> None:
    data = json.loads(PROPS.read_text())
    room_w = data['room']['width']
    total = 0

    room = Image.open(ROOM_SRC).convert('RGB')
    room = room.resize((ROOM_W, round(room.height * ROOM_W / room.width)), Image.LANCZOS)
    total += save(room, OUT / 'room.webp', 82)

    # optional painted daytime backdrop: same size and camera as the night one; the scene crossfades to it
    if ROOM_DAY_SRC.exists():
        day = Image.open(ROOM_DAY_SRC).convert('RGB')
        if day.size != Image.open(ROOM_SRC).size:
            raise SystemExit(f'{ROOM_DAY_SRC.name} must be {Image.open(ROOM_SRC).size[0]}x{Image.open(ROOM_SRC).size[1]} like {ROOM_SRC.name} (same camera, pixel for pixel)')
        day = day.resize(room.size, Image.LANCZOS)
        total += save(day, OUT / 'room-day.webp', 82)
        print('  room-day.webp (painted day backdrop)')

    need: dict[str, float] = {}
    for p in data['props']:
        for s in [p, *p.get('sprites', [])]:
            for key in ('sprite', 'busySprite', 'failSprite'):
                if key in s:
                    need[s[key]] = max(need.get(s[key], 0), s.get('width', p.get('width', 4)))

    for sprite, width in sorted(need.items()):
        src = ROOT / 'Assets' / sprite
        im = Image.open(src).convert('RGBA')
        target = math.ceil(width / 100 * room_w * HEADROOM)
        if im.width > target:
            im = im.resize((target, round(im.height * target / im.width)), Image.LANCZOS)
        rel = Path(sprite.removeprefix('sci-fi/')).with_suffix('.webp')
        size = save(im, OUT / rel, 88)
        total += size
        print(f'  {rel}  {im.width}x{im.height}  {size // 1024} KB')

    print(f'art: {len(need) + 1} files, {total // 1024} KB total -> {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
