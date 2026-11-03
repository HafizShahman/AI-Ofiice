import * as THREE from 'three';
import { ROOM_W } from './layout.ts';
import { lightAt, phaseOf } from './daylight.ts';

/**
 * A holographic digital clock floating in the middle of the window wall, in front of the glass. It
 * lies on the wall plane (skewed along the wall slope, like the sky in DayNight.ts) and shows the hour
 * the scene is lit for, so it always agrees with the sky: the real time in Auto, 09:30 / 00:00 when
 * Day / Night is pinned. A small word under the digits names the phase (DAWN, DAY, DUSK, NIGHT).
 *
 * One normal-blended canvas quad: a dark translucent plate keeps the cyan legible over the bright day
 * sky, the digits, border and corner brackets are drawn bright with a soft glow so they read as light.
 * Placement was traced on the 1920 px art (room.webp), same numbers as DayNight.ts.
 */

const K = ROOM_W / 1920; // art px (1920 wide) -> room px
const SLOPE = 0.47; // the window wall climbs 0.47 px per px to the right (DayNight.ts)
const CENTRE = [466, 455]; // art px: horizontally centred on the window (188..745), a little above mid-glass
const WIDTH = 222; // art px along x
const HEIGHT = 84; // art px, straight up (canvas aspect W/H = 440/150 matches the skewed run length / HEIGHT)
const RUN = [WIDTH, -SLOPE * WIDTH];
const ORIGIN = [CENTRE[0] - WIDTH / 2, CENTRE[1] + HEIGHT / 2 + (SLOPE * WIDTH) / 2]; // bottom-left corner
const ORDER = -4e5; // above the backdrop, sky, glow and sun beams, below every prop

const W = 440;
const H = 150;
const CYAN = '34,211,238'; // #22d3ee
const ICE = '103,232,249'; // #67e8f9
const PALE = '165,243,252'; // #a5f3fc

// 7-segment layout: a b c d e f g
const SEGMENTS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
};

const LABEL: Record<string, string> = { dawn: 'DAWN', day: 'DAY', dusk: 'DUSK', night: 'NIGHT' };

export class WallClock {
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private mesh: THREE.Mesh;
  private shown = '';

  constructor(scene: THREE.Scene) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0), mat);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = ORDER;
    // u runs along the wall (right and up on screen), v straight up; room space has y up
    this.mesh.matrix.set(RUN[0] * K, 0, 0, ORIGIN[0] * K, -RUN[1] * K, HEIGHT * K, 0, -ORIGIN[1] * K, 0, 0, 1, 0, 0, 0, 0, 1);
    this.mesh.matrixWorldNeedsUpdate = true;
    scene.add(this.mesh);
  }

  /**
   * Put the clock somewhere else (the 3D room): `m` maps the unit square (u right, v up, facing +z) to
   * the world; depth-tested like any other surface there.
   */
  place(m: THREE.Matrix4): void {
    this.mesh.matrix.copy(m);
    this.mesh.matrixWorldNeedsUpdate = true;
    this.mesh.renderOrder = 0;
    const mat = this.mesh.material as THREE.MeshBasicMaterial;
    mat.depthTest = true;
    mat.toneMapped = false;
    mat.needsUpdate = true;
  }

  /** Redraw when the minute, the phase or the blinking colon changes. True when it did. */
  update(hour: number): boolean {
    hour = Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : 0;
    const total = Math.floor(hour * 60 + 1e-6);
    const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    const colon = Math.floor(Date.now() / 1000) % 2 === 0;
    const light = lightAt(hour);
    const phase = LABEL[phaseOf(light)];
    const day = Math.round(light.day * 8) / 8; // plate is a bit denser by day; quantised so it repaints rarely
    const key = `${hh}${colon ? ':' : ' '}${mm}|${phase}|${day}`;
    if (key === this.shown) return false;
    this.shown = key;
    this.paint(hh + mm, colon, phase, day);
    return true;
  }

  private paint(digits: string, colon: boolean, phase: string, day: number): void {
    const g = this.ctx;
    g.clearRect(0, 0, W, H);

    // plate: dark glass, denser by day so the cyan holds up on a bright sky
    const a = 0.52 + 0.14 * day;
    const plate = g.createLinearGradient(0, 0, 0, H);
    plate.addColorStop(0, `rgba(5,16,28,${a})`);
    plate.addColorStop(1, `rgba(8,44,58,${a * 0.88})`);
    g.fillStyle = plate;
    g.beginPath();
    plateShape(g);
    g.fill();

    // scanlines, clipped to the plate
    g.save();
    g.clip();
    g.fillStyle = `rgba(${ICE},0.07)`;
    for (let y = 4; y < H - 4; y += 4) g.fillRect(4, y, W - 8, 1);
    g.restore();

    // border
    g.strokeStyle = `rgba(${CYAN},0.75)`;
    g.lineWidth = 1.6;
    g.shadowColor = `rgba(${CYAN},0.55)`;
    g.shadowBlur = 6;
    g.beginPath();
    plateShape(g);
    g.stroke();

    // corner brackets
    const L = 22;
    g.strokeStyle = `rgb(${PALE})`;
    g.lineWidth = 3.2;
    g.lineCap = 'butt';
    g.shadowColor = `rgba(${CYAN},0.8)`;
    g.shadowBlur = 8;
    g.beginPath();
    for (const [cx, cy, sx, sy] of [[3, 3, 1, 1], [W - 3, 3, -1, 1], [3, H - 3, 1, -1], [W - 3, H - 3, -1, -1]]) {
      g.moveTo(cx + sx * L, cy);
      g.lineTo(cx, cy);
      g.lineTo(cx, cy + sy * L);
    }
    g.stroke();

    // four digits and a colon, centred
    const dw = 58;
    const dh = 86;
    const gap = 10;
    const colonW = 26;
    const dot = 13;
    const total = dw * 4 + gap * 4 + colonW; // 4 gaps: d0 d1 : d2 d3
    let x = (W - total) / 2;
    const y = 20;
    g.fillStyle = `rgb(${ICE})`;
    g.shadowColor = `rgba(${CYAN},0.8)`;
    g.shadowBlur = 14;
    for (let i = 0; i < 4; i++) {
      digit(g, digits[i], x, y, dw, dh);
      x += dw + gap;
      if (i === 1) {
        if (colon) {
          g.fillRect(x + colonW / 2 - dot / 2, y + dh * 0.3, dot, dot);
          g.fillRect(x + colonW / 2 - dot / 2, y + dh * 0.64, dot, dot);
        }
        x += colonW + gap;
      }
    }

    // phase word, letter-spaced, under the digits
    g.font = '700 17px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    g.textBaseline = 'alphabetic';
    g.fillStyle = `rgba(${ICE},0.9)`;
    g.shadowColor = `rgba(${CYAN},0.4)`;
    g.shadowBlur = 4;
    const spacing = 5;
    const widths = [...phase].map((c) => g.measureText(c).width);
    let lx = (W - (widths.reduce((s, w) => s + w, 0) + spacing * (phase.length - 1))) / 2;
    [...phase].forEach((c, i) => {
      g.fillText(c, lx, 136);
      lx += widths[i] + spacing;
    });

    g.shadowBlur = 0;
    this.tex.needsUpdate = true;
  }

  dispose(): void {
    this.tex.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** The plate outline (roundRect needs Chrome 99 / Safari 16 / Firefox 112; older browsers get square corners). */
function plateShape(g: CanvasRenderingContext2D): void {
  if (typeof g.roundRect === 'function') g.roundRect(3, 3, W - 6, H - 6, 10);
  else g.rect(3, 3, W - 6, H - 6);
}

/** One 7-segment digit with slanted ends and a small gap between segments, in the box (x, y, w, h). */
function digit(g: CanvasRenderingContext2D, ch: string, x: number, y: number, w: number, h: number): void {
  const on = SEGMENTS[ch] ?? '';
  const t = 14; // segment thickness
  const s = 1.6; // gap between neighbouring segments
  const e = t / 2 + s; // where a segment's tip starts, from the box edge
  const half = h / 2;
  const horiz = (cy: number) => {
    g.beginPath();
    g.moveTo(x + e, cy);
    g.lineTo(x + e + t / 2, cy - t / 2);
    g.lineTo(x + w - e - t / 2, cy - t / 2);
    g.lineTo(x + w - e, cy);
    g.lineTo(x + w - e - t / 2, cy + t / 2);
    g.lineTo(x + e + t / 2, cy + t / 2);
    g.closePath();
    g.fill();
  };
  const vert = (cx: number, top: number) => {
    g.beginPath();
    g.moveTo(cx, top + e);
    g.lineTo(cx + t / 2, top + e + t / 2);
    g.lineTo(cx + t / 2, top + half - e - t / 2);
    g.lineTo(cx, top + half - e);
    g.lineTo(cx - t / 2, top + half - e - t / 2);
    g.lineTo(cx - t / 2, top + e + t / 2);
    g.closePath();
    g.fill();
  };
  if (on.includes('a')) horiz(y + t / 2);
  if (on.includes('g')) horiz(y + half);
  if (on.includes('d')) horiz(y + h - t / 2);
  if (on.includes('f')) vert(x + t / 2, y);
  if (on.includes('b')) vert(x + w - t / 2, y);
  if (on.includes('e')) vert(x + t / 2, y + half);
  if (on.includes('c')) vert(x + w - t / 2, y + half);
}
