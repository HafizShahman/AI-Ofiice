import { Fragment, type ReactNode } from 'react';
import type { AgentState } from '@ai-office/shared';
import { useOffice } from '../store.ts';

/**
 * Tiny, safe formatter for chat text: `code`, **bold**, line breaks, and agent names turned
 * into buttons that select that robot. React escapes everything else.
 */
export function Rich({ text }: { text: string }) {
  const agents = useOffice((s) => s.agents);
  return <>{format(text, Object.values(agents))}</>;
}

function format(text: string, agents: AgentState[]): ReactNode[] {
  const out: ReactNode[] = [];
  // split on `code` and **bold** spans
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(...names(text.slice(last, m.index), agents, k++));
    if (m[1] != null)
      out.push(
        <code key={`c${k++}`} className="rounded bg-[#070b14] px-1 py-px font-mono text-[12px] text-[#67e8f9]">
          {m[1]}
        </code>,
      );
    else out.push(<strong key={`b${k++}`}>{names(m[2], agents, k++)}</strong>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(...names(text.slice(last), agents, k++));
  return out;
}

function names(text: string, agents: AgentState[], key: number): ReactNode[] {
  if (!agents.length) return [<Fragment key={key}>{text}</Fragment>];
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
  const re = new RegExp(`(${sorted.map((a) => a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w#])`, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const a = sorted.find((x) => x.name === m![1])!;
    if (m.index > last) out.push(<Fragment key={`${key}-t${i++}`}>{text.slice(last, m.index)}</Fragment>);
    out.push(
      <button key={`${key}-a${i++}`} className="rounded px-0.5 font-medium text-accent hover:bg-accent/10" onClick={() => useOffice.getState().select(a.id)} title="Show in the office">
        {m[1]}
      </button>,
    );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<Fragment key={`${key}-t${i++}`}>{text.slice(last)}</Fragment>);
  return out;
}
