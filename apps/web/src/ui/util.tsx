import { useEffect, useMemo, useState } from 'react';
import type { AgentState, OfficeEvent } from '@ai-office/shared';
import { ROLE_COLOR, ROLE_INITIALS, statusGroup, type StatusGroup } from '../scene/layout.ts';
import { useOffice } from '../store.ts';
import { usePrefs, useUi } from './prefs.ts';

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const timeOfDay = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: !usePrefs.getState().clock24 });

/** Agents in roster order (lead first, then by arrival). */
export function useAgentList(): AgentState[] {
  const agents = useOffice((s) => s.agents);
  return useMemo(() => Object.values(agents).sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId) || a.startedAt - b.startedAt), [agents]);
}

/** Raw statuses in the order of the 1-8 keys. */
export const STATUS_KEYS = ['arriving', 'working', 'blocked', 'idle', 'break', 'charging', 'done', 'leaving'] as const;

/** Does the agent pass the roster filter (a status group or one raw status)? */
export function matchesFilter(a: AgentState, f: string | null): boolean {
  return !f || a.status === f || statusGroup(a) === f;
}

/** The roster: agents that pass the status filter. */
export function useFilteredAgents(): AgentState[] {
  const list = useAgentList();
  const filter = useUi((s) => s.filter);
  return useMemo(() => list.filter((a) => matchesFilter(a, filter)), [list, filter]);
}

export function useCounts(): Record<StatusGroup, number> & { doneToday: number } {
  const list = useAgentList();
  const doneToday = useOffice((s) => s.doneToday);
  return useMemo(() => {
    const c = { working: 0, idle: 0, blocked: 0, done: 0, doneToday };
    for (const a of list) c[statusGroup(a)]++;
    return c;
  }, [list, doneToday]);
}

export function Avatar({ a, size = 28 }: { a: Pick<AgentState, 'role'>; size?: number }) {
  const color = ROLE_COLOR[a.role];
  return (
    <span
      className="grid shrink-0 place-items-center rounded-md font-mono font-medium"
      style={{ width: size, height: size, fontSize: size * 0.38, background: color + '26', color, border: `1px solid ${color}66` }}
      aria-hidden="true"
    >
      {ROLE_INITIALS[a.role]}
    </span>
  );
}

const VERB: Record<string, [string, string]> = {
  Edit: ['EDIT', 'text-accent'],
  MultiEdit: ['EDIT', 'text-accent'],
  Write: ['WRITE', 'text-accent'],
  NotebookEdit: ['EDIT', 'text-accent'],
  Read: ['READ', 'text-success'],
  Grep: ['GREP', 'text-success'],
  Glob: ['GLOB', 'text-success'],
  Bash: ['BASH', 'text-[#FB923C]'],
  WebFetch: ['WEB', 'text-[#2DD4BF]'],
  WebSearch: ['SEARCH', 'text-[#2DD4BF]'],
  Task: ['TASK', 'text-[#A78BFA]'],
  Agent: ['AGENT', 'text-[#A78BFA]'],
  TodoWrite: ['TODO', 'text-[#A78BFA]'],
};

export function verb(tool?: string): [string, string] {
  if (!tool) return ['—', 'text-muted'];
  if (tool.startsWith('mcp__')) return ['MCP', 'text-[#2DD4BF]'];
  return VERB[tool] ?? [tool.slice(0, 6).toUpperCase(), 'text-muted'];
}

export function agentName(id: string | undefined, names: Record<string, string>, e?: OfficeEvent): string {
  if (id && names[id]) return names[id];
  // agents that left before this page loaded: main sessions are always the Lead Engineer
  if (!e?.parentAgentId) return 'Lead Engineer';
  return e.agentType ? `${e.agentType[0].toUpperCase()}${e.agentType.slice(1)} agent` : 'A subagent';
}

/** One readable line for #activity, or null for noise (tool_end etc.). */
export function describe(e: OfficeEvent, names: Record<string, string>): { text: string; tone: 'info' | 'warn' | 'fail' | 'done' } | null {
  const who = agentName(e.agentId, names, e);
  switch (e.kind) {
    case 'spawn':
      return { text: e.parentAgentId ? `${who} spawned by ${agentName(e.parentAgentId, names, { ...e, agentType: undefined, parentAgentId: undefined })} · ${e.project}` : `${who} started a session · ${e.project}`, tone: 'info' };
    case 'leave':
      return { text: `${who} left · ${e.project}`, tone: 'info' };
    case 'blocked':
      return { text: `${who} needs permission${e.tool ? ` · ${e.tool}` : ''}${e.summary ? ` → ${e.summary}` : ''}`, tone: 'warn' };
    case 'tool_fail':
      return { text: `${who} · ${e.tool ?? 'tool'}${e.summary ? ` ${e.summary}` : ''} failed`, tone: 'fail' };
    case 'turn_done':
      return { text: `${who} finished a turn · ${e.project}`, tone: 'done' };
    case 'prompt':
      return { text: `You briefed ${who} · ${e.project}`, tone: 'info' };
    case 'task_created':
      return { text: `${who} created a task`, tone: 'info' };
    case 'task_done':
      return { text: `${who} completed a task`, tone: 'done' };
    case 'compact':
      return { text: `${who} is compacting context`, tone: 'info' };
    default:
      return null;
  }
}
