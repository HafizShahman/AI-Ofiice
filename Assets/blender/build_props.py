"""
AI Office - 3D props modelled from the sprites in Assets/sci-fi/ (one asset per sprite / state).

Needs build_room.py loaded first (same globals: B, V, N, mat, text, ...). Then:
    build_props()      # asset masters in scene "AI_Office_Assets" (marked as Blender assets, with catalogs)
                       # + linked copies placed in the room (collection "Props" in scene "AI_Office")

Every asset is built in local plan coordinates: origin = floor (or wall) contact point, x = width,
d = toward the front (Blender -Y), so the "front" of each asset faces -Y. Wall-mounted assets have their
back at d = 0. Placed copies share the master's mesh, so the glTF export writes each mesh once.
"""
import bpy, math, os, random
from mathutils import Vector

ASSET_SCENE = "AI_Office_Assets"
FLOOR_Z = 0.05                     # top of the floor tiles
CATALOGS = {
    "Furniture": "3f6c2a10-8b1e-4a52-9c3d-1e2f3a4b5c01",
    "Appliances": "3f6c2a10-8b1e-4a52-9c3d-1e2f3a4b5c02",
    "Plants": "3f6c2a10-8b1e-4a52-9c3d-1e2f3a4b5c03",
    "Wall": "3f6c2a10-8b1e-4a52-9c3d-1e2f3a4b5c04",
}
R90 = math.pi / 2


# --------------------------------------------------------------------------- extra materials
def leafmat(name, color):
    m = mat(name, color, 0.0, 0.55)
    m.use_backface_culling = False
    return m


def prop_materials(C):
    C["desk_top"] = mat("OF_DeskTop", (0.36, 0.42, 0.50), 0.5, 0.35)
    C["scr_cyan"] = mat("OF_ScreenCyan", (0.3, 0.8, 1.0), 0.0, 0.25, emit=(0.35, 0.85, 1.0), strength=1.6)
    C["pot_stone"] = mat("OF_PotStone", (0.30, 0.35, 0.44), 0.2, 0.6)
    C["pot_black"] = mat("OF_PotBlack", (0.03, 0.035, 0.045), 0.3, 0.3)
    C["soil"] = mat("OF_Soil", (0.08, 0.05, 0.03), 0.0, 0.9)
    C["leaf"] = leafmat("OF_LeafGreen", (0.10, 0.38, 0.12))
    C["leaf_l"] = leafmat("OF_LeafLight", (0.25, 0.58, 0.18))
    C["leaf_y"] = leafmat("OF_LeafYellow", (0.78, 0.72, 0.22))
    C["leaf_d"] = leafmat("OF_LeafDark", (0.06, 0.24, 0.10))
    C["bark"] = mat("OF_Bark", (0.36, 0.25, 0.15), 0.0, 0.8)
    C["wood"] = mat("OF_Wood", (0.42, 0.26, 0.13), 0.0, 0.6)
    C["brass"] = mat("OF_Brass", (0.95, 0.72, 0.22), 1.0, 0.25)
    C["ac"] = mat("OF_AcGrey", (0.40, 0.45, 0.53), 0.4, 0.35)
    C["paper"] = leafmat("OF_Paper", (0.85, 0.9, 0.95))
    C["coffee"] = mat("OF_Coffee", (0.18, 0.09, 0.04), 0.0, 0.3)
    C["board"] = mat("OF_BoardTeal", (0.05, 0.18, 0.22), 0.1, 0.3, emit=(0.06, 0.25, 0.32), strength=0.8)
    C["rubber"] = mat("OF_Rubber", (0.02, 0.02, 0.025), 0.0, 0.8)
    return C


# --------------------------------------------------------------------------- builder extras
def _leaf(b, base, dirv, length, width, m, n=6, droop=0.3, notch=0.0):
    p0 = V(*base)
    dvec = N(*dirv).normalized()
    side = dvec.cross(Vector((0, 0, 1)))
    if side.length < 1e-4:
        side = Vector((1, 0, 0))
    side.normalize()
    up = side.cross(dvec).normalized()
    rows = []
    for i in range(n + 1):
        t = i / n
        c = p0 + dvec * length * t + Vector((0, 0, -droop * length * t * t))
        w = width * 0.5 * max(0.06, math.sin(math.pi * min(t * 1.04, 1.0)) ** 0.7)
        if notch and 0 < i < n and i % 2 == 1:
            w *= 1 - notch
        rows.append((b.bm.verts.new(c - side * w), b.bm.verts.new(c + up * width * 0.04), b.bm.verts.new(c + side * w)))
    faces = []
    for i in range(n):
        a, c = rows[i], rows[i + 1]
        faces.append(b.bm.faces.new((a[0], c[0], c[1], a[1])))
        faces.append(b.bm.faces.new((a[1], c[1], c[2], a[2])))
    return b._tag(faces, m)


def _blade(b, base, lean, h, w, m_c, m_e, n=5, base_angle=0.0, twist=0.3):
    rows = []
    for i in range(n + 1):
        t = i / n
        c = V(*base) + N(lean[0], lean[1], 0) * h * 0.22 * t * t + Vector((0, 0, h * t))
        hw = w * 0.5 * (1 - t) ** 0.8 + 0.002
        ang = base_angle + twist * t
        side = Vector((math.cos(ang), math.sin(ang), 0))
        rows.append([b.bm.verts.new(c + side * s * hw) for s in (-1, -0.6, 0.6, 1)])
    for i in range(n):
        for k in range(3):
            f = b.bm.faces.new((rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]))
            b._tag([f], m_c if k == 1 else m_e)


def _text(b, sc, coll, body, loc, rot, size, m):
    ob = text(coll, sc, "Txt_tmp", body, loc, rot, size, m)
    me = ob.data
    me.transform(ob.matrix_basis)
    before = set(b.bm.faces)
    b.bm.from_mesh(me)
    b._tag([f for f in b.bm.faces if f not in before], m)
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.meshes.remove(me)


def _lid(b, x0, x1, hinge, top, thick, m_body, m_screen):
    """A thin slab from hinge (d, z) to top (d, z) between x0..x1, screen on the front (+d) side."""
    (hd, hz), (td, tz) = hinge, top
    xm = (x0 + x1) / 2
    b.beam((xm, hd, hz), (xm, td, tz), x1 - x0, m_body, h=thick)
    vd, vz = td - hd, tz - hz
    L = math.hypot(vd, vz)
    nd, nz = vz / L, -vd / L
    if nd < 0:
        nd, nz = -nd, -nz
    o = thick / 2 + 0.002
    pts = [(x0 + 0.01, hd + nd * o, hz + nz * o), (x1 - 0.01, hd + nd * o, hz + nz * o),
           (x1 - 0.01, td + nd * o, tz + nz * o), (x0 + 0.01, td + nd * o, tz + nz * o)]
    b.quad(pts, m_screen, normal=N(0, nd, nz))


# --------------------------------------------------------------------------- assets
def a_workstation(b, C, sc, coll, variant="A"):
    zt = 1.0
    b.box(-0.8, 0.8, -0.4, 0.4, zt - 0.05, zt, C["desk_top"])
    b.box(-0.8, 0.8, 0.4, 0.412, zt - 0.045, zt - 0.01, C["neon_s"])
    for x in (-0.66, 0.66):
        b.box(x - 0.045, x + 0.045, -0.045, 0.045, 0.06, 0.55, C["dark"])
        b.box(x - 0.06, x + 0.06, -0.06, 0.06, 0.55, zt - 0.05, C["metal"])
        b.box(x - 0.05, x + 0.05, -0.36, 0.36, 0.0, 0.06, C["metal"])
    b.box(-0.66, 0.66, -0.04, 0.04, zt - 0.12, zt - 0.06, C["dark"])
    # dual monitors on an arm
    b.cyl(0, -0.3, 0.03, zt, zt + 0.5, C["metal"], n=12)
    b.box(-0.07, 0.07, -0.37, -0.23, zt, zt + 0.03, C["metal"])
    for sx in (-1, 1):
        cx = sx * 0.33
        b.beam((0, -0.3, zt + 0.42), (cx, -0.29, zt + 0.42), 0.035, C["metal"])
        b.box(cx - 0.31, cx + 0.31, -0.29, -0.25, zt + 0.24, zt + 0.62, C["dark"])
        b.quad([(cx - 0.29, -0.248, zt + 0.26), (cx + 0.29, -0.248, zt + 0.26), (cx + 0.29, -0.248, zt + 0.6), (cx - 0.29, -0.248, zt + 0.6)],
               C["scr_cyan"], normal=N(0, 1, 0))
    # keyboard, mouse, mini PC
    b.box(-0.24, 0.2, 0.06, 0.22, zt, zt + 0.022, C["dark"])
    b.box(-0.225, 0.185, 0.075, 0.205, zt + 0.022, zt + 0.027, C["metal"])
    b.box(0.28, 0.34, 0.1, 0.19, zt, zt + 0.025, C["dark"])
    b.box(-0.74, -0.52, -0.36, -0.18, zt, zt + 0.09, C["dark"])
    b.box(-0.74, -0.52, -0.181, -0.176, zt + 0.06, zt + 0.07, C["neon"])
    if variant == "A":           # laptop
        b.box(0.44, 0.74, -0.02, 0.2, zt, zt + 0.018, C["metal"])
        _lid(b, 0.44, 0.74, (-0.02, zt + 0.018), (-0.07, zt + 0.22), 0.012, C["metal"], C["scr_cyan"])
    else:                        # tablet on a stand
        _lid(b, 0.46, 0.72, (0.05, zt), (-0.01, zt + 0.18), 0.012, C["dark"], C["scr_cyan"])
        b.box(-0.5, -0.42, -0.1, -0.02, zt, zt + 0.12, C["dark"])


def a_ceo_table(b, C, sc, coll):
    """The CEO's table on the deck: wider top, gold trim, three monitors, a nameplate for visitors."""
    zt, L, Wd = 1.0, 1.0, 0.48            # half length (x), half depth (d)
    b.box(-L, L, -Wd, Wd, zt - 0.06, zt, C["desk_top"])
    for d0, d1 in ((Wd, Wd + 0.015), (-Wd - 0.015, -Wd)):
        b.box(-L, L, d0, d1, zt - 0.055, zt - 0.01, C["brass"])
    for x0, x1 in ((L, L + 0.015), (-L - 0.015, -L)):
        b.box(x0, x1, -Wd, Wd, zt - 0.055, zt - 0.01, C["brass"])
    b.box(-L + 0.05, L - 0.05, Wd + 0.015, Wd + 0.025, zt - 0.045, zt - 0.025, C["amber"])      # gold glow, user side
    # two solid pedestals + a modesty panel on the visitors' side
    for x in (-L + 0.22, L - 0.22):
        b.box(x - 0.2, x + 0.2, -Wd + 0.04, Wd - 0.04, 0.0, zt - 0.06, C["dark"])
        for sx in (-0.17, 0.17):                                                  # thin gold lines, not panels
            b.box(x + sx - 0.012, x + sx + 0.012, Wd - 0.045, Wd - 0.035, 0.1, zt - 0.12, C["amber"])
    b.box(-L + 0.42, L - 0.42, -Wd + 0.02, -Wd + 0.06, 0.25, zt - 0.06, C["dark"])
    # three monitors on a wide arm (centre one larger)
    b.box(-0.08, 0.08, -0.4, -0.28, zt, zt + 0.03, C["metal"])
    b.cyl(0, -0.34, 0.035, zt, zt + 0.55, C["metal"], n=12)
    for cx, w, h in ((-0.66, 0.29, 0.36), (0.0, 0.36, 0.42), (0.66, 0.29, 0.36)):
        b.beam((0, -0.34, zt + 0.46), (cx, -0.33, zt + 0.46), 0.035, C["metal"])
        b.box(cx - w, cx + w, -0.33, -0.29, zt + 0.26, zt + 0.26 + h, C["dark"])
        b.quad([(cx - w + 0.02, -0.288, zt + 0.28), (cx + w - 0.02, -0.288, zt + 0.28), (cx + w - 0.02, -0.288, zt + 0.24 + h), (cx - w + 0.02, -0.288, zt + 0.24 + h)],
               C["scr_cyan"], normal=N(0, 1, 0))
    b.box(-0.3, 0.26, 0.08, 0.26, zt, zt + 0.022, C["dark"])
    b.box(-0.285, 0.245, 0.095, 0.245, zt + 0.022, zt + 0.027, C["metal"])
    b.box(0.34, 0.41, 0.12, 0.21, zt, zt + 0.025, C["dark"])
    # holo nameplate facing visitors (the far side)
    b.box(-0.22, 0.22, -0.46, -0.42, zt, zt + 0.02, C["brass"])
    b.quad([(-0.2, -0.44, zt + 0.03), (0.2, -0.44, zt + 0.03), (0.2, -0.44, zt + 0.14), (-0.2, -0.44, zt + 0.14)], C["holo"])
    _text(b, sc, coll, "CEO", (0.0, -0.445, zt + 0.085), (math.pi / 2, 0, math.pi), 0.07, C["amber"])


def a_cabinet(b, C, sc, coll, open_=False):
    rnd = random.Random(4)
    b.box(-0.275, 0.275, -0.3, 0.28, 0, 1.33, C["dark"])
    b.box(-0.285, 0.285, -0.31, 0.29, 1.33, 1.37, C["metal"])
    for x in (-0.275, 0.265):
        b.box(x, x + 0.01, 0.28, 0.29, 0.05, 1.33, C["neon_s"])
    folders = [C["s_yellow"], C["s_pink"], C["s_green"], C["s_blue"], C["red"], C["s_yellow"], C["s_green"], C["s_pink"]]
    for i in range(3):
        z0 = 0.06 + i * 0.43
        z1 = z0 + 0.4
        o = 0.38 if (open_ and i == 1) else 0.0
        b.box(-0.25, 0.25, 0.28 + o, 0.31 + o, z0, z1, C["metal"])
        b.box(-0.09, 0.09, 0.31 + o, 0.34 + o, z1 - 0.13, z1 - 0.1, C["light"])
        b.box(-0.06, 0.06, 0.31 + o, 0.315 + o, z1 - 0.08, z1 - 0.04, C["light"])
        if o:
            b.box(-0.23, 0.23, 0.0, 0.28 + o, z0 + 0.02, z0 + 0.04, C["dark"])
            for x in (-0.23, 0.21):
                b.box(x, x + 0.02, 0.0, 0.28 + o, z0 + 0.04, z1 - 0.08, C["dark"])
            for k, m in enumerate(folders):
                d = 0.08 + k * 0.07
                top = z1 - 0.04 - rnd.uniform(0.0, 0.06)
                b.box(-0.2, 0.2, d, d + 0.035, z0 + 0.04, top, m)


def a_printer_stand(b, C, sc, coll):
    b.box(-0.36, 0.36, -0.32, 0.32, 0, 0.55, C["dark"])
    corners = [(-0.36, -0.32), (0.36, -0.32), (0.36, 0.32), (-0.36, 0.32)]
    for (x0, d0), (x1, d1) in zip(corners, corners[1:] + corners[:1]):
        b.beam((x0, d0, 0.55), (x1, d1, 0.55), 0.02, C["neon"])
    b.box(-0.36, 0.36, 0.32, 0.325, 0.29, 0.31, C["neon"])
    b.box(-0.18, 0.18, 0.32, 0.33, 0.4, 0.42, C["light"])


def a_printer(b, C, sc, coll, broken=False):
    b.box(-0.3, 0.3, -0.25, 0.25, 0, 0.3, C["dark"])
    b.box(-0.31, 0.31, -0.26, 0.26, 0.3, 0.36, C["metal"])
    b.quad([(-0.17, -0.2, 0.36), (0.17, -0.2, 0.36), (0.17, -0.28, 0.62), (-0.17, -0.28, 0.62)], C["paper"], normal=N(0, 1, 0.3))
    for k in range(4):
        z = 0.42 + k * 0.045
        b.beam((-0.12, -0.212 - (z - 0.36) * 0.3, z), (0.08 - k * 0.03, -0.212 - (z - 0.36) * 0.3, z), 0.012, C["neon_s"], h=0.004)
    b.box(-0.2, 0.2, 0.25, 0.42, 0.1, 0.12, C["metal"])
    b.box(-0.17, 0.17, 0.25, 0.38, 0.12, 0.14, C["paper"])
    b.box(-0.22, 0.22, 0.25, 0.255, 0.14, 0.2, C["rubber"])
    b.box(0.12, 0.28, 0.05, 0.22, 0.36, 0.38, C["screen"])
    for i in range(2):
        for j in range(2):
            b.box(0.15 + i * 0.06, 0.19 + i * 0.06, 0.09 + j * 0.06, 0.13 + j * 0.06, 0.38, 0.39, C["neon"])
    b.box(0.22, 0.27, 0.25, 0.26, 0.24, 0.27, C["red"] if broken else C["green"])
    if broken:                    # jammed, crumpled sheets
        rnd = random.Random(2)
        for k in range(5):
            x = rnd.uniform(-0.15, 0.15)
            b.beam((x, 0.27, 0.16), (x + rnd.uniform(-0.12, 0.12), 0.42 + rnd.uniform(0, 0.1), 0.2 + rnd.uniform(0, 0.15)), 0.09, C["paper"], h=0.012)
        b.box(0.22, 0.27, 0.255, 0.26, 0.28, 0.3, C["red"])


def a_coffee(b, C, sc, coll, on=False):
    b.box(-0.2, 0.2, -0.18, 0.18, 0.0, 0.03, C["metal"])
    b.box(-0.2, 0.2, -0.18, 0.05, 0.03, 0.42, C["dark"])
    b.box(-0.2, 0.2, 0.05, 0.18, 0.28, 0.42, C["dark"])
    b.box(-0.2, 0.2, -0.18, 0.18, 0.42, 0.44, C["metal"])
    for k in range(6):
        b.box(-0.17, 0.17, -0.15 + k * 0.05, -0.13 + k * 0.05, 0.44, 0.452, C["light"])
    b.box(-0.16, 0.16, 0.05, 0.17, 0.03, 0.06, C["light"])
    b.cyl(0.0, 0.12, 0.045, 0.22, 0.28, C["metal"], n=12)
    b.beam((0.0, 0.12, 0.225), (0.0, 0.3, 0.205), 0.03, C["rubber"])
    b.box(-0.08, 0.08, 0.18, 0.185, 0.34, 0.39, C["scr_cyan"] if on else C["screen"])
    for x in (-0.15, 0.15):
        b.box(x - 0.02, x + 0.02, 0.18, 0.2, 0.33, 0.37, C["metal"])
    b.beam((0.16, 0.15, 0.3), (0.17, 0.2, 0.12), 0.015, C["light"])
    b.box(0.2, 0.203, 0.13, 0.15, 0.06, 0.4, C["neon_s"])                  # thin glow line down the front edge
    if on:
        b.cyl(0.0, 0.12, 0.035, 0.06, 0.13, C["white"], n=12)
        b.cyl(0.0, 0.12, 0.029, 0.125, 0.132, C["coffee"], n=12)
        b.box(0.11, 0.14, 0.18, 0.19, 0.3, 0.33, C["red"])


def a_monstera(b, C, sc, coll):
    b.cyl(0, 0, 0.2, 0.0, 0.42, C["pot_stone"], n=20, r2=0.26)
    b.annulus(0, 0, 0.23, 0.275, 0.40, 0.45, C["pot_stone"], n=20)
    b.cyl(0, 0, 0.235, 0.37, 0.41, C["soil"], n=20)
    rnd = random.Random(11)
    for k in range(8):
        a = k * 2 * math.pi / 8 + rnd.uniform(-0.25, 0.25)
        r, h = rnd.uniform(0.18, 0.38), rnd.uniform(0.75, 1.35)
        tip = (r * math.cos(a), r * math.sin(a), h)
        b.beam((0.0, 0.0, 0.41), tip, 0.018, C["leaf_d"])
        L = rnd.uniform(0.38, 0.52)
        _leaf(b, tip, (math.cos(a), math.sin(a), 0.35), L, L * 0.85, C["leaf"], n=6, droop=0.45, notch=0.45)


def a_money_tree(b, C, sc, coll):
    b.cyl(0, 0, 0.16, 0.0, 0.32, C["pot_stone"], n=20, r2=0.23)
    b.annulus(0, 0, 0.2, 0.245, 0.3, 0.35, C["pot_stone"], n=20)
    b.cyl(0, 0, 0.205, 0.27, 0.31, C["soil"], n=20)
    for s in range(3):
        pts = []
        for i in range(9):
            t = i / 8
            ang = s * 2 * math.pi / 3 + t * 4 * math.pi
            r = 0.035 * (1 - 0.3 * t)
            pts.append((r * math.cos(ang), r * math.sin(ang), 0.3 + t * 0.8))
        for p, q in zip(pts, pts[1:]):
            b.beam(p, q, 0.035, C["bark"])
    rnd = random.Random(5)
    for k in range(7):
        a = k * 2 * math.pi / 7 + rnd.uniform(-0.2, 0.2)
        r, z = rnd.uniform(0.15, 0.32), rnd.uniform(1.15, 1.45)
        tip = (r * math.cos(a), r * math.sin(a), z)
        b.beam((0, 0, 1.08), tip, 0.014, C["bark"])
        for j in range(5):
            aa = a + (j - 2) * 0.55
            _leaf(b, tip, (math.cos(aa), math.sin(aa), 0.15), 0.17, 0.07, C["leaf_l"], n=4, droop=0.4)


def a_snake(b, C, sc, coll):
    b.cyl(0, 0, 0.15, 0.0, 0.32, C["pot_black"], n=20, r2=0.19)
    b.cyl(0, 0, 0.175, 0.28, 0.31, C["soil"], n=20)
    rnd = random.Random(7)
    for k in range(10):
        a, r = rnd.uniform(0, 2 * math.pi), rnd.uniform(0.0, 0.1)
        _blade(b, (r * math.cos(a), r * math.sin(a), 0.3), (math.cos(a), math.sin(a)), rnd.uniform(0.6, 1.05),
               rnd.uniform(0.07, 0.1), C["leaf"], C["leaf_y"], base_angle=rnd.uniform(0, math.pi), twist=rnd.uniform(-0.6, 0.6))


def a_whiteboard(b, C, sc, coll):
    W = 0.7
    for x in (-W - 0.03, W + 0.03):
        b.box(x - 0.025, x + 0.025, -0.025, 0.025, 0.08, 1.85, C["metal"])
        b.box(x - 0.03, x + 0.03, -0.35, 0.35, 0.06, 0.1, C["metal"])
        for d in (-0.32, 0.32):
            b.cyl(x, d, 0.03, 0.0, 0.06, C["rubber"], n=8)
    b.box(-W, W, -0.02, 0.02, 0.7, 1.75, C["metal"])
    b.box(-W + 0.04, W - 0.04, 0.02, 0.025, 0.74, 1.71, C["board"])
    corners = [(-W + 0.04, 0.74), (W - 0.04, 0.74), (W - 0.04, 1.71), (-W + 0.04, 1.71)]
    for (x0, z0), (x1, z1) in zip(corners, corners[1:] + corners[:1]):
        b.beam((x0, 0.028, z0), (x1, 0.028, z1), 0.015, C["neon_s"])
    stickies = [(-0.55, 1.55, "s_yellow"), (-0.4, 1.58, "s_pink"), (-0.55, 1.38, "s_green"), (-0.38, 1.4, "s_blue"),
                (-0.2, 1.52, "s_yellow"), (-0.05, 1.3, "s_pink"), (-0.55, 1.15, "s_blue"), (-0.35, 1.12, "s_green")]
    for x, z, m in stickies:
        b.box(x - 0.06, x + 0.06, 0.025, 0.035, z - 0.055, z + 0.055, C[m])
    cx, cz, R = 0.42, 1.48, 0.15
    for a0, a1, m in ((0, 2.2, "s_blue"), (2.2, 4.0, "s_pink"), (4.0, 2 * math.pi, "s_yellow")):
        pts = [(cx, 0.03, cz)] + [(cx + R * math.cos(a0 + (a1 - a0) * i / 8), 0.03, cz + R * math.sin(a0 + (a1 - a0) * i / 8)) for i in range(9)]
        b.quad(pts, C[m], normal=N(0, 1, 0))
    line = [(0.2, 1.0), (0.3, 1.12), (0.4, 1.05), (0.52, 1.22)]
    for (xa, za), (xb, zb) in zip(line, line[1:]):
        b.beam((xa, 0.03, za), (xb, 0.03, zb), 0.012, C["neon"])
    b.box(-0.5, 0.5, 0.0, 0.09, 0.66, 0.7, C["metal"])
    for i, m in enumerate(("red", "s_green", "s_blue", "metal")):
        b.beam((-0.3 + i * 0.12, 0.06, 0.715), (-0.2 + i * 0.12, 0.06, 0.715), 0.022, C[m])


def a_bell(b, C, sc, coll):
    b.box(-0.12, 0.12, 0.0, 0.04, 0.0, 0.32, C["wood"])
    b.box(-0.03, 0.03, 0.04, 0.2, 0.24, 0.27, C["brass"])
    b.cyl(0, 0.2, 0.012, 0.17, 0.25, C["brass"], n=8)
    b.cyl(0, 0.2, 0.11, 0.0, 0.14, C["brass"], n=20, r2=0.055)
    b.sphere(0, 0.2, 0.15, 0.05, C["brass"], sub=1)
    b.annulus(0, 0.2, 0.09, 0.118, -0.01, 0.02, C["brass"], n=20)
    b.beam((0, 0.2, 0.02), (0, 0.2, -0.2), 0.012, C["metal"])
    b.sphere(0, 0.2, -0.21, 0.02, C["metal"], sub=1)


def a_ac(b, C, sc, coll):
    b.box(-0.55, 0.55, 0.0, 0.24, 0.0, 0.32, C["ac"])
    for k in range(8):
        b.box(-0.5, 0.5, 0.03 + k * 0.024, 0.04 + k * 0.024, 0.32, 0.326, C["dark"])
    b.box(-0.5, 0.5, 0.24, 0.245, 0.03, 0.08, C["dark"])
    b.box(-0.52, 0.52, 0.24, 0.243, 0.12, 0.125, C["metal"])
    b.box(0.38, 0.42, 0.24, 0.246, 0.1, 0.12, C["green"])
    b.box(0.44, 0.48, 0.24, 0.246, 0.1, 0.12, C["green"])


def a_days_sign(b, C, sc, coll):
    b.box(-0.8, 0.8, 0.0, 0.08, 0.0, 0.45, C["dark"])
    for (x0, z0), (x1, z1) in (((-0.8, 0.0), (0.8, 0.0)), ((-0.8, 0.45), (0.8, 0.45))):
        b.beam((x0, 0.082, z0), (x1, 0.082, z1), 0.012, C["neon_s"])
    _text(b, sc, coll, "DAYS SINCE", (-0.15, 0.085, 0.31), FACE_BACK, 0.1, C["red"])
    _text(b, sc, coll, "LAST INCIDENT:", (-0.15, 0.085, 0.14), FACE_BACK, 0.1, C["red"])
    _text(b, sc, coll, "0", (0.6, 0.085, 0.22), FACE_BACK, 0.36, C["red"])


def a_deploy_screen(b, C, sc, coll):
    b.box(-0.09, 0.09, -0.1, 0.1, 0, 0.02, C["metal"])
    b.box(-0.02, 0.02, -0.02, 0.02, 0.02, 0.12, C["metal"])
    b.box(-0.3, 0.3, -0.03, 0.03, 0.1, 0.62, C["dark"])
    b.quad([(-0.28, 0.031, 0.12), (0.28, 0.031, 0.12), (0.28, 0.031, 0.6), (-0.28, 0.031, 0.6)], C["screen"], normal=N(0, 1, 0))
    for zc in (0.52, 0.42):
        b.beam((-0.23, 0.034, zc), (-0.205, 0.034, zc - 0.025), 0.012, C["green"])
        b.beam((-0.205, 0.034, zc - 0.025), (-0.16, 0.034, zc + 0.03), 0.012, C["green"])
    b.beam((-0.23, 0.034, 0.34), (-0.17, 0.034, 0.28), 0.012, C["red"])
    b.beam((-0.23, 0.034, 0.28), (-0.17, 0.034, 0.34), 0.012, C["red"])
    for k in range(8):
        a = k * math.pi / 4
        x, z = 0.08 + 0.055 * math.cos(a), 0.44 + 0.055 * math.sin(a)
        b.box(x - 0.008, x + 0.008, 0.031, 0.036, z - 0.008, z + 0.008, C["neon"] if k < 6 else C["neon_s"])
    _text(b, sc, coll, "DEPLOYING...", (0.03, 0.036, 0.24), FACE_BACK, 0.06, C["neon"])


def a_todo_board(b, C, sc, coll):
    b.box(-0.6, 0.6, 0.0, 0.05, 0.0, 1.3, C["metal"])
    b.box(-0.56, 0.56, 0.05, 0.055, 0.06, 1.24, C["board"])
    for x in (-0.19, 0.19):
        b.beam((x, 0.058, 0.1), (x, 0.058, 1.2), 0.012, C["neon_s"])
    b.beam((-0.54, 0.058, 1.1), (0.54, 0.058, 1.1), 0.012, C["neon_s"])
    rnd = random.Random(8)
    cols = ["s_yellow", "s_green", "s_pink", "s_blue"]
    for c in range(3):
        for k in range(rnd.randint(2, 4)):
            x = -0.37 + c * 0.38 + rnd.uniform(-0.08, 0.08)
            z = 0.95 - k * 0.22 + rnd.uniform(-0.03, 0.03)
            b.box(x - 0.07, x + 0.07, 0.056, 0.066, z - 0.06, z + 0.06, C[rnd.choice(cols)])
    b.box(-0.45, 0.45, 0.0, 0.08, -0.02, 0.02, C["metal"])
    b.box(-0.05, 0.05, 0.03, 0.06, 0.02, 0.04, C["red"])


# name, builder, kwargs, catalog, description, sprite it replaces
ASSETS = [
    ("Workstation", a_workstation, {"variant": "A"}, "Furniture", "Standing desk, dual monitors, laptop", "furniture/standing-desk-*.png"),
    ("Workstation_Tablet", a_workstation, {"variant": "B"}, "Furniture", "Standing desk, dual monitors, tablet", "furniture/standing-desk-*.png"),
    ("CEO_Table", a_ceo_table, {}, "Furniture", "CEO table: wide desk, gold trim, three monitors, nameplate", "furniture/standing-desk-*.png"),
    ("FilingCabinet", a_cabinet, {}, "Furniture", "Archive filing cabinet, closed", "furniture/filling-closed.png"),
    ("FilingCabinet_Open", a_cabinet, {"open_": True}, "Furniture", "Archive filing cabinet, drawer open", "furniture/filling-open.png"),
    ("PrinterStand", a_printer_stand, {}, "Furniture", "Printer stand with cyan edge", "furniture/printer-stand.png"),
    ("Whiteboard", a_whiteboard, {}, "Furniture", "Mobile whiteboard on wheels", "decoration/white-board.png"),
    ("Printer", a_printer, {}, "Appliances", "Printer, working", "decoration/printer-working.png"),
    ("Printer_Broken", a_printer, {"broken": True}, "Appliances", "Printer, jammed", "decoration/printer-broken.png"),
    ("CoffeeMachine", a_coffee, {}, "Appliances", "Espresso machine, idle", "appliances/coffee-off.png"),
    ("CoffeeMachine_On", a_coffee, {"on": True}, "Appliances", "Espresso machine, brewing", "appliances/coffee-on.png"),
    ("Plant_Monstera", a_monstera, {}, "Plants", "Monstera in stone pot", "decoration/monstera-plant.png"),
    ("Plant_MoneyTree", a_money_tree, {}, "Plants", "Braided money tree", "decoration/money-tree.png"),
    ("Plant_Snake", a_snake, {}, "Plants", "Snake plant in black pot", "decoration/snake-plant.png"),
    ("ShipBell", a_bell, {}, "Wall", "Brass ship bell on wood plaque", "culture/bell.png"),
    ("AC_WallUnit", a_ac, {}, "Wall", "Split AC wall unit", "decoration/ac-wall-unit.png"),
    ("Sign_DaysSinceIncident", a_days_sign, {}, "Wall", "Days since last incident LED sign", "culture/days-last-incident.png"),
    ("Screen_Deploying", a_deploy_screen, {}, "Appliances", "Deploy status screen", "culture/deploying-screen.png"),
    ("TodoBoard", a_todo_board, {}, "Wall", "Wall kanban board", "culture/todo-board.png"),
]

# where copies go in the room: asset, name, (x, d, z), rotation about Z (90 deg = front faces the window side? no: +X)
DESKS = [   # name, asset, (column, row) in DESK_COLS / DESK_ROWS  (Caman's arrangement)
    ("Desk_1", "Workstation", 0, 0), ("Desk_2", "Workstation_Tablet", 0, 1),
    ("Desk_3", "Workstation_Tablet", 1, 0), ("Desk_4", "Workstation", 1, 1),
    ("Desk_7", "Workstation", 2, 0), ("Desk_5", "Workstation", 2, 1),
    ("Desk_8", "Workstation_Tablet", 3, 0), ("Desk_6", "Workstation_Tablet", 3, 1),
]
PLACEMENTS = [(asset, name, (DESK_COLS[c], DESK_ROWS[r], FLOOR_Z), R90) for name, asset, c, r in DESKS] + [
    ("CEO_Table", "CEO_Table", (DESK_DECK[0], DESK_DECK[1], DECK_H), R90),
    ("FilingCabinet", "Archive_1", (0.55, 1.95, FLOOR_Z), R90), ("FilingCabinet", "Archive_2", (0.55, 2.55, FLOOR_Z), R90),
    ("PrinterStand", "PrinterStand", (0.5, 3.26, FLOOR_Z), R90), ("Printer", "Printer", (0.5, 3.26, FLOOR_Z + 0.55), R90),   # moved back by Caman
    ("CoffeeMachine", "Coffee_1", (2.2, 0.45, 1.12), 0.0, 1.5), ("CoffeeMachine", "Coffee_2", (3.9, 0.45, 1.12), 0.0, 1.5),   # scaled by Caman; "on" is a state
    ("Whiteboard", "Whiteboard", (1.05, 9.4, FLOOR_Z), R90),
    ("Plant_Monstera", "Plant_Monstera", (5.245, 11.45, FLOOR_Z), 0.4), ("Plant_MoneyTree", "Plant_MoneyTree", (0.614, 1.06, FLOOR_Z), 0.0),   # moved by Caman
    ("Plant_Snake", "Plant_Snake_Front", (11.47, 5.34, FLOOR_Z), 1.0),            # placed by Caman in Blender
    ("ShipBell", "ShipBell", (9.46, 0.0, 2.93), 0.0), ("AC_WallUnit", "AC_WallUnit", (8.2, 0.0, 4.15), 0.0),
    ("Sign_DaysSinceIncident", "Sign_DaysSinceIncident", (3.05, 0.04, 3.25), 0.0),
    ("Screen_Deploying", "Screen_Deploying", (10.55, 0.45, DECK_H + 1.13), 0.0),
]

# prop states the web app swaps in: base asset -> (variant asset, when, the server prop id robots use it through)
ALTS = []          # filled by build_props(), written to room3d.json
ALT_OF = {
    "CoffeeMachine": ("CoffeeMachine_On", "busy", "coffee"),      # a robot drinking at it
    "FilingCabinet": ("FilingCabinet_Open", "busy", "archive"),   # a robot reading at it
    "Printer": ("Printer_Broken", "fail", "printer"),            # a tool call failed
}

# where robots stand to use the new props (plan x, d, z)
PROP_SPOTS = {
    **{name: (DESK_COLS[c] + 0.75, DESK_ROWS[r], FLOOR_Z) for name, _, c, r in DESKS},
    "Archive_1": (1.45, 1.95, FLOOR_Z), "Archive_2": (1.45, 2.55, FLOOR_Z), "Printer": (1.35, 3.26, FLOOR_Z),
    "Whiteboard_1": (1.95, 9.1, FLOOR_Z), "Whiteboard_2": (1.95, 9.8, FLOOR_Z), "Bell": (9.46, 0.9, DECK_H),
}


def write_catalogs(path):
    lines = ["# Blender asset catalogs for the AI Office props", "VERSION 1", ""]
    for name, uid in CATALOGS.items():
        lines.append("%s:AI Office/%s:AI Office-%s" % (uid, name, name))
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def _asset_scene():
    sc = bpy.data.scenes.get(ASSET_SCENE)
    if sc:
        for o in list(sc.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        for c in list(sc.collection.children_recursive):
            bpy.data.collections.remove(c)
    else:
        sc = bpy.data.scenes.new(ASSET_SCENE)
    for me in list(bpy.data.meshes):
        if me.users == 0 and me.name.startswith(("Asset_", "Prop_", "Txt_tmp")):
            bpy.data.meshes.remove(me)
    return sc


def build_props(write_catalog_file=True):
    room = bpy.data.scenes[SCENE]
    C = prop_materials(make_materials())
    asc = _asset_scene()
    lib = bpy.data.collections.new("AI_Office_Props_Library")
    asc.collection.children.link(lib)

    masters = {}
    for i, (name, fn, kw, cat, desc, sprite) in enumerate(ASSETS):
        b = B("Asset_" + name, lib)
        fn(b, C, asc, lib, **kw)
        ob = b.finish()
        ob.location = Vector(((i % 6) * 2.4, -(i // 6) * 2.6, 0))
        ob.asset_mark()
        ad = ob.asset_data
        ad.description = desc + " (from Assets/sci-fi/" + sprite + ")"
        ad.catalog_id = CATALOGS[cat]
        for t in ("ai-office", cat.lower()):
            ad.tags.new(t, skip_if_exists=True)
        ob["sprite"] = sprite
        if not bpy.app.background:            # previews need a GPU context
            try:
                ob.asset_generate_preview()
            except Exception:
                pass
        masters[name] = ob

    # place linked copies in the room
    root = ROOM_COLLS.get("root") or bpy.data.collections.get("AI_Office_Room")
    props = next((c for c in root.children if c.name.startswith("Props")), None)
    if props is None:
        props = bpy.data.collections.new("Props")
        root.children.link(props)
    for o in list(props.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for asset, name, (x, d, z), rz, *scale in PLACEMENTS:
        ob = bpy.data.objects.new("Prop_" + name, masters[asset].data)
        ob.location = V(x, d, z)
        ob.rotation_euler = (0, 0, rz)
        if scale:
            ob.scale = (scale[0],) * 3
        ob["asset"] = asset
        props.objects.link(ob)

    alts = []
    for asset, name, (x, d, z), rz, *scale in PLACEMENTS:
        if asset not in ALT_OF:
            continue
        variant, when, prop = ALT_OF[asset]
        ob = bpy.data.objects.new("PropAlt_" + name, masters[variant].data)
        ob.location = V(x, d, z)
        ob.rotation_euler = (0, 0, rz)
        if scale:
            ob.scale = (scale[0],) * 3
        ob["alt_of"] = "Prop_" + name
        props.objects.link(ob)
        ob.hide_render = True
        try:
            ob.hide_set(True)          # only shown by the web app; the exporter unhides it
        except RuntimeError:
            pass
        alts.append({"node": "Prop_" + name, "alt": "PropAlt_" + name, "when": when, "prop": prop, "at": [x, d, z]})
    ALTS[:] = alts

    anchors = ROOM_COLLS.get("anchors") or next(c for c in root.children if c.name.startswith("Anchors"))
    for o in list(anchors.objects):              # only this room's anchors
        if o.name.split(".")[0][len("Anchor_"):] in PROP_SPOTS:
            bpy.data.objects.remove(o, do_unlink=True)
    for name, (x, d, z) in PROP_SPOTS.items():
        anchor(anchors, name, x, d, z)

    if write_catalog_file:
        try:
            write_catalogs(os.path.join(REPO, "Assets/blender/blender_assets.cats.txt"))
        except Exception as e:
            print("[AI Office] catalogs not written:", e)
    tris = {}
    for name, ob in masters.items():
        ob.data.calc_loop_triangles()
        tris[name] = len(ob.data.loop_triangles)
    return {"assets": len(masters), "placed": len(PLACEMENTS), "tris": tris}


# --------------------------------------------------------------------------- web app contract
def spot_table():
    """Everything the web app's 3D scene needs from the layout, written to apps/web/src/scene/room3d.json.

    Positions are plan coordinates [x, d, z]: three.js uses them as (x, z, d), which is also what the
    glTF export gives (Blender Y = -d, glTF is Y-up). Spot ids are the server's (props.json): "desk-3",
    "coffee.2"... `face` is the point a robot turns to once it has arrived (null: face the camera).
    """
    S = {}

    def put(sid, pos, face=None, prop=None):
        S[sid] = {"pos": [round(v, 3) for v in pos], "face": [round(v, 3) for v in face] if face else None,
                  "prop": prop or sid.split(".")[0]}

    for name, _, c, r in DESKS:
        x, d = DESK_COLS[c], DESK_ROWS[r]
        put("desk-%s" % name.split("_")[1], (x + 0.75, d, FLOOR_Z), (x - 0.3, d, 1.3))
    put("coffee.1", (2.2, 1.75, FLOOR_Z), (2.2, 0.45, 1.3))
    put("coffee.2", (3.9, 1.75, FLOOR_Z), (3.9, 0.45, 1.3))
    put("archive.1", (1.45, 1.95, FLOOR_Z), (0.55, 1.95, 0.8))
    put("archive.2", (1.45, 2.55, FLOOR_Z), (0.55, 2.55, 0.8))
    put("whiteboard.1", (1.95, 9.1, FLOOR_Z), (1.05, 9.1, 1.2))
    put("whiteboard.2", (1.95, 9.8, FLOOR_Z), (1.05, 9.8, 1.2))
    put("bell", (9.46, 0.9, DECK_H), (9.46, 0.0, 3.0))
    hx, hd = HOLO_C
    for k in range(7):
        a = k * 2 * math.pi / 7 + math.pi / 7
        put("holo-table.%d" % (k + 1), (hx + 1.2 * math.cos(a), hd + 1.2 * math.sin(a), PIT_Z), (hx, hd, 0.5))
    sx, sd = HOLO_SCREEN_C
    for k, ang in enumerate((150, 210)):
        a = math.radians(ang)
        put("comms.%d" % (k + 1), (sx + 2.45 * math.cos(a), sd + 2.45 * math.sin(a), 0.12), (sx + 2.95 * math.cos(a), sd + 2.95 * math.sin(a), 2.2))
    put("server-bank.1", (10.9, 2.0, DECK_H), (10.9, 1.5, 1.6))
    put("server-bank.2", (11.7, 2.0, DECK_H), (11.7, 1.5, 1.6))
    for k, (x, d) in enumerate(((14.65, 1.95), (13.95, 2.15), (15.35, 2.15))):
        put("approval.%d" % (k + 1), (x, d, DECK_H), (14.65, 0.85, 2.4))
    for k, (x, d) in enumerate(PADS):
        put("charging.%d" % (k + 1), (x, d, PAD_Z + 0.1))
    put("door", (8.2, 0.9, DECK_H))
    put("ceo-desk", (DESK_DECK[0] + 0.75, DESK_DECK[1], DECK_H), (DESK_DECK[0] - 0.2, DESK_DECK[1], 1.5))
    put("ceo-servers", (13.1, 2.2, DECK_H), (13.1, 1.5, 1.6))
    put("ceo-holo", (hx + 2.85 * math.cos(math.radians(20)), hd + 2.85 * math.sin(math.radians(20)), FLOOR_Z), (hx, hd, 0.5))
    put("ceo-whiteboard", (2.25, 9.45, FLOOR_Z), (1.05, 9.45, 1.2))
    put("ceo-board", (12.4, 2.6, DECK_H), (12.35, 0.4, 3.6))
    put("ceo-coffee", (3.05, 1.9, FLOOR_Z), (3.05, 0.45, 1.3))
    put("ceo-comms", (sx - 2.45, sd, 0.12), (sx - 2.95, sd, 2.2))
    put("ceo-desks", (9.39, 7.75, FLOOR_Z), (9.39, 9.3, 1.0))
    seats = [(1.78, k * 36.0, STEP_Z) for k in range(10)] + [(2.3, a, 0.12) for a in (-60, -30, 0, 30, 60)]
    for k, (r, ang, z) in enumerate(seats):
        a = math.radians(ang)
        put("meeting.%d" % (k + 1), (hx + r * math.cos(a), hd + r * math.sin(a), z), (hx, hd, 0.5))

    return {
        "_note": "Generated by Assets/blender/export_headless.py from build_room.py / build_props.py. Plan coords [x, d, z]; three.js = (x, z, d).",
        "room": {"w": W, "d": D, "h": H, "floorZ": FLOOR_Z, "deckH": DECK_H},
        "camera": {"target": [8.0, 6.3, 1.4], "az": 45, "el": 30, "orthoScale": 26.5},
        "deck": [list(p) for p in DECK_PTS],
        "stairs": {"top": [8.0, DECK_FRONT - 0.4, DECK_H], "bottom": [8.0, STAIRS_BOTTOM + 0.6, FLOOR_Z]},
        "holo": {"c": list(HOLO_C), "bandR": HOLO_R, "pitR": PIT_R, "stepR": STEP_R, "stepZ": STEP_Z, "pitZ": PIT_Z},
        "board": {"c": [12.35, 0.42, 3.65], "w": 3.1, "h": 1.8},
        "spots": S,
        "alts": ALTS,
        "nav": nav_table(),
    }


def nav_table():
    """Walkable areas and obstacles for the web app's 3D walk grid (plan coords; the app adds the robot's radius).
    The floor grid treats the whole holo ring as blocked: robots step into it radially from outside."""
    plants = [(p[0], p[1], 0.34 if "Monstera" in a else 0.3 if "Money" in a else 0.24)
              for a, n, p, rz, *sc in PLACEMENTS if a.startswith("Plant_") and abs(p[2] - FLOOR_Z) < 1e-6]
    floor = [{"poly": [list(p) for p in DECK_PTS]},
             {"rect": [STAIRS_X[0], DECK_FRONT, STAIRS_X[1], STAIRS_BOTTOM]},
             {"circle": [HOLO_C[0], HOLO_C[1], HOLO_R]},
             {"rect": [0.5, 0.0, 5.6, 1.3]},                  # bench alcove
             {"rect": [0.25, 1.65, 0.85, 2.85]},              # archive cabinets
             {"rect": [0.15, 2.9, 0.85, 3.62]},               # printer stand
             {"rect": [0.68, 8.65, 1.42, 10.15]},             # whiteboard
             {"circle": [0.22, 11.05, 0.2]}]                  # extinguisher
    floor += [{"rect": [DESK_COLS[c] - 0.42, DESK_ROWS[r] - 0.82, DESK_COLS[c] + 0.42, DESK_ROWS[r] + 0.82]} for _, _, c, r in DESKS]
    floor += [{"circle": [x, d, rr]} for x, d, rr in plants]
    deck = [{"rect": [10.15, 0.0, 15.45, 1.6]},                # console
            {"rect": [DESK_DECK[0] - 0.48, DESK_DECK[1] - 1.0, DESK_DECK[0] + 0.48, DESK_DECK[1] + 1.0]}]   # CEO table
    deck += [{"circle": [p[0], p[1], 0.24]} for a, n, p, rz, *sc in PLACEMENTS if a.startswith("Plant_") and abs(p[2] - DECK_H) < 1e-6]
    return {"floor": {"bounds": [0.2, 0.2, W - 0.2, D - 0.2], "y": FLOOR_Z, "blocks": floor},
            "deck": {"poly": [list(p) for p in DECK_PTS], "y": DECK_H, "blocks": deck}}
