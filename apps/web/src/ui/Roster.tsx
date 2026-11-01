import { chipLine, modelLine, statusGroup } from '../scene/layout.ts';
import { useOffice } from '../store.ts';
import { Icon } from './icons.tsx';
import { Avatar, useAgentList } from './util.tsx';

export function Roster() {
  const list = useAgentList();
  const selected = useOffice((s) => s.selected);

  return (
    <nav aria-label="Roster" className="flex min-h-[64px] items-center gap-2 overflow-x-auto border-t border-border bg-[#0b1220] px-4 py-2">
      <span className="mr-2 font-mono text-[11px] tracking-[0.1em] text-muted">ROSTER</span>
      {!list.length && <span className="text-[13px] text-muted">Nobody in the office yet.</span>}
      {list.map((a) => {
        const g = statusGroup(a);
        const isSel = a.id === selected;
        return (
          <button
            key={a.id}
            onClick={() => useOffice.getState().select(isSel ? null : a.id)}
            aria-pressed={isSel}
            className={`flex h-11 shrink-0 items-center gap-2 rounded-lg border px-2 pr-3 text-left ${
              g === 'blocked' ? 'border-warning/60 bg-warning/5' : isSel ? 'border-accent/70 bg-accent/8' : 'border-border hover:bg-surface-2'
            }`}
          >
            <Avatar a={a} />
            <span className="flex flex-col leading-tight">
              <span className="flex items-baseline gap-1.5">
                <span className="text-[13px] font-medium">{a.name}</span>
                {modelLine(a) && (
                  <span className="font-mono text-[10px] text-accent" title={a.model}>
                    {modelLine(a)}
                  </span>
                )}
              </span>
              <span className={`flex items-center gap-1 font-mono text-[11px] ${g === 'blocked' ? 'text-warning' : 'text-muted'}`}>
                {g === 'blocked' ? (
                  <Icon name="hand" size={11} />
                ) : g === 'done' ? (
                  <Icon name="check" size={11} className="text-success" />
                ) : (
                  <span className={`size-1.5 rounded-full ${g === 'working' ? 'bg-accent' : 'border border-muted'}`} />
                )}
                <span className="max-w-[120px] truncate">{chipLine(a)}</span>
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
