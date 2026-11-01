import { useEffect, useMemo, useState } from 'react';
import type { AgentState, AgentStatus, OfficeEvent, Role } from '@ai-office/shared';
import { connect, toggleSim, useOffice } from './store.ts';
import { modelLine } from './scene/layout.ts';

// Debug view (?debug): proves the hook → server → browser pipeline and shows raw state next to the office.

const ROLE_COLOR: Record<Role, string> = {
  lead: '#60A5FA',
  researcher: '#2DD4BF',
  architect: '#A78BFA',
  engineer: '#FB923C',
  qa: '#F87171',
  devops: '#4ADE80',
  designer: '#F472B6',
};

const STATUS: Record<AgentStatus, { label: string; color: string; icon: string }> = {
  arriving: { label: 'Arriving', color: 'text-muted', icon: '→' },
  working: { label: 'Working', color: 'text-accent', icon: '●' },
  blocked: { label: 'Blocked', color: 'text-warning', icon: '✋' },
  idle: { label: 'Idle', color: 'text-muted', icon: '◐' },
  break: { label: 'Break', color: 'text-muted', icon: '☕' },
  charging: { label: 'Charging', color: 'text-success', icon: '⚡' },
  done: { label: 'Done', color: 'text-success', icon: '✓' },
  leaving: { label: 'Leaving', color: 'text-muted', icon: '←' },
};

const ORDER: AgentStatus[] = ['blocked', 'working', 'arriving', 'done', 'idle', 'break', 'charging', 'leaving'];

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function ago(ts: number, now: number) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

export function DebugView() {
  useEffect(() => connect(), []);
  const { agents, events, sim, connection, retries } = useOffice();
  const now = useNow();
  const list = useMemo(
    () => Object.values(agents).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.startedAt - b.startedAt),
    [agents],
  );
  const count = (...s: AgentStatus[]) => list.filter((a) => s.includes(a.status)).length;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex min-h-12 flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-[#0b1220] px-4 py-1.5">
        <span className="font-display text-xl tracking-widest">AI OFFICE</span>
        <span className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-muted">debug view</span>
        <nav aria-label="Agent status counters" className="mx-auto flex flex-wrap gap-2 font-mono text-[13px] tabular-nums">
          <Counter n={count('working', 'arriving')} label="working" cls="text-accent" />
          <Counter n={count('blocked')} label="blocked" cls="text-warning" />
          <Counter n={count('idle', 'break', 'charging')} label="idle" cls="text-muted" />
          <Counter n={count('done')} label="done" cls="text-success" />
        </nav>
        <button
          onClick={() => toggleSim(!sim)}
          aria-pressed={sim}
          className={`h-8 cursor-pointer rounded-full border px-3 text-[13px] ${sim ? 'border-accent-2/60 bg-accent-2/10 text-[#f0abfc]' : 'border-border text-muted hover:text-text'}`}
        >
          {sim ? 'Stop demo' : 'Run demo'}
        </button>
      </header>

      {connection !== 'open' && (
        <div role="status" className="border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-[13px] text-warning">
          {connection === 'connecting' && retries === 0 ? 'Connecting to the office server…' : `Reconnecting… (${retries})`}
        </div>
      )}
      {sim && (
        <div className="bg-accent-2/15 px-4 py-1 font-mono text-[11px] tracking-widest text-[#f0abfc]">SIMULATION — these agents are fake</div>
      )}

      <main className="flex min-h-0 flex-1 flex-wrap">
        <section aria-label="Agents" className="min-w-0 flex-[999_1_640px] overflow-x-auto p-4">
          {list.length === 0 ? <Empty /> : <AgentTable list={list} now={now} />}
        </section>
        <aside aria-label="Activity" className="flex min-w-0 flex-[1_1_360px] flex-col border-l border-border bg-surface">
          <h2 className="m-0 border-b border-border px-4 py-3 text-sm font-semibold">
            <span className="text-muted">#</span> activity
          </h2>
          <EventLog events={events} agents={agents} now={now} />
        </aside>
      </main>
    </div>
  );
}

function Counter({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1">
      <span className={cls}>{n}</span>
      <span className="font-sans text-muted">{label}</span>
    </span>
  );
}

function Empty() {
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col gap-3 rounded-xl border border-border bg-surface p-6">
      <h1 className="m-0 text-lg font-semibold">Waiting for Claude Code…</h1>
      <p className="m-0 text-sm leading-relaxed text-muted">
        Install the hooks once, then start any Claude Code session. Robots appear here as soon as the first event arrives.
      </p>
      <code className="rounded-md border border-border bg-bg px-3 py-2 font-mono text-[13px] text-[#67e8f9]">npm run install-hooks</code>
      <button onClick={() => toggleSim(true)} className="mt-1 h-10 cursor-pointer self-start rounded-lg border border-accent-2/50 bg-accent-2/10 px-4 text-sm text-[#f0abfc]">
        Run demo instead
      </button>
    </div>
  );
}

function AgentTable({ list, now }: { list: AgentState[]; now: number }) {
  return (
    <table className="w-full border-collapse text-left text-[13px]">
      <thead className="font-mono text-[11px] tracking-wider text-muted">
        <tr className="border-b border-border">
          {['AGENT', 'PROJECT', 'MODEL', 'STATUS', 'ACTIVITY', 'SPOT', 'NOW', 'TOOLS', 'LAST'].map((h) => (
            <th key={h} className="px-2 py-2 font-medium">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {list.map((a) => {
          const st = STATUS[a.status];
          return (
            <tr key={a.id} className="border-b border-border/60 align-top">
              <td className="px-2 py-2">
                <div className="flex items-center gap-2">
                  <span className="size-2.5 rounded-sm" style={{ background: ROLE_COLOR[a.role] }} />
                  <span className="font-medium">{a.name}</span>
                </div>
                <div className="pl-[18px] font-mono text-[11px] text-muted">{a.agentType ?? 'main session'}{a.parentId ? ' · subagent' : ''}</div>
              </td>
              <td className="px-2 py-2 font-mono text-muted">{a.project}</td>
              <td className="px-2 py-2 font-mono text-muted" title={a.model}>{modelLine(a) || '—'}</td>
              <td className={`px-2 py-2 ${st.color}`}>
                <span aria-hidden>{st.icon}</span> {st.label}
              </td>
              <td className="px-2 py-2">{a.activity}</td>
              <td className="px-2 py-2 font-mono text-muted">{a.spot ?? '—'}</td>
              <td className="max-w-56 truncate px-2 py-2 font-mono" title={a.summary}>{a.tool ? `${a.tool} ${a.summary ?? ''}` : '—'}</td>
              <td className="px-2 py-2 font-mono text-muted tabular-nums">
                {a.counts.tools}
                {a.counts.failures > 0 && <span className="text-danger"> · {a.counts.failures}✕</span>}
              </td>
              <td className="px-2 py-2 font-mono text-muted tabular-nums">{ago(a.lastEventAt, now)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const KIND_STYLE: Partial<Record<OfficeEvent['kind'], string>> = {
  blocked: 'text-warning',
  tool_fail: 'text-danger',
  spawn: 'text-success',
  leave: 'text-muted',
  turn_done: 'text-success',
};

function EventLog({ events, agents, now }: { events: OfficeEvent[]; agents: Record<string, AgentState>; now: number }) {
  const shown = events.slice(-150).reverse();
  return (
    <ol role="log" aria-live="polite" className="m-0 flex-1 list-none overflow-y-auto p-0 font-mono text-[12px]">
      {shown.map((e) => (
        <li key={e.id} className="flex gap-2 border-b border-border/40 px-4 py-1.5">
          <span className="w-8 shrink-0 text-right text-muted tabular-nums">{ago(e.ts, now)}</span>
          <span className="w-24 shrink-0 truncate font-sans">{agents[e.agentId]?.name ?? e.agentType ?? 'agent'}</span>
          <span className={`w-20 shrink-0 ${KIND_STYLE[e.kind] ?? 'text-accent'}`}>{e.kind}</span>
          <span className="min-w-0 truncate text-muted">{e.tool ? `${e.tool} ${e.summary ?? ''}` : e.project}</span>
        </li>
      ))}
    </ol>
  );
}
