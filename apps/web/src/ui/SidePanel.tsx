import { useEffect, useMemo, useRef, useState } from 'react';
import { statusGroup, STATUS_COLOR } from '../scene/layout.ts';
import { useOffice } from '../store.ts';
import { Icon } from './icons.tsx';
import { describe, timeOfDay, useAgentList } from './util.tsx';

type Channel = 'activity' | 'office';

const TONE = {
  info: 'text-muted',
  warn: 'border border-warning/30 bg-warning/8 text-warning',
  fail: 'border border-danger/30 bg-danger/8 text-danger',
  done: 'text-success',
} as const;

/** Channels + #activity feed. #office (the AI Office Manager chat) arrives in P3. */
export function SidePanel() {
  const [channel, setChannel] = useState<Channel>('activity');
  const names = useOffice((s) => s.names);
  const events = useOffice((s) => s.events);
  const list = useAgentList();
  const feed = useMemo(
    () =>
      events
        .map((e) => ({ e, d: describe(e, names) }))
        .filter((x) => x.d)
        .slice(-200),
    [events, names],
  );
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' }); // newer Chromium returns a Promise here; keep it out of the effect's return
  }, [feed.length, channel]);

  return (
    <aside aria-label="Channels" className="flex min-h-0 w-[400px] shrink-0 border-l border-border bg-[#0b1220] max-[1280px]:w-[300px]">
      <nav className="flex w-[140px] shrink-0 flex-col gap-0.5 border-r border-border p-2 text-[13px] max-[1280px]:hidden">
        <div className="px-2 pb-1 pt-2 font-mono text-[11px] tracking-[0.1em] text-muted">CHANNELS</div>
        <ChannelBtn active={channel === 'office'} onClick={() => setChannel('office')} label="office" />
        <ChannelBtn active={channel === 'activity'} onClick={() => setChannel('activity')} label="activity" count={feed.length} />
        <div className="px-2 pb-1 pt-4 font-mono text-[11px] tracking-[0.1em] text-muted">AGENTS</div>
        {list.map((a) => (
          <button key={a.id} onClick={() => useOffice.getState().select(a.id)} className="flex items-center gap-2 truncate rounded-md px-2 py-1 text-left text-muted hover:bg-surface-2 hover:text-text">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[statusGroup(a)] }} />
            <span className="truncate">@{a.name.toLowerCase().replace(/\s+/g, '-').replace('#', '')}</span>
          </button>
        ))}
        {!list.length && <span className="px-2 text-[12px] text-muted">none yet</span>}
      </nav>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="text-[15px] font-semibold">
            <span className="text-muted">#</span> {channel}
          </span>
          <span className="truncate text-[12px] text-muted">{channel === 'activity' ? 'What the office is doing' : 'Ask the Office Manager'}</span>
          <span className="ml-auto flex gap-1 min-[1281px]:hidden">
            {(['activity', 'office'] as const).map((c) => (
              <button key={c} onClick={() => setChannel(c)} className={`rounded px-1.5 text-[12px] ${c === channel ? 'bg-surface-2 text-text' : 'text-muted'}`}>
                #{c}
              </button>
            ))}
          </span>
        </header>

        {channel === 'activity' ? (
          <div role="log" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {!feed.length && <p className="mt-6 text-center text-[13px] text-muted">Nothing yet. Start a Claude Code session or run the demo.</p>}
            {feed.map(({ e, d }) => (
              <div key={e.id} className={`my-1 flex items-start gap-2 rounded-md px-2 py-1.5 text-[12.5px] leading-snug ${TONE[d!.tone]}`}>
                <span className="min-w-0 flex-1">{d!.text}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted tabular-nums">{timeOfDay(e.ts)}</span>
              </div>
            ))}
            <div ref={end} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="grid size-10 place-items-center rounded-full bg-accent-2/12 text-accent-2">
              <Icon name="sparkle" size={18} />
            </span>
            <p className="text-[14px] font-medium">The Office Manager is not hired yet</p>
            <p className="text-[13px] leading-normal text-muted">Ask “who’s stuck?” or “what changed in the last hour?” here once the AI chat lands (P3). Until then, #activity has the raw feed.</p>
          </div>
        )}

        <div className="shrink-0 border-t border-border p-3">
          <div className="flex items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-muted">
            <span className="flex-1">{channel === 'office' ? 'Message #office — coming in P3' : 'Read-only feed'}</span>
            <Icon name="hash" />
          </div>
        </div>
      </section>
    </aside>
  );
}

function ChannelBtn({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button onClick={onClick} aria-current={active} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${active ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`}>
      <span className="text-muted">#</span>
      <span className="flex-1">{label}</span>
      {!!count && <span className="rounded-full bg-accent/20 px-1.5 font-mono text-[11px] text-accent">{count > 99 ? '99+' : count}</span>}
    </button>
  );
}
