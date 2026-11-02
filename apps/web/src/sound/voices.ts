import { noise, tone } from './engine.ts';

/** Every office sound, synthesised. `pan` and `gain` place a sound in the room (see OfficeScene.spatial). */
export interface Fx {
  pan?: number;
  gain?: number;
}

const jitter = (x: number, amt = 0.05) => x * (1 + (Math.random() * 2 - 1) * amt);

/** A struck bell: a fundamental plus two inharmonic partials that die away faster. */
function bell(f: number, at: number, dur: number, vol: number, pan?: number): void {
  for (const [ratio, level, decay] of [
    [1, 1, 1],
    [2.76, 0.35, 0.55],
    [5.4, 0.12, 0.25],
  ] as const) tone({ f: f * ratio, at, dur: dur * decay, vol: vol * level, attack: 0.002, pan });
}

// ── status cues (heard from a background tab too) ──────────────────────────

/** An agent needs you: a rising two-note ping, twice. */
export function alert(): void {
  for (const at of [0, 0.26]) {
    tone({ f: 784, type: 'triangle', at, dur: 0.16, vol: 0.3 });
    tone({ f: 1047, type: 'triangle', at: at + 0.1, dur: 0.2, vol: 0.3 });
  }
}

/** A reminder is due: three rising bell strikes, clearly different from the agents' two-note ping. */
export function reminder(): void {
  bell(880, 0, 0.9, 0.2);
  bell(1109, 0.22, 0.9, 0.22);
  bell(1319, 0.44, 1.6, 0.26);
}

/** A turn finished: the bell prop. */
export function done(): void {
  bell(988, 0, 0.6, 0.18);
  bell(1319, 0.12, 1.4, 0.24);
}

export function fail(): void {
  tone({ f: 190, to: 95, type: 'sawtooth', dur: 0.26, vol: 0.12, lp: 900 });
  noise({ f: 300, filter: 'lowpass', dur: 0.18, vol: 0.1 });
}

/** The door opens and a robot walks in (or out: the sweep and the notes run backwards). */
export function door(entering: boolean, fx: Fx = {}): void {
  const g = fx.gain ?? 1;
  noise({ f: entering ? 400 : 2600, to: entering ? 2600 : 400, q: 1.2, dur: 0.38, vol: 0.1 * g, attack: 0.06, pan: fx.pan });
  const [a, b] = entering ? [880, 1319] : [1319, 880];
  tone({ f: a, type: 'triangle', at: 0.2, dur: 0.14, vol: 0.12 * g, pan: fx.pan });
  tone({ f: b, type: 'triangle', at: 0.32, dur: 0.22, vol: 0.12 * g, pan: fx.pan });
}

export function powerDown(): void {
  tone({ f: 520, to: 120, dur: 0.9, vol: 0.09, attack: 0.05, lp: 1400 });
}

/** The user typed a prompt. */
export function prompt(): void {
  tone({ f: 600, to: 900, dur: 0.09, vol: 0.1 });
}

export function ping(): void {
  tone({ f: 1568, dur: 0.3, vol: 0.1 });
  tone({ f: 2093, at: 0.06, dur: 0.22, vol: 0.05 });
}

/** A chat message from the Office Manager. */
export function pop(): void {
  tone({ f: 420, to: 700, dur: 0.07, vol: 0.12 });
  tone({ f: 900, at: 0.07, dur: 0.1, vol: 0.08 });
}

/** Sound switched on (also the volume slider's feedback). */
export function hello(): void {
  tone({ f: 660, type: 'triangle', dur: 0.14, vol: 0.14 });
  tone({ f: 990, type: 'triangle', at: 0.1, dur: 0.26, vol: 0.14 });
}

// ── an agent starting a tool ───────────────────────────────────────────────

type Tool = 'key' | 'run' | 'page' | 'web' | 'radio';

const TOOL_KIND: [RegExp, Tool][] = [
  [/^(Bash|PowerShell|Monitor)$/, 'run'],
  [/^(Read|Grep|Glob|LS|NotebookRead)$/, 'page'],
  [/^(WebFetch|WebSearch)$/, 'web'],
  [/^(Agent|Task|SendMessage)$/, 'radio'],
];

export function tool(name: string | undefined, fx: Fx = {}): void {
  const g = (fx.gain ?? 1) * 0.8;
  const pan = fx.pan;
  switch (TOOL_KIND.find(([re]) => re.test(name ?? ''))?.[1] ?? 'key') {
    case 'key': // keyboard clack, sometimes two
      noise({ f: jitter(2600, 0.15), filter: 'highpass', dur: 0.035, vol: 0.1 * g, pan });
      tone({ f: jitter(1700, 0.1), type: 'square', dur: 0.02, vol: 0.025 * g, lp: 3000, pan });
      if (Math.random() < 0.5) noise({ f: jitter(2200, 0.15), filter: 'highpass', at: 0.07, dur: 0.03, vol: 0.08 * g, pan });
      break;
    case 'run': // terminal blips
      tone({ f: jitter(440), type: 'square', dur: 0.05, vol: 0.05 * g, lp: 2200, pan });
      tone({ f: jitter(660), type: 'square', at: 0.07, dur: 0.05, vol: 0.05 * g, lp: 2200, pan });
      break;
    case 'page': // paper
      noise({ f: jitter(3200, 0.1), q: 0.7, dur: 0.1, vol: 0.07 * g, attack: 0.02, pan });
      break;
    case 'web': // a quick two-step "dial"
      tone({ f: 900, to: 1500, dur: 0.06, vol: 0.07 * g, pan });
      tone({ f: 1200, to: 1800, at: 0.07, dur: 0.06, vol: 0.07 * g, pan });
      break;
    case 'radio': // delegating: a chirp
      tone({ f: 700, to: 1500, dur: 0.1, vol: 0.09 * g, pan });
      tone({ f: 1500, at: 0.11, dur: 0.04, vol: 0.06 * g, pan });
      break;
  }
}

// ── in the room ────────────────────────────────────────────────────────────

/** A small metal robot's footfall. */
export function step(fx: Fx): void {
  const g = fx.gain ?? 1;
  noise({ f: jitter(1100, 0.2), filter: 'lowpass', dur: 0.04, vol: 0.09 * g, pan: fx.pan });
  tone({ f: jitter(150, 0.15), to: 70, dur: 0.05, vol: 0.1 * g, pan: fx.pan });
  tone({ f: jitter(2300, 0.1), dur: 0.02, vol: 0.015 * g, pan: fx.pan });
}

/** What a robot does on reaching a prop, by prop id (props.json). */
export const AT_PROP: Record<string, (fx: Fx) => void> = {
  coffee: coffee,
  'ceo-coffee': coffee,
  charging: chargeUp,
  'server-bank': servers,
  'ceo-servers': servers,
  'holo-table': holo,
  'ceo-holo': holo,
  whiteboard: marker,
  'ceo-whiteboard': marker,
  'ceo-board': marker,
  comms: comms,
  'ceo-comms': comms,
  archive: drawer,
};

function coffee({ pan, gain: g = 1 }: Fx): void {
  noise({ f: 3500, q: 0.5, dur: 1, vol: 0.08 * g, attack: 0.15, pan });
  tone({ f: 1760, at: 1, dur: 0.18, vol: 0.05 * g, pan });
}

function chargeUp({ pan, gain: g = 1 }: Fx): void {
  tone({ f: 130, to: 520, dur: 0.7, vol: 0.08 * g, attack: 0.05, lp: 1400, pan });
}

function servers({ pan, gain: g = 1 }: Fx): void {
  [1400, 1800, 1400].forEach((f, i) => tone({ f, at: i * 0.07, dur: 0.04, vol: 0.05 * g, lp: 3000, pan }));
}

function holo({ pan, gain: g = 1 }: Fx): void {
  tone({ f: 200, to: 700, dur: 0.5, vol: 0.07 * g, attack: 0.1, pan });
  tone({ f: 400, to: 1400, type: 'triangle', at: 0.05, dur: 0.4, vol: 0.03 * g, attack: 0.1, pan });
}

function marker({ pan, gain: g = 1 }: Fx): void {
  noise({ f: 4800, to: 6200, q: 6, dur: 0.12, vol: 0.06 * g, attack: 0.02, pan });
  noise({ f: 6000, to: 4500, q: 6, at: 0.16, dur: 0.12, vol: 0.05 * g, attack: 0.02, pan });
}

function comms({ pan, gain: g = 1 }: Fx): void {
  noise({ f: 1800, q: 0.6, dur: 0.18, vol: 0.05 * g, pan });
  tone({ f: 1000, at: 0.2, dur: 0.07, vol: 0.06 * g, pan });
}

function drawer({ pan, gain: g = 1 }: Fx): void {
  noise({ f: 700, filter: 'lowpass', dur: 0.18, vol: 0.08 * g, pan });
  tone({ f: 110, at: 0.15, dur: 0.1, vol: 0.08 * g, pan });
}
