import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * "Mini Robot" by Onur (CC BY 4.0) has no skeleton: it is 25 rigid parts, and a part such as
 * "arms_high" holds BOTH arms. To animate it we bake every part into one normalised space
 * (feet at y=0, height 1, facing +Z), cut each part into left/right halves by triangle, sort
 * the halves into six segments by where they sit, and give each segment a pivot.
 * Animation is then plain rotations on those pivots (see RobotRig.pose).
 */

export type Seg = 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR';
const SEGS: Seg[] = ['head', 'torso', 'armL', 'armR', 'legL', 'legR'];

/** Parts that take the role colour. */
const ACCENT_PARTS = new Set(['cap', 'ears', 'ears_part_1', 'ears_part_2']);

const NECK_Y = 0.62;
const HIP_Y = 0.38;
const ARM_X = 0.105;

interface SegTemplate {
  pivot: THREE.Vector3;
  /** merged geometries keyed by material slot */
  geos: { slot: 'body' | 'bag' | 'accent'; geo: THREE.BufferGeometry }[];
}

export interface RigTemplate {
  segs: Record<Seg, SegTemplate>;
  materials: { body: THREE.MeshStandardMaterial; bag: THREE.MeshStandardMaterial };
}

let templatePromise: Promise<RigTemplate> | null = null;

export function loadRobot(url = '/models/robot.opt.glb'): Promise<RigTemplate> {
  templatePromise ??= new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .loadAsync(url)
    .then((g) => buildTemplate(g.scene));
  return templatePromise;
}

/** Copy every attribute to plain Float32 so transforms don't clip quantised Int16 data. */
function toFloat(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv'] as const) {
    const a = src.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!a) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) {
      out[i * a.itemSize] = a.getX(i);
      if (a.itemSize > 1) out[i * a.itemSize + 1] = a.getY(i);
      if (a.itemSize > 2) out[i * a.itemSize + 2] = a.getZ(i);
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>));
  return g.index ? g.toNonIndexed() : g;
}

/** Split a non-indexed geometry into triangles with centroid x ≥ 0 and < 0. */
function splitBySide(g: THREE.BufferGeometry): THREE.BufferGeometry[] {
  const pos = g.getAttribute('position');
  const tris = pos.count / 3;
  const sides: number[][] = [[], []];
  for (let t = 0; t < tris; t++) {
    const cx = pos.getX(t * 3) + pos.getX(t * 3 + 1) + pos.getX(t * 3 + 2);
    sides[cx >= 0 ? 0 : 1].push(t);
  }
  return sides
    .filter((s) => s.length)
    .map((list) => {
      const out = new THREE.BufferGeometry();
      for (const name of Object.keys(g.attributes)) {
        const a = g.getAttribute(name);
        const arr = new Float32Array(list.length * 3 * a.itemSize);
        list.forEach((t, k) => arr.set((a.array as Float32Array).subarray(t * 3 * a.itemSize, (t + 1) * 3 * a.itemSize), k * 3 * a.itemSize));
        out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
      }
      return out;
    });
}

function classify(g: THREE.BufferGeometry): Seg {
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new THREE.Vector3());
  if (c.y > NECK_Y) return 'head';
  if (Math.abs(c.x) > ARM_X && c.y > 0.12) return c.x > 0 ? 'armL' : 'armR';
  if (c.y < HIP_Y) return c.x > 0 ? 'legL' : 'legR';
  return 'torso';
}

function buildTemplate(scene: THREE.Object3D): RigTemplate {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const norm = new THREE.Matrix4()
    .makeScale(1 / size.y, 1 / size.y, 1 / size.y)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));

  let body: THREE.MeshStandardMaterial | null = null;
  let bag: THREE.MeshStandardMaterial | null = null;
  const buckets = new Map<string, THREE.BufferGeometry[]>(); // `${seg}|${slot}`

  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    const partName = m.parent?.name ?? '';
    const isBag = mat.name === 'material';
    if (isBag) bag ??= mat;
    else body ??= mat;
    const slot = ACCENT_PARTS.has(partName) ? 'accent' : isBag ? 'bag' : 'body';
    const g = toFloat(m.geometry);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(norm, m.matrixWorld));
    const halves = partName.startsWith('head') || partName === 'screen' || partName === 'cap' ? [g] : splitBySide(g);
    for (const h of halves) {
      const seg = slot === 'accent' ? 'head' : classify(h);
      const key = `${seg}|${slot}`;
      buckets.set(key, [...(buckets.get(key) ?? []), h]);
    }
  });

  const segs = {} as Record<Seg, SegTemplate>;
  for (const seg of SEGS) {
    const all = [...buckets.entries()].filter(([k]) => k.startsWith(seg + '|')).flatMap(([, v]) => v);
    const bb = new THREE.Box3();
    for (const g of all) {
      g.computeBoundingBox();
      bb.union(g.boundingBox!);
    }
    const c = bb.getCenter(new THREE.Vector3());
    const pivot =
      seg === 'head' ? new THREE.Vector3(0, bb.min.y + 0.02, c.z)
      : seg === 'torso' ? new THREE.Vector3(0, HIP_Y, c.z)
      : seg.startsWith('arm') ? new THREE.Vector3(c.x * 0.8, bb.max.y - 0.04, c.z)
      : new THREE.Vector3(c.x, bb.max.y - 0.01, c.z);
    const geos: SegTemplate['geos'] = [];
    for (const slot of ['body', 'bag', 'accent'] as const) {
      const list = buckets.get(`${seg}|${slot}`);
      if (!list?.length) continue;
      const merged = mergeGeometries(list, false)!;
      merged.translate(-pivot.x, -pivot.y, -pivot.z);
      merged.computeBoundingSphere();
      geos.push({ slot, geo: merged });
    }
    segs[seg] = { pivot, geos };
  }
  if (!body || !bag) throw new Error('robot model: materials not found');
  return { segs, materials: { body, bag } };
}

// ── one robot instance ─────────────────────────────────────────────────────

export type Pose =
  | 'idle'
  | 'walk'
  | 'type'
  | 'read'
  | 'think'
  | 'raise_hand'
  | 'wave'
  | 'drink'
  | 'celebrate'
  | 'charge';

export class RobotRig {
  readonly root = new THREE.Group(); // placed in the room by the scene
  readonly yawGroup = new THREE.Group(); // faces the walk direction
  private bob = new THREE.Group();
  private nodes = {} as Record<Seg, THREE.Group>;
  private materials: THREE.MeshStandardMaterial[] = [];
  private seed = Math.random() * 100;

  constructor(t: RigTemplate, roleColor: string) {
    const body = t.materials.body.clone();
    const bag = t.materials.bag.clone();
    const color = new THREE.Color(roleColor);
    const accent = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, metalness: 0.2, roughness: 0.35 });
    this.materials = [body, bag, accent];
    for (const m of this.materials) {
      m.transparent = true; // drawn in the painter's-order pass with the sprites
      m.depthWrite = true;
      m.depthTest = true;
    }
    const mats = { body, bag, accent };

    this.root.add(this.yawGroup);
    this.yawGroup.add(this.bob);
    const debugParts = new URLSearchParams(location.search).has('parts'); // ?parts colours each segment
    for (const [i, seg] of SEGS.entries()) {
      const g = new THREE.Group();
      g.name = seg;
      const dbg = debugParts ? new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(i / 6, 0.8, 0.55), transparent: true }) : null;
      if (dbg) this.materials.push(dbg);
      for (const { slot, geo } of t.segs[seg].geos) g.add(new THREE.Mesh(geo, dbg ?? mats[slot]));
      this.nodes[seg] = g;
    }
    const { torso, head, armL, armR, legL, legR } = this.nodes;
    const piv = (s: Seg) => t.segs[s].pivot;
    const rel = (s: Seg, parent: Seg | null) => (parent ? piv(s).clone().sub(piv(parent)) : piv(s).clone());
    torso.position.copy(rel('torso', null));
    for (const s of ['head', 'armL', 'armR'] as Seg[]) {
      this.nodes[s].position.copy(rel(s, 'torso'));
      torso.add(this.nodes[s]);
    }
    legL.position.copy(rel('legL', null));
    legR.position.copy(rel('legR', null));
    this.bob.add(torso, legL, legR);
    void head;
    void armL;
    void armR;
  }

  setRenderOrder(order: number): void {
    this.root.traverse((o) => (o.renderOrder = order));
  }

  setOpacity(o: number): void {
    for (const m of this.materials) m.opacity = o;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
  }

  /**
   * Set every joint for a pose at time t (seconds). walkPhase advances with distance walked.
   * Model faces +Z; its own left (+x) arm is armL. Arm: rotation.x < 0 swings forward,
   * rotation.z raises sideways (+ for armL, − for armR).
   */
  pose(p: Pose, t: number, walkPhase = 0): void {
    const { torso, head, armL, armR, legL, legR } = this.nodes;
    const tt = t + this.seed;
    const breathe = Math.sin(tt * 2) * 0.006;
    for (const n of [torso, head, armL, armR, legL, legR]) n.rotation.set(0, 0, 0);
    this.bob.position.y = breathe;
    armL.rotation.z = 0.08;
    armR.rotation.z = -0.08;

    switch (p) {
      case 'walk': {
        const s = Math.sin(walkPhase);
        legL.rotation.x = s * 0.55;
        legR.rotation.x = -s * 0.55;
        armL.rotation.x = -s * 0.45;
        armR.rotation.x = s * 0.45;
        this.bob.position.y = Math.abs(Math.cos(walkPhase)) * 0.025;
        torso.rotation.x = 0.06;
        break;
      }
      case 'type': {
        armL.rotation.x = -1.15 + Math.sin(tt * 14) * 0.07;
        armR.rotation.x = -1.15 + Math.sin(tt * 14 + 1.7) * 0.07;
        armL.rotation.z = -0.15;
        armR.rotation.z = 0.15;
        head.rotation.x = 0.18;
        head.rotation.y = Math.sin(tt * 0.6) * 0.12;
        break;
      }
      case 'read': {
        armL.rotation.x = -0.95;
        armR.rotation.x = -0.95;
        armL.rotation.z = -0.25;
        armR.rotation.z = 0.25;
        head.rotation.x = 0.28;
        head.rotation.y = Math.sin(tt * 0.9) * 0.25; // scanning
        break;
      }
      case 'think': {
        armR.rotation.x = -1.9;
        armR.rotation.z = 0.55; // hand to chin
        armL.rotation.x = -0.5;
        armL.rotation.z = -0.3;
        head.rotation.z = Math.sin(tt * 0.8) * 0.12 + 0.08;
        head.rotation.x = -0.08;
        torso.rotation.y = Math.sin(tt * 0.5) * 0.06;
        break;
      }
      case 'raise_hand': {
        armL.rotation.z = 2.95 + Math.sin(tt * 7) * 0.15; // waving overhead
        armL.rotation.x = -0.25;
        armR.rotation.z = -0.12;
        head.rotation.x = -0.15;
        this.bob.position.y = Math.abs(Math.sin(tt * 3.5)) * 0.018;
        break;
      }
      case 'wave': {
        armL.rotation.z = 2.2 + Math.sin(tt * 9) * 0.3;
        head.rotation.y = 0.15;
        break;
      }
      case 'drink': {
        const sip = (Math.sin(tt * 0.9) + 1) / 2; // 0 = cup down, 1 = sipping
        armR.rotation.x = -1.2 - sip * 0.9;
        armR.rotation.z = 0.35;
        head.rotation.x = -sip * 0.25;
        break;
      }
      case 'celebrate': {
        const j = Math.abs(Math.sin(tt * 6));
        armL.rotation.z = 2.5 + j * 0.3;
        armR.rotation.z = -2.5 - j * 0.3;
        this.bob.position.y = j * 0.07;
        head.rotation.x = -0.2;
        break;
      }
      case 'charge': {
        head.rotation.x = 0.38;
        torso.rotation.x = 0.1;
        armL.rotation.z = 0.2;
        armR.rotation.z = -0.2;
        this.bob.position.y = Math.sin(tt * 1.2) * 0.004;
        break;
      }
      default: {
        // idle: breathe, glance around now and then
        const look = Math.sin(tt * 0.35);
        head.rotation.y = Math.abs(look) > 0.8 ? Math.sign(look) * 0.35 * (Math.abs(look) - 0.8) * 5 : 0;
        armL.rotation.x = Math.sin(tt * 2) * 0.03;
        armR.rotation.x = -Math.sin(tt * 2) * 0.03;
      }
    }
  }
}
