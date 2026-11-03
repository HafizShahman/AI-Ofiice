import { create } from 'zustand';

/**
 * Per-browser preferences (the settings drawer's General / Scene / Notifications sections) and the
 * open/closed state of the drawer, the ⌘K palette and wallboard mode. Server-side settings (AI,
 * approvals) live on the server; sound and lighting keep their own stores.
 */

export const ACCENTS = { cyan: '#22d3ee', violet: '#a78bfa', green: '#34d399', amber: '#fbbf24' } as const;
export type Accent = keyof typeof ACCENTS;
/** Resolution cap for the 3D canvas: the device pixel ratio is limited to this. */
export type Quality = 'low' | 'medium' | 'high';
export const QUALITY_DPR: Record<Quality, number> = { low: 1, medium: 1.5, high: 2 };

const KEY = 'ai-office.prefs';

export interface Prefs {
  accent: Accent;
  clock24: boolean;
  quality: Quality;
  /** jump the camera instead of flying, no wallboard tour, no UI animation */
  reduceMotion: boolean;
  /** browser notification when an agent is blocked and this tab is hidden */
  notify: boolean;
  /** the 3D room (on) or the painted 2D office (off); ?view=2d|3d overrides it per tab */
  view3d: boolean;
}

const osReducesMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function readPrefs(): Prefs {
  const d: Prefs = { accent: 'cyan', clock24: true, quality: 'medium', reduceMotion: osReducesMotion(), notify: false, view3d: true };
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      accent: p.accent && p.accent in ACCENTS ? p.accent : d.accent,
      clock24: typeof p.clock24 === 'boolean' ? p.clock24 : d.clock24,
      quality: p.quality && p.quality in QUALITY_DPR ? p.quality : d.quality,
      reduceMotion: typeof p.reduceMotion === 'boolean' ? p.reduceMotion : d.reduceMotion,
      // a saved "on" only holds while the browser still allows notifications
      notify: p.notify === true && typeof Notification !== 'undefined' && Notification.permission === 'granted',
      view3d: typeof p.view3d === 'boolean' ? p.view3d : d.view3d,
    };
  } catch {
    return d;
  }
}

interface PrefsStore extends Prefs {
  set(p: Partial<Prefs>): void;
}

export const usePrefs = create<PrefsStore>((set) => ({ ...readPrefs(), set: (p) => set(p) }));

function apply(p: Prefs): void {
  const root = document.documentElement;
  root.style.setProperty('--color-accent', ACCENTS[p.accent]);
  root.toggleAttribute('data-reduce-motion', p.reduceMotion);
}

/** Persist and apply the preferences. Returns the cleanup. */
export function initPrefs(): () => void {
  apply(usePrefs.getState());
  return usePrefs.subscribe((s) => {
    apply(s);
    try {
      const { accent, clock24, quality, reduceMotion, notify, view3d } = s;
      localStorage.setItem(KEY, JSON.stringify({ accent, clock24, quality, reduceMotion, notify, view3d }));
    } catch {
      /* private mode: the choices just don't survive a reload */
    }
  });
}

/** Turn browser notifications on (asks for permission the first time) or off. Resolves to the new state. */
export async function setNotify(on: boolean): Promise<boolean> {
  if (!on || typeof Notification === 'undefined') {
    usePrefs.getState().set({ notify: false });
    return false;
  }
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  const granted = perm === 'granted';
  usePrefs.getState().set({ notify: granted });
  return granted;
}

// ── shell state: drawer, palette, wallboard ─────────────────────────────────

interface UiStore {
  settingsOpen: boolean;
  paletteOpen: boolean;
  /** wallboard mode (?wallboard): all chrome hidden, slow camera tour, big counters */
  wallboard: boolean;
  /** the "?" shortcut sheet */
  shortcutsOpen: boolean;
  /** the mission board: a small card, or the full overlay */
  board: 'closed' | 'card' | 'overlay';
  /** roster filter: a status group (counters) or one raw status (keys 1-8); null = everyone */
  filter: string | null;
  setSettings(open: boolean): void;
  setShortcuts(open: boolean): void;
  setBoard(mode: 'closed' | 'card' | 'overlay'): void;
  setFilter(f: string | null): void;
  setPalette(open: boolean): void;
  setWallboard(on: boolean): void;
}

export const useUi = create<UiStore>((set) => ({
  settingsOpen: false,
  paletteOpen: false,
  wallboard: new URLSearchParams(location.search).has('wallboard'),
  shortcutsOpen: false,
  board: 'closed',
  filter: null,
  setSettings: (settingsOpen) => set(settingsOpen ? { settingsOpen, paletteOpen: false, shortcutsOpen: false } : { settingsOpen }),
  setPalette: (paletteOpen) => set(paletteOpen ? { paletteOpen, settingsOpen: false, shortcutsOpen: false } : { paletteOpen }),
  setShortcuts: (shortcutsOpen) => set(shortcutsOpen ? { shortcutsOpen, paletteOpen: false, settingsOpen: false } : { shortcutsOpen }),
  setBoard: (board) => set(board === 'overlay' ? { board, paletteOpen: false, settingsOpen: false, shortcutsOpen: false } : { board }),
  setFilter: (filter) => set((s) => ({ filter: s.filter === filter ? null : filter })),
  setWallboard: (wallboard) => {
    const url = new URL(location.href);
    if (wallboard) url.searchParams.set('wallboard', '');
    else url.searchParams.delete('wallboard');
    history.replaceState(null, '', url.search === '?wallboard=' ? url.pathname + '?wallboard' : url);
    set({ wallboard, settingsOpen: false, paletteOpen: false, shortcutsOpen: false, board: 'closed' });
  },
}));
