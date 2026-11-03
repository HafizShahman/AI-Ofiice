import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Activity } from '@ai-office/shared';
import type { Anchor } from './anchors.ts';
import { currentHour, lerp, lightAt, mix, phaseOf, rigAt, useDaylight, type RGB } from './daylight.ts';
import type { Pt } from './layout.ts';
import type { Waypoint } from './nav.ts';
import { route } from './route3d.ts';
import { SunPatches } from './SunPatches.ts';
import { loadRobot, RobotRig, type Pose, type RigTemplate } from './robot.ts';
import type { CameraView, OfficeSceneApi, SceneAgent, Spatial } from './sceneApi.ts';
import { WallClock } from './WallClock.ts';
import room from './room3d.json';
import overrides from './room3d.overrides.json';

/**
 * The office as a real 3D room: apps/web/public/models/room.glb, built in Blender by
 * Assets/blender/build_room.py + build_props.py (`npm run build:room`). Robots stand at the
 * server's spots (room3d.json maps every spot id from props.json to a place in the room) and walk
 * there over the 3D walk grids (route3d.ts / nav3d.ts), down the stairs and into the holo pit.
 *
 * World units are metres. Plan coordinates [x, d, z] (x along the back wall, d away from it,
 * z up) become three.js (x, z, d), the same mapping the glTF export uses.
 *
 * The camera is orthographic. It starts at the painting's angle (azimuth 45°, elevation 30°) and
 * can orbit a little (right-drag / Shift-drag). The city outside only lines up from that one
 * angle, so it hides when the camera turns away.
 *
 * Look: bloom on the neon (off on the Low resolution setting), a light rig and sky that follow the
 * day/night clock (daylight.ts, the same model as the painted office), and the holo wall clock on
 * the window wall. Props with a second state (coffee brewing, cabinet open, printer jammed) ship
 * as hidden `PropAlt_*` nodes in the GLB and are swapped in while a robot uses them.
 */

const ROBOT_H = 1.3; // metres, feet to antenna
const WALK_SPEED = 1.5; // m/s
const FADE_S = 0.6;
const AZ_RANGE: [number, number] = [5, 85];
const EL_RANGE: [number, number] = [18, 60];
const QUERY = new URLSearchParams(location.search);
const FORCE_POSE = QUERY.get('pose') as Pose | null;

const POSE_FOR: Partial<Record<Activity, Pose>> = {
  coding: 'type',
  running: 'type',
  browsing: 'type',
  researching: 'read',
  planning: 'think',
  thinking: 'think',
  delegating: 'wave',
  blocked: 'raise_hand',
  done: 'celebrate',
  coffee: 'drink',
  charging: 'charge',
};

/** plan [x, d, z] → world */
const W3 = (p: number[]): THREE.Vector3 => new THREE.Vector3(p[0], p[2] ?? 0, p[1]);

interface Spot3 {
  pos: THREE.Vector3;
  face: THREE.Vector3 | null;
  prop: string;
}

type SpotDef = { pos: number[]; face: number[] | null; prop: string };
/** Points moved in ?helper (room3d.overrides.json) win over Blender's, so a rebuild keeps them. */
const SPOT_OVERRIDES = (overrides as { spots: Record<string, { pos: number[]; face: number[] | null }> }).spots;
const SPOTS = new Map<string, Spot3>(
  Object.entries(room.spots as Record<string, SpotDef>).map(([id, s]) => {
    const o = SPOT_OVERRIDES[id] ?? s;
    return [id, { pos: W3(o.pos), face: o.face ? W3(o.face) : null, prop: s.prop }];
  }),
);
/** plan [x, d, height] ← world (three.js is x, height, d) */
const PLAN = (v: THREE.Vector3): number[] => [v.x, v.z, v.y];
const DOOR = SPOTS.get('door')!;

interface AltDef {
  node: string;
  alt: string;
  when: 'busy' | 'fail';
  prop: string;
  at: number[];
}
interface Alt {
  def: AltDef;
  base: THREE.Object3D;
  alt: THREE.Object3D;
  at: THREE.Vector3;
  on: boolean;
  failUntil: number;
}
const ALTS = (room as unknown as { alts?: AltDef[] }).alts ?? [];
/** Nodes that keep their own meshes (they move or swap); everything else is merged by material. */
const LIVE = new Set(['Prop_ShipBell', ...ALTS.flatMap((a) => [a.node, a.alt])]);

/** Room materials the day/night grade touches (Blender material names). */
const SKY = {
  haze: 'OF_CityHaze',
  blocks: 'OF_CityBlock',
  lights: ['OF_CityLightCyan', 'OF_CityLightPink', 'OF_CityLightAmber'],
  glass: 'OF_Glass',
};
const HAZE_NIGHT: RGB = [0.25, 0.45, 0.8];
const HAZE_DAY: RGB = [0.62, 0.82, 1.0];
const HAZE_DUSK: RGB = [1.0, 0.55, 0.36];
const BLOCK_NIGHT: RGB = [0.06, 0.1, 0.22];
const BLOCK_DAY: RGB = [0.3, 0.4, 0.55];
const CLEAR_NIGHT = new THREE.Color(0x0f1324);
const EMISSIVE_SCALE = 0.35;
const CLEAR_DAY = new THREE.Color(0x1a2438);

interface Bot {
  id: string;
  rig: RobotRig;
  ring: THREE.Mesh;
  pos: THREE.Vector3;
  path: THREE.Vector3[];
  spot: string | null;
  target: Spot3;
  yaw: number;
  yawTarget: number;
  walkPhase: number;
  stepK: number;
  wasMoving: boolean;
  agent: SceneAgent;
  fade: number;
  removing: boolean;
}

interface View {
  target: THREE.Vector3;
  az: number; // degrees
  el: number;
  zoom: number; // screen px per metre
}

/** Plain float position + normal, so quantised (meshopt) meshes can be transformed and merged. */
function floatGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const geo = src.index ? src.toNonIndexed() : src;
  for (const name of ['position', 'normal'] as const) {
    const a = geo.getAttribute(name);
    if (!a) continue;
    const out = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i++) {
      out[i * 3] = a.getX(i);
      out[i * 3 + 1] = a.getY(i);
      out[i * 3 + 2] = a.getZ(i);
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, 3));
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

export class OfficeScene3D implements OfficeSceneApi {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private useBloom = true;
  private bots = new Map<string, Bot>();
  private template: RigTemplate | null = null;
  private pending: SceneAgent[] | null = null;
  private raf = 0;
  private last = performance.now();
  private clock = 0;
  private w = 1;
  private h = 1;
  private view: View;
  private viewTarget: View;
  private following: string | null = null;
  private selected: string | null = null;
  private dirty = true;
  private userMoved = false;
  private city: THREE.Object3D[] = [];
  private bell: THREE.Object3D | null = null;
  private bellRest = 0;
  private bellUntil = 0;
  private alts: Alt[] = [];
  private roomRoot: THREE.Object3D | null = null;
  private pmrem: THREE.PMREMGenerator;
  private hemi: THREE.HemisphereLight;
  private key: THREE.DirectionalLight;
  private sun: THREE.DirectionalLight;
  /** sun through each window pane, laid on the floor */
  private sunPatches: SunPatches;
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  private wallClock: WallClock;
  private lit = { day: -1, warm: -1 };
  private statsLogged = !QUERY.has('stats');
  onViewChange?: (v: CameraView) => void;
  onStep?: (id: string, at: Spatial) => void;
  onArrive?: (id: string, propId: string, at: Spatial) => void;
  overlay: HTMLElement | null = null;
  reduceMotion = false;
  readonly tags: Map<string, HTMLElement>;
  anchors = new Map<string, Anchor>();

  constructor(canvas: HTMLCanvasElement, tags: Map<string, HTMLElement>) {
    this.tags = tags;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(CLEAR_NIGHT);
    // Neutral rather than AgX: once the whole frame goes through the OutputPass, AgX lifts the dark navy background to grey
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.8;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // bloom on the bright neon only; the OutputPass applies tone mapping + sRGB afterwards
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.18, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const cam = room.camera;
    const home: View = { target: W3(cam.target), az: cam.az, el: cam.el, zoom: 40 };
    this.view = { ...home, target: home.target.clone() };
    this.viewTarget = { ...home, target: home.target.clone() };

    // soft reflections for the metal, plus a light rig close to the Blender preview's
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.12;
    this.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x0b1220, 0.55);
    this.key = new THREE.DirectionalLight(0xbfd8ff, 0.7);
    this.key.position.set(6, 14, 10);
    // daylight through the window wall (x = 0), off at night
    this.sun = new THREE.DirectionalLight(0xfff1d6, 0);
    this.sun.position.set(-12, 10, 4);
    this.sun.target.position.set(8, 0, 6);
    this.scene.add(this.hemi, this.key, this.sun, this.sun.target);
    this.sunPatches = new SunPatches(this.scene);
    const glow = (x: number, d: number, z: number, i: number, color = 0x55d8ff, dist = 7) => {
      const l = new THREE.PointLight(color, i, dist, 1.6);
      l.position.copy(W3([x, d, z]));
      this.scene.add(l);
    };
    glow(room.holo.c[0], room.holo.c[1], 1.4, 6);
    glow(8.2, 1.2, 3.6, 3);
    glow(3.0, 1.2, 2.9, 3);
    glow(9.4, 10.2, 2.4, 4, 0x66ccff, 9);
    glow(15.3, 10.2, 1.4, 3);
    glow(12.5, 3.0, 2.6, 3, 0x66ccff, 8);
    glow(0.8, 6.0, 2.8, 3, 0x8899ff, 6);

    // holo wall clock on the window wall, above the curved holo screen, facing into the room
    this.wallClock = new WallClock(this.scene);
    const cw = 1.9;
    const ch = (cw * 150) / 440;
    this.wallClock.place(new THREE.Matrix4().set(0, 0, 1, 0.2, 0, ch, 0, 3.85, -cw, 0, 0, 5.8 + cw / 2, 0, 0, 0, 1));

    new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .loadAsync('/models/room.glb')
      .then((g) => this.addRoom(g.scene));
    loadRobot().then((t) => {
      this.template = t;
      if (this.pending) this.setAgents(this.pending);
      this.dirty = true;
    });
    this.loop();
  }

  private addRoom(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (o.name.startsWith('City_')) this.city.push(o);
      if (o.name === 'Prop_ShipBell') this.bell = o;
      o.matrixAutoUpdate = false;
      o.updateMatrix();
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of ([] as THREE.Material[]).concat(mesh.material)) {
        if (m.transparent) m.depthWrite = false;
        const std = m as THREE.MeshStandardMaterial;
        if (!std.isMeshStandardMaterial) continue;
        // Blender's EEVEE glow needs strong emission; with real bloom here a third of it reads the same
        if (!this.mats.has(std.name) && std.emissiveIntensity > 1) std.emissiveIntensity *= EMISSIVE_SCALE;
        this.mats.set(std.name, std);
      }
    });
    if (this.bell) this.bellRest = this.bell.rotation.z;
    for (const def of ALTS) {
      const base = root.getObjectByName(def.node);
      const alt = root.getObjectByName(def.alt);
      if (!base || !alt) continue;
      alt.visible = false;
      this.alts.push({ def, base, alt, at: W3(def.at), on: false, failUntil: 0 });
    }
    this.mergeStatic(root);
    this.roomRoot = root;
    this.scene.add(root);
    this.lit = { day: -1, warm: -1 }; // re-grade now that the sky materials exist
    this.dirty = true;
  }

  /** Merge every mesh that never moves or swaps into one mesh per material (≈200 draw calls → ≈45). */
  private mergeStatic(root: THREE.Object3D): void {
    root.updateMatrixWorld(true);
    const live = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (LIVE.has(p.name) || p.name.startsWith('City_')) return true;
      return false;
    };
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const drop: THREE.Mesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material) || live(m)) return;
      const g = floatGeometry(m.geometry).applyMatrix4(m.matrixWorld);
      const list = buckets.get(m.material) ?? [];
      list.push(g);
      buckets.set(m.material, list);
      drop.push(m);
    });
    for (const m of drop) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    for (const [mat, geos] of buckets) {
      const g = mergeGeometries(geos, false);
      geos.forEach((x) => x.dispose());
      if (!g) continue;
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = `Static_${mat.name}`;
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
    }
  }

  // ── agents ──────────────────────────────────────────────────────────────

  private spotOf(id: string | null): Spot3 | null {
    return id ? (SPOTS.get(id) ?? null) : null;
  }

  /** ?helper: every spot as plan [x, d, height] (face: null when the spot has none). */
  spotPoints(): { id: string; pos: number[]; face: number[] | null }[] {
    return [...SPOTS].map(([id, s]) => ({ id, pos: PLAN(s.pos), face: s.face ? PLAN(s.face) : null }));
  }

  /** ?helper: move a spot's point (plan [x, d, height]). Robots use it from their next walk. */
  setSpotPoint(id: string, which: 'pos' | 'face', p: number[]): void {
    const s = SPOTS.get(id);
    const v = s && (which === 'pos' ? s.pos : s.face);
    v?.copy(W3(p));
    this.dirty = true;
  }

  /** ?helper: screen px of a plan point [x, d, height]. */
  projectPlan(p: number[]): Pt {
    this.applyCamera(this.view);
    const s = this.toScreen(W3(p));
    return [s.x, s.y];
  }

  /** ?helper: plan [x, d] under a screen point, on the horizontal plane at `height`. */
  planAt(sx: number, sy: number, height: number): Pt {
    this.applyCamera(this.view);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((sx / this.w) * 2 - 1, -(sy / this.h) * 2 + 1), this.camera);
    const hit = new THREE.Vector3();
    ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -height), hit);
    return [hit.x, hit.z];
  }

  setAgents(agents: SceneAgent[]): void {
    if (!this.template) {
      this.pending = agents;
      return;
    }
    const seen = new Set<string>();
    for (const a of agents) {
      seen.add(a.id);
      const bot = this.bots.get(a.id) ?? this.spawn(a);
      bot.agent = a;
      bot.removing = false;
      if (a.spot !== bot.spot) {
        const target = this.spotOf(a.spot) ?? (a.status === 'leaving' ? DOOR : { pos: bot.pos.clone(), face: null, prop: '' });
        bot.spot = a.spot;
        bot.target = target;
        bot.path = route(bot.pos, target.pos);
      }
    }
    for (const [id, bot] of this.bots) if (!seen.has(id)) bot.removing = true;
    this.dirty = true;
  }

  private spawn(a: SceneAgent): Bot {
    const rig = new RobotRig(this.template!, a.color);
    rig.root.scale.setScalar(ROBOT_H);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.78, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, depthWrite: false, toneMapped: false }),
    );
    ring.scale.setScalar(0.42);
    ring.visible = false;
    this.scene.add(rig.root, ring);
    const target = this.spotOf(a.spot) ?? DOOR;
    const fromDoor = a.status === 'arriving';
    const start = fromDoor ? DOOR : target;
    const bot: Bot = {
      id: a.id,
      rig,
      ring,
      pos: start.pos.clone(),
      path: fromDoor ? route(DOOR.pos, target.pos) : [],
      spot: a.spot,
      target,
      yaw: 0,
      yawTarget: 0,
      walkPhase: 0,
      stepK: -1,
      wasMoving: false,
      agent: a,
      fade: 0,
      removing: false,
    };
    this.bots.set(a.id, bot);
    return bot;
  }

  private dropBot(bot: Bot): void {
    this.scene.remove(bot.rig.root, bot.ring);
    bot.rig.dispose();
    (bot.ring.material as THREE.Material).dispose();
    bot.ring.geometry.dispose();
    this.bots.delete(bot.id);
    this.tags.get(bot.id)?.style.setProperty('display', 'none');
  }

  private updateBot(bot: Bot, dt: number): boolean {
    let moving = false;
    let step = WALK_SPEED * dt;
    while (step > 0 && bot.path.length) {
      const wp = bot.path[0];
      const dx = wp.x - bot.pos.x;
      const dz = wp.z - bot.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.01) {
        bot.pos.copy(wp);
        bot.path.shift();
        continue;
      }
      const s = Math.min(step, d);
      const t = s / d;
      bot.pos.x += dx * t;
      bot.pos.z += dz * t;
      bot.pos.y += (wp.y - bot.pos.y) * t;
      bot.yawTarget = Math.atan2(dx, dz);
      bot.walkPhase += (s / ROBOT_H) * 7;
      step -= s;
      moving = true;
    }
    if (!moving) {
      const f = bot.target.face;
      bot.yawTarget = f ? Math.atan2(f.x - bot.pos.x, f.z - bot.pos.z) : (this.view.az * Math.PI) / 180;
    }
    if (moving) {
      const k = Math.floor((bot.walkPhase - Math.PI / 2) / Math.PI);
      if (k !== bot.stepK) {
        bot.stepK = k;
        if (bot.fade > 0.4) this.onStep?.(bot.id, this.spatialAt(bot.pos));
      }
    } else if (bot.wasMoving && bot.fade > 0.4) this.onArrive?.(bot.id, bot.target.prop, this.spatialAt(bot.pos));
    bot.wasMoving = moving;
    let dy = bot.yawTarget - bot.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    bot.yaw += dy * Math.min(1, dt * 10);
    bot.rig.yawGroup.rotation.y = bot.yaw;

    const leavingDone = bot.removing && !moving;
    bot.fade = Math.max(0, Math.min(1, bot.fade + (leavingDone ? -dt : dt) / FADE_S));
    bot.rig.setOpacity(bot.fade);

    const a = bot.agent;
    const pose: Pose = FORCE_POSE ?? (moving ? 'walk' : (POSE_FOR[a.activity] ?? 'idle'));
    bot.rig.pose(pose, this.clock, bot.walkPhase);
    bot.rig.root.position.copy(bot.pos);

    const ringMat = bot.ring.material as THREE.MeshBasicMaterial;
    const blocked = a.status === 'blocked';
    const charging = a.activity === 'charging' && !moving;
    bot.ring.visible = bot.fade > 0 && (this.selected === a.id || blocked || charging);
    ringMat.color.set(blocked ? 0xfbbf24 : 0x22d3ee);
    ringMat.opacity = (this.selected === a.id ? 0.95 : 0.45 + 0.4 * Math.sin(this.clock * 4) ** 2) * bot.fade;
    bot.ring.position.set(bot.pos.x, bot.pos.y + 0.015, bot.pos.z);
    return moving;
  }

  // ── living details ──────────────────────────────────────────────────────

  flashProp(propId: string, kind: 'fail' | 'ring'): void {
    const now = performance.now();
    if (propId === 'bell' && kind === 'ring') this.bellUntil = now + 1800;
    if (kind === 'fail') for (const a of this.alts) if (a.def.prop === propId && a.def.when === 'fail') a.failUntil = now + 6000;
    this.dirty = true;
  }

  /** Coffee brews and the cabinet opens while a robot stands at it; the printer jams for a few seconds after a failure. */
  private updateProps(now: number): void {
    for (const a of this.alts) {
      let on: boolean;
      if (a.def.when === 'fail') on = a.failUntil > now;
      else {
        on = false;
        for (const b of this.bots.values()) {
          if (b.path.length || b.removing || b.target.prop !== a.def.prop) continue;
          // a desk screen is on only while its agent is at work (idle or on a break leaves it dark)
          if (a.def.prop.startsWith('desk-') && b.agent?.status !== 'working' && b.agent?.status !== 'blocked') continue;
          // the nearest machine of that kind to where the robot stands
          let best: Alt | null = null;
          let bestD = Infinity;
          for (const o of this.alts) {
            if (o.def.prop !== a.def.prop) continue;
            const d = Math.hypot(o.at.x - b.pos.x, o.at.z - b.pos.z);
            if (d < bestD) {
              bestD = d;
              best = o;
            }
          }
          if (best === a && bestD < 2) on = true;
        }
      }
      if (on !== a.on) {
        a.on = on;
        a.base.visible = !on;
        a.alt.visible = on;
        this.dirty = true;
      }
    }
    if (this.bell) {
      const left = this.bellUntil - now;
      const swing = left > 0 ? Math.sin(left / 55) * 0.16 * (left / 1800) : 0;
      if (swing !== this.bell.rotation.z - this.bellRest) {
        this.bell.rotation.z = this.bellRest + swing;
        this.bell.updateMatrix();
        this.dirty = true;
      }
    }
  }

  // ── day / night ─────────────────────────────────────────────────────────

  /** Same clock and model as the painted office: lights, sky in the windows, exposure. */
  private updateLight(dt: number): void {
    const hour = currentHour(useDaylight.getState().mode, this.clock);
    if (this.wallClock.update(hour)) this.dirty = true;
    const l = lightAt(hour);
    const first = this.lit.day < 0;
    const k = first || this.reduceMotion ? 1 : Math.min(1, dt * 2.5);
    const day = first ? l.day : lerp(this.lit.day, l.day, k);
    const warm = first ? l.warm : lerp(this.lit.warm, l.warm, k);
    const phase = phaseOf(l);
    if (useDaylight.getState().phase !== phase) useDaylight.setState({ phase });
    if (!first && Math.abs(day - this.lit.day) < 1e-4 && Math.abs(warm - this.lit.warm) < 1e-4) return;
    this.lit = { day, warm };

    const rig = rigAt({ ...l, day, warm });
    this.hemi.color.setRGB(...rig.hemiSky, THREE.SRGBColorSpace);
    this.hemi.groundColor.setRGB(...rig.hemiGround, THREE.SRGBColorSpace);
    this.hemi.intensity = rig.hemi * 0.26;
    this.key.color.setRGB(...rig.key, THREE.SRGBColorSpace);
    this.key.intensity = rig.keyI * 0.29;
    this.sun.color.setRGB(...mix([1, 0.95, 0.85], [1, 0.62, 0.38], warm), THREE.SRGBColorSpace);
    this.sun.intensity = 1.6 * day + 0.6 * warm * (1 - day);
    this.renderer.toneMappingExposure = lerp(0.8, 0.95, day);
    this.renderer.setClearColor(CLEAR_NIGHT.clone().lerp(CLEAR_DAY, day));

    const haze = this.mats.get(SKY.haze);
    if (haze) {
      haze.emissive.setRGB(...mix(mix(HAZE_NIGHT, HAZE_DAY, day), HAZE_DUSK, warm * 0.8), THREE.SRGBColorSpace);
      haze.emissiveIntensity = lerp(1.2, 2.4, day) * EMISSIVE_SCALE * 1.6;
    }
    const blocks = this.mats.get(SKY.blocks);
    if (blocks) {
      blocks.emissive.setRGB(...mix(BLOCK_NIGHT, BLOCK_DAY, day), THREE.SRGBColorSpace);
      blocks.emissiveIntensity = lerp(1.4, 1.0, day) * EMISSIVE_SCALE * 1.6;
    }
    for (const n of SKY.lights) {
      const m = this.mats.get(n);
      if (m) m.emissiveIntensity = lerp(3, 0.6, day) * EMISSIVE_SCALE;
    }
    this.sunPatches.update(l, day);
    this.dirty = true;
  }

  // ── camera ──────────────────────────────────────────────────────────────

  private applyCamera(v: View): void {
    const az = (v.az * Math.PI) / 180;
    const el = (v.el * Math.PI) / 180;
    const cam = this.camera;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    cam.position.copy(v.target).addScaledVector(dir, 120);
    cam.up.set(0, 1, 0);
    cam.lookAt(v.target);
    cam.left = -this.w / 2 / v.zoom;
    cam.right = this.w / 2 / v.zoom;
    cam.top = this.h / 2 / v.zoom;
    cam.bottom = -this.h / 2 / v.zoom;
    cam.near = 1;
    cam.far = 300;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  resize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.renderer.setSize(this.w, this.h, false);
    this.composer.setSize(this.w, this.h);
    if (!this.userMoved) this.fit(true);
    this.dirty = true;
  }

  /** Resolution cap (settings: Low 1×, Medium 1.5×, High 2×). Low also turns the bloom off. */
  setPixelRatioCap(cap: number): void {
    const pr = Math.min(window.devicePixelRatio, cap);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.w, this.h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this.w, this.h);
    this.useBloom = cap > 1;
    this.dirty = true;
  }

  private touring = false;
  private tourT = 0;

  setTour(on: boolean): void {
    if (on === this.touring) return;
    this.touring = on;
    this.tourT = 0;
    if (on) this.following = null;
    else this.fit();
    this.dirty = true;
  }

  private tourStep(dt: number): void {
    this.tourT += dt;
    const t = this.tourT;
    const home = room.camera;
    const z = this.fitZoom();
    this.viewTarget.target.set(home.target[0] + Math.sin(t * 0.045) * 3.2, home.target[2], home.target[1] + Math.sin(t * 0.032 + 1) * 1.8);
    this.viewTarget.az = home.az + Math.sin(t * 0.03) * 22;
    this.viewTarget.el = home.el + Math.sin(t * 0.021 + 2) * 6;
    this.viewTarget.zoom = z * (1.35 + 0.3 * Math.sin(t * 0.027 + 2));
    this.userMoved = true;
  }

  private fitZoom(): number {
    const s = room.camera.orthoScale * 0.86; // Blender: width of the 4:3 frame in metres (with a margin we don't need here)
    return Math.min(this.w / s, this.h / (s * 0.75));
  }

  fit(jump = false): void {
    const home = room.camera;
    this.viewTarget = { target: W3(home.target), az: home.az, el: home.el, zoom: this.fitZoom() };
    if (jump) this.view = { ...this.viewTarget, target: this.viewTarget.target.clone() };
    this.userMoved = false;
    this.following = null;
    this.dirty = true;
  }

  /** Point on the horizontal plane through the view target under a screen point. */
  private groundAt(sx: number, sy: number, v: View): THREE.Vector3 {
    this.applyCamera(v);
    const ndc = new THREE.Vector2((sx / this.w) * 2 - 1, -(sy / this.h) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -v.target.y), hit) ?? v.target.clone();
  }

  zoomBy(factor: number, at?: { x: number; y: number }): void {
    const v = this.viewTarget;
    const fz = this.fitZoom();
    const zoom = Math.max(fz * 0.8, Math.min(fz * 5, v.zoom * factor));
    if (at && !this.following) {
      const before = this.groundAt(at.x, at.y, v);
      v.zoom = zoom;
      const after = this.groundAt(at.x, at.y, v);
      v.target.add(before.sub(after));
      this.view.target.copy(v.target);
    }
    v.zoom = zoom;
    this.view.zoom = zoom;
    this.clamp();
    this.userMoved = true;
    this.dirty = true;
  }

  panBy(dx: number, dy: number): void {
    this.following = null;
    const v = this.viewTarget;
    const az = (v.az * Math.PI) / 180;
    const el = (v.el * Math.PI) / 180;
    const right = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));
    const away = new THREE.Vector3(-Math.sin(az), 0, -Math.cos(az));
    v.target.addScaledVector(right, -dx / v.zoom).addScaledVector(away, dy / (v.zoom * Math.sin(el)));
    this.clamp();
    this.view.target.copy(v.target);
    this.userMoved = true;
    this.dirty = true;
  }

  orbitBy(dx: number, dy: number): void {
    const v = this.viewTarget;
    v.az = Math.max(AZ_RANGE[0], Math.min(AZ_RANGE[1], v.az - dx * 0.25));
    v.el = Math.max(EL_RANGE[0], Math.min(EL_RANGE[1], v.el + dy * 0.2));
    this.view.az = v.az;
    this.view.el = v.el;
    this.userMoved = true;
    this.dirty = true;
  }

  private clamp(): void {
    const t = this.viewTarget.target;
    t.x = Math.max(-2, Math.min(room.room.w + 2, t.x));
    t.z = Math.max(-2, Math.min(room.room.d + 2, t.z));
  }

  focus(id: string, follow = false): void {
    const b = this.bots.get(id);
    if (!b) return;
    this.viewTarget.target.set(b.pos.x, b.pos.y + ROBOT_H * 0.5, b.pos.z);
    this.viewTarget.zoom = Math.max(this.viewTarget.zoom, this.fitZoom() * 2);
    this.following = follow ? id : null;
    this.userMoved = true;
    this.dirty = true;
  }

  private toScreen(p: THREE.Vector3): { x: number; y: number; depth: number } {
    const v = p.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * this.w, y: ((1 - v.y) / 2) * this.h, depth: v.z };
  }

  spatial(id: string): Spatial | null {
    const b = this.bots.get(id);
    return b ? this.spatialAt(b.pos) : null;
  }

  private spatialAt(p: THREE.Vector3): Spatial {
    const s = this.toScreen(p);
    const nx = (s.x - this.w / 2) / (this.w / 2);
    const ny = (s.y - this.h / 2) / (this.h / 2);
    const d = Math.hypot(nx, ny * 0.7);
    return { pan: Math.max(-0.85, Math.min(0.85, nx * 0.7)), gain: Math.max(0.12, Math.min(1, 1.2 - d * 0.55)) };
  }

  isWalking(id: string): boolean | null {
    const b = this.bots.get(id);
    return b ? b.path.length > 0 : null;
  }

  get followingId(): string | null {
    return this.following;
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.dirty = true;
  }

  /** Front-most robot under a screen point (its screen-space box, feet to head). */
  hitTest(sx: number, sy: number): string | null {
    let best: { id: string; depth: number } | null = null;
    const head = new THREE.Vector3();
    for (const b of this.bots.values()) {
      if (b.removing) continue;
      const f = this.toScreen(b.pos);
      const h = this.toScreen(head.copy(b.pos).setY(b.pos.y + ROBOT_H));
      const hpx = Math.abs(f.y - h.y);
      if (Math.abs(sx - f.x) < hpx * 0.3 && sy < f.y + 6 && sy > h.y && (!best || f.depth < best.depth)) best = { id: b.id, depth: f.depth };
    }
    return best?.id ?? null;
  }

  // ── loop ────────────────────────────────────────────────────────────────

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (document.hidden) return;
    this.clock += dt;

    let moving = false;
    for (const b of [...this.bots.values()]) {
      moving = this.updateBot(b, dt) || moving;
      if (b.removing && b.fade <= 0) this.dropBot(b);
    }
    this.updateProps(now);
    this.updateLight(dt);

    if (this.following) {
      const b = this.bots.get(this.following);
      if (b) this.viewTarget.target.set(b.pos.x, b.pos.y + ROBOT_H * 0.5, b.pos.z);
      else this.following = null;
    }
    if (this.touring && !this.following) this.tourStep(dt);
    const k = this.reduceMotion ? 1 : 1 - Math.exp(-dt * 7);
    const v = this.view;
    const t = this.viewTarget;
    const camMoving = v.target.distanceTo(t.target) > 0.005 || Math.abs(t.zoom - v.zoom) > 1e-3 || Math.abs(t.az - v.az) > 0.05 || Math.abs(t.el - v.el) > 0.05;
    v.target.lerp(t.target, k);
    v.zoom += (t.zoom - v.zoom) * k;
    v.az += (t.az - v.az) * k;
    v.el += (t.el - v.el) * k;

    if (!this.bots.size && !camMoving && !this.dirty && !moving) return;
    this.dirty = false;

    // the city only lines up with the walls from the painting's angle
    const onAngle = Math.abs(v.az - room.camera.az) < 2.5 && Math.abs(v.el - room.camera.el) < 2.5;
    for (const c of this.city) c.visible = onAngle;

    this.applyCamera(v);
    if (this.useBloom) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.placeTags();
    this.placeAnchors();
    if (camMoving) this.onViewChange?.({ cx: v.target.x, cy: v.target.z, zoom: v.zoom });
    if (!this.statsLogged && this.roomRoot && this.template) {
      this.statsLogged = true;
      // ?stats: what one frame costs (the bloom passes add a few full-screen draws)
      this.renderer.render(this.scene, this.camera);
      const { calls, triangles } = this.renderer.info.render;
      console.info(`[office3d] draw calls ${calls}, triangles ${triangles}`);
      (window as unknown as { __office3d?: object }).__office3d = { calls, triangles, alts: () => this.alts.map((a) => [a.def.alt, a.on]) };
    }
  };

  private placeTags(): void {
    const p = new THREE.Vector3();
    for (const [id, el] of this.tags) {
      const b = this.bots.get(id);
      if (!b || b.fade <= 0.05) {
        el.style.display = 'none';
        continue;
      }
      const s = this.toScreen(p.copy(b.pos).setY(b.pos.y + ROBOT_H * 1.02));
      const off = s.x < -200 || s.x > this.w + 200 || s.y < -100 || s.y > this.h + 100;
      el.style.display = off ? 'none' : '';
      if (!off) {
        el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%)`;
        el.style.opacity = String(b.fade);
        el.style.zIndex = String(Math.round((1 - s.depth) * 10000));
      }
    }
  }

  /** The mission board hotspot follows the kanban board on the back wall; other room anchors are 2D-only. */
  private placeAnchors(): void {
    const { c, w, h } = room.board;
    const corners = [
      [c[0] - w / 2, c[1], c[2] - h / 2],
      [c[0] + w / 2, c[1], c[2] - h / 2],
      [c[0] + w / 2, c[1], c[2] + h / 2],
      [c[0] - w / 2, c[1], c[2] + h / 2],
    ].map((q) => this.toScreen(W3(q)));
    const x0 = Math.min(...corners.map((q) => q.x));
    const x1 = Math.max(...corners.map((q) => q.x));
    const y0 = Math.min(...corners.map((q) => q.y));
    const y1 = Math.max(...corners.map((q) => q.y));
    for (const [key, { el }] of this.anchors) {
      if (key === 'board:box') {
        el.style.display = '';
        el.style.width = `${(x1 - x0).toFixed(1)}px`;
        el.style.height = `${(y1 - y0).toFixed(1)}px`;
        el.style.transform = `translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px)`;
      } else if (key === 'board:badge') {
        el.style.display = '';
        el.style.transform = `translate(${((x0 + x1) / 2).toFixed(1)}px, ${(y0 + 8).toFixed(1)}px) translate(-50%, -100%)`;
      } else el.style.display = 'none';
    }
  }

  walkers(): { id: string; pos: Pt; path: Waypoint[] }[] {
    return [];
  }

  roomAt(): Pt {
    return [0, 0];
  }

  get zoom(): number {
    return this.view.zoom;
  }

  invalidate(): void {
    this.dirty = true;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const b of [...this.bots.values()]) this.dropBot(b);
    this.roomRoot?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of ([] as THREE.Material[]).concat(m.material)) mat.dispose();
    });
    this.wallClock.dispose();
    this.composer.dispose();
    this.scene.environment?.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
  }
}
