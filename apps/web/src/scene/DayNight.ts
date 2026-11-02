import * as THREE from 'three';
import { ROOM_W } from './layout.ts';
import { clamp01, lerp, lightAt, mix, phaseOf, rigAt, tintAt, type Light, type Phase, type RGB } from './daylight.ts';

/**
 * Day / night in the scene (the model is in daylight.ts). Three flat layers sit between the
 * backdrop and the props, plus the robots' lights:
 *  - `grade`: normal-blended sky over the window glass (dark at night, orange at dusk, bright by day);
 *  - `glow`: additive sun, moon, stars and city lights in the glass;
 *  - one sun (or moon) beam per pane, laid on the floor, longer and leaning as the sun moves.
 * The grade that tints the backdrop and every sprite is `tint`; OfficeScene applies it to its materials.
 *
 * The window, wall slope and panes below were traced by eye on the 1920 px wide room art
 * (public/art/room.webp). Check them with `?time=day` if the art ever changes.
 */

const K = ROOM_W / 1920; // the traced numbers are px of the 1920 wide art; room space is 2400 wide
const PANES: [number, number][] = [
  [188, 300],
  [330, 412],
  [436, 514],
  [556, 640],
  [670, 745],
];
const SLOPE = 0.47; // the window wall climbs 0.47 px per px to the right
const topAt = (x: number) => 382 - SLOPE * (x - 188);
const botAt = (x: number) => 815 - SLOPE * (x - 188);
const BOX = { x0: 188, x1: 745, y0: topAt(745), y1: botAt(188) };
const SKY_SCALE = 0.8; // sky canvas px per art px
const BASE_CLEAR = new THREE.Color(0x0f1324);

/** the layers sit above the backdrop (-1e6) and below every prop (foot y >= 0) */
const ORDER = { dayArt: -1e6 + 1, grade: -9e5, glow: -8.9e5, beam: -5e5 };

const rgba = (c: RGB, a: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a.toFixed(3)})`;

/** small seeded random so the stars are the same every load */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A canvas-textured quad over the window glass; paint() draws clipped to the panes. */
class SkyLayer {
  readonly canvas = document.createElement('canvas');
  readonly tex: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh;
  private ctx: CanvasRenderingContext2D;

  constructor(scene: THREE.Scene, additive: boolean, order: number) {
    const w = BOX.x1 - BOX.x0;
    const h = BOX.y1 - BOX.y0;
    this.canvas.width = Math.ceil(w * SKY_SCALE);
    this.canvas.height = Math.ceil(h * SKY_SCALE);
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w * K, h * K), mat);
    this.mesh.position.set(((BOX.x0 + BOX.x1) / 2) * K, (-(BOX.y0 + BOX.y1) / 2) * K, 0);
    this.mesh.renderOrder = order;
    scene.add(this.mesh);
  }

  /** art px → canvas px */
  at(x: number, y: number): [number, number] {
    return [(x - BOX.x0) * SKY_SCALE, (y - BOX.y0) * SKY_SCALE];
  }

  paint(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.beginPath();
    for (const [x0, x1] of PANES) {
      ctx.moveTo(...this.at(x0, topAt(x0)));
      ctx.lineTo(...this.at(x1, topAt(x1)));
      ctx.lineTo(...this.at(x1, botAt(x1)));
      ctx.lineTo(...this.at(x0, botAt(x0)));
      ctx.closePath();
    }
    ctx.clip();
    draw(ctx, canvas.width, canvas.height);
    ctx.restore();
    this.tex.needsUpdate = true;
  }

  dispose(): void {
    this.tex.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** One soft-edged streak: opaque at the window, fading out across the floor. */
function beamTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  const v = g.createLinearGradient(0, 0, 0, 128); // canvas top = far end of the beam
  v.addColorStop(0, 'rgba(255,255,255,0)');
  v.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  v.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 128);
  g.globalCompositeOperation = 'destination-in';
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, 'rgba(255,255,255,0)');
  h.addColorStop(0.14, 'rgba(255,255,255,1)');
  h.addColorStop(0.86, 'rgba(255,255,255,1)');
  h.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface SceneLights {
  hemi: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
}

export class DayNight {
  /** multiplies the backdrop and every sprite (linear) */
  readonly tint = new THREE.Color(1, 1, 1);
  /** the renderer's clear colour, graded like the backdrop's dark margin */
  readonly clear = new THREE.Color().copy(BASE_CLEAR);
  private grade: SkyLayer;
  private glow: SkyLayer;
  private beams: THREE.Mesh[] = [];
  private beamTex = beamTexture();
  private shown: Light | null = null;
  private applied: Light | null = null;
  private dayArt = false;
  private stars: { x: number; y: number; r: number; a: number }[];
  private lamps: { x: number; y: number; c: RGB; a: number }[];

  private lights: SceneLights;

  constructor(scene: THREE.Scene, lights: SceneLights) {
    this.lights = lights;
    this.grade = new SkyLayer(scene, false, ORDER.grade);
    this.glow = new SkyLayer(scene, true, ORDER.glow);
    for (const [x0, x1] of PANES) {
      const mat = new THREE.MeshBasicMaterial({ map: this.beamTex, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0), mat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = ORDER.beam;
      mesh.userData = { x0, x1 };
      scene.add(mesh);
      this.beams.push(mesh);
    }
    const rnd = rng(7);
    this.stars = Array.from({ length: 60 }, () => ({ x: rnd(), y: rnd() * 0.6, r: 0.4 + rnd() * 0.7, a: 0.35 + rnd() * 0.65 }));
    this.lamps = Array.from({ length: 240 }, () => {
      const k = rnd();
      return { x: rnd(), y: 0.3 + rnd() * 0.65, c: k < 0.55 ? [255, 214, 150] : k < 0.8 ? [120, 225, 255] : [255, 120, 210], a: 0.5 + rnd() * 0.5 };
    });
  }

  /** How much daylight is showing right now (eased), for crossfading a painted day backdrop. */
  get day(): number {
    return this.shown?.day ?? 0;
  }

  get phase(): Phase {
    return this.shown ? phaseOf(this.shown) : 'night';
  }

  /** A painted day backdrop is present: the sky stays out of the way and the grade only matches props to it. */
  setDayArt(on: boolean): void {
    if (this.dayArt === on) return;
    this.dayArt = on;
    this.applied = null;
  }

  /** Move toward the light for this hour. True when something changed and the scene should re-apply `tint`. */
  update(hour: number, dt: number): boolean {
    const target = lightAt(hour);
    const s = this.shown;
    if (!s) this.shown = target;
    else {
      // ease the brightness (a mode switch is a jump in time); the sun and moon just follow the clock
      const k = 1 - Math.exp(-dt * 2.5);
      s.day += (target.day - s.day) * k;
      s.warm += (target.warm - s.warm) * k;
      s.elev += (target.elev - s.elev) * k;
      s.sunP = target.sunP;
      s.moonP = target.moonP;
      s.morning = target.morning;
    }
    const l = this.shown!;
    const a = this.applied;
    if (a && Math.abs(a.day - l.day) < 0.003 && Math.abs(a.warm - l.warm) < 0.003 && Math.abs(a.elev - l.elev) < 0.003 && Math.abs(a.sunP - l.sunP) < 0.004 && Math.abs(a.moonP - l.moonP) < 0.004) return false;
    this.applied = { ...l };
    this.render(l);
    return true;
  }

  private render(l: Light): void {
    this.tint.setRGB(...tintAt(l, this.dayArt));
    this.clear.copy(BASE_CLEAR).multiply(this.tint);
    const r = rigAt(l);
    const { hemi, key, rim } = this.lights;
    hemi.color.setRGB(...r.hemiSky, THREE.SRGBColorSpace);
    hemi.groundColor.setRGB(...r.hemiGround, THREE.SRGBColorSpace);
    hemi.intensity = r.hemi;
    key.color.setRGB(...r.key, THREE.SRGBColorSpace);
    key.intensity = r.keyI;
    rim.color.setRGB(...r.rim, THREE.SRGBColorSpace);
    rim.intensity = r.rimI;
    this.paintSky(l);
    this.placeBeams(l);
  }

  // ── the window ────────────────────────────────────────────────────────────

  private paintSky(l: Light): void {
    const night = 1 - l.day;
    // sky over the glass: [top, bottom, opacity]
    const nightSky: [RGB, RGB, number] = [[6, 10, 34], [40, 36, 104], 0.6];
    const duskSky: [RGB, RGB, number] = [[64, 44, 118], [255, 118, 56], 0.66];
    const daySky: [RGB, RGB, number] = [[64, 150, 255], [190, 226, 255], this.dayArt ? 0 : 0.52];
    const base = [mix(nightSky[0], daySky[0], l.day), mix(nightSky[1], daySky[1], l.day), lerp(nightSky[2], daySky[2], l.day)] as const;
    const w = l.warm * 0.85;
    const top = mix(base[0], duskSky[0], w);
    const bot = mix(base[1], duskSky[1], w);
    const alpha = lerp(base[2], duskSky[2], w);

    this.grade.paint((ctx, cw, ch) => {
      const g = ctx.createLinearGradient(0, 0, 0, ch);
      g.addColorStop(0, rgba(top, alpha));
      g.addColorStop(1, rgba(bot, alpha));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cw, ch);
    });

    this.glow.paint((ctx, cw, ch) => {
      const spot = (p: number, lift: number): [number, number] => {
        const x = BOX.x0 + (0.07 + 0.86 * p) * (BOX.x1 - BOX.x0);
        return this.glow.at(x, lerp(topAt(x), botAt(x), 0.8 - lift * Math.sin(Math.PI * p)));
      };
      const orb = (x: number, y: number, r: number, c: RGB, a: number) => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(c, a));
        g.addColorStop(0.25, rgba(c, a * 0.35));
        g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      };
      // stars and city lights come out as the light goes
      const dark = clamp01(night * 1.6 - 0.2);
      if (dark > 0.01) {
        for (const s of this.stars) {
          ctx.fillStyle = rgba([205, 225, 255], s.a * dark);
          ctx.beginPath();
          ctx.arc(s.x * cw, s.y * ch, s.r * SKY_SCALE * 1.3, 0, Math.PI * 2);
          ctx.fill();
        }
        for (const p of this.lamps) {
          ctx.fillStyle = rgba(p.c, p.a * dark);
          ctx.fillRect(p.x * cw, p.y * ch, 2.4, 3.2);
        }
        const [mx, my] = spot(l.moonP, 0.62);
        const moon = dark * dark; // gone soon after sunrise
        orb(mx, my, 70, [170, 200, 255], 0.5 * moon);
        ctx.fillStyle = rgba([232, 240, 255], 0.95 * moon);
        ctx.beginPath();
        ctx.arc(mx, my, 11, 0, Math.PI * 2);
        ctx.fill();
      }
      if (l.day > 0.02) {
        const [sx, sy] = spot(l.sunP, 0.66);
        const c = mix([255, 236, 190], [255, 140, 70], l.warm * 0.9);
        orb(sx, sy, 120, c, 0.85 * l.day);
        ctx.fillStyle = rgba([255, 250, 232], 0.95 * l.day);
        ctx.beginPath();
        ctx.arc(sx, sy, 15, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  // ── sun on the floor ──────────────────────────────────────────────────────

  private placeBeams(l: Light): void {
    // the sun by day, the moon by night
    const moonElev = Math.sin(Math.PI * l.moonP);
    const elev = lerp(moonElev, l.elev, l.day);
    const p = lerp(l.moonP, l.sunP, l.day);
    const reach = 140 + 380 * Math.pow(1 - elev, 1.5); // art px: low sun, long beams
    const shear = (0.5 - p) * 1.1 * reach; // and they swing across the floor through the day
    const strength = l.day * (0.2 + 0.4 * Math.sqrt(l.elev)) + (1 - l.day) * 0.1 * Math.sqrt(moonElev);
    const col = mix(mix([0.42, 0.72, 1], [1, 0.84, 0.5], l.day), [1, 0.55, 0.22], l.warm * 0.8);
    const wall = Math.hypot(1, SLOPE);
    const m = new THREE.Matrix4();
    for (const mesh of this.beams) {
      const { x0, x1 } = mesh.userData as { x0: number; x1: number };
      const ax = x0;
      const ay = botAt(x0);
      // along the window sill, and out across the floor (2:1 iso: down and to the right)
      const ux = x1 - x0;
      const uy = botAt(x1) - ay;
      const vx = (reach * 2) / Math.sqrt(5) + shear / wall;
      const vy = reach / Math.sqrt(5) - (shear * SLOPE) / wall;
      m.set(ux * K, vx * K, 0, ax * K, -uy * K, -vy * K, 0, -ay * K, 0, 0, 1, 0, 0, 0, 0, 1);
      mesh.matrix.copy(m);
      mesh.matrixWorldNeedsUpdate = true;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace);
      mat.opacity = strength;
      mesh.visible = strength > 0.004;
    }
  }

  dispose(): void {
    this.grade.dispose();
    this.glow.dispose();
    for (const b of this.beams) {
      b.geometry.dispose();
      (b.material as THREE.Material).dispose();
    }
    this.beamTex.dispose();
  }
}

export { ORDER as DAY_ORDER };
