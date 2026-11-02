import type { AgentState, Role } from '@ai-office/shared';
import initial from './props.json';

export type Pt = [number, number];

/** Walkable areas, extra obstacles and the stairs, all in % of the room image. */
export interface NavDef {
  _note?: string;
  /** grid cell size in room px (default 12) */
  cell?: number;
  areas: { level: 'floor' | 'deck'; poly: Pt[] }[];
  blocks: { id?: string; level?: 'floor' | 'deck'; poly: Pt[] }[];
  /** [bottom (floor), top (deck)] */
  stairs: [Pt, Pt];
}

export interface LayoutData {
  _note?: string;
  room: { image: string; width: number; height: number };
  nav: NavDef;
  props: PropDef[];
}

export interface SpriteDef {
  sprite: string;
  busySprite?: string;
  failSprite?: string;
  foot: Pt;
  width: number;
  z?: number;
}

export interface PropDef {
  id: string;
  kind: string;
  level?: 'floor' | 'deck';
  sprite?: string;
  busySprite?: string;
  failSprite?: string;
  foot?: Pt;
  width?: number;
  z?: number;
  spots?: Pt[];
  sprites?: SpriteDef[];
  face?: Pt;
  /** false = robots may walk through it; a polygon (%) overrides the automatic floor footprint */
  block?: boolean | Pt[];
}

// ── the live layout (props.json, or the ?helper editor's working copy) ─────

let data = initial as unknown as LayoutData;
/** Room space = pixels of the 2400×1792 room image. props.json stores % of it. */
export const ROOM_W = data.room.width;
export const ROOM_H = data.room.height;
export let PROPS: PropDef[] = data.props;
const listeners = new Set<() => void>();

export const getLayout = (): LayoutData => data;

/** Swap in an edited layout (the ?helper editor); the scene and nav grid rebuild. */
export function setLayout(next: LayoutData): void {
  data = next;
  PROPS = next.props;
  spotCache.clear();
  DOOR = spotInfo('door')!;
  for (const f of listeners) f();
}

export function onLayoutChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** % → room px */
export const px = (p: Pt): Pt => [(p[0] / 100) * ROOM_W, (p[1] / 100) * ROOM_H];

/** "sci-fi/furniture/desk.png" → "/art/furniture/desk.webp" (built by scripts/build-art.py) */
export const artUrl = (sprite: string) => '/art/' + sprite.replace(/^sci-fi\//, '').replace(/\.png$/, '.webp');

/** Every drawable sprite, flattened (props with `sprites` contribute one entry each). */
export function spriteList(): (SpriteDef & { propId: string; index: number })[] {
  const out: (SpriteDef & { propId: string; index: number })[] = [];
  for (const p of PROPS) {
    if (p.sprite && p.foot && p.width) out.push({ propId: p.id, index: 0, sprite: p.sprite, busySprite: p.busySprite, failSprite: p.failSprite, foot: p.foot, width: p.width, z: p.z });
    p.sprites?.forEach((s, i) => out.push({ ...s, propId: p.id, index: i }));
  }
  return out;
}

export interface SpotInfo {
  pos: Pt; // room px
  level: 'floor' | 'deck';
  /** room px point to face once arrived, or null = face the camera */
  face: Pt | null;
  propId: string;
}

const spotCache = new Map<string, SpotInfo>();

/** Server spot ids: "desk-3" (single-spot prop) or "coffee.2" (n-th spot, 1-based). */
export function spotInfo(spot: string | null): SpotInfo | null {
  if (!spot) return null;
  const hit = spotCache.get(spot);
  if (hit) return hit;
  const [id, n] = spot.split('.');
  const prop = PROPS.find((p) => p.id === id);
  const s = prop?.spots?.[n ? Number(n) - 1 : 0];
  if (!prop || !s) return null;
  let face: Pt | null = prop.face ?? prop.foot ?? null;
  if (!prop.face && prop.sprites?.length) {
    // nearest of the prop's sprites (e.g. which coffee machine)
    face = prop.sprites.map((x) => x.foot).sort((a, b) => dist2(a, s) - dist2(b, s))[0];
  }
  if (prop.kind === 'door') face = null;
  const info: SpotInfo = { pos: px(s), level: prop.level ?? 'floor', face: face ? px(face) : null, propId: prop.id };
  spotCache.set(spot, info);
  return info;
}

const dist2 = (a: Pt, b: Pt) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

export let DOOR = spotInfo('door')!;

/** Spot ids in the server's format, for the helper. */
export function spotIds(p: PropDef): string[] {
  if (!p.spots?.length) return [];
  return p.spots.length === 1 ? [p.id] : p.spots.map((_, i) => `${p.id}.${i + 1}`);
}

// ── role + status presentation (UI-PLAN §5) ────────────────────────────────

export const ROLE_COLOR: Record<Role | 'ceo', string> = {
  ceo: '#FACC15',
  lead: '#60A5FA',
  researcher: '#2DD4BF',
  architect: '#A78BFA',
  engineer: '#FB923C',
  qa: '#F87171',
  devops: '#4ADE80',
  designer: '#F472B6',
};

export const ROLE_INITIALS: Record<Role | 'ceo', string> = {
  ceo: 'Hafiz Shahman',
  lead: 'LE',
  researcher: 'RS',
  architect: 'AR',
  engineer: 'EN',
  qa: 'QA',
  devops: 'DO',
  designer: 'DS',
};

export type StatusGroup = 'working' | 'idle' | 'blocked' | 'done';

export function statusGroup(a: AgentState): StatusGroup {
  if (a.status === 'blocked') return 'blocked';
  if (a.status === 'done') return 'done';
  if (a.status === 'working' || a.status === 'arriving') return 'working';
  return 'idle';
}

export const STATUS_COLOR: Record<StatusGroup, string> = {
  working: '#22D3EE',
  idle: '#64748B',
  blocked: '#FBBF24',
  done: '#34D399',
};

/** Blocked on an AskUserQuestion: a question for you rather than a permission to grant. */
export const asking = (a: { tool?: string }) => a.tool === 'AskUserQuestion';

/** One short line for tags and the roster. */
export function activityLine(a: AgentState): string {
  const s = a.summary;
  switch (a.activity) {
    case 'coding':
      return s ? `Editing ${s}` : 'Coding';
    case 'researching':
      return s ? `Reading ${s}` : 'Researching';
    case 'running':
      return s ? `$ ${s}` : 'Running a command';
    case 'browsing':
      return s ? `Browsing ${s}` : 'Browsing';
    case 'planning':
      return a.tool?.startsWith('Task') || a.tool === 'TodoWrite' ? 'Updating tasks' : 'Planning';
    case 'delegating':
      return s ? `Briefing ${s}` : 'Delegating';
    case 'thinking':
      return 'Thinking…';
    case 'blocked':
      return asking(a) ? 'Has a question' : `Needs permission${a.tool ? ` · ${a.tool}` : ''}`;
    case 'coffee':
      return 'Coffee break';
    case 'lounge':
      return 'Lounge';
    case 'charging':
      return 'Charging';
    case 'done':
      return 'Done ✓';
    case 'arriving':
      return 'Arriving…';
    case 'leaving':
      return 'Leaving';
    default:
      return 'Idle';
  }
}

/** Short tool label for the roster chip: "Edit", "Bash", "Coffee". */
export function chipLine(a: AgentState): string {
  if (a.status === 'working' && a.tool) return a.tool.startsWith('mcp__') ? a.tool.split('__')[1] : a.tool;
  return activityLine(a).replace(/ ✓$/, '');
}

/** "claude-sonnet-5-5" → "Sonnet 5.5", "claude-opus-4-1-20250805" → "Opus 4.1". Shapes it doesn't know pass through. */
export function modelName(id: string): string {
  const parts = id.replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '').split('-');
  const words = parts.filter((p) => !/^\d+$/.test(p));
  const nums = parts.filter((p) => /^\d+$/.test(p));
  if (!words.length) return id;
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return nums.length ? `${name} ${nums.join('.')}` : name;
}

/** "Sonnet 5.5 · xhigh". Just one half when the other isn't known (the model needs the server to see the transcript); '' when neither is. */
export function modelLine(a: Pick<AgentState, 'model' | 'effort'>): string {
  if (a.model) return a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model);
  return a.effort ? `${a.effort} effort` : '';
}
