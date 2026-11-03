#!/usr/bin/env bash
# Rebuild the 3D room from the Blender scripts and optimise it for the web.
#   npm run build:room
# 1. Assets/blender/export_headless.py builds the room + props and writes
#    apps/web/public/models/room.glb, room-nav.glb, apps/web/src/scene/room3d.json, Assets/blender/office-room.blend
#    It needs Blender's Python: the Blender app ($BLENDER, or /Applications/Blender.app) or `pip install bpy==5.2.3`.
# 2. gltf-transform dedups and meshopt-compresses room.glb (~0.9 MB -> ~0.3 MB). Node names are kept:
#    the web app looks up Prop_*, PropAlt_*, City_* and Prop_ShipBell by name.
set -euo pipefail
cd "$(dirname "$0")/.."
EXPORT=Assets/blender/export_headless.py
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
if [ -x "$BLENDER" ]; then
  "$BLENDER" --background --factory-startup --python "$EXPORT"
elif python3 -c "import bpy" 2>/dev/null; then
  python3 "$EXPORT"
else
  echo "Blender not found: set BLENDER=/path/to/blender or pip install bpy==5.2.3" >&2
  exit 1
fi
OUT=apps/web/public/models/room.glb
TMP=$(mktemp -d)
GT="npx --yes @gltf-transform/cli@4"
$GT dedup   "$OUT"        "$TMP/1.glb"
$GT meshopt "$TMP/1.glb"  "$TMP/2.glb"
mv "$TMP/2.glb" "$OUT"
rm -rf "$TMP"
ls -lh "$OUT" apps/web/public/models/room-nav.glb
