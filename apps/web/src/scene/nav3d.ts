import room from './room3d.json';

/**
 * Walk grids for the 3D room: one for the floor, one for the deck, CELL-metre squares in plan
 * coordinates (x along the back wall, d away from it). A cell is open when it is inside the level's
 * area and clear of every obstacle grown by the robot's radius. The obstacles come from Blender
 * (room3d.json `nav`, written by Assets/blender/export_headless.py). The holo ring is one round
 * obstacle on the floor grid: the scene walks robots into it radially, and between the levels over
 * the stairs.
 */

export type P2 = [number, number];
export type Level3 = 'floor' | 'deck';
type Block = { rect?: number[]; circle?: number[]; poly?: number[][] };

const CELL = 0.2;
const RADIUS = 0.24; // robot footprint: obstacles grow by this
const DECK_EDGE = 0.32; // keep off the railings
const W = room.room.w;
const D = room.room.d;
const COLS = Math.ceil(W / CELL);
const ROWS = Math.ceil(D / CELL);

const NAV = room.nav as unknown as {
  floor: { bounds: number[]; y: number; blocks: Block[] };
  deck: { poly: number[][]; y: number; blocks: Block[] };
};
export const LEVEL_Y: Record<Level3, number> = { floor: NAV.floor.y, deck: NAV.deck.y };

function inPoly(x: number, d: number, poly: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, di] = poly[i];
    const [xj, dj] = poly[j];
    if (di > d !== dj > d && x < ((xj - xi) * (d - di)) / (dj - di) + xi) inside = !inside;
  }
  return inside;
}

function edgeDist(x: number, d: number, poly: number[][]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ad] = poly[j];
    const [bx, bd] = poly[i];
    const vx = bx - ax;
    const vd = bd - ad;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (d - ad) * vd) / (vx * vx + vd * vd || 1)));
    best = Math.min(best, Math.hypot(x - (ax + vx * t), d - (ad + vd * t)));
  }
  return best;
}

function hits(x: number, d: number, b: Block, grow: number): boolean {
  if (b.rect) {
    const [x0, d0, x1, d1] = b.rect;
    return x > x0 - grow && x < x1 + grow && d > d0 - grow && d < d1 + grow;
  }
  if (b.circle) {
    const [cx, cd, r] = b.circle;
    return Math.hypot(x - cx, d - cd) < r + grow;
  }
  if (b.poly) return inPoly(x, d, b.poly) || edgeDist(x, d, b.poly) < grow;
  return false;
}

const grids: Partial<Record<Level3, Uint8Array>> = {};

function grid(level: Level3): Uint8Array {
  const hit = grids[level];
  if (hit) return hit;
  const open = new Uint8Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = (c + 0.5) * CELL;
      const d = (r + 0.5) * CELL;
      let ok: boolean;
      if (level === 'floor') {
        const [x0, d0, x1, d1] = NAV.floor.bounds;
        ok = x > x0 && x < x1 && d > d0 && d < d1 && !NAV.floor.blocks.some((b) => hits(x, d, b, RADIUS));
      } else {
        ok = inPoly(x, d, NAV.deck.poly) && edgeDist(x, d, NAV.deck.poly) >= DECK_EDGE && !NAV.deck.blocks.some((b) => hits(x, d, b, RADIUS));
      }
      open[r * COLS + c] = ok ? 1 : 0;
    }
  }
  grids[level] = open;
  return open;
}

const cellOf = ([x, d]: P2): number => {
  const c = Math.max(0, Math.min(COLS - 1, Math.floor(x / CELL)));
  const r = Math.max(0, Math.min(ROWS - 1, Math.floor(d / CELL)));
  return r * COLS + c;
};
const centre = (i: number): P2 => [((i % COLS) + 0.5) * CELL, (Math.floor(i / COLS) + 0.5) * CELL];

/** Whether a plan point is walkable on a level. */
export function isOpen(level: Level3, p: P2): boolean {
  return grid(level)[cellOf(p)] === 1;
}

/** Nearest open cell (spiral search), or -1. */
function nearestOpen(open: Uint8Array, start: number): number {
  if (open[start]) return start;
  const sc = start % COLS;
  const sr = Math.floor(start / COLS);
  for (let rad = 1; rad < 25; rad++) {
    let best = -1;
    let bestD = Infinity;
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
        const r = sr + dr;
        const c = sc + dc;
        if (r < 0 || c < 0 || r >= ROWS || c >= COLS || !open[r * COLS + c]) continue;
        const dd = dr * dr + dc * dc;
        if (dd < bestD) {
          bestD = dd;
          best = r * COLS + c;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Straight line stays on open cells (sampled every fifth of a cell, so it can't clip a corner). */
function lineOpen(open: Uint8Array, a: P2, b: P2): boolean {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL / 5));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (!open[cellOf([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])]) return false;
  }
  return true;
}

/**
 * A* (8-way, no corner cutting) from `from` to `to` on a level, smoothed by line of sight.
 * Returns the waypoints after `from`, ending exactly at `to`.
 */
export function gridPath(level: Level3, from: P2, to: P2): P2[] {
  const open = grid(level);
  const s = nearestOpen(open, cellOf(from));
  const t = nearestOpen(open, cellOf(to));
  if (s < 0 || t < 0 || lineOpen(open, from, to)) return [to];
  const g = new Float32Array(COLS * ROWS).fill(Infinity);
  const came = new Int32Array(COLS * ROWS).fill(-1);
  const closed = new Uint8Array(COLS * ROWS);
  const heap: [number, number][] = []; // [f, cell]
  const push = (f: number, i: number) => {
    heap.push([f, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  const tc = t % COLS;
  const tr = Math.floor(t / COLS);
  const h = (i: number) => {
    const dc = Math.abs((i % COLS) - tc);
    const dr = Math.abs(Math.floor(i / COLS) - tr);
    return Math.max(dc, dr) + (Math.SQRT2 - 1) * Math.min(dc, dr);
  };
  g[s] = 0;
  push(h(s), s);
  while (heap.length) {
    const [, cur] = pop();
    if (cur === t) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const c = cur % COLS;
    const r = Math.floor(cur / COLS);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= ROWS || nc >= COLS) continue;
        const n = nr * COLS + nc;
        if (!open[n] || closed[n]) continue;
        if (dr && dc && (!open[r * COLS + nc] || !open[nr * COLS + c])) continue; // no corner cutting
        const ng = g[cur] + (dr && dc ? Math.SQRT2 : 1);
        if (ng < g[n]) {
          g[n] = ng;
          came[n] = cur;
          push(ng + h(n), n);
        }
      }
    }
  }
  if (came[t] < 0 && s !== t) return [to]; // unreachable: straight line
  const cells: P2[] = [];
  for (let i = t; i !== s && i >= 0; i = came[i]) cells.push(centre(i));
  cells.reverse();
  cells[cells.length - 1] = to;
  // line-of-sight smoothing
  const out: P2[] = [];
  let anchor = from;
  for (let i = 0; i < cells.length; i++) {
    const next = cells[i + 1];
    if (next && lineOpen(open, anchor, next)) continue;
    out.push(cells[i]);
    anchor = cells[i];
  }
  return out;
}
