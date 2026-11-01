import * as THREE from 'three';
import type { Activity, AgentStatus } from '@ai-office/shared';
import { DOOR, onLayoutChange, px, ROOM_H, ROOM_W, spotInfo, spriteList, artUrl, type Pt, type SpotInfo } from './layout.ts';
import { findPath, type Level, type Waypoint } from './nav.ts';
import { loadRobot, RobotRig, type Pose, type RigTemplate } from './robot.ts';

/**
 * The isometric office. Everything lives in "room space" (pixels of the 2400×1792 room image,
 * y down). An orthographic camera looks straight at that plane, so the painted backdrop and the
 * prop sprites are flat quads, drawn in painter's order (renderOrder = foot y, no depth test).
 * Robots are real 3D models tipped back 30° (the backdrop's 2:1 isometric angle) and dropped
 * into the same order by their foot y, so a desk in front of a robot covers it and vice versa.
 */

export interface SceneAgent {
  id: string;
  color: string;
  spot: string | null;
  status: AgentStatus;
  activity: Activity;
}

export interface CameraView {
  cx: number;
  cy: number;
  zoom: number; // screen px per room px
}

/** Where something sits relative to the view: stereo pan, and loudness (quieter when far from the middle). */
export interface Spatial {
  pan: number;
  gain: number;
}

const ROBOT_H = 150; // room px, feet to antenna tip
const TILT = Math.PI / 6; // 30°: 2:1 isometric
const WALK_SPEED = 230; // room px / s
const FADE_S = 0.6;
/** ?pose=wave forces every robot into one pose (for checking animations) */
const FORCE_POSE = new URLSearchParams(location.search).get('pose') as Pose | null;

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

interface Bot {
  id: string;
  rig: RobotRig;
  ring: THREE.Mesh;
  pos: Pt;
  level: Level;
  path: Waypoint[];
  spot: string | null;
  target: SpotInfo;
  yaw: number;
  yawTarget: number;
  walkPhase: number;
  /** index of the last footfall, so each is reported once */
  stepK: number;
  wasMoving: boolean;
  agent: SceneAgent;
  fade: number; // 0..1
  removing: boolean;
}

interface SpriteObj {
  mesh: THREE.Mesh;
  propId: string;
  footPx: Pt;
  idle: THREE.Texture;
  busy?: THREE.Texture;
}

export class OfficeScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
  private bots = new Map<string, Bot>();
  private sprites: SpriteObj[] = [];
  private template: RigTemplate | null = null;
  private pending: SceneAgent[] | null = null;
  private raf = 0;
  private last = performance.now();
  private clock = 0;
  private w = 1;
  private h = 1;
  private view: CameraView = { cx: ROOM_W / 2, cy: ROOM_H / 2, zoom: 0.5 };
  private viewTarget: CameraView = { ...this.view };
  private following: string | null = null;
  private selected: string | null = null;
  private dirty = true;
  private texCache = new Map<string, THREE.Texture>();
  private spriteQuad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0); // origin at bottom-centre
  private offLayout: () => void;
  onViewChange?: (v: CameraView) => void;
  /** a robot's foot lands while walking */
  onStep?: (id: string, at: Spatial) => void;
  /** a robot stops after a walk; propId is the prop it came to ('' when it stayed put) */
  onArrive?: (id: string, propId: string, at: Spatial) => void;
  /** ?helper overlay: an element in room-px coordinates that the scene keeps aligned with the camera */
  overlay: HTMLElement | null = null;

  /** @param tags DOM tags the React overlay registers; positioned over the robots every frame */
  readonly tags: Map<string, HTMLElement>;

  constructor(canvas: HTMLCanvasElement, tags: Map<string, HTMLElement>) {
    this.tags = tags;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x0f1324);
    this.renderer.sortObjects = true;
    this.camera.position.set(0, 0, 10000);

    this.scene.add(new THREE.HemisphereLight(0xd7f3ff, 0x1b2436, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-0.6, 1, 1.2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x22d3ee, 1.1);
    rim.position.set(1, 0.4, -1);
    this.scene.add(rim);

    this.buildRoom();
    this.buildSprites();
    this.offLayout = onLayoutChange(() => {
      this.buildSprites();
      // spots may have moved: send everyone to where their spot is now
      for (const b of this.bots.values()) {
        const t = spotInfo(b.spot);
        if (!t) continue;
        b.target = t;
        b.path = findPath(b.pos, b.level, t.pos, t.level);
      }
      this.dirty = true;
    });
    loadRobot().then((t) => {
      this.template = t;
      if (this.pending) this.setAgents(this.pending);
      this.dirty = true;
    });
    this.loop();
  }

  // ── room ────────────────────────────────────────────────────────────────

  /** Cached texture; onSize gets the image size once it is known. */
  private loadTex(url: string, onSize?: (w: number, h: number) => void): THREE.Texture {
    let t = this.texCache.get(url);
    if (!t) {
      t = new THREE.TextureLoader().load(url, () => (this.dirty = true));
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.texCache.set(url, t);
    }
    if (onSize) {
      const tex = t;
      const img = tex.image as HTMLImageElement | undefined;
      if (img?.width) onSize(img.width, img.height);
      else {
        const poll = () => {
          const im = tex.image as HTMLImageElement | undefined;
          if (im?.complete && im.width) {
            onSize(im.width, im.height);
            this.dirty = true;
          } else setTimeout(poll, 50);
        };
        poll();
      }
    }
    return t;
  }

  private buildRoom(): void {
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_W, ROOM_H),
      new THREE.MeshBasicMaterial({ map: this.loadTex('/art/room.webp'), depthTest: false, depthWrite: false, transparent: true }),
    );
    bg.position.set(ROOM_W / 2, -ROOM_H / 2, -100);
    bg.renderOrder = -1e6;
    this.scene.add(bg);

  }

  /** (Re)place every prop sprite from the current layout. */
  private buildSprites(): void {
    for (const o of this.sprites) {
      this.scene.remove(o.mesh);
      (o.mesh.material as THREE.Material).dispose();
    }
    this.sprites = [];
    for (const s of spriteList()) {
      const footPx = px(s.foot);
      const wPx = (s.width / 100) * ROOM_W;
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(this.spriteQuad, mat);
      mesh.scale.set(wPx, wPx, 1);
      const idle = this.loadTex(artUrl(s.sprite), (w, h) => mesh.scale.set(wPx, (wPx * h) / w, 1));
      mat.map = idle;
      mesh.position.set(footPx[0], -footPx[1], 0);
      mesh.renderOrder = ((s.z ?? s.foot[1]) / 100) * ROOM_H;
      this.scene.add(mesh);
      this.sprites.push({ mesh, propId: s.propId, footPx, idle, busy: s.busySprite ? this.loadTex(artUrl(s.busySprite)) : undefined });
    }
    this.dirty = true;
  }

  // ── agents ──────────────────────────────────────────────────────────────

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
        // no free spot (every pool full): stay where it is rather than wander to the door
        const target = spotInfo(a.spot) ?? (a.status === 'leaving' ? DOOR : { pos: bot.pos, level: bot.level, face: null, propId: '' });
        bot.spot = a.spot;
        bot.target = target;
        bot.path = findPath(bot.pos, bot.level, target.pos, target.level);
      }
    }
    for (const [id, bot] of this.bots) if (!seen.has(id)) bot.removing = true;
    this.dirty = true;
  }

  private spawn(a: SceneAgent): Bot {
    const rig = new RobotRig(this.template!, a.color);
    rig.root.scale.setScalar(ROBOT_H);
    rig.root.rotation.x = TILT;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.78, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, depthTest: false, depthWrite: false }),
    );
    ring.scale.set(ROBOT_H * 0.32, ROBOT_H * 0.16, 1);
    ring.visible = false;
    this.scene.add(rig.root, ring);
    // walk in from the door when the server says so; otherwise appear in place (e.g. after a reload)
    const target = spotInfo(a.spot) ?? DOOR;
    const fromDoor = a.status === 'arriving';
    const start = fromDoor ? DOOR : target;
    const bot: Bot = {
      id: a.id,
      rig,
      ring,
      pos: [...start.pos] as Pt,
      level: start.level,
      path: fromDoor ? findPath(DOOR.pos, DOOR.level, target.pos, target.level) : [],
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
    // walk the path
    let step = WALK_SPEED * dt;
    while (step > 0 && bot.path.length) {
      const { x: tx, y: ty, level } = bot.path[0];
      const dx = tx - bot.pos[0];
      const dy = ty - bot.pos[1];
      const d = Math.hypot(dx, dy);
      if (d < 0.5) {
        bot.pos = [tx, ty];
        bot.level = level;
        bot.path.shift();
        continue;
      }
      const s = Math.min(step, d);
      bot.pos = [bot.pos[0] + (dx / d) * s, bot.pos[1] + (dy / d) * s];
      bot.yawTarget = yawFor(dx, dy);
      bot.walkPhase += (s / ROBOT_H) * 7;
      step -= s;
      moving = true;
    }
    if (!moving) {
      const f = bot.target.face;
      bot.yawTarget = f ? yawFor(f[0] - bot.pos[0], f[1] - bot.pos[1]) : 0;
    }
    // sound: a footfall each time the legs are at their widest (the body bob is lowest there)
    if (moving) {
      const k = Math.floor((bot.walkPhase - Math.PI / 2) / Math.PI);
      if (k !== bot.stepK) {
        bot.stepK = k;
        if (bot.fade > 0.4) this.onStep?.(bot.id, this.spatialAt(bot.pos));
      }
    } else if (bot.wasMoving && bot.fade > 0.4) this.onArrive?.(bot.id, bot.target.propId, this.spatialAt(bot.pos));
    bot.wasMoving = moving;
    // turn smoothly (shortest way round)
    let dy = bot.yawTarget - bot.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    bot.yaw += dy * Math.min(1, dt * 10);
    bot.rig.yawGroup.rotation.y = bot.yaw;

    // fade in / out
    const leavingDone = bot.removing && !moving;
    bot.fade = Math.max(0, Math.min(1, bot.fade + (leavingDone ? -dt : dt) / FADE_S));
    bot.rig.setOpacity(bot.fade);

    const a = bot.agent;
    const pose: Pose = FORCE_POSE ?? (moving ? 'walk' : POSE_FOR[a.activity] ?? 'idle');
    bot.rig.pose(pose, this.clock, bot.walkPhase);

    const [x, y] = bot.pos;
    bot.rig.root.position.set(x, -y, y * 4);
    bot.rig.setRenderOrder(y);

    // floor ring: selected (cyan), blocked (amber pulse), charging (cyan pulse)
    const ringMat = bot.ring.material as THREE.MeshBasicMaterial;
    const blocked = a.status === 'blocked';
    const charging = a.activity === 'charging' && !moving;
    bot.ring.visible = bot.fade > 0 && (this.selected === a.id || blocked || charging);
    ringMat.color.set(blocked ? 0xfbbf24 : 0x22d3ee);
    ringMat.opacity = (this.selected === a.id ? 0.95 : 0.45 + 0.4 * Math.sin(this.clock * 4) ** 2) * bot.fade;
    bot.ring.position.set(x, -y, 0);
    bot.ring.renderOrder = y - 0.5;
    return moving;
  }

  private updateSprites(): void {
    for (const s of this.sprites) {
      if (!s.busy) continue;
      const busy = [...this.bots.values()].some(
        (b) => !b.path.length && !b.removing && b.target.propId === s.propId && b.target.face?.[0] === s.footPx[0] && b.target.face?.[1] === s.footPx[1],
      );
      const mat = s.mesh.material as THREE.MeshBasicMaterial;
      const want = busy ? s.busy : s.idle;
      if (mat.map !== want) {
        mat.map = want;
        mat.needsUpdate = true;
      }
    }
  }

  // ── camera ──────────────────────────────────────────────────────────────

  resize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.renderer.setSize(this.w, this.h, false);
    if (!this.userMoved) this.fit(true);
    this.dirty = true;
  }

  private userMoved = false;

  /** Zoom so the whole room fits. */
  fit(jump = false): void {
    const zoom = Math.min(this.w / (ROOM_W * 0.94), this.h / (ROOM_H * 0.92));
    this.viewTarget = { cx: ROOM_W / 2, cy: ROOM_H * 0.52, zoom };
    if (jump) this.view = { ...this.viewTarget };
    this.userMoved = false;
    this.following = null;
    this.dirty = true;
  }

  private fitZoom(): number {
    return Math.min(this.w / (ROOM_W * 0.94), this.h / (ROOM_H * 0.92));
  }

  zoomBy(factor: number, at?: { x: number; y: number }): void {
    const v = this.viewTarget;
    const min = this.fitZoom() * 0.8;
    const max = this.fitZoom() * 4;
    const zoom = Math.max(min, Math.min(max, v.zoom * factor));
    if (at && !this.following) {
      // keep the room point under the cursor where it is
      const [rx, ry] = this.toRoom(at.x, at.y, v);
      v.cx = rx - (at.x - this.w / 2) / zoom;
      v.cy = ry - (at.y - this.h / 2) / zoom;
    }
    v.zoom = zoom;
    this.view.zoom = zoom; // wheel feels better without easing
    if (at && !this.following) {
      this.view.cx = v.cx;
      this.view.cy = v.cy;
    }
    this.clampView();
    this.userMoved = true;
    this.dirty = true;
  }

  panBy(dx: number, dy: number): void {
    this.following = null;
    this.viewTarget.cx -= dx / this.viewTarget.zoom;
    this.viewTarget.cy -= dy / this.viewTarget.zoom;
    this.clampView();
    this.view.cx = this.viewTarget.cx;
    this.view.cy = this.viewTarget.cy;
    this.userMoved = true;
    this.dirty = true;
  }

  private clampView(): void {
    const v = this.viewTarget;
    v.cx = Math.max(0, Math.min(ROOM_W, v.cx));
    v.cy = Math.max(0, Math.min(ROOM_H, v.cy));
  }

  /** Fly to a robot; with follow, keep it centred while it walks. */
  focus(id: string, follow = false): void {
    const b = this.bots.get(id);
    if (!b) return;
    this.viewTarget.cx = b.pos[0];
    this.viewTarget.cy = b.pos[1] - ROBOT_H * 0.4;
    this.viewTarget.zoom = Math.max(this.viewTarget.zoom, this.fitZoom() * 1.6);
    this.following = follow ? id : null;
    this.userMoved = true;
    this.dirty = true;
  }

  /** Where a robot is in the stereo field; null when it isn't in the scene. */
  spatial(id: string): Spatial | null {
    const b = this.bots.get(id);
    return b ? this.spatialAt(b.pos) : null;
  }

  private spatialAt([x, y]: Pt): Spatial {
    const [sx, sy] = this.toScreen(x, y);
    const nx = (sx - this.w / 2) / (this.w / 2);
    const ny = (sy - this.h / 2) / (this.h / 2);
    const d = Math.hypot(nx, ny * 0.7);
    return { pan: Math.max(-0.85, Math.min(0.85, nx * 0.7)), gain: Math.max(0.12, Math.min(1, 1.2 - d * 0.55)) };
  }

  /** Whether a robot is mid-walk; null when it isn't in the scene (yet). */
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

  private toRoom(sx: number, sy: number, v = this.view): Pt {
    return [(sx - this.w / 2) / v.zoom + v.cx, (sy - this.h / 2) / v.zoom + v.cy];
  }

  private toScreen(rx: number, ry: number): Pt {
    return [(rx - this.view.cx) * this.view.zoom + this.w / 2, (ry - this.view.cy) * this.view.zoom + this.h / 2];
  }

  /** Front-most robot under a screen point. */
  hitTest(sx: number, sy: number): string | null {
    const [rx, ry] = this.toRoom(sx, sy);
    let best: Bot | null = null;
    for (const b of this.bots.values()) {
      if (b.removing) continue;
      const [x, y] = b.pos;
      if (Math.abs(rx - x) < ROBOT_H * 0.3 && ry < y + 6 && ry > y - ROBOT_H * 0.95 && (!best || y > best.pos[1])) best = b;
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
    this.updateSprites();

    // camera: follow + ease toward target
    if (this.following) {
      const b = this.bots.get(this.following);
      if (b) {
        this.viewTarget.cx = b.pos[0];
        this.viewTarget.cy = b.pos[1] - ROBOT_H * 0.4;
      } else this.following = null;
    }
    const k = 1 - Math.exp(-dt * 7);
    const v = this.view;
    const t = this.viewTarget;
    const camMoving = Math.abs(t.cx - v.cx) + Math.abs(t.cy - v.cy) > 0.3 || Math.abs(t.zoom - v.zoom) > 1e-4;
    v.cx += (t.cx - v.cx) * k;
    v.cy += (t.cy - v.cy) * k;
    v.zoom += (t.zoom - v.zoom) * k;

    // robots always animate (breathing, typing); with none in the room, render on demand only
    if (!this.bots.size && !camMoving && !this.dirty && !moving) return;
    this.dirty = false;

    const cam = this.camera;
    cam.left = -this.w / 2 / v.zoom;
    cam.right = this.w / 2 / v.zoom;
    cam.top = this.h / 2 / v.zoom;
    cam.bottom = -this.h / 2 / v.zoom;
    cam.position.set(v.cx, -v.cy, 10000);
    cam.updateProjectionMatrix();
    this.renderer.render(this.scene, cam);
    this.placeTags();
    if (this.overlay) this.overlay.style.transform = `translate(${this.w / 2 - v.cx * v.zoom}px, ${this.h / 2 - v.cy * v.zoom}px) scale(${v.zoom})`;
    if (camMoving) this.onViewChange?.(v);
  };

  private placeTags(): void {
    for (const [id, el] of this.tags) {
      const b = this.bots.get(id);
      if (!b || b.fade <= 0.05) {
        el.style.display = 'none';
        continue;
      }
      const [sx, sy] = this.toScreen(b.pos[0], b.pos[1] - ROBOT_H * 0.92);
      const off = sx < -200 || sx > this.w + 200 || sy < -100 || sy > this.h + 100;
      el.style.display = off ? 'none' : '';
      if (!off) {
        el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
        el.style.opacity = String(b.fade);
        el.style.zIndex = String(Math.round(b.pos[1]));
      }
    }
  }

  /** For the ?helper overlay: where every robot is and the path it is walking. */
  walkers(): { id: string; pos: Pt; path: Waypoint[] }[] {
    return [...this.bots.values()].map((b) => ({ id: b.id, pos: b.pos, path: b.path }));
  }

  /** Room px under a screen point (for the helper). */
  roomAt(sx: number, sy: number): Pt {
    return this.toRoom(sx, sy);
  }

  get zoom(): number {
    return this.view.zoom;
  }

  /** Keep rendering every frame (the helper overlay redraws paths). */
  invalidate(): void {
    this.dirty = true;
  }

  dispose(): void {
    this.offLayout();
    cancelAnimationFrame(this.raf);
    for (const b of [...this.bots.values()]) this.dropBot(b);
    this.renderer.dispose();
  }
}

/** Screen-space direction → model yaw. The floor is foreshortened 2:1, so screen dy counts double. */
function yawFor(dx: number, dy: number): number {
  return Math.atan2(dx, dy * 2);
}
