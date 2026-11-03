"""
AI Office - 3D room rebuilt from Assets/room/bg-main-area.png (painted isometric sci-fi office).

Run inside Blender (UI or background). Note: Blender 5.2's UI crashed during the glTF export when it was
driven through the MCP addon, so exports are run headless instead (the same script works with the `bpy`
PyPI module: see Assets/blender/export_headless.py).
    exec(open("<repo>/Assets/blender/build_room.py").read())
    build()            # (re)builds everything into the scene "AI_Office"
    render_preview()   # Assets/blender/renders/room_iso.png
    export_all()       # apps/web/public/models/room.glb + room-nav.glb

Layout units are metres. Plan coordinates used throughout this file:
    x = along the back wall, 0..16 (left corner -> right)
    d = depth away from the back wall, 0..12 (toward the viewer)
Blender: X = x, Y = -d, Z = up. The window wall sits at x = 0, the back wall at d = 0.
The iso camera looks from +X/-Y at 30 deg elevation, matching the painting.
"""
import bpy, bmesh, math, os, random
from mathutils import Vector, Matrix

REPO = globals().get("AI_OFFICE_REPO", "/Users/siputbrokoli/Documents/GitHub/Claude/AI-Ofiice")
SCENE = "AI_Office"
W, D, H, WT = 16.0, 12.0, 5.5, 0.3      # room width (x), depth (d), wall height, wall thickness
DECK_H = 1.0                             # command deck height

# furniture layout, as arranged by Caman in Blender (2026-11-02). The floor neon is laid out around it.
DESK_COLS = (6.385, 8.374, 10.406, 12.402)  # workstation centres (x); desks are 0.8 deep in x, 1.6 long in d
DESK_ROWS = (9.3, 11.0)                     # workstation centres (d)
DESK_DECK = (14.02, 5.64)                   # the CEO table, up on the deck
PAD_Z = 0.05
HOLO_C = (3.174, 6.0)                   # holo ring centre (moved by Caman)
HOLO_SCREEN_C = (3.53, 6.0)             # centre of the curved holo screen's arc (moved by Caman)
HOLO_R = 2.6                            # outer radius of the ring band
PIT_R, STEP_R = 2.0, 1.6                # sunken pit: wall radius, inner step radius
STEP_Z, PIT_Z = -0.15, -0.35            # step top, pit floor
PADS = [(15.36, 8.95), (15.36, 10.15), (15.36, 11.35)]   # charging pads, front-right corner of the floor
PREFIXES = ("Room_", "Fx_", "City_", "Txt_", "NAV_", "OF_IsoCam", "Asset_", "Prop_")


def V(x, d, z):
    return Vector((x, -d, z))


def N(x, d, z):
    return Vector((x, -d, z))


# --------------------------------------------------------------------------- materials
def mat(name, color, metal=0.4, rough=0.45, emit=None, strength=0.0, alpha=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        nt.nodes.clear()
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs[0], out.inputs[0])

    def setin(names, val):
        for n in names:
            if n in bsdf.inputs:
                bsdf.inputs[n].default_value = val
                return

    setin(["Base Color"], (*color, 1.0))
    setin(["Metallic"], metal)
    setin(["Roughness"], rough)
    if emit:
        setin(["Emission Color", "Emission"], (*emit, 1.0))
        setin(["Emission Strength"], strength)
    else:
        setin(["Emission Strength"], 0.0)
    setin(["Alpha"], alpha)
    if alpha < 1.0:
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try:
                setattr(m, attr, val)
            except Exception:
                pass
        try:
            m.shadow_method = "NONE"
        except Exception:
            pass
        m.use_backface_culling = False
    m.diffuse_color = (*(emit or color), alpha)
    return m


def make_materials():
    C = {}
    C["floor"] = mat("OF_Floor", (0.17, 0.21, 0.27), 0.6, 0.3)
    C["slab"] = mat("OF_Slab", (0.035, 0.045, 0.06), 0.5, 0.5)
    C["wall"] = mat("OF_Wall", (0.13, 0.16, 0.20), 0.45, 0.45)
    C["metal"] = mat("OF_Gunmetal", (0.22, 0.26, 0.31), 0.75, 0.32)
    C["dark"] = mat("OF_PanelDark", (0.04, 0.05, 0.065), 0.5, 0.45)
    C["light"] = mat("OF_TrimLight", (0.42, 0.47, 0.53), 0.75, 0.3)
    C["neon"] = mat("OF_NeonCyan", (0.2, 0.85, 1.0), 0.0, 0.3, emit=(0.25, 0.9, 1.0), strength=8)
    C["neon_s"] = mat("OF_NeonCyanSoft", (0.1, 0.5, 0.6), 0.0, 0.4, emit=(0.2, 0.8, 1.0), strength=2.5)
    C["pad"] = mat("OF_PadGlow", (0.3, 0.9, 1.0), 0.0, 0.3, emit=(0.3, 0.95, 1.0), strength=5)
    C["glass"] = mat("OF_Glass", (0.55, 0.8, 0.95), 0.0, 0.05, alpha=0.12)
    C["holo"] = mat("OF_HoloGlass", (0.3, 0.85, 1.0), 0.0, 0.1, emit=(0.2, 0.75, 1.0), strength=0.8, alpha=0.22)
    C["holo_f"] = mat("OF_HoloFaint", (0.3, 0.9, 1.0), 0.0, 0.2, emit=(0.3, 0.9, 1.0), strength=0.35, alpha=0.035)
    C["screen"] = mat("OF_ScreenDark", (0.02, 0.04, 0.06), 0.2, 0.25, emit=(0.02, 0.08, 0.12), strength=1.0)
    C["scr_green"] = mat("OF_ScreenGreen", (0.1, 0.6, 0.3), 0.0, 0.3, emit=(0.2, 0.95, 0.5), strength=2.5)
    C["green"] = mat("OF_LedGreen", (0.2, 1.0, 0.4), 0.0, 0.4, emit=(0.25, 1.0, 0.45), strength=5)
    C["red"] = mat("OF_LedRed", (1.0, 0.15, 0.15), 0.0, 0.4, emit=(1.0, 0.12, 0.1), strength=5)
    C["amber"] = mat("OF_LedAmber", (1.0, 0.6, 0.1), 0.0, 0.4, emit=(1.0, 0.55, 0.1), strength=5)
    C["pink"] = mat("OF_LedPink", (1.0, 0.3, 0.7), 0.0, 0.4, emit=(1.0, 0.25, 0.7), strength=5)
    C["s_yellow"] = mat("OF_StickyYellow", (1.0, 0.85, 0.2), 0.0, 0.5, emit=(1.0, 0.8, 0.15), strength=2)
    C["s_green"] = mat("OF_StickyGreen", (0.3, 0.9, 0.3), 0.0, 0.5, emit=(0.3, 0.9, 0.3), strength=2)
    C["s_pink"] = mat("OF_StickyPink", (1.0, 0.35, 0.45), 0.0, 0.5, emit=(1.0, 0.3, 0.45), strength=2)
    C["s_blue"] = mat("OF_StickyBlue", (0.3, 0.6, 1.0), 0.0, 0.5, emit=(0.3, 0.6, 1.0), strength=2)
    C["poster"] = mat("OF_PosterBlue", (0.1, 0.3, 0.6), 0.0, 0.4, emit=(0.12, 0.35, 0.7), strength=1.5)
    C["txt_white"] = mat("OF_TextWhite", (0.9, 0.95, 1.0), 0.0, 0.4, emit=(0.9, 0.95, 1.0), strength=2)
    C["white"] = mat("OF_White", (0.85, 0.88, 0.92), 0.1, 0.4)
    C["ext"] = mat("OF_ExtinguisherRed", (0.55, 0.04, 0.04), 0.3, 0.35)
    C["city"] = mat("OF_CityBlock", (0.06, 0.09, 0.17), 0.3, 0.5, emit=(0.06, 0.10, 0.22), strength=1.4)
    C["haze"] = mat("OF_CityHaze", (0.2, 0.35, 0.6), 0.0, 0.5, emit=(0.25, 0.45, 0.8), strength=1.2)
    C["city_c"] = mat("OF_CityLightCyan", (0.3, 0.8, 1.0), 0.0, 0.5, emit=(0.3, 0.8, 1.0), strength=3)
    C["city_p"] = mat("OF_CityLightPink", (1.0, 0.3, 0.7), 0.0, 0.5, emit=(1.0, 0.3, 0.7), strength=3)
    C["city_a"] = mat("OF_CityLightAmber", (1.0, 0.6, 0.25), 0.0, 0.5, emit=(1.0, 0.6, 0.25), strength=2)
    return C


# --------------------------------------------------------------------------- mesh builder
class B:
    """Accumulates primitives into one bmesh -> one object with several material slots."""

    def __init__(self, name, coll):
        self.name, self.coll = name, coll
        self.bm = bmesh.new()
        self.mats = []

    def _tag(self, faces, m):
        if m not in self.mats:
            self.mats.append(m)
        i = self.mats.index(m)
        for f in faces:
            f.material_index = i
        return faces

    @staticmethod
    def _faces(verts):
        return {f for v in verts for f in v.link_faces}

    def box(self, x0, x1, d0, d1, z0, z1, m):
        c = V((x0 + x1) / 2, (d0 + d1) / 2, (z0 + z1) / 2)
        mtx = Matrix.LocRotScale(c, None, (abs(x1 - x0), abs(d1 - d0), abs(z1 - z0)))
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=mtx)
        return self._tag(self._faces(r["verts"]), m)

    def beam(self, p0, p1, w, m, h=None):
        a, b = V(*p0), V(*p1)
        v = b - a
        q = Vector((0, 0, 1)).rotation_difference(v.normalized())
        mtx = Matrix.LocRotScale((a + b) / 2, q, (w, h or w, v.length))
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=mtx)
        return self._tag(self._faces(r["verts"]), m)

    def cyl(self, cx, cd, r, z0, z1, m, n=32, r2=None):
        mtx = Matrix.Translation(V(cx, cd, (z0 + z1) / 2))
        res = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=n, radius1=r,
                                    radius2=(r if r2 is None else r2), depth=(z1 - z0), matrix=mtx)
        return self._tag(self._faces(res["verts"]), m)

    def sphere(self, cx, cd, cz, r, m, sub=2):
        res = bmesh.ops.create_icosphere(self.bm, subdivisions=sub, radius=r, matrix=Matrix.Translation(V(cx, cd, cz)))
        return self._tag(self._faces(res["verts"]), m)

    def annulus(self, cx, cd, ri, ro, z0, z1, m, n=64, a0=0.0, a1=2 * math.pi):
        full = abs((a1 - a0) - 2 * math.pi) < 1e-6
        cnt = n if full else n + 1
        rings = []
        for i in range(cnt):
            a = a0 + (a1 - a0) * i / n
            ca, sa = math.cos(a), math.sin(a)
            rings.append([self.bm.verts.new(V(cx + r * ca, cd + r * sa, z)) for r, z in ((ro, z0), (ro, z1), (ri, z1), (ri, z0))])
        faces = []
        for i in range(n):
            A, Bv = rings[i], rings[(i + 1) % cnt]
            for k in range(4):
                faces.append(self.bm.faces.new((A[k], Bv[k], Bv[(k + 1) % 4], A[(k + 1) % 4])))
        if not full:
            faces.append(self.bm.faces.new(rings[0]))
            faces.append(self.bm.faces.new(list(reversed(rings[-1]))))
        bmesh.ops.recalc_face_normals(self.bm, faces=faces)
        return self._tag(faces, m)

    def prism(self, pts, z0, z1, m, top=None):
        bot = [self.bm.verts.new(V(x, d, z0)) for x, d in pts]
        tp = [self.bm.verts.new(V(x, d, z1)) for x, d in pts]
        faces = [self.bm.faces.new(bot)]
        ftop = self.bm.faces.new(tp)
        faces.append(ftop)
        for i in range(len(pts)):
            j = (i + 1) % len(pts)
            faces.append(self.bm.faces.new((bot[i], bot[j], tp[j], tp[i])))
        bmesh.ops.recalc_face_normals(self.bm, faces=faces)
        self._tag(faces, m)
        if top is not None:
            self._tag([ftop], top)
        return faces

    def quad(self, pts, m, normal=None):
        f = self.bm.faces.new([self.bm.verts.new(V(*p)) for p in pts])
        if normal is not None:
            f.normal_update()
            if f.normal.dot(normal) < 0:
                f.normal_flip()
        return self._tag([f], m)

    def arc_strip(self, cx, cd, r, a0, a1, z0, z1, m, n=24):
        cols = []
        for i in range(n + 1):
            a = a0 + (a1 - a0) * i / n
            x, d = cx + r * math.cos(a), cd + r * math.sin(a)
            cols.append((self.bm.verts.new(V(x, d, z0)), self.bm.verts.new(V(x, d, z1))))
        faces = [self.bm.faces.new((cols[i][0], cols[i + 1][0], cols[i + 1][1], cols[i][1])) for i in range(n)]
        return self._tag(faces, m)

    def finish(self, sharp_deg=35):
        bm = self.bm
        for f in bm.faces:
            f.smooth = True
        for e in bm.edges:
            if len(e.link_faces) != 2:
                e.smooth = False
                continue
            try:
                ang = e.calc_face_angle()
            except ValueError:
                ang = math.pi
            if ang > math.radians(sharp_deg):
                e.smooth = False
        me = bpy.data.meshes.new(self.name)
        bm.to_mesh(me)
        bm.free()
        for m in self.mats:
            me.materials.append(m)
        if hasattr(me, "use_auto_smooth"):          # Blender < 4.1
            me.use_auto_smooth = True
            me.auto_smooth_angle = math.pi
        ob = bpy.data.objects.new(self.name, me)
        self.coll.objects.link(ob)
        return ob


# --------------------------------------------------------------------------- helpers
def poly_normals(pts):
    """Outward unit normal (in x,d) for every edge i -> i+1 of a simple polygon."""
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    out = []
    for i in range(len(pts)):
        (x0, d0), (x1, d1) = pts[i], pts[(i + 1) % len(pts)]
        L = math.hypot(x1 - x0, d1 - d0)
        n = (d1 - d0) / L, -(x1 - x0) / L
        out.append(n if area > 0 else (-n[0], -n[1]))
    return out


def band(b, p0, p1, n, z0, z1, m, off=0.012):
    a = (p0[0] + n[0] * off, p0[1] + n[1] * off)
    c = (p1[0] + n[0] * off, p1[1] + n[1] * off)
    b.quad([(a[0], a[1], z0), (c[0], c[1], z0), (c[0], c[1], z1), (a[0], a[1], z1)], m, normal=N(n[0], n[1], 0))


def railing(b, C, p0, p1, n, z, inset=0.12, step=1.3):
    a = (p0[0] - n[0] * inset, p0[1] - n[1] * inset)
    c = (p1[0] - n[0] * inset, p1[1] - n[1] * inset)
    L = math.hypot(c[0] - a[0], c[1] - a[1])
    k = max(1, math.ceil(L / step))
    for i in range(k + 1):
        t = i / k
        x, d = a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t
        b.box(x - 0.04, x + 0.04, d - 0.04, d + 0.04, z, z + 0.95, C["metal"])
    b.quad([(a[0], a[1], z + 0.12), (c[0], c[1], z + 0.12), (c[0], c[1], z + 0.88), (a[0], a[1], z + 0.88)], C["holo"])
    b.beam((a[0], a[1], z + 0.95), (c[0], c[1], z + 0.95), 0.07, C["neon"])


def text(coll, sc, name, body, loc, rot, size, m, align="CENTER"):
    cu = bpy.data.curves.new(name + "_cu", "FONT")
    cu.body, cu.size, cu.extrude = body, size, 0.0
    cu.resolution_u = 2
    cu.align_x, cu.align_y = align, "CENTER"
    tmp = bpy.data.objects.new(name + "_tmp", cu)
    bpy.context.scene.collection.objects.link(tmp)     # evaluate in the active scene (always has a depsgraph)
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.curves.remove(cu)
    me.name = name
    me.materials.clear()
    me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    ob.location, ob.rotation_euler = V(*loc), rot
    coll.objects.link(ob)
    return ob


FACE_BACK = (math.pi / 2, 0, 0)               # text on the back wall, readable from the room
FACE_WINDOW = (math.pi / 2, 0, math.pi / 2)   # text on the window wall, readable from the room


def anchor(coll, name, x, d, z):
    e = bpy.data.objects.new("Anchor_" + name, None)
    e.empty_display_type, e.empty_display_size = "PLAIN_AXES", 0.4
    e.location = V(x, d, z)
    coll.objects.link(e)
    return e


# --------------------------------------------------------------------------- scene
def get_scene():
    sc = bpy.data.scenes.get(SCENE)
    if sc:
        for o in list(sc.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        for c in list(sc.collection.children_recursive):
            bpy.data.collections.remove(c)
    else:
        sc = bpy.data.scenes.new(SCENE)
    for blocks in (bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
        for blk in list(blocks):
            if blk.users == 0 and blk.name.startswith(PREFIXES + ("OF_",)):
                blocks.remove(blk)
    try:
        bpy.context.window.scene = sc
    except Exception:
        pass
    return sc


ROOM_COLLS = {}


def new_coll(name, parent):
    c = bpy.data.collections.new(name)
    parent.children.link(c)
    return c


# --------------------------------------------------------------------------- room parts
def build_floor(C, col):
    # slab and tiles are cut separately: a boolean on touching boxes in one mesh drops the slab
    sl = B("Room_FloorSlab", col)
    sl.box(-WT, W + WT, -WT, D + WT, -0.5, 0.0, C["slab"])
    cut_pit(sl.finish())
    b = B("Room_Floor", col)
    for i in range(8):
        for j in range(6):
            b.box(i * 2 + 0.03, i * 2 + 1.97, j * 2 + 0.03, j * 2 + 1.97, 0.0, 0.05, C["floor"])
    cut_pit(b.finish())

    b = B("Room_FloorNeon", col)
    z0, z1 = 0.05, 0.065
    desk_x = [(c - 0.4, c + 0.4) for c in DESK_COLS]
    aisles = [(a1 + b0) / 2 for (_, a1), (b0, _) in zip(desk_x, desk_x[1:])]     # between desk columns
    pad_edge = PADS[0][0] - 0.55
    lane_x = (desk_x[-1][1] + pad_edge) / 2                                     # between the desks and the pads
    walk_d = (max(STAIRS_BOTTOM, DECK_RIGHT) + DESK_ROWS[0] - 0.8) / 2           # walkway: deck/stairs -> desks

    # edge lights, only in the gaps between furniture
    front = [(1.6, 3.0), (3.4, 4.8)] + [(a - 0.3, a + 0.3) for a in aisles] + [(desk_x[-1][1] + 0.4, pad_edge - 0.4)]
    for x0, x1 in front:
        b.box(x0, x1, D - 0.42, D - 0.28, z0, z1, C["neon"])
    b.box(W - 0.42, W - 0.28, DECK_RIGHT + 0.3, PADS[0][1] - 0.75, z0, z1, C["neon"])
    for d0, d1 in ((4.3, 5.4), (6.4, 7.4), (10.3, 10.9)):
        b.box(0.3, 0.44, d0, d1, z0, z1, C["neon"])

    # circuit traces: walkway + aisles + pad feeds, never under a desk, pad or the stairs
    traces = [
        [(HOLO_C[0] + math.sqrt((HOLO_R + 0.15) ** 2 - (walk_d - HOLO_C[1]) ** 2), walk_d), (lane_x, walk_d), (lane_x, PADS[-1][1] + 0.05)],   # walkway
        [((STAIRS_X[0] + STAIRS_X[1]) / 2, STAIRS_BOTTOM + 0.1), ((STAIRS_X[0] + STAIRS_X[1]) / 2, walk_d)],
        [(aisles[0], walk_d), (aisles[0], D - 0.7)],
        [(aisles[1], walk_d), (aisles[1], DESK_ROWS[0] - 0.4)],
        [(aisles[2], walk_d), (aisles[2], D - 0.7)],
        *[[(lane_x, d), (pad_edge - 0.05, d)] for _, d in PADS],              # power to each charging pad
        [(HOLO_C[0] - 0.3, HOLO_C[1] + HOLO_R + 0.15), (HOLO_C[0] - 0.3, 10.2), (4.6, 10.2), (4.6, 11.3)],   # holo ring -> front
        [(HOLO_C[0] + 0.8, HOLO_C[1] + HOLO_R + 0.05), (HOLO_C[0] + 0.8, 9.5), (5.4, 9.5)],
        [(1.2, 1.8), (3.6, 1.8), (3.6, 3.0)],                                 # archive -> bench
        [(5.2, 1.6), (5.2, 3.2), (6.0, 3.2)],
    ]
    w = 0.035
    for path in traces:
        for (x0, d0), (x1, d1) in zip(path, path[1:]):
            b.box(min(x0, x1) - w, max(x0, x1) + w, min(d0, d1) - w, max(d0, d1) + w, z0, z1 - 0.007, C["neon_s"])
        for x, d in (path[0], path[-1]):
            b.cyl(x, d, 0.09, z0, z1 - 0.004, C["neon_s"], n=12)
    b.finish()


def build_walls(C, col):
    b = B("Room_Walls", col)
    # back wall (d = 0) and window wall (x = 0)
    b.box(-WT, W + WT, -WT, 0, 0, H, C["wall"])
    b.box(-WT, 0, 0, 1.4, 0, H, C["wall"])
    b.box(-WT, 0, 10.2, D + WT, 0, H, C["wall"])
    b.box(-WT, 0, 1.4, 10.2, 0, 0.35, C["wall"])
    b.box(-WT, 0, 1.4, 10.2, 5.0, H, C["wall"])
    # mullions + little status lights
    for k in range(6):
        d = 1.4 + k * 1.76
        b.box(-WT, 0.12, d - 0.11, d + 0.11, 0.0, H - 0.1, C["metal"])
        b.box(0.12, 0.15, d - 0.04, d + 0.04, 0.9, 1.3, C["neon"])
    b.box(-0.05, 0.18, 1.4, 10.2, 0.30, 0.40, C["metal"])      # sill cap
    b.box(-0.05, 0.14, 1.4, 10.2, 4.92, 5.05, C["metal"])      # header cap
    # skirting + top caps
    b.box(0, W, 0, 0.08, 0, 0.18, C["dark"])
    b.box(0, 0.08, 0, 1.4, 0, 0.18, C["dark"])
    b.box(0, 0.08, 10.2, D, 0, 0.18, C["dark"])
    b.box(-WT, W + WT, -WT, 0.12, H - 0.15, H + 0.05, C["metal"])
    b.box(-WT, 0.12, -WT, D + WT, H - 0.15, H + 0.05, C["metal"])
    # wall ribs and the right-hand corner trim
    for x in (9.85, 14.05):
        b.box(x - 0.06, x + 0.06, 0, 0.1, 0.18, H - 0.15, C["metal"])
    b.box(W, W + WT, -WT, 0.1, 0, H + 0.05, C["metal"])
    b.box(-WT, 0.1, D, D + WT, 0, H + 0.05, C["metal"])
    # pipes along the top of the back wall + neon line
    b.beam((0.2, 0.18, 5.12), (W, 0.18, 5.12), 0.12, C["metal"])
    b.box(6.0, W, 0.03, 0.07, 4.86, 4.92, C["neon"])
    b.beam((0.18, 0.2, 5.0), (0.18, D - 0.2, 5.0), 0.1, C["metal"])
    b.finish()

    g = B("Room_WindowGlass", col)
    for k in range(5):
        d0, d1 = 1.4 + k * 1.76 + 0.11, 1.4 + (k + 1) * 1.76 - 0.11
        g.quad([(-0.15, d0, 0.4), (-0.15, d1, 0.4), (-0.15, d1, 4.95), (-0.15, d0, 4.95)], C["glass"])
    g.finish()


def build_bench(C, col):
    b = B("Fx_Bench", col)
    b.box(0.5, 0.8, 0, 0.55, 0, 4.6, C["metal"])
    b.box(5.3, 5.6, 0, 0.55, 0, 4.6, C["metal"])
    b.box(0.5, 5.6, 0, 0.55, 4.3, 4.6, C["metal"])
    b.box(0.8, 5.3, 0, 0.04, 0.2, 4.3, C["dark"])
    b.box(0.8, 0.84, 0.42, 0.5, 0.3, 4.25, C["neon_s"])
    b.box(5.26, 5.3, 0.42, 0.5, 0.3, 4.25, C["neon_s"])
    b.box(1.0, 5.1, 0.0, 1.25, 1.02, 1.12, C["light"])          # counter top (coffee machines go here)
    b.box(1.0, 5.1, 1.2, 1.27, 0.92, 1.02, C["neon"])           # glowing lip
    b.box(1.05, 5.05, 0.1, 1.15, 0.30, 0.36, C["metal"])        # lower shelf
    for x in (1.1, 4.95):
        for d in (0.15, 1.08):
            b.box(x - 0.06, x + 0.06, d - 0.06, d + 0.06, 0, 1.02, C["metal"])
    b.box(1.0, 5.1, 0.0, 0.85, 2.55, 2.63, C["light"])          # upper shelf
    for x in (1.2, 4.9):
        b.box(x - 0.04, x + 0.04, 0.0, 0.8, 2.3, 2.55, C["metal"])
    b.finish()


def build_walltech(C, col):
    b = B("Fx_WallTech", col)
    # two terminals left of the deck
    for z0, z1 in ((3.0, 3.8), (1.9, 2.6)):
        b.box(5.85, 6.45, 0, 0.18, z0, z1, C["metal"])
        b.quad([(5.92, 0.185, z0 + 0.1), (6.38, 0.185, z0 + 0.1), (6.38, 0.185, z1 - 0.1), (5.92, 0.185, z1 - 0.1)], C["scr_green"], normal=N(0, 1, 0))
    b.beam((6.72, 0.12, 0.0), (6.72, 0.12, 5.05), 0.06, C["neon_s"])
    # corner terminal on the window wall + antenna
    b.box(0, 0.25, 0.35, 1.05, 2.8, 4.0, C["metal"])
    b.quad([(0.255, 0.45, 3.2), (0.255, 0.95, 3.2), (0.255, 0.95, 3.85), (0.255, 0.45, 3.85)], C["scr_green"], normal=N(1, 0, 0))
    for d in (0.5, 0.65, 0.8):
        b.box(0.255, 0.27, d - 0.04, d + 0.04, 2.9, 3.05, C["green"])
    b.cyl(0.12, 0.5, 0.025, 4.0, 4.6, C["metal"], n=8)
    b.finish()


DECK_GROW = 1.4                      # extra depth (d) of the command deck; the stairs and nav ramp follow it
DECK_FRONT = 3.6 + DECK_GROW         # front edge of the deck's main strip (stairs start here)
DECK_RIGHT = 5.6 + DECK_GROW         # front edge of the deck's right-hand extension
STAIRS_X = (7.2, 8.8)
STAIRS_BOTTOM = DECK_FRONT + 1.6     # 4 steps x 0.4
DECK_PTS = [(6.6, 0.0), (16.0, 0.0), (16.0, DECK_RIGHT), (12.4, DECK_RIGHT), (11.8, DECK_RIGHT - 0.6),
            (11.8, DECK_FRONT), (7.2, DECK_FRONT), (6.6, DECK_FRONT - 0.6)]


def build_deck(C, col):
    b = B("Fx_CommandDeck", col)
    b.prism(DECK_PTS, 0.0, DECK_H - 0.06, C["dark"])
    b.prism(DECK_PTS, DECK_H - 0.06, DECK_H, C["metal"], top=C["floor"])
    norms = poly_normals(DECK_PTS)
    for i, n in enumerate(norms):
        p0, p1 = DECK_PTS[i], DECK_PTS[(i + 1) % len(DECK_PTS)]
        if p0[1] == 0 and p1[1] == 0:
            continue                       # against the back wall
        band(b, p0, p1, n, 0.42, 0.5, C["neon"])
        band(b, p0, p1, n, 0.12, 0.16, C["neon_s"])
    # railings: every edge except the back wall, with a gap for the stairs
    sx0, sx1 = STAIRS_X
    rails = [((6.6, 0.25), (6.6, DECK_FRONT - 0.6), (-1, 0)), ((6.6, DECK_FRONT - 0.6), (sx0, DECK_FRONT), (-0.7071, 0.7071)),
             ((sx1, DECK_FRONT), (11.8, DECK_FRONT), (0, 1)), ((11.8, DECK_FRONT), (11.8, DECK_RIGHT - 0.6), (-1, 0)),
             ((11.8, DECK_RIGHT - 0.6), (12.4, DECK_RIGHT), (-0.7071, 0.7071)), ((12.4, DECK_RIGHT), (16.0, DECK_RIGHT), (0, 1)),
             ((16.0, DECK_RIGHT), (16.0, 0.3), (1, 0))]
    for p0, p1, n in rails:
        railing(b, C, p0, p1, n, DECK_H)
    b.finish()

    s = B("Fx_Stairs", col)
    for i in range(4):
        d0, top = DECK_FRONT + 0.4 * i, 0.8 - 0.2 * i
        s.box(sx0, sx1, d0, d0 + 0.4, 0.0, top, C["metal"])
        s.box(sx0 + 0.05, sx1 - 0.05, d0 + 0.37, d0 + 0.405, top - 0.05, top - 0.012, C["neon"])
    for x in (sx0 + 0.07, sx1 - 0.07):
        s.box(x - 0.04, x + 0.04, STAIRS_BOTTOM + 0.01, STAIRS_BOTTOM + 0.09, 0.0, 0.95, C["metal"])
        s.quad([(x, DECK_FRONT, DECK_H + 0.12), (x, STAIRS_BOTTOM + 0.05, 0.12), (x, STAIRS_BOTTOM + 0.05, 0.88), (x, DECK_FRONT, DECK_H + 0.88)], C["holo"])
        s.beam((x, DECK_FRONT - 0.12, DECK_H + 0.95), (x, STAIRS_BOTTOM + 0.05, 0.95), 0.07, C["neon"])
    s.finish()

    p = B("Fx_ChargingPads", col)
    for x, d in PADS:
        p.box(x - 0.55, x + 0.55, d - 0.55, d + 0.55, PAD_Z, PAD_Z + 0.08, C["metal"])
        p.box(x - 0.42, x + 0.42, d - 0.42, d + 0.42, PAD_Z + 0.08, PAD_Z + 0.1, C["pad"])
        p.cyl(x, d, 0.42, PAD_Z + 0.1, PAD_Z + 0.75, C["holo_f"], n=24, r2=0.3)
    p.finish()


def build_console(C, col):
    rnd = random.Random(3)
    b = B("Fx_Console", col)
    b.box(10.2, 15.4, 0.0, 1.5, DECK_H, DECK_H + 1.05, C["metal"])
    b.box(10.15, 15.45, 0.0, 1.56, DECK_H + 1.05, DECK_H + 1.13, C["light"])
    leds = [C["green"], C["neon"], C["amber"], C["green"]]
    for k in range(8):
        x0 = 10.4 + k * 0.6
        b.box(x0, x0 + 0.55, 1.5, 1.53, DECK_H + 0.1, DECK_H + 0.95, C["dark"])
        for z in (0.75, 0.6, 0.45, 0.3):
            if rnd.random() < 0.8:
                L = rnd.uniform(0.12, 0.38)
                b.box(x0 + 0.08, x0 + 0.08 + L, 1.53, 1.545, DECK_H + z, DECK_H + z + 0.04, rnd.choice(leds))
    b.box(10.2 - 0.03, 10.2, 0.2, 1.3, DECK_H + 0.15, DECK_H + 0.9, C["dark"])
    # approval terminal on the right end
    zt = DECK_H + 1.13
    b.box(14.3, 15.0, 0.5, 1.2, zt, zt + 0.32, C["metal"])
    b.quad([(14.35, 1.15, zt + 0.34), (14.95, 1.15, zt + 0.34), (14.95, 0.75, zt + 0.75), (14.35, 0.75, zt + 0.75)], C["scr_green"], normal=N(0, 1, 1))
    for i in range(3):
        for j in range(3):
            b.box(14.4 + i * 0.18, 14.52 + i * 0.18, 1.2, 1.215, zt + 0.06 + j * 0.08, zt + 0.11 + j * 0.08, C["neon_s"])
    for x in (14.45, 14.6, 14.75):
        b.cyl(x, 0.6, 0.03, zt + 0.32, zt + 0.7, C["metal"], n=8)
    b.finish()


def build_door(coll, sc, C, col):
    b = B("Fx_Door", col)
    z0, z1 = DECK_H, DECK_H + 2.75
    b.box(7.2, 7.4, 0, 0.22, z0, z1 + 0.25, C["metal"])
    b.box(9.0, 9.2, 0, 0.22, z0, z1 + 0.25, C["metal"])
    b.box(7.2, 9.2, 0, 0.22, z1, z1 + 0.25, C["metal"])
    b.box(7.4, 9.0, 0, 0.1, z0, z1, C["light"])
    b.box(7.36, 7.4, 0.1, 0.22, z0, z1, C["neon"])
    b.box(9.0, 9.04, 0.1, 0.22, z0, z1, C["neon"])
    b.box(7.4, 9.0, 0.1, 0.22, z1 - 0.04, z1, C["neon"])
    for z in (z0 + 0.9, z0 + 1.6):
        b.box(7.5, 8.9, 0.1, 0.11, z, z + 0.03, C["dark"])
    # CLAUDE sign
    b.box(7.6, 8.8, 0.1, 0.14, z1 - 0.62, z1 - 0.25, C["screen"])
    for zz in (z1 - 0.62, z1 - 0.28):
        b.box(7.6, 8.8, 0.14, 0.15, zz, zz + 0.03, C["neon"])
    b.box(7.7, 7.84, 0.14, 0.155, z1 - 0.5, z1 - 0.36, C["red"])
    # side panel with robot glyph
    b.box(9.3, 9.6, 0, 0.08, z0 + 1.0, z0 + 1.6, C["dark"])
    b.quad([(9.34, 0.085, z0 + 1.08), (9.56, 0.085, z0 + 1.08), (9.56, 0.085, z0 + 1.52), (9.34, 0.085, z0 + 1.52)], C["scr_green"], normal=N(0, 1, 0))
    b.finish()
    text(coll, sc, "Txt_DoorSign", "CLAUDE", (8.36, 0.16, z1 - 0.435), FACE_BACK, 0.2, C["neon"])


def build_boards(coll, sc, C, col):
    b = B("Fx_KanbanBoard", col)
    x0, x1, z0, z1, d = 10.8, 13.9, 2.75, 4.55, 0.4
    b.quad([(x0, d, z0), (x1, d, z0), (x1, d, z1), (x0, d, z1)], C["holo"])
    for p, q in (((x0, d, z0), (x1, d, z0)), ((x0, d, z1), (x1, d, z1)), ((x0, d, z0), (x0, d, z1)), ((x1, d, z0), (x1, d, z1))):
        b.beam(p, q, 0.035, C["neon"])
    for x in (11.83, 12.86):
        b.beam((x, d, z0 + 0.1), (x, d, z1 - 0.1), 0.02, C["neon_s"])
    b.beam((x0 + 0.05, d, 4.25), (x1 - 0.05, d, 4.25), 0.02, C["neon_s"])
    stickies = [(11.15, 3.85), (11.45, 3.45), (11.2, 3.05), (12.15, 3.85), (12.55, 3.75), (12.2, 3.3),
                (12.6, 3.0), (13.25, 3.8), (13.55, 3.5), (13.3, 3.15), (13.6, 2.95)]
    cols = [C["s_yellow"], C["s_green"], C["s_pink"], C["s_blue"]]
    for i, (x, z) in enumerate(stickies):
        b.box(x - 0.12, x + 0.12, d + 0.01, d + 0.03, z - 0.1, z + 0.1, cols[i % 4])
    b.box(12.1, 12.6, 0.0, 0.6, 2.45, 2.6, C["metal"])          # projector arm
    b.finish()
    for label, x in (("TO DO", 11.32), ("IN PROGRESS", 12.35), ("DONE", 13.38)):
        text(coll, sc, "Txt_Kanban_" + label.replace(" ", ""), label, (x, d + 0.02, 4.38), FACE_BACK, 0.11, C["neon_s"])

    s = B("Fx_StatusScreens", col)
    s.box(14.3, 15.7, 0, 0.08, 3.75, 4.6, C["metal"])
    s.quad([(14.35, 0.085, 3.8), (15.65, 0.085, 3.8), (15.65, 0.085, 4.55), (14.35, 0.085, 4.55)], C["screen"], normal=N(0, 1, 0))
    for z, m in ((4.35, C["green"]), (4.12, C["green"]), (3.9, C["red"])):
        s.box(14.45, 14.57, 0.086, 0.1, z - 0.05, z + 0.05, m)
        s.box(14.75, 15.45, 0.086, 0.095, z - 0.02, z + 0.02, C["neon_s"])
    s.quad([(14.3, 0.3, 2.75), (15.7, 0.3, 2.75), (15.7, 0.3, 3.55), (14.3, 0.3, 3.55)], C["holo"])
    rnd = random.Random(5)
    for k in range(7):
        x = 14.42 + k * 0.1
        h = rnd.uniform(0.1, 0.45)
        s.box(x, x + 0.06, 0.31, 0.32, 2.85, 2.85 + h, rnd.choice([C["amber"], C["red"], C["neon"]]))
    pts = [(15.15, 2.95), (15.3, 3.2), (15.42, 3.05), (15.6, 3.4)]
    for (xa, za), (xb, zb) in zip(pts, pts[1:]):
        s.beam((xa, 0.31, za), (xb, 0.31, zb), 0.02, C["neon"])
    s.finish()


def build_holo(C, col):
    cx, cd = HOLO_C
    b = B("Fx_HoloRing", col)
    # raised outer band around the pit, cyan on both top edges
    b.annulus(cx, cd, PIT_R, HOLO_R, 0.0, 0.12, C["metal"])
    b.annulus(cx, cd, HOLO_R - 0.13, HOLO_R - 0.05, 0.12, 0.13, C["neon"])
    b.annulus(cx, cd, PIT_R, PIT_R + 0.06, 0.12, 0.13, C["neon"])
    b.annulus(cx, cd, HOLO_R, HOLO_R + 0.02, 0.03, 0.08, C["neon_s"])             # outer side glow
    # pit wall down to the step, with a glow strip under the lip
    b.annulus(cx, cd, PIT_R - 0.04, PIT_R, STEP_Z, 0.12, C["dark"])
    b.annulus(cx, cd, PIT_R - 0.05, PIT_R - 0.04, -0.02, 0.03, C["neon"])
    # one step down, then the pit floor
    b.annulus(cx, cd, STEP_R, PIT_R - 0.04, PIT_Z, STEP_Z, C["metal"])
    b.annulus(cx, cd, STEP_R - 0.01, STEP_R, STEP_Z - 0.06, STEP_Z - 0.03, C["neon_s"])
    b.cyl(cx, cd, STEP_R, PIT_Z - 0.05, PIT_Z, C["floor"], n=64)
    b.annulus(cx, cd, 1.18, 1.24, PIT_Z, PIT_Z + 0.012, C["neon_s"], n=48)
    for k in range(4):
        a = k * math.pi / 2
        b.beam((cx + 0.85 * math.cos(a), cd + 0.85 * math.sin(a), PIT_Z + 0.006),
               (cx + 1.55 * math.cos(a), cd + 1.55 * math.sin(a), PIT_Z + 0.006), 0.035, C["neon_s"], h=0.012)
    # pedestal rising out of the pit, with four buttresses
    top = PIT_Z + 0.62
    b.cyl(cx, cd, 0.62, PIT_Z, top, C["metal"], n=32)
    b.annulus(cx, cd, 0.62, 0.66, top - 0.2, top - 0.14, C["neon"], n=32)
    b.cyl(cx, cd, 0.46, top, top + 0.03, C["pad"], n=32)
    b.annulus(cx, cd, 0.5, 0.6, top, top + 0.02, C["dark"], n=32)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        x, d = cx + 0.72 * math.cos(a), cd + 0.72 * math.sin(a)
        b.box(x - 0.12, x + 0.12, d - 0.12, d + 0.12, PIT_Z, top - 0.08, C["metal"])
        b.box(x - 0.13, x + 0.13, d - 0.13, d + 0.13, top - 0.12, top - 0.08, C["neon_s"])
    # light column + globe
    b.cyl(cx, cd, 0.44, top + 0.03, top + 0.75, C["holo_f"], n=24, r2=0.3)
    b.sphere(cx, cd, top + 0.85, 0.38, C["holo"])
    b.annulus(cx, cd, 0.44, 0.46, top + 0.84, top + 0.86, C["neon_s"], n=32)
    b.finish()

    s = B("Fx_HoloScreen", col)
    sx, sd = HOLO_SCREEN_C
    a0, a1, r = math.radians(128), math.radians(238), 2.95
    s.arc_strip(sx, sd, r, a0, a1, 1.25, 3.2, C["holo"])
    s.annulus(sx, sd, r - 0.02, r + 0.02, 3.2, 3.23, C["neon"], n=24, a0=a0, a1=a1)
    s.annulus(sx, sd, r - 0.02, r + 0.02, 1.22, 1.25, C["neon"], n=24, a0=a0, a1=a1)
    rnd = random.Random(9)
    for k in range(9):
        aa = rnd.uniform(a0 + 0.08, a1 - 0.5)
        z = rnd.uniform(1.45, 2.95)
        s.arc_strip(sx, sd, r - 0.03, aa, aa + rnd.uniform(0.12, 0.4), z, z + 0.04, C["neon_s"], n=4)
    s.finish()


def cut_pit(ob):
    """Cut the round holo pit out of the floor (boolean, baked into the mesh)."""
    cx, cd = HOLO_C
    cb = bmesh.new()
    bmesh.ops.create_cone(cb, cap_ends=True, segments=64, radius1=PIT_R, radius2=PIT_R, depth=0.7,
                          matrix=Matrix.Translation(V(cx, cd, PIT_Z - 0.05 + 0.35)))
    cme = bpy.data.meshes.new("Room_PitCutter")
    cb.to_mesh(cme)
    cb.free()
    cutter = bpy.data.objects.new("Room_PitCutter", cme)
    bpy.context.scene.collection.objects.link(cutter)
    mod = ob.modifiers.new("pit", "BOOLEAN")
    mod.operation, mod.object = "DIFFERENCE", cutter
    for solver in ("EXACT", "MANIFOLD", "FLOAT"):
        try:
            mod.solver = solver
            break
        except TypeError:
            pass
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    old = ob.data
    ob.modifiers.remove(mod)
    ob.data = me
    bpy.data.meshes.remove(old)
    me.name = ob.name
    while len(me.materials) and me.materials[-1] is None:      # boolean adds an empty slot for the cutter
        me.materials.pop()
    bpy.data.objects.remove(cutter, do_unlink=True)
    bpy.data.meshes.remove(cme)

def build_poster(coll, sc, C, col):
    b = B("Fx_ShipItPoster", col)
    b.box(0, 0.08, 10.55, 11.85, 2.2, 3.75, C["screen"])
    b.quad([(0.085, 10.62, 2.27), (0.085, 11.78, 2.27), (0.085, 11.78, 3.68), (0.085, 10.62, 3.68)], C["poster"], normal=N(1, 0, 0))
    for p, q in (((0.09, 10.55, 2.2), (0.09, 11.85, 2.2)), ((0.09, 10.55, 3.75), (0.09, 11.85, 3.75)),
                 ((0.09, 10.55, 2.2), (0.09, 10.55, 3.75)), ((0.09, 11.85, 2.2), (0.09, 11.85, 3.75))):
        b.beam(p, q, 0.03, C["neon"])
    # rocket
    b.cyl(0.16, 11.2, 0.07, 2.85, 3.3, C["white"], n=16)
    b.cyl(0.16, 11.2, 0.07, 3.3, 3.46, C["red"], n=16, r2=0.0)
    b.cyl(0.16, 11.2, 0.012, 2.66, 2.85, C["amber"], n=12, r2=0.06)
    for dd in (-0.1, 0.1):
        b.box(0.14, 0.18, 11.2 + dd - 0.03, 11.2 + dd + 0.03, 2.85, 3.0, C["red"])
    # red LED sign above
    b.box(0, 0.06, 10.5, 11.9, 4.1, 4.45, C["dark"])
    for k in range(5):
        b.box(0.06, 0.07, 10.6 + k * 0.2, 10.75 + k * 0.2, 4.22, 4.3, C["red"])
    b.box(0.06, 0.07, 11.7, 11.8, 4.16, 4.38, C["red"])
    # extinguisher + small status panel
    b.cyl(0.22, 11.05, 0.15, 0.1, 0.85, C["ext"], n=20)
    b.cyl(0.22, 11.05, 0.06, 0.85, 0.95, C["metal"], n=12)
    b.box(0.2, 0.36, 11.0, 11.1, 0.93, 0.97, C["metal"])
    b.box(0, 0.06, 10.9, 11.2, 0.6, 0.66, C["metal"])
    b.box(0, 0.06, 11.45, 11.65, 0.6, 1.2, C["dark"])
    for z, m in ((1.05, C["green"]), (0.9, C["red"]), (0.75, C["amber"])):
        b.box(0.06, 0.075, 11.5, 11.6, z - 0.04, z + 0.04, m)
    b.finish()
    text(coll, sc, "Txt_ShipIt", "SHIP IT", (0.1, 11.2, 2.45), FACE_WINDOW, 0.2, C["txt_white"])


def build_city(C, col):
    rnd = random.Random(17)
    bl, li = B("City_Blocks", col), B("City_Lights", col)
    for xn in (3.5, 8.0, 13.0, 18.0, 24.0, 30.0):
        d = -xn
        while True:
            sx, sd = rnd.uniform(2.2, 4.0), rnd.uniform(2.2, 4.0)
            xf = xn + sx                       # far face sets the limits (sight line rises 0.816 per metre)
            d1 = min(d + sd, 12.0 - xf)
            if d1 - d < 1.2:
                break
            # every block stays inside the window's sight-line wedge, so from the iso camera the city
            # only appears through the windows and never pokes out around the room
            top = 5.0 - 0.82 * xf - rnd.uniform(0.0, 3.5)
            x1, x0 = -xn, -xn - sx
            bl.box(x0, x1, d, d1, 0.25 - 0.82 * xn, top, C["city"])
            lm = rnd.choice([C["city_c"], C["city_p"], C["city_a"], C["city_c"]])
            z, k = top - 0.35, 0
            while k < 10 and z > 0.4 - 0.82 * xn:
                lm = rnd.choice([C["city_c"], C["city_p"], C["city_a"], C["city_c"], lm])
                if rnd.random() < 0.8:
                    li.quad([(x1 + 0.02, d + 0.2, z), (x1 + 0.02, d1 - 0.2, z), (x1 + 0.02, d1 - 0.2, z + 0.18), (x1 + 0.02, d + 0.2, z + 0.18)], lm, normal=N(1, 0, 0))
                if rnd.random() < 0.8:
                    li.quad([(x0 + 0.2, d1 + 0.02, z), (x1 - 0.2, d1 + 0.02, z), (x1 - 0.2, d1 + 0.02, z + 0.18), (x0 + 0.2, d1 + 0.02, z + 0.18)], lm, normal=N(0, 1, 0))
                z -= rnd.uniform(0.45, 0.9)
                k += 1
            d = d1 + rnd.uniform(0.6, 1.6)
    # glowing horizon band far out, inside the same sight-line limits
    bl.quad([(-32.0, -31.5, -26.4), (-32.0, -19.8, -26.4), (-32.0, -19.8, -21.3), (-32.0, -31.5, -21.3)], C["haze"], normal=N(1, 0, 0))
    bl.finish()
    li.finish()


def build_anchors(col):
    spots = {
        "Door": (8.2, 0.9, DECK_H), "Pad_1": (*PADS[0], PAD_Z + 0.1), "Pad_2": (*PADS[1], PAD_Z + 0.1),
        "Pad_3": (*PADS[2], PAD_Z + 0.1), "CEO_Desk": (DESK_DECK[0] + 0.75, DESK_DECK[1], DECK_H), "Approval_Terminal": (14.6, 2.0, DECK_H),
        "Stairs_Top": (8.0, DECK_FRONT - 0.4, DECK_H), "Stairs_Bottom": (8.0, STAIRS_BOTTOM + 0.6, 0.05),
        "Coffee_1": (2.2, 1.75, 0.05), "Coffee_2": (3.9, 1.75, 0.05),
    }
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        spots["HoloRing_%d" % (k + 1)] = (HOLO_C[0] + 1.25 * math.cos(k * math.pi / 2), HOLO_C[1] + 1.25 * math.sin(k * math.pi / 2), PIT_Z)
    for name, (x, d, z) in spots.items():
        anchor(col, name, x, d, z)


def build_nav(C, col):
    b = B("NAV_Walkable", col)
    # floor with a round hole over the holo pit: quads between the pit rim and the room edge
    cx, cd = HOLO_C
    x0, x1, d0, d1 = 0.2, W - 0.2, 0.2, D - 0.2
    corners = [math.atan2(d - cd, x - cx) % (2 * math.pi) for x, d in ((x0, d0), (x1, d0), (x1, d1), (x0, d1))]
    angs = sorted(set([i * 2 * math.pi / 64 for i in range(64)] + corners))

    def edge_pt(a):
        ca, sa = math.cos(a), math.sin(a)
        ts = [t for t in ((x1 - cx) / ca if ca > 1e-9 else None, (x0 - cx) / ca if ca < -1e-9 else None,
                          (d1 - cd) / sa if sa > 1e-9 else None, (d0 - cd) / sa if sa < -1e-9 else None) if t is not None]
        t = min(ts)
        return cx + t * ca, cd + t * sa

    for a, a2 in zip(angs, angs[1:] + angs[:1]):
        (ox, od), (ox2, od2) = edge_pt(a), edge_pt(a2)
        b.quad([(cx + PIT_R * math.cos(a), cd + PIT_R * math.sin(a), 0.05), (cx + PIT_R * math.cos(a2), cd + PIT_R * math.sin(a2), 0.05),
                (ox2, od2, 0.05), (ox, od, 0.05)], C["neon_s"], normal=N(0, 0, 1))
    # into the pit: a sloped ring (the step) and the pit floor
    n = 48
    ring = [(math.cos(i * 2 * math.pi / n), math.sin(i * 2 * math.pi / n)) for i in range(n)]
    for (c0, s0), (c1, s1) in zip(ring, ring[1:] + ring[:1]):
        b.quad([(cx + PIT_R * c0, cd + PIT_R * s0, 0.05), (cx + PIT_R * c1, cd + PIT_R * s1, 0.05),
                (cx + STEP_R * c1, cd + STEP_R * s1, PIT_Z), (cx + STEP_R * c0, cd + STEP_R * s0, PIT_Z)], C["neon_s"], normal=N(0, 0, 1))
    b.quad([(cx + STEP_R * c, cd + STEP_R * sn, PIT_Z) for c, sn in ring], C["neon_s"], normal=N(0, 0, 1))

    top = [(x, d, DECK_H) for x, d in DECK_PTS]
    b.quad(top, C["neon_s"], normal=N(0, 0, 1))
    b.quad([(7.3, DECK_FRONT, DECK_H), (8.7, DECK_FRONT, DECK_H), (8.7, STAIRS_BOTTOM, 0.05), (7.3, STAIRS_BOTTOM, 0.05)], C["neon_s"], normal=N(0, 0, 1))
    ob = b.finish()
    ob.display_type = "WIRE"
    ob.hide_render = True


def build_preview_rig(sc, col):
    cam_data = bpy.data.cameras.new("OF_IsoCam")
    cam_data.type, cam_data.ortho_scale, cam_data.clip_end = "ORTHO", 26.5, 300
    cam = bpy.data.objects.new("OF_IsoCam", cam_data)
    cam.rotation_euler = (math.radians(60), 0, math.radians(45))
    fwd = cam.rotation_euler.to_matrix() @ Vector((0, 0, -1))
    cam.location = V(8.0, 6.3, 1.4) - fwd * 80
    col.objects.link(cam)
    sc.camera = cam

    def light(name, kind, loc, energy, color, size=None):
        ld = bpy.data.lights.new(name, kind)
        ld.energy, ld.color = energy, color
        if size and kind == "AREA":
            ld.size = size
        ob = bpy.data.objects.new(name, ld)
        ob.location = V(*loc)
        col.objects.link(ob)
        return ob

    light("OF_Key", "AREA", (8, 6, 14), 1500, (0.7, 0.82, 1.0), size=22)
    light("OF_RingGlow", "POINT", (HOLO_C[0], HOLO_C[1], 1.3), 180, (0.3, 0.85, 1.0))
    light("OF_PadGlow", "POINT", (PADS[1][0], PADS[1][1], 2.0), 140, (0.3, 0.9, 1.0))
    light("OF_DoorGlow", "POINT", (8.2, 1.2, 3.6), 90, (0.4, 0.85, 1.0))
    light("OF_BenchGlow", "POINT", (3.0, 1.2, 2.9), 90, (0.4, 0.85, 1.0))
    light("OF_CityGlow", "AREA", (0.6, 6.0, 2.8), 220, (0.5, 0.65, 1.0), size=6)
    light("OF_DeskGlow", "POINT", (7.5, 10.2, 2.4), 120, (0.4, 0.85, 1.0))

    world = bpy.data.worlds.get("OF_World") or bpy.data.worlds.new("OF_World")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.012, 0.016, 0.03, 1)
        bg.inputs[1].default_value = 1.0
    sc.world = world


def setup_render(sc):
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            pass
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1600, 1200, 100
    for vt in ("AgX", "Filmic"):
        try:
            sc.view_settings.view_transform = vt
            break
        except TypeError:
            pass
    ee = sc.eevee
    if hasattr(ee, "taa_render_samples"):
        ee.taa_render_samples = 32
    if hasattr(ee, "use_bloom"):                       # Blender <= 4.1
        ee.use_bloom, ee.bloom_intensity, ee.bloom_threshold = True, 0.06, 0.9
        return
    if hasattr(sc, "compositing_node_group"):         # Blender 5.x
        try:
            ng = bpy.data.node_groups.get("OF_Compositor") or bpy.data.node_groups.new("OF_Compositor", "CompositorNodeTree")
            ng.nodes.clear()
            if not any(i.in_out == "OUTPUT" for i in ng.interface.items_tree):
                ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
            rl = ng.nodes.new("CompositorNodeRLayers")
            gl = ng.nodes.new("CompositorNodeGlare")
            out = ng.nodes.new("NodeGroupOutput")
            for k, v in (("Type", "Bloom"), ("Quality", "High"), ("Threshold", 0.85), ("Strength", 0.55), ("Size", 0.7)):
                try:
                    gl.inputs[k].default_value = v
                except Exception as e:
                    print("[AI Office] glare", k, e)
            ng.links.new(rl.outputs["Image"], gl.inputs["Image"])
            ng.links.new(gl.outputs["Image"], out.inputs[0])
            sc.compositing_node_group = ng
        except Exception as e:
            print("[AI Office] bloom skipped:", e)
        return
    try:                                               # Blender 4.2-4.x: compositor glare
        sc.use_nodes = True
        nt = sc.node_tree
        nt.nodes.clear()
        rl = nt.nodes.new("CompositorNodeRLayers")
        gl = nt.nodes.new("CompositorNodeGlare")
        comp = nt.nodes.new("CompositorNodeComposite")
        for attr, val in (("glare_type", "BLOOM"), ("glare_type", "FOG_GLOW")):
            try:
                setattr(gl, attr, val)
                break
            except Exception:
                pass
        for attr, val in (("quality", "HIGH"), ("threshold", 0.9), ("size", 7), ("mix", -0.3)):
            try:
                setattr(gl, attr, val)
            except Exception:
                pass
        nt.links.new(rl.outputs["Image"], gl.inputs["Image"])
        nt.links.new(gl.outputs["Image"], comp.inputs["Image"])
    except Exception as e:
        print("[AI Office] bloom skipped:", e)


# --------------------------------------------------------------------------- entry points
def build():
    random.seed(1)
    sc = get_scene()
    root = new_coll("AI_Office_Room", sc.collection)
    c_shell = new_coll("Shell", root)
    c_fx = new_coll("Fixtures", root)
    c_city = new_coll("City", root)
    c_anchor = new_coll("Anchors", root)
    ROOM_COLLS.update(root=root, anchors=c_anchor)
    c_nav = new_coll("Nav", root)
    c_prev = new_coll("Preview", root)
    C = make_materials()

    build_floor(C, c_shell)
    build_walls(C, c_shell)
    build_bench(C, c_fx)
    build_walltech(C, c_fx)
    build_deck(C, c_fx)
    build_console(C, c_fx)
    build_door(c_fx, sc, C, c_fx)
    build_boards(c_fx, sc, C, c_fx)
    build_holo(C, c_fx)
    build_poster(c_fx, sc, C, c_fx)
    build_city(C, c_city)
    build_anchors(c_anchor)
    build_nav(C, c_nav)
    build_preview_rig(sc, c_prev)
    setup_render(sc)
    return stats()


def stats():
    sc = bpy.data.scenes[SCENE]
    out, total = {}, 0
    for ob in sc.objects:
        if ob.type == "MESH":
            ob.data.calc_loop_triangles()
            t = len(ob.data.loop_triangles)
            out[ob.name] = t
            if not ob.name.startswith("NAV_"):
                total += t
    return {"objects": len(sc.objects), "triangles_total": total, "per_object": out}


def render_preview(path=None):
    sc = bpy.data.scenes[SCENE]
    path = path or os.path.join(REPO, "Assets/blender/renders/room_iso.png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True, scene=sc.name)
    return path


def _export(sc, objs, path):
    vl = sc.view_layers[0]
    for o in sc.objects:
        o.select_set(False, view_layer=vl)
    hidden = [o for o in objs if o.hide_get(view_layer=vl)]     # e.g. PropAlt_* state variants
    for o in hidden:
        o.hide_set(False, view_layer=vl)
    for o in objs:
        o.select_set(True, view_layer=vl)
    if bpy.context.scene != sc and bpy.context.window:
        bpy.context.window.scene = sc
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=True,
                              export_lights=False, export_cameras=False, export_extras=True)
    for o in hidden:
        o.hide_set(True, view_layer=vl)
    return path


def export_all():
    sc = bpy.data.scenes[SCENE]
    out_dir = os.path.join(REPO, "apps/web/public/models")
    os.makedirs(out_dir, exist_ok=True)
    room = [o for o in sc.objects if not o.name.startswith(("NAV_", "OF_"))]
    nav = [o for o in sc.objects if o.name.startswith("NAV_")]
    a = _export(sc, room, os.path.join(out_dir, "room.glb"))
    b = _export(sc, nav, os.path.join(out_dir, "room-nav.glb"))
    return {"room": a, "nav": b, "room_bytes": os.path.getsize(a), "nav_bytes": os.path.getsize(b)}


def save_blend(path=None):
    path = path or os.path.join(REPO, "Assets/blender/office-room.blend")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=path, copy=True)
    return path
