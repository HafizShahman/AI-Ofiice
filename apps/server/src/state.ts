import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Activity, AgentState, AgentStatus, OfficeEvent, PropKind, Role } from '@ai-office/shared';
import { config, ROOT } from './config.ts';
import { resolveRole, roleForTool, rolePinned, ROLE_LABEL } from './roles.ts';

// ── spots, read from the same props.json the web app draws ─────────────────

interface PropDef { id: string; kind: string; spots?: [number, number][] }
const props = (JSON.parse(readFileSync(join(ROOT, 'apps/web/src/scene/props.json'), 'utf8')) as { props: PropDef[] }).props;

const POOLS = new Map<string, string[]>();
for (const p of props) {
  if (!p.spots?.length) continue;
  const ids = p.spots.length === 1 ? [p.id] : p.spots.map((_, i) => `${p.id}.${i + 1}`);
  POOLS.set(p.kind, [...(POOLS.get(p.kind) ?? []), ...ids]);
}
const DESK_COUNT = Math.min(config.desks, POOLS.get('desk')?.length ?? 0);

// ── what each tool means in the office ─────────────────────────────────────

type Plan = { activity: Activity; kind: PropKind };

const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

export function planFor(tool: string | undefined, role: AgentState['role']): Plan {
  const t = tool ?? '';
  if (t === 'EnterPlanMode' || t === 'ExitPlanMode') return { activity: 'planning', kind: 'holo-table' };
  if (PLAN_TOOLS.has(t)) return { activity: 'planning', kind: 'whiteboard' };
  if (role === 'architect') return { activity: 'planning', kind: 'holo-table' }; // Plan agents think at the holo-table
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(t)) return { activity: 'coding', kind: 'desk' };
  if (['Read', 'Grep', 'Glob', 'LS'].includes(t)) return { activity: 'researching', kind: 'archive' };
  if (['Bash', 'BashOutput', 'KillShell'].includes(t)) return { activity: 'running', kind: 'server-bank' };
  if (t === 'WebFetch' || t === 'WebSearch' || t.startsWith('mcp__')) return { activity: 'browsing', kind: 'comms' };
  if (t === 'Task' || t === 'Agent') return { activity: 'delegating', kind: 'desk' };
  return { activity: 'coding', kind: 'desk' };
}

const ZONE_DEBOUNCE_MS = 2000; // a Read→Edit→Read burst shouldn't make the robot sprint around
const ARRIVE_MS = 2500;
const LEAVE_MS = 3000;

export interface OfficeListener {
  agent(a: AgentState): void;
  remove(id: string): void;
}

export class Office {
  readonly agents = new Map<string, AgentState>();
  private pending = new Map<string, Plan>();
  /** leads whose turn ended while background subagents were still working */
  private awaitingChildren = new Set<string>();
  /** subagents whose type names their job (Explore, Plan…): their role never changes */
  private pinned = new Set<string>();
  /** the roles of an agent's last few tool calls; it takes the role they agree on */
  private recent = new Map<string, Role[]>();
  /** roles suggested by the wording of Agent calls, waiting for their subagent to appear (by parent) */
  private hints = new Map<string, Role[]>();
  private listener: OfficeListener;

  constructor(listener: OfficeListener) {
    this.listener = listener;
    setInterval(() => this.tick(Date.now()), 1000).unref();
  }

  snapshot(): AgentState[] {
    return [...this.agents.values()];
  }

  /** Walk matching agents out (used when the demo stops). */
  dismiss(match: (a: AgentState) => boolean): void {
    const now = Date.now();
    for (const a of this.agents.values()) if (match(a) && a.status !== 'leaving') this.set(a, 'leaving', { activity: 'leaving', kind: 'door' }, now);
  }

  apply(e: OfficeEvent): void {
    let a = this.agents.get(e.agentId);
    if (e.kind === 'leave') {
      if (a && a.status !== 'leaving') this.set(a, 'leaving', { activity: 'leaving', kind: 'door' }, e.ts);
      if (a?.parentId) this.childGone(a.parentId, e.ts);
      return;
    }
    if (!a) a = this.create(e);
    a.lastEventAt = e.ts;
    if (e.effort) a.effort = e.effort;
    if (e.model) a.model = e.model;

    switch (e.kind) {
      case 'spawn':
        break;
      case 'prompt':
        this.awaitingChildren.delete(a.id);
        this.set(a, 'working', { activity: 'thinking', kind: 'desk' }, e.ts);
        break;
      case 'tool_start': {
        a.tool = e.tool;
        a.summary = e.summary;
        a.counts.tools++;
        if (e.roleHint) this.hints.set(a.id, [...(this.hints.get(a.id) ?? []), e.roleHint]);
        this.follow(a, e);
        const plan = this.plan(a, e.tool);
        if (plan.activity === 'coding') a.counts.edits++;
        if (plan.activity === 'running') a.counts.commands++;
        this.set(a, 'working', plan, e.ts, true);
        break;
      }
      case 'tool_end':
        if (a.status === 'blocked') this.set(a, 'working', this.plan(a, a.tool), e.ts);
        else this.listener.agent(a);
        break;
      case 'tool_fail':
        a.counts.failures++;
        this.listener.agent(a);
        break;
      case 'blocked':
        if (e.tool) { a.tool = e.tool; a.summary = e.summary; }
        this.set(a, 'blocked', { activity: 'blocked', kind: 'approval' }, e.ts);
        break;
      case 'turn_done':
        // Stop fires while background subagents are still working: the lead isn't done until they are
        if (this.liveChildren(a.id)) {
          this.awaitingChildren.add(a.id);
          this.set(a, 'working', { activity: 'delegating', kind: 'desk' }, e.ts);
        } else this.set(a, 'done', { activity: 'done', kind: 'bell' }, e.ts);
        break;
      case 'task_created':
        if (a.status !== 'blocked') this.set(a, 'working', { activity: 'planning', kind: 'whiteboard' }, e.ts, true);
        break;
      case 'compact':
        this.set(a, 'charging', { activity: 'charging', kind: 'charging' }, e.ts);
        break;
      default:
        this.listener.agent(a);
    }
  }

  /** You answered its permission from the office: back to work without waiting for the next hook. */
  resume(id: string): void {
    const a = this.agents.get(id);
    if (a?.status === 'blocked') this.set(a, 'working', this.plan(a, a.tool), Date.now());
  }

  /** Where a tool call takes an agent. Only a pinned Plan agent thinks at the holo-table whatever it does. */
  private plan(a: AgentState, tool: string | undefined): Plan {
    return planFor(tool, this.pinned.has(a.id) ? a.role : 'lead');
  }

  /**
   * Agents take the role of the work they do: when two of the last four classified tool calls agree on a role
   * that isn't theirs (and no other role has as many), the same robot changes role in place: colour, name and
   * tag, but not desk.
   */
  private follow(a: AgentState, e: OfficeEvent): void {
    if (this.pinned.has(a.id)) return;
    const r = roleForTool(e.tool, e.summary);
    if (!r) return;
    const window = [...(this.recent.get(a.id) ?? []), r].slice(-4);
    this.recent.set(a.id, window);
    const votes = new Map<Role, number>();
    for (const x of window) votes.set(x, (votes.get(x) ?? 0) + 1);
    const [top, n] = [...votes].sort((x, y) => y[1] - x[1])[0];
    if (n >= 2 && top !== a.role && (votes.get(a.role) ?? 0) < n) {
      a.role = top;
      const same = [...this.agents.values()].filter((x) => x.id !== a.id && x.role === top).length;
      a.name = ROLE_LABEL[top] + (same ? ` #${same + 1}` : '');
    }
  }

  /** The model an agent's transcript says it is running on (see model.ts). */
  setModel(id: string, model: string): void {
    const a = this.agents.get(id);
    if (!a || a.model === model) return;
    a.model = model;
    this.listener.agent(a);
  }

  private liveChildren(id: string): number {
    return [...this.agents.values()].filter((x) => x.parentId === id && x.status !== 'leaving').length;
  }

  /** A subagent left: if its lead was only waiting on it, the lead's turn is now done. */
  private childGone(parentId: string, now: number): void {
    const p = this.agents.get(parentId);
    if (!p || !this.awaitingChildren.has(parentId) || this.liveChildren(parentId)) return;
    this.awaitingChildren.delete(parentId);
    if (p.status !== 'leaving' && p.status !== 'blocked') this.set(p, 'done', { activity: 'done', kind: 'bell' }, now);
  }

  private create(e: OfficeEvent): AgentState {
    const isMain = !e.parentAgentId;
    const pinned = rolePinned(e.agentType, isMain);
    // the wording of the task ("research the DDEV docs") decides the role of a subagent whose type doesn't
    const hint = !isMain && !pinned ? this.hints.get(e.parentAgentId!)?.shift() : undefined;
    const role = hint ?? resolveRole(e.agentType, isMain);
    const same = [...this.agents.values()].filter((x) => x.role === role).length;
    const parent = e.parentAgentId ? this.agents.get(e.parentAgentId) : undefined;
    const a: AgentState = {
      id: e.agentId,
      sessionId: e.sessionId,
      parentId: e.parentAgentId,
      name: ROLE_LABEL[role] + (same ? ` #${same + 1}` : ''),
      role,
      agentType: e.agentType,
      project: e.project,
      cwd: e.cwd,
      status: 'arriving',
      activity: 'arriving',
      spot: 'door',
      desk: this.freeDesk(parent?.desk ?? null),
      startedAt: e.ts,
      lastEventAt: e.ts,
      statusSince: e.ts,
      counts: { tools: 0, edits: 0, commands: 0, failures: 0 },
    };
    this.agents.set(a.id, a);
    if (pinned) this.pinned.add(a.id);
    // first sighting mid-session (server restarted): skip the walk-in
    if (e.kind !== 'spawn') this.set(a, 'idle', { activity: 'idle', kind: 'desk' }, e.ts);
    else this.listener.agent(a);
    return a;
  }

  /** Free desk, nearest to the parent's desk when there is one. */
  private freeDesk(near: number | null): number | null {
    const used = new Set([...this.agents.values()].map((x) => x.desk));
    const free = Array.from({ length: DESK_COUNT }, (_, i) => i + 1).filter((d) => !used.has(d));
    if (!free.length) return null;
    if (near == null) return free[0];
    return free.sort((x, y) => Math.abs(x - near) - Math.abs(y - near))[0];
  }

  /** Claim a free spot of a kind. Desks are owned; the door never runs out. */
  private claim(a: AgentState, kind: PropKind): string | null {
    if (kind === 'desk') return a.desk ? `desk-${a.desk}` : this.claim(a, 'lounge');
    if (kind === 'door') return 'door';
    const taken = new Set([...this.agents.values()].filter((x) => x.id !== a.id).map((x) => x.spot));
    return (POOLS.get(kind) ?? []).find((s) => !taken.has(s)) ?? null;
  }

  private set(a: AgentState, status: AgentStatus, plan: Plan, now: number, debounce = false): void {
    const currentKind = kindOf(a.spot);
    if (debounce && a.status === 'working' && status === 'working' && plan.kind !== currentKind && now - a.statusSince < ZONE_DEBOUNCE_MS) {
      this.pending.set(a.id, plan); // apply on a later tick if it still stands
      this.listener.agent(a);
      return;
    }
    this.pending.delete(a.id);
    // prop full (e.g. someone else at the bell) → fall back to own desk, then the lounge
    const spot = this.claim(a, plan.kind) ?? this.claim(a, 'desk');
    const moved = spot !== a.spot || status !== a.status;
    a.status = status;
    a.activity = plan.activity;
    a.spot = spot;
    if (moved) a.statusSince = now;
    this.listener.agent(a);
  }

  private tick(now: number): void {
    const t = config.timers;
    for (const a of this.agents.values()) {
      const inState = now - a.statusSince;
      const quiet = (now - a.lastEventAt) / 1000;
      const pending = this.pending.get(a.id);

      if (a.status === 'leaving') {
        if (inState > LEAVE_MS) {
          this.agents.delete(a.id);
          this.pending.delete(a.id);
          this.awaitingChildren.delete(a.id);
          this.pinned.delete(a.id);
          this.recent.delete(a.id);
          this.hints.delete(a.id);
          this.listener.remove(a.id);
          if (a.parentId) this.childGone(a.parentId, now);
        }
        continue;
      }
      if (a.status === 'arriving') {
        if (inState > ARRIVE_MS) this.set(a, pending ? 'working' : 'idle', pending ?? { activity: 'idle', kind: 'desk' }, now);
        continue;
      }
      if (pending && inState >= ZONE_DEBOUNCE_MS) {
        this.set(a, 'working', pending, now);
        continue;
      }
      if (a.status === 'done') {
        if (inState > t.doneHoldSec * 1000) this.set(a, 'idle', { activity: 'idle', kind: 'desk' }, now);
        continue;
      }
      if (a.status === 'blocked') continue; // waits for you, never wanders off
      if (quiet > t.staleAfterSec) {
        this.set(a, 'leaving', { activity: 'leaving', kind: 'door' }, now);
      } else if (quiet > t.chargeAfterSec && a.status !== 'charging') {
        this.set(a, 'charging', { activity: 'charging', kind: 'charging' }, now);
      } else if (quiet > t.breakAfterSec && a.status !== 'break' && a.status !== 'charging') {
        const someoneOnBreak = [...this.agents.values()].some((x) => x.id !== a.id && x.status === 'break');
        const plan: Plan = someoneOnBreak ? { activity: 'lounge', kind: 'lounge' } : { activity: 'coffee', kind: 'coffee' };
        this.set(a, 'break', plan, now);
      } else if (quiet > t.idleAfterSec && a.status === 'working') {
        this.set(a, 'idle', { activity: 'idle', kind: 'desk' }, now);
      }
    }
  }
}

function kindOf(spot: string | null): string | null {
  if (!spot) return null;
  if (spot.startsWith('desk-')) return 'desk';
  const id = spot.split('.')[0];
  return props.find((p) => p.id === id)?.kind ?? null;
}
