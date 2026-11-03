import { Vector3 } from 'three';
import { gridPath, isOpen, LEVEL_Y, type P2 } from './nav3d.ts';
import room from './room3d.json';

/**
 * Routes through the 3D room: the floor and deck walk grids (nav3d.ts), the stairs between them,
 * and the holo ring, which robots step into radially (band → step → pit floor) and walk round on an
 * arc, never across the pedestal. Pure geometry: no scene, so it can be tested in Node.
 *
 * Points are three.js world coordinates: x along the back wall, y up, z away from the back wall.
 */

export type Zone = 'floor' | 'deck' | 'holo';

const W3 = (p: number[]): Vector3 => new Vector3(p[0], p[2] ?? 0, p[1]);
const plan2 = (v: Vector3): P2 => [v.x, v.z];

export const HOLO = room.holo;
export const HOLO_CENTRE = new Vector3(HOLO.c[0], 0, HOLO.c[1]);
const STAIRS_TOP = W3(room.stairs.top);
const STAIRS_BOTTOM = W3(room.stairs.bottom);
/** where the deck ends and the stairs start, and the foot of the stairs on the floor */
const DECK_EDGE = new Vector3(STAIRS_TOP.x, LEVEL_Y.deck, room.stairs.top[1] + 0.4);
const STAIRS_FOOT = new Vector3(STAIRS_BOTTOM.x, LEVEL_Y.floor, room.stairs.bottom[1] - 0.6);
/** how far outside the ring robots line up before stepping in */
const GATE_R = HOLO.bandR + 0.4;

export const holoR = (v: Vector3) => Math.hypot(v.x - HOLO_CENTRE.x, v.z - HOLO_CENTRE.z);
export const holoA = (v: Vector3) => Math.atan2(v.z - HOLO_CENTRE.z, v.x - HOLO_CENTRE.x);

export function zoneOf(v: Vector3): Zone {
  if (v.y > 0.6) return 'deck';
  return holoR(v) < HOLO.bandR + 0.02 ? 'holo' : 'floor';
}

/** Floor height inside the holo ring: the raised band, the step, the pit floor. */
export function holoY(r: number): number {
  if (r > HOLO.bandR) return LEVEL_Y.floor;
  if (r > HOLO.pitR) return 0.12;
  if (r > HOLO.stepR) return HOLO.stepZ;
  return HOLO.pitZ;
}

const onHolo = (a: number, r: number) => new Vector3(HOLO_CENTRE.x + r * Math.cos(a), holoY(r), HOLO_CENTRE.z + r * Math.sin(a));

/** The nearest angle to `a` whose lining-up point outside the ring is walkable. */
function gate(a: number): number {
  for (let k = 0; k < 18; k++) {
    for (const s of k ? [1, -1] : [1]) {
      const aa = a + s * k * (Math.PI / 18);
      if (isOpen('floor', plan2(onHolo(aa, GATE_R)))) return aa;
    }
  }
  return a;
}

/** Straight in or out at angle a, a point either side of every height change. */
function radial(a: number, r0: number, r1: number): Vector3[] {
  const edges = [HOLO.bandR, HOLO.pitR, HOLO.stepR].filter((e) => (e - r0) * (e - r1) < 0);
  edges.sort((x, y) => (r1 < r0 ? y - x : x - y));
  const pts: Vector3[] = [];
  for (const e of edges) {
    pts.push(onHolo(a, r1 < r0 ? e + 0.06 : e - 0.06), onHolo(a, r1 < r0 ? e - 0.06 : e + 0.06));
  }
  pts.push(onHolo(a, r1));
  return pts;
}

/** From `from`, change radius to r at its own angle, then round the ring to angle a1. */
function around(from: Vector3, r: number, a1: number): Vector3[] {
  const a0 = holoA(from);
  const pts = Math.abs(holoR(from) - r) > 0.05 ? radial(a0, holoR(from), r) : [];
  const da = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
  const n = Math.ceil(Math.abs(da) / (Math.PI / 9));
  for (let i = 1; i <= n; i++) pts.push(onHolo(a0 + (da * i) / n, r));
  return pts;
}

/** Waypoints from `from` to `to` (both world points), ending exactly at `to`. */
export function route(from: Vector3, to: Vector3): Vector3[] {
  const za = zoneOf(from);
  const zb = zoneOf(to);
  const out: Vector3[] = [];
  let cur = from.clone();
  const walk = (level: 'floor' | 'deck', goal: Vector3) => {
    for (const [x, d] of gridPath(level, plan2(cur), plan2(goal))) out.push(new Vector3(x, LEVEL_Y[level], d));
    out[out.length - 1].y = goal.y;
    cur = goal.clone();
  };
  const push = (...vs: Vector3[]) => {
    if (!vs.length) return;
    out.push(...vs.map((v) => v.clone()));
    cur = vs[vs.length - 1].clone();
  };

  if (za === zb && za !== 'holo') {
    walk(za, to);
    return out;
  }
  if (za === 'holo' && zb === 'holo') {
    push(...around(cur, holoR(to), holoA(to)), to);
    return out;
  }
  // leave the start zone for the floor
  if (za === 'deck') {
    walk('deck', STAIRS_TOP);
    push(DECK_EDGE, STAIRS_FOOT, STAIRS_BOTTOM);
  } else if (za === 'holo') {
    const exitA = gate(holoA(zb === 'deck' ? STAIRS_BOTTOM : to));
    const r = holoR(cur);
    push(...around(cur, r, exitA), ...radial(exitA, r, GATE_R));
  }
  // and enter the target zone
  if (zb === 'deck') {
    walk('floor', STAIRS_BOTTOM);
    push(STAIRS_FOOT, DECK_EDGE, STAIRS_TOP);
    walk('deck', to);
  } else if (zb === 'holo') {
    const inA = gate(holoA(cur));
    const r = holoR(to);
    walk('floor', onHolo(inA, GATE_R));
    push(...radial(inA, GATE_R, r), ...around(onHolo(inA, r), r, holoA(to)), to);
  } else {
    walk('floor', to);
  }
  return out;
}
