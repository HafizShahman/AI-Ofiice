import { useMemo } from 'react';
import { activityLine, statusGroup, STATUS_COLOR } from '../scene/layout.ts';
import { useOffice } from '../store.ts';
import { Icon } from './icons.tsx';
import { ago, Avatar, clock, useNow, verb } from './util.tsx';

const STATUS_LABEL = { working: 'Working', idle: 'Idle', blocked: 'Blocked', done: 'Done' } as const;

export function Inspector() {
  const id = useOffice((s) => s.selected);
  const a = useOffice((s) => (s.selected ? s.agents[s.selected] : undefined));
  const parent = useOffice((s) => (a?.parentId ? s.agents[a.parentId] : undefined));
  const events = useOffice((s) => s.events);
  const following = useOffice((s) => s.following);
  const now = useNow();
  const recent = useMemo(() => events.filter((e) => e.agentId === id && e.kind === 'tool_start').slice(-4).reverse(), [events, id]);
  if (!a) return null;
  const g = statusGroup(a);

  return (
    <aside
      data-ui
      aria-label={`${a.name} details`}
      className="absolute right-4 top-4 w-[320px] overflow-hidden rounded-[10px] border border-border bg-surface/97 shadow-[0_8px_24px_rgb(0_0_0/.45)]"
    >
      <header className="flex items-start gap-3 border-b border-border p-3.5">
        <Avatar a={a} size={32} />
        <div className="min-w-0 flex-1 leading-snug">
          <div className="truncate text-[14px] font-semibold">{a.name}</div>
          <div className="truncate text-[12px] text-muted">
            {parent ? `Subagent of ${parent.name}` : a.parentId ? 'Subagent' : 'Main session'} · {a.project}
          </div>
          <div className="font-mono text-[11px] text-muted tabular-nums">
            {a.counts.tools} tools · {a.counts.edits} edits{a.counts.failures ? ` · ${a.counts.failures} failed` : ''} · {ago(a.startedAt, now)}
          </div>
        </div>
        <span
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[12px]"
          style={{ color: STATUS_COLOR[g], borderColor: STATUS_COLOR[g] + '99' }}
        >
          {g === 'blocked' ? <Icon name="hand" size={11} /> : <span className="size-1.5 rounded-full" style={{ background: STATUS_COLOR[g] }} />}
          {STATUS_LABEL[g]}
        </span>
        <button aria-label="Close" className="grid size-6 shrink-0 place-items-center rounded text-muted hover:text-text" onClick={() => useOffice.getState().select(null)}>
          <Icon name="x" />
        </button>
      </header>

      <div className="border-b border-border px-3.5 py-3">
        <div className="font-mono text-[11px] tracking-[0.1em] text-muted">NOW</div>
        <div className="mt-1 flex items-baseline justify-between gap-2 font-mono text-[13px]">
          <span className={`truncate ${g === 'blocked' ? 'text-warning' : ''}`}>{activityLine(a)}</span>
          <span className="shrink-0 text-muted tabular-nums">{clock(now - a.statusSince)}</span>
        </div>
      </div>

      {recent.length > 0 && (
        <ul className="border-b border-border px-3.5 py-2 font-mono text-[12px]">
          {recent.map((e) => {
            const [v, cls] = verb(e.tool);
            return (
              <li key={e.id} className="flex items-center gap-3 py-1">
                <span className={`w-12 shrink-0 ${cls}`}>{v}</span>
                <span className="min-w-0 flex-1 truncate">{e.summary ?? e.tool}</span>
                <span className="shrink-0 text-muted">{ago(e.ts, now)}</span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex gap-2 p-3">
        <button
          onClick={() => useOffice.getState().openChannel(`dm:${a.id}`, true)}
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent text-[13px] font-medium text-[#04131a] hover:bg-[#67e8f9]"
        >
          <Icon name="message" /> Open DM
        </button>
        <button
          aria-pressed={following}
          onClick={() => useOffice.getState().setFollowing(!following)}
          className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border text-[13px] ${following ? 'border-accent/70 bg-accent/10 text-accent' : 'border-border hover:bg-surface-2'}`}
        >
          <Icon name="eye" /> {following ? 'Following' : 'Follow'}
        </button>
      </div>
    </aside>
  );
}

export function BlockedToast() {
  const agents = useOffice((s) => s.agents);
  const blocked = useMemo(() => Object.values(agents).filter((a) => a.status === 'blocked'), [agents]);
  const selected = useOffice((s) => s.selected);
  const first = blocked[0];
  if (!first) return null;
  return (
    <div
      data-ui
      role="alert"
      className="absolute left-4 top-4 flex w-[320px] items-start gap-2.5 rounded-[10px] border border-warning/60 bg-surface p-3 shadow-[0_8px_24px_rgb(0_0_0/.45),0_0_14px_rgb(251_191_36/.2)]"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-warning/14 text-warning">
        <Icon name="hand" size={16} />
      </span>
      <div className="min-w-0 flex-1 leading-snug">
        <div className="text-[13px] font-semibold">
          {first.name} needs permission{blocked.length > 1 ? ` (+${blocked.length - 1})` : ''}
        </div>
        <div className="truncate font-mono text-[12px] text-muted">
          {first.tool ?? 'tool'}
          {first.summary ? ` → ${first.summary}` : ''}
        </div>
      </div>
      {selected !== first.id && (
        <button className="h-7 shrink-0 rounded-md border border-warning/50 px-2.5 text-[12px] text-warning hover:bg-warning/10" onClick={() => useOffice.getState().select(first.id)}>
          Show
        </button>
      )}
    </div>
  );
}
