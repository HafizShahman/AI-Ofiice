import { useMemo } from 'react';
import { useOffice } from '../store.ts';
import { useUi } from './prefs.ts';
import { describe, timeOfDay, useCounts } from './util.tsx';

const TONE = { info: 'text-text/80', warn: 'text-warning', fail: 'text-danger', done: 'text-success' } as const;

/** UI-PLAN §3: wallboard mode for a second monitor. Big counters bottom-left, the latest three activity lines, Esc to leave. */
export function Wallboard() {
  const c = useCounts();
  const events = useOffice((s) => s.events);
  const names = useOffice((s) => s.names);
  const connection = useOffice((s) => s.connection);
  const last = useMemo(
    () =>
      events
        .map((e) => ({ e, d: describe(e, names) }))
        .filter((x) => x.d)
        .slice(-3),
    [events, names],
  );
  const stats: [number, string, string][] = [
    [c.working, 'Working', 'text-accent'],
    [c.idle, 'Idle', 'text-muted'],
    [c.blocked, 'Blocked', c.blocked ? 'text-warning' : 'text-muted'],
    [c.doneToday, 'Done today', 'text-success'],
  ];
  return (
    <>
      <div data-ui className="pointer-events-none absolute bottom-6 left-6 z-[1500] flex max-w-[min(640px,calc(100%-3rem))] flex-col gap-4 rounded-xl border border-border bg-[#070b14]/80 px-6 py-5">
        <dl className="flex flex-wrap gap-x-9 gap-y-2">
          {stats.map(([n, label, color]) => (
            <div key={label}>
              <dd className={`font-display text-[48px] leading-none tabular-nums ${color}`}>{n}</dd>
              <dt className="mt-1 text-[12px] uppercase tracking-[0.12em] text-muted">{label}</dt>
            </div>
          ))}
        </dl>
        <ul aria-label="Latest activity" aria-live="polite" className="flex flex-col gap-1 font-mono text-[13px]">
          {last.length === 0 && <li className="text-muted">Waiting for activity…</li>}
          {last.map(({ e, d }) => (
            <li key={e.id} className={`flex gap-3 ${TONE[d!.tone]}`}>
              <span className="shrink-0 text-muted tabular-nums">{timeOfDay(e.ts)}</span>
              <span className="min-w-0 truncate">{d!.text}</span>
            </li>
          ))}
        </ul>
      </div>
      <div data-ui className="absolute right-4 top-4 z-[1500] flex items-center gap-2">
        {connection !== 'open' && (
          <span role="status" className="rounded-md border border-warning/50 bg-[#070b14]/80 px-2 py-1 font-mono text-[11px] text-warning">
            {connection === 'connecting' ? 'connecting…' : 'server offline · retrying'}
          </span>
        )}
        <button onClick={() => useUi.getState().setWallboard(false)} className="rounded-md border border-border bg-[#070b14]/70 px-2.5 py-1 font-mono text-[11px] text-muted opacity-60 hover:opacity-100">
          Esc to exit
        </button>
      </div>
    </>
  );
}
