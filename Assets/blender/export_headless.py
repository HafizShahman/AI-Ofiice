"""Headless build + export (no Blender UI needed).

    pip install bpy==5.2.3          # Blender as a Python module (Python 3.13)
    python3 Assets/blender/export_headless.py

Writes apps/web/public/models/room.glb, room-nav.glb and Assets/blender/office-room.blend.
"""
import json, os, sys
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPT = os.path.join(HERE, "build_room.py")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.name = "AI_Office"
g = {"__name__": "ai_office_build", "AI_OFFICE_REPO": REPO}
exec(compile(open(SCRIPT).read(), SCRIPT, "exec"), g)
PROPS = os.path.join(HERE, "build_props.py")
exec(compile(open(PROPS).read(), PROPS, "exec"), g)
stats = g["build"]()
out_props = g["build_props"]()
stats = g["stats"]()
out = g["export_all"]()
out["blend"] = g["save_blend"]()
out["triangles"] = stats["triangles_total"]
out["props"] = out_props
web = os.path.join(REPO, "apps/web/src/scene/room3d.json")
with open(web, "w") as f:
    json.dump(g["spot_table"](), f, indent=1)
out["room3d"] = web
print(json.dumps(out, indent=2))
