import { create } from 'zustand';

/**
 * Day / night: the model. Pure numbers, no three.js; `DayNight.ts` turns them into light.
 *
 * The painted room is a dusk-lit sci-fi office, so night is close to the art as drawn and day is
 * built on top of it (a brighter grade, sky in the windows, sun beams on the floor). The clock is
 * the browser's local time; the top-bar chip (or N) can pin Day or Night instead.
 *
 * Test hooks: `?time=14:30` freezes the clock (also `?time=day|night`), `?timelapse` runs 24 h in 40 s.
 */

export type Mode = 'auto' | 'day' | 'night';
export type Phase = 'dawn' | 'day' | 'dusk' | 'night';
export type RGB = [number, number, number];

const KEY = 'ai-office.daylight';
const query = new URLSearchParams(location.search);

/** What the manual modes show: a clear morning (long beams) and the middle of the night. */
const HOUR = { day: 9.5, night: 0 };
const RISE = 7;
const SET = 19;

const MODES: Mode[] = ['auto', 'day', 'night'];

function readMode(): Mode {
  try {
    const m = localStorage.getItem(KEY) as Mode | null;
    return m && MODES.includes(m) ? m : 'auto';
  } catch {
    return 'auto';
  }
}

interface DaylightStore {
  mode: Mode;
  /** what the scene is showing right now (the scene writes it) */
  phase: Phase;
  setMode(m: Mode): void;
  cycle(): void;
}

export const useDaylight = create<DaylightStore>((set, get) => ({
  mode: readMode(),
  phase: 'night',
  setMode: (mode) => {
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* private mode: the choice just doesn't persist */
    }
    set({ mode });
  },
  cycle: () => get().setMode(MODES[(MODES.indexOf(get().mode) + 1) % MODES.length]),
}));

/** Hour of day (0..24) the office should be lit for; `seconds` is scene time, for ?timelapse. */
export function currentHour(mode: Mode, seconds: number): number {
  const t = query.get('time');
  if (t === 'day') return HOUR.day;
  if (t === 'night') return HOUR.night;
  if (t) {
    const [h, m = '0'] = t.split(':');
    const v = Number(h) + Number(m) / 60;
    if (Number.isFinite(v)) return ((v % 24) + 24) % 24;
  }
  if (query.has('timelapse')) return (5.5 + seconds * 0.6) % 24;
  if (mode === 'day') return HOUR.day;
  if (mode === 'night') return HOUR.night;
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

// ── maths ───────────────────────────────────────────────────────────────────

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export interface Light {
  /** 0 = night … 1 = full daylight */
  day: number;
  /** sunrise / sunset warmth, 0..1 (peaks just after sunrise and just before sunset) */
  warm: number;
  /** sun height, 0 (below the horizon) … 1 (noon) */
  elev: number;
  /** the sun's way across the sky: 0 at sunrise … 1 at sunset */
  sunP: number;
  /** the moon's way across the night: 0 at sunset … 1 at sunrise */
  moonP: number;
  /** before noon */
  morning: boolean;
}

export function lightAt(hour: number): Light {
  // >0 by day, <0 at night (−1 at 01:00); smooth through the horizon
  const s = Math.sin((Math.PI * (hour - RISE)) / (SET - RISE));
  return {
    day: smooth(-0.12, 0.38, s),
    warm: clamp01(1 - Math.abs(s - 0.04) / 0.42),
    elev: Math.max(0, s),
    sunP: clamp01((hour - RISE) / (SET - RISE)),
    moonP: clamp01((((hour - SET) % 24) + 24) % 24 / (24 - (SET - RISE))),
    morning: hour < 13,
  };
}

export function phaseOf(l: Light): Phase {
  if (l.day > 0.82) return 'day';
  if (l.day < 0.12) return 'night';
  return l.morning ? 'dawn' : 'dusk';
}

// ── the grade ───────────────────────────────────────────────────────────────

/** What the painted room and every prop sprite are multiplied by (linear). */
const NIGHT_TINT: RGB = [0.8, 0.88, 1.04];
const DAY_TINT: RGB = [1.55, 1.5, 1.4];
/** with a painted day backdrop the grade only has to match the props to it */
const DAY_ART_TINT: RGB = [1.1, 1.08, 1.02];
const DUSK_TINT: RGB = [1.3, 0.96, 0.78];

export function tintAt(l: Light, dayArt: boolean): RGB {
  return mix(mix(NIGHT_TINT, dayArt ? DAY_ART_TINT : DAY_TINT, l.day), DUSK_TINT, l.warm * 0.8);
}

/** Lights that sit the robots in the room (sRGB colours, intensities). */
export interface Rig {
  hemiSky: RGB;
  hemiGround: RGB;
  hemi: number;
  key: RGB;
  keyI: number;
  rim: RGB;
  rimI: number;
}

const NIGHT_RIG: Rig = { hemiSky: [0.84, 0.95, 1], hemiGround: [0.106, 0.141, 0.212], hemi: 2.1, key: [1, 1, 1], keyI: 2.4, rim: [0.133, 0.827, 0.933], rimI: 1.1 };
const DAY_RIG: Rig = { hemiSky: [1, 0.97, 0.9], hemiGround: [0.25, 0.28, 0.34], hemi: 2.7, key: [1, 0.95, 0.84], keyI: 3.0, rim: [0.133, 0.827, 0.933], rimI: 0.5 };
const DUSK_RIG: Rig = { hemiSky: [1, 0.75, 0.6], hemiGround: [0.2, 0.17, 0.24], hemi: 2.3, key: [1, 0.62, 0.38], keyI: 2.8, rim: [0.133, 0.827, 0.933], rimI: 0.9 };

export function rigAt(l: Light): Rig {
  const blend = (a: Rig, b: Rig, t: number): Rig => ({
    hemiSky: mix(a.hemiSky, b.hemiSky, t),
    hemiGround: mix(a.hemiGround, b.hemiGround, t),
    hemi: lerp(a.hemi, b.hemi, t),
    key: mix(a.key, b.key, t),
    keyI: lerp(a.keyI, b.keyI, t),
    rim: mix(a.rim, b.rim, t),
    rimI: lerp(a.rimI, b.rimI, t),
  });
  return blend(blend(NIGHT_RIG, DAY_RIG, l.day), DUSK_RIG, l.warm * 0.8);
}
