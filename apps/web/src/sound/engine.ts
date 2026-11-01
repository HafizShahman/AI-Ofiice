import { create } from 'zustand';

/**
 * Office sound: procedural WebAudio, so there are no audio files to download or license.
 * It is off until the user turns it on, and a browser only lets audio start after a click or key
 * press, so the context is created (and resumed) from the toggle or the first gesture after a reload.
 */

const KEY = 'ai-office.sound';
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

interface Prefs {
  on: boolean;
  /** 0..1, shaped by volume² so the slider feels even */
  volume: number;
}

function readPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return { on: p.on === true, volume: typeof p.volume === 'number' ? clamp(p.volume, 0, 1) : 0.7 };
  } catch {
    return { on: false, volume: 0.7 };
  }
}

interface SoundStore extends Prefs {
  /** resolves once the audio context is running (or can't be) */
  setOn(on: boolean): Promise<void>;
  setVolume(v: number): void;
}

export const useSound = create<SoundStore>((set) => ({
  ...readPrefs(),
  setOn: async (on) => {
    set({ on });
    if (on) await wake()?.resume().catch(() => {});
  },
  setVolume: (volume) => set({ volume: clamp(volume, 0, 1) }),
}));

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let air: GainNode | null = null;
let airLevel = 0;
const lastPlayed = new Map<string, number>();

/** Create the context on first use (must happen inside a user gesture) and try to resume it. */
function wake(): AudioContext | null {
  if (!ctx) {
    if (typeof AudioContext === 'undefined') return null;
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor(); // many voices at once must not clip
    comp.threshold.value = -16;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    master.connect(comp);
    comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    startAir(ctx, master);
    apply();
  }
  if (ctx.state !== 'running') void ctx.resume().catch(() => {});
  return ctx;
}

/** Master volume, the room tone level, and suspending the context while sound is off (no CPU, no tab speaker icon). */
function apply(): void {
  if (!ctx || !master || !air) return;
  const { on, volume } = useSound.getState();
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(on ? volume * volume : 0, t, 0.03);
  air.gain.setTargetAtTime(on && !document.hidden ? airLevel : 0, t, 0.8);
  if (!on && ctx.state === 'running') void ctx.suspend().catch(() => {});
  else if (on && ctx.state === 'suspended') void ctx.resume().catch(() => {});
}

/** Wire up persistence, the first-gesture unlock and tab visibility. Returns the cleanup. */
export function initSound(): () => void {
  const unsub = useSound.subscribe((s) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ on: s.on, volume: s.volume }));
    } catch {
      /* private mode: the choice just doesn't survive a reload */
    }
    apply();
  });
  const unlock = () => {
    if (useSound.getState().on) wake();
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  document.addEventListener('visibilitychange', apply);
  return () => {
    unsub();
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    document.removeEventListener('visibilitychange', apply);
  };
}

/**
 * Whether a cue may play right now. `essential` cues (blocked, done, failure, arrivals) also play
 * from a background tab, which is the point of an office you keep open beside your work; the rest
 * (footsteps, typing, props) only while the tab is visible.
 */
export function ready(essential = false): boolean {
  return useSound.getState().on && ctx?.state === 'running' && (essential || !document.hidden);
}

/** True at most once per `ms` for a key, so bursts of events don't pile up into noise. */
export function throttle(key: string, ms: number): boolean {
  const now = performance.now();
  if (now - (lastPlayed.get(key) ?? -Infinity) < ms) return false;
  lastPlayed.set(key, now);
  return true;
}

/** Room tone follows how busy the office is (the number of working agents). */
export function setBusy(working: number): void {
  airLevel = 0.016 + 0.007 * Math.min(working, 6);
  apply();
}

// ── voices ─────────────────────────────────────────────────────────────────

interface Voice {
  /** seconds from now */
  at?: number;
  dur: number;
  vol: number;
  attack?: number;
  /** -1 (left) .. 1 (right) */
  pan?: number;
  /** low-pass cutoff in Hz */
  lp?: number;
}

function route(c: AudioContext, node: AudioNode, v: Voice): void {
  let out = node;
  if (v.lp) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = v.lp;
    out.connect(f);
    out = f;
  }
  if (v.pan) {
    const p = c.createStereoPanner();
    p.pan.value = clamp(v.pan, -1, 1);
    out.connect(p);
    out = p;
  }
  out.connect(master!);
}

function envelope(c: AudioContext, v: Voice, t0: number): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v.vol), t0 + (v.attack ?? 0.004));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + v.dur);
  return g;
}

/** A pitched blip; `to` slides the frequency exponentially over the duration. */
export function tone(v: Voice & { f: number; to?: number; type?: OscillatorType }): void {
  if (!ctx || !master) return;
  const t0 = ctx.currentTime + (v.at ?? 0);
  const osc = ctx.createOscillator();
  osc.type = v.type ?? 'sine';
  osc.frequency.setValueAtTime(v.f, t0);
  if (v.to) osc.frequency.exponentialRampToValueAtTime(v.to, t0 + v.dur);
  const g = envelope(ctx, v, t0);
  osc.connect(g);
  route(ctx, g, v);
  osc.start(t0);
  osc.stop(t0 + v.dur + 0.03);
}

/** A burst of filtered noise (clicks, hiss, whooshes); `to` sweeps the filter frequency. */
export function noise(v: Voice & { f: number; to?: number; q?: number; filter?: BiquadFilterType }): void {
  if (!ctx || !master || !noiseBuf) return;
  const t0 = ctx.currentTime + (v.at ?? 0);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = v.filter ?? 'bandpass';
  f.Q.value = v.q ?? 0.8;
  f.frequency.setValueAtTime(v.f, t0);
  if (v.to) f.frequency.exponentialRampToValueAtTime(v.to, t0 + v.dur);
  const g = envelope(ctx, v, t0);
  src.connect(f);
  f.connect(g);
  route(ctx, g, v);
  src.start(t0, Math.random() * 0.5); // the buffer is 2 s: every burst stays under 1.5 s
  src.stop(t0 + v.dur + 0.03);
}

/** The room tone: a low machine hum plus a breath of air, always running while sound is on. */
function startAir(c: AudioContext, out: AudioNode): void {
  air = c.createGain();
  air.gain.value = 0;
  air.connect(out);

  const hum = c.createBiquadFilter();
  hum.type = 'lowpass';
  hum.frequency.value = 260;
  hum.connect(air);
  for (const [f, type, v] of [
    [80, 'sawtooth', 0.35],
    [80.6, 'sawtooth', 0.35],
    [160.4, 'sine', 0.3],
  ] as const) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = c.createGain();
    g.gain.value = v;
    o.connect(g);
    g.connect(hum);
    o.start();
  }

  const wind = c.createBufferSource();
  wind.buffer = noiseBuf;
  wind.loop = true;
  const wf = c.createBiquadFilter();
  wf.type = 'lowpass';
  wf.frequency.value = 520;
  const wg = c.createGain();
  wg.gain.value = 0.22;
  wind.connect(wf);
  wf.connect(wg);
  wg.connect(air);
  wind.start();

  // the air-handling breathes: a very slow sweep of the filter
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.07;
  const depth = c.createGain();
  depth.gain.value = 180;
  lfo.connect(depth);
  depth.connect(wf.frequency);
  lfo.start();
}
