#!/usr/bin/env bash
# Optimise the Sketchfab "Mini Robot" for the web: 257k → ~36k triangles, 4K PNG/JPEG → 1024px WebP,
# meshopt compression. Keeps all 25 parts separate (they're animated as rigid pieces). ~55 MB → ~0.7 MB.
#   npm run build:robot
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=Assets/mini_robot/scene.gltf
OUT=apps/web/public/models/robot.opt.glb
TMP=$(mktemp -d)
GT="npx --yes @gltf-transform/cli@4"
mkdir -p "$(dirname "$OUT")"
$GT copy     "$SRC"        "$TMP/0.glb"
$GT dedup    "$TMP/0.glb"  "$TMP/1.glb"
$GT weld     "$TMP/1.glb"  "$TMP/2.glb"
$GT simplify "$TMP/2.glb"  "$TMP/3.glb" --ratio 0.08 --error 0.0015
$GT prune    "$TMP/3.glb"  "$TMP/4.glb"
$GT resize   "$TMP/4.glb"  "$TMP/5.glb" --width 1024 --height 1024
$GT webp     "$TMP/5.glb"  "$TMP/6.glb" --quality 85
$GT meshopt  "$TMP/6.glb"  "$OUT"
rm -rf "$TMP"
ls -lh "$OUT"
