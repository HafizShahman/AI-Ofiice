import { getLayout, onLayoutChange, PROPS, px, ROOM_H, ROOM_W, type Pt } from './layout.ts';

/**
 * Walk grid + A*. Each level (floor, deck) is a grid of CELL-px squares over the room image.
 * A cell is walkable when its centre is inside one of that level's `nav.areas` polygons and
 * outside every obstacle: `nav.blocks` polygons plus an automatic footprint under each sprite
 * prop (a 2:1 diamond whose bottom corner is the sprite's foot). Obstacles are grown by one
 * cell so robots don't brush furniture, then every spot is carved back open so it stays
 * reachable. Floor ↔ deck routes go through `nav.stairs`.
 */

export type Level = 'floor' | 'deck';
export interface Waypoint {
  x: number;
  y: number;
  level: Level;
}

interface Grid {
  cols: number;
  rows: number;
  cell: number;
  open: Uint8Array; // 1 = walkable
}

let grids: Record<Level, Grid> | null = null;
onLayoutChange(() => (grids = null));

export function navGrids(): Record<Level, Grid> {
  grids ??= build();
  return grids;
}

function inPoly(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Floor footprint of a sprite (room px): diamond with its bottom corner at the foot. */
export function footprint(foot: Pt, widthPct: number, k = 0.78): Pt[] {
  const [fx, fy] = px(foot);
  const w = (widthPct / 100) * ROOM_W * k;
  return [
    [fx, fy],
    [fx + w / 2, fy - w / 4],
    [fx, fy - w / 2],
    [fx - w / 2, fy - w / 4],
  ];
}

/** Obstacles per level, in room px (also drawn by the helper). */
export function obstacles(): { level: Level; poly: Pt[]; id: string }[] {
  const nav = getLayout().nav;
  const out: { level: Level; poly: Pt[]; id: string }[] = nav.blocks.map((b, i) => ({ level: b.level ?? 'floor', poly: b.poly.map(px), id: b.id ?? `block-${i + 1}` }));
  for (const p of PROPS) {
    if (p.block === false) continue;
    const level: Level = p.level ?? 'floor';
    if (Array.isArray(p.block)) {
      out.push({ level, poly: p.block.map(px), id: p.id });
      continue;
    }
    if (p.kind === 'decor' && !p.foot) continue;
    const feet = p.sprites?.length ? p.sprites.map((s) => [s.foot, s.width] as const) : p.foot && p.width ? [[p.foot, p.width] as const] : [];
    for (const [foot, width] of feet) out.push({ level, poly: footprint(foot, width), id: p.id });
  }
  return out;
}

function build(): Record<Level, Grid> {
  const nav = getLayout().nav;
  const cell = nav.cell ?? 12;
  const cols = Math.ceil(ROOM_W / cell);
  const rows = Math.ceil(ROOM_H / cell);
  const blocks = obstacles();
  const spots: { level: Level; p: Pt }[] = [];
  for (const p of PROPS) for (const s of p.spots ?? []) spots.push({ level: p.level ?? 'floor', p: px(s) });
  const [bottom, top] = nav.stairs.map(px);
  spots.push({ level: 'floor', p: bottom }, { level: 'deck', p: top });

  const make = (level: Level): Grid => {
    const areas = nav.areas.filter((a) => a.level === level).map((a) => a.poly.map(px));
    const mine = blocks.filter((b) => b.level === level).map((b) => b.poly);
    const inArea = new Uint8Array(cols * rows);
    const blocked = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) * cell;
        const y = (r + 0.5) * cell;
        if (!areas.some((a) => inPoly(x, y, a))) continue;
        inArea[r * cols + c] = 1;
        if (mine.some((b) => inPoly(x, y, b))) blocked[r * cols + c] = 1;
      }
    // grow obstacles by one cell, then carve spots open again
    const open = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!inArea[i] || blocked[i]) continue;
        let near = false;
        for (let dr = -1; dr <= 1 && !near; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && blocked[rr * cols + cc]) near = true;
          }
        open[i] = near ? 0 : 1;
      }
    for (const s of spots.filter((s) => s.level === level)) {
      const c0 = Math.floor(s.p[0] / cell);
      const r0 = Math.floor(s.p[1] / cell);
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r0 + dr;
          const cc = c0 + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && inArea[rr * cols + cc]) open[rr * cols + cc] = 1;
        }
    }
    return { cols, rows, cell, open };
  };
  return { floor: make('floor'), deck: make('deck') };
}

// ── A* ────────────────────────────────────────────────────────────────────

/** Nearest walkable cell to a point (breadth-first), or null when the level has none. */
function nearestOpen(g: Grid, p: Pt): number | null {
  const c0 = Math.max(0, Math.min(g.cols - 1, Math.floor(p[0] / g.cell)));
  const r0 = Math.max(0, Math.min(g.rows - 1, Math.floor(p[1] / g.cell)));
  const start = r0 * g.cols + c0;
  if (g.open[start]) return start;
  const seen = new Uint8Array(g.cols * g.rows);
  const queue = [start];
  seen[start] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi];
    if (g.open[i]) return i;
    const r = Math.floor(i / g.cols);
    const c = i % g.cols;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= g.rows || cc < 0 || cc >= g.cols) continue;
      const j = rr * g.cols + cc;
      if (!seen[j]) {
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  return null;
}

/** Binary min-heap of cell indices keyed by f. */
class Heap {
  private items: number[] = [];
  private f: Float32Array;
  constructor(f: Float32Array) {
    this.f = f;
  }
  get size() {
    return this.items.length;
  }
  push(i: number) {
    const a = this.items;
    a.push(i);
    let k = a.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.f[a[p]] <= this.f[a[k]]) break;
      [a[p], a[k]] = [a[k], a[p]];
      k = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < a.length && this.f[a[l]] < this.f[a[m]]) m = l;
        if (r < a.length && this.f[a[r]] < this.f[a[m]]) m = r;
        if (m === k) break;
        [a[m], a[k]] = [a[k], a[m]];
        k = m;
      }
    }
    return top;
  }
}

const DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

function astar(g: Grid, from: number, to: number): number[] | null {
  const n = g.cols * g.rows;
  const gs = new Float32Array(n).fill(Infinity);
  const f = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const tc = to % g.cols;
  const tr = Math.floor(to / g.cols);
  const h = (i: number) => {
    const dx = Math.abs((i % g.cols) - tc);
    const dy = Math.abs(Math.floor(i / g.cols) - tr);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const heap = new Heap(f);
  gs[from] = 0;
  f[from] = h(from);
  heap.push(from);
  while (heap.size) {
    const i = heap.pop();
    if (i === to) {
      const out = [i];
      for (let k = came[i]; k !== -1; k = came[k]) out.push(k);
      return out.reverse();
    }
    if (closed[i]) continue;
    closed[i] = 1;
    const r = Math.floor(i / g.cols);
    const c = i % g.cols;
    for (const [dc, dr, cost] of DIRS) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= g.rows || cc < 0 || cc >= g.cols) continue;
      const j = rr * g.cols + cc;
      if (!g.open[j] || closed[j]) continue;
      // no corner cutting
      if (dr && dc && (!g.open[r * g.cols + cc] || !g.open[rr * g.cols + c])) continue;
      const ng = gs[i] + cost;
      if (ng < gs[j]) {
        gs[j] = ng;
        came[j] = i;
        f[j] = ng + h(j);
        heap.push(j);
      }
    }
  }
  return null;
}

/** Is the straight segment between two points on open cells only? */
function clear(g: Grid, a: Pt, b: Pt): boolean {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const steps = Math.ceil(d / (g.cell / 3));
  for (let s = 0; s <= steps; s++) {
    const x = a[0] + ((b[0] - a[0]) * s) / steps;
    const y = a[1] + ((b[1] - a[1]) * s) / steps;
    const c = Math.floor(x / g.cell);
    const r = Math.floor(y / g.cell);
    if (r < 0 || r >= g.rows || c < 0 || c >= g.cols || !g.open[r * g.cols + c]) return false;
  }
  return true;
}

/** Path on one level, smoothed by line of sight. Falls back to a straight line if unreachable. */
function levelPath(level: Level, from: Pt, to: Pt): Pt[] {
  const g = navGrids()[level];
  const a = nearestOpen(g, from);
  const b = nearestOpen(g, to);
  const cells = a != null && b != null ? astar(g, a, b) : null;
  if (!cells) return [to];
  const centre = (i: number): Pt => [((i % g.cols) + 0.5) * g.cell, (Math.floor(i / g.cols) + 0.5) * g.cell];
  const pts: Pt[] = [from, ...cells.slice(1, -1).map(centre), to];
  // string-pull: from each kept point, jump to the farthest point still in sight
  const out: Pt[] = [];
  let k = 0;
  while (k < pts.length - 1) {
    let j = pts.length - 1;
    while (j > k + 1 && !clear(g, pts[k], pts[j])) j--;
    out.push(pts[j]);
    k = j;
  }
  return out;
}

/** Waypoints from one spot to another (excluding the start). Floor ↔ deck goes via the stairs. */
export function findPath(from: Pt, fromLevel: Level, to: Pt, toLevel: Level): Waypoint[] {
  const wp = (pts: Pt[], level: Level) => pts.map(([x, y]) => ({ x, y, level }));
  if (fromLevel === toLevel) return wp(levelPath(fromLevel, from, to), toLevel);
  const [bottom, top] = getLayout().nav.stairs.map(px);
  return fromLevel === 'floor'
    ? [...wp(levelPath('floor', from, bottom), 'floor'), { x: top[0], y: top[1], level: 'deck' }, ...wp(levelPath('deck', top, to), 'deck')]
    : [...wp(levelPath('deck', from, top), 'deck'), { x: bottom[0], y: bottom[1], level: 'floor' }, ...wp(levelPath('floor', bottom, to), 'floor')];
}
