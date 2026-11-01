import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentState, ChatMessage, OfficeEvent } from '@ai-office/shared';
import { activityLine, ROLE_COLOR, statusGroup, STATUS_COLOR } from '../scene/layout.ts';
import { sendChat, setAi, useOffice } from '../store.ts';
import { Icon } from './icons.tsx';
import { Rich } from './Rich.tsx';
import { Avatar, describe, timeOfDay, useAgentList, verb } from './util.tsx';

const TONE = {
  info: 'text-muted',
  warn: 'border border-warning/30 bg-warning/8 text-warning',
  fail: 'border border-danger/30 bg-danger/8 text-danger',
  done: 'text-success',
  ok: 'text-success',
} as const;

const COMMANDS = [
  ['/status', 'office summary'],
  ['/agents', 'who is here'],
  ['/who ', 'find by role or name'],
  ['/ai on', 'turn the Office Manager on'],
  ['/ai off', 'turn it off'],
  ['/sim', 'start or stop the demo'],
  ['/clear', 'clear this channel'],
  ['/help', 'all commands'],
] as const;

/** Channels (#office, #activity), one DM per robot, and the composer. UI-PLAN §4 / PLAN §10. */
export function SidePanel() {
  const channel = useOffice((s) => s.channel);
  const unread = useOffice((s) => s.unread);
  const events = useOffice((s) => s.events);
  const list = useAgentList();
  const dmAgent = useOffice((s) => (channel.startsWith('dm:') ? s.agents[channel.slice(3)] : undefined));
  const dmName = useOffice((s) => (channel.startsWith('dm:') ? s.names[channel.slice(3)] : undefined));
  const open = (c: string) => useOffice.getState().openChannel(c);
  const activityCount = useMemo(() => events.filter((e) => e.kind !== 'tool_end' && e.kind !== 'tool_start').length, [events]);

  return (
    <aside aria-label="Chat" className="flex min-h-0 w-[430px] shrink-0 border-l border-border bg-[#0b1220] max-[1280px]:w-[320px]">
      <nav className="flex w-[140px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2 text-[13px] max-[1280px]:hidden">
        <div className="px-2 pb-1 pt-2 font-mono text-[11px] tracking-[0.1em] text-muted">CHANNELS</div>
        <ChannelBtn active={channel === 'office'} onClick={() => open('office')} label="# office" count={unread.office} />
        <ChannelBtn active={channel === 'activity'} onClick={() => open('activity')} label="# activity" count={activityCount} muted />
        <div className="px-2 pb-1 pt-4 font-mono text-[11px] tracking-[0.1em] text-muted">AGENTS</div>
        {list.map((a) => (
          <ChannelBtn
            key={a.id}
            active={channel === `dm:${a.id}`}
            onClick={() => {
              open(`dm:${a.id}`);
              useOffice.getState().select(a.id);
            }}
            label={handle(a)}
            dot={STATUS_COLOR[statusGroup(a)]}
            count={unread[`dm:${a.id}`]}
          />
        ))}
        {!list.length && <span className="px-2 text-[12px] text-muted">none yet</span>}
      </nav>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          {channel === 'office' ? (
            <>
              <span className="text-[15px] font-semibold">
                <span className="text-muted">#</span> office
              </span>
              <span className="truncate text-[12px] text-muted">Ask the Office Manager</span>
            </>
          ) : channel === 'activity' ? (
            <>
              <span className="text-[15px] font-semibold">
                <span className="text-muted">#</span> activity
              </span>
              <span className="truncate text-[12px] text-muted">What the office is doing</span>
            </>
          ) : (
            <>
              {dmAgent && <Avatar a={dmAgent} size={22} />}
              <span className="truncate text-[15px] font-semibold">{dmAgent?.name ?? dmName ?? 'Agent'}</span>
              {dmAgent ? (
                <span className="truncate font-mono text-[11px]" style={{ color: STATUS_COLOR[statusGroup(dmAgent)] }}>
                  {activityLine(dmAgent)}
                </span>
              ) : (
                <span className="text-[12px] text-muted">left the office</span>
              )}
            </>
          )}
          <select
            aria-label="Channel"
            value={channel}
            onChange={(e) => open(e.target.value)}
            className="ml-auto rounded border border-border bg-surface px-1 text-[12px] min-[1281px]:hidden"
          >
            <option value="office"># office</option>
            <option value="activity"># activity</option>
            {list.map((a) => (
              <option key={a.id} value={`dm:${a.id}`}>
                {handle(a)}
              </option>
            ))}
          </select>
        </header>

        {channel === 'activity' ? <ActivityFeed /> : <Conversation channel={channel} agent={dmAgent} />}
        {channel !== 'activity' && <Composer channel={channel} agent={dmAgent} />}
      </section>
    </aside>
  );
}

const handle = (a: AgentState) => '@' + a.name.toLowerCase().replace(/\s+#?/g, '-');

function ChannelBtn(p: { active: boolean; onClick: () => void; label: string; count?: number; dot?: string; muted?: boolean }) {
  return (
    <button
      onClick={p.onClick}
      aria-current={p.active}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${p.active ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`}
    >
      {p.dot && <span className="size-1.5 shrink-0 rounded-full" style={{ background: p.dot }} />}
      <span className="min-w-0 flex-1 truncate">{p.label}</span>
      {!!p.count && (
        <span className={`rounded-full px-1.5 font-mono text-[11px] ${p.muted ? 'bg-surface-2 text-muted' : 'bg-accent/20 text-accent'}`}>{p.count > 99 ? '99+' : p.count}</span>
      )}
    </button>
  );
}

// ── #activity ─────────────────────────────────────────────────────────────

function ActivityFeed() {
  const names = useOffice((s) => s.names);
  const events = useOffice((s) => s.events);
  const feed = useMemo(
    () =>
      events
        .map((e) => ({ e, d: describe(e, names) }))
        .filter((x) => x.d)
        .slice(-200),
    [events, names],
  );
  const end = useStickToBottom(feed.length);
  return (
    <div role="log" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {!feed.length && <p className="mt-6 text-center text-[13px] text-muted">Nothing yet. Start a Claude Code session or run the demo.</p>}
      {feed.map(({ e, d }) => (
        <button
          key={e.id}
          onClick={() => useOffice.getState().agents[e.agentId] && useOffice.getState().select(e.agentId)}
          className={`my-1 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] leading-snug hover:bg-surface-2/60 ${TONE[d!.tone]}`}
        >
          <span className="min-w-0 flex-1">{d!.text}</span>
          <span className="shrink-0 font-mono text-[11px] text-muted tabular-nums">{timeOfDay(e.ts)}</span>
        </button>
      ))}
      <div ref={end} />
    </div>
  );
}

function useStickToBottom(dep: unknown) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' }); // braces: newer Chromium returns a Promise here
  }, [dep]);
  return end;
}

// ── #office and DMs ───────────────────────────────────────────────────────

type Row = { kind: 'msg'; ts: number; m: ChatMessage } | { kind: 'event'; ts: number; e: OfficeEvent };

const TIMELINE_KINDS = new Set<OfficeEvent['kind']>(['spawn', 'tool_start', 'tool_fail', 'blocked', 'turn_done', 'leave', 'prompt']);

function Conversation({ channel, agent }: { channel: string; agent?: AgentState }) {
  const msgs = useOffice((s) => s.chat[channel]);
  const typing = useOffice((s) => s.typing[channel]);
  const ai = useOffice((s) => s.ai);
  const live = useOffice((s) => s.events);
  const dmId = channel.startsWith('dm:') ? channel.slice(3) : null;

  // a DM also shows that agent's own timeline
  const [past, setPast] = useState<OfficeEvent[]>([]);
  useEffect(() => {
    setPast([]);
    if (!dmId) return;
    let stale = false;
    fetch(`/api/events?agent=${encodeURIComponent(dmId)}&limit=80`)
      .then((r) => (r.ok ? r.json() : []))
      .then((ev: OfficeEvent[]) => !stale && setPast(ev));
    return () => {
      stale = true;
    };
  }, [dmId]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = (msgs ?? []).map((m) => ({ kind: 'msg', ts: m.ts, m }));
    if (dmId) {
      const seen = new Set(past.map((e) => e.id));
      const evs = [...past, ...live.filter((e) => e.agentId === dmId && !seen.has(e.id))].filter((e) => TIMELINE_KINDS.has(e.kind));
      out.push(...evs.map((e) => ({ kind: 'event' as const, ts: e.ts, e })));
    }
    return out.sort((a, b) => a.ts - b.ts).slice(-300);
  }, [msgs, past, live, dmId]);

  const end = useStickToBottom(`${rows.length}:${typing ? 1 : 0}:${rows.at(-1)?.ts ?? 0}`);
  let lastDay = '';

  return (
    <div role="log" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {msgs === undefined && <p className="mt-6 text-center text-[13px] text-muted">Loading…</p>}
      {msgs !== undefined && !rows.length && <EmptyChat channel={channel} agent={agent} aiOn={ai.enabled} />}
      {rows.map((r) => {
        const day = new Date(r.ts).toDateString();
        const sep =
          day !== lastDay ? (
            <div key={'d' + r.ts} className="my-3 flex items-center gap-2 font-mono text-[11px] tracking-[0.1em] text-muted">
              <span className="h-px flex-1 bg-border" />
              {day === new Date().toDateString() ? 'TODAY' : new Date(r.ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()}
              <span className="h-px flex-1 bg-border" />
            </div>
          ) : null;
        lastDay = day;
        return (
          <div key={r.kind === 'msg' ? 'm' + r.m.id : 'e' + r.e.id}>
            {sep}
            {r.kind === 'msg' ? <Message m={r.m} /> : <TimelineRow e={r.e} />}
          </div>
        );
      })}
      {typing && (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-muted">
          <span className="flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1.5 animate-[pulse-dot_1.2s_infinite] rounded-full bg-accent-2" style={{ animationDelay: `${i * 0.2}s` }} />
            ))}
          </span>
          {agent ? `${agent.name} is thinking…` : 'Office Manager is thinking…'}
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

function EmptyChat({ channel, agent, aiOn }: { channel: string; agent?: AgentState; aiOn: boolean }) {
  return (
    <div className="mt-8 flex flex-col items-center gap-2 px-4 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-accent-2/12 text-accent-2">
        <Icon name="sparkle" size={18} />
      </span>
      {channel === 'office' ? (
        <>
          <p className="text-[14px] font-medium">Ask the Office Manager</p>
          <p className="text-[13px] leading-normal text-muted">
            “who’s stuck?”, “what changed in the last hour?”, “summarize today”.{' '}
            {aiOn ? 'Answers come from the agents’ recent events.' : 'It’s off right now: try /status, or /ai on.'}
          </p>
        </>
      ) : (
        <>
          <p className="text-[14px] font-medium">{agent ? `Talk to ${agent.name}` : 'This agent has left'}</p>
          <p className="text-[13px] leading-normal text-muted">Its timeline shows up here. Questions are answered by the Office Manager speaking as this agent, from its events.</p>
        </>
      )}
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  if (m.author === 'you')
    return (
      <div className="my-2 flex flex-col items-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[10px] rounded-br-sm border border-border bg-surface-2 px-3 py-2 text-[13.5px] leading-normal">
          <Rich text={m.body} />
        </div>
        <span className="mt-0.5 font-mono text-[11px] text-muted">You · {timeOfDay(m.ts)}</span>
      </div>
    );
  if (m.author === 'system')
    return (
      <div className={`my-2 flex items-start gap-2 rounded-md px-2.5 py-2 text-[12.5px] leading-snug ${m.tone && m.tone !== 'info' ? TONE[m.tone] : 'border border-border bg-surface text-text'}`}>
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          <Rich text={m.body} />
        </div>
        <span className="shrink-0 font-mono text-[11px] text-muted tabular-nums">{timeOfDay(m.ts)}</span>
      </div>
    );
  const agent = useOffice.getState().agents[m.agentId ?? ''];
  return (
    <div className="my-2.5 flex gap-2.5">
      {m.author === 'agent' && agent ? (
        <Avatar a={agent} size={26} />
      ) : (
        <span className="grid size-[26px] shrink-0 place-items-center rounded-md bg-accent-2/15 text-accent-2" style={m.author === 'agent' ? { color: ROLE_COLOR.lead } : undefined}>
          <Icon name="sparkle" size={14} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold">{m.author === 'agent' ? m.name : 'Office Manager'}</span>
          <span className="rounded bg-accent-2/15 px-1 font-mono text-[10px] text-accent-2" title="Written by the AI Office Manager from the office's events">
            AI
          </span>
          <span className="font-mono text-[11px] text-muted">{timeOfDay(m.ts)}</span>
        </div>
        <div className="mt-0.5 whitespace-pre-wrap break-words text-[13.5px] leading-normal">
          <Rich text={m.body} />
        </div>
      </div>
    </div>
  );
}

function TimelineRow({ e }: { e: OfficeEvent }) {
  const [v, cls] =
    e.kind === 'tool_start'
      ? verb(e.tool)
      : ({ spawn: ['IN', 'text-muted'], leave: ['OUT', 'text-muted'], blocked: ['ASK', 'text-warning'], tool_fail: ['FAIL', 'text-danger'], turn_done: ['DONE', 'text-success'], prompt: ['YOU', 'text-accent-2'] } as Record<string, [string, string]>)[e.kind] ?? ['·', 'text-muted'];
  const text =
    e.kind === 'spawn' ? 'arrived' : e.kind === 'leave' ? 'left' : e.kind === 'turn_done' ? 'finished a turn' : e.kind === 'prompt' ? 'you sent a prompt' : (e.summary ?? e.tool ?? '');
  return (
    <div className="flex items-center gap-2 py-0.5 font-mono text-[11.5px]">
      <span className={`w-12 shrink-0 ${cls}`}>{v}</span>
      <span className="min-w-0 flex-1 truncate text-muted">{e.kind === 'tool_fail' || e.kind === 'blocked' ? `${e.tool ?? ''} ${text}`.trim() : text}</span>
      <span className="shrink-0 text-muted/70 tabular-nums">{timeOfDay(e.ts)}</span>
    </div>
  );
}

// ── composer ──────────────────────────────────────────────────────────────

function Composer({ channel, agent }: { channel: string; agent?: AgentState }) {
  const [text, setText] = useState('');
  const [pick, setPick] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const ai = useOffice((s) => s.ai);
  const focusTick = useOffice((s) => s.focusTick);
  useEffect(() => {
    if (focusTick) ref.current?.focus();
  }, [focusTick]);

  const suggestions = text.startsWith('/') && !text.includes('\n') ? COMMANDS.filter(([c]) => c.startsWith(text.split(' ')[0]) && c !== text) : [];
  const send = () => {
    const body = text.trim();
    if (!body) return;
    void sendChat(channel, body);
    setText('');
  };
  const placeholder =
    channel === 'office'
      ? ai.enabled
        ? 'Message #office — / for commands'
        : 'AI is off · /status, /agents, /ai on'
      : agent
        ? `Ask ${agent.name}…`
        : 'This agent has left';

  return (
    <div className="relative shrink-0 border-t border-border p-3">
      {suggestions.length > 0 && (
        <ul className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-[10px] border border-border bg-surface py-1 shadow-[0_8px_24px_rgb(0_0_0/.45)]">
          {suggestions.map(([c, d], i) => (
            <li key={c}>
              <button
                className={`flex w-full gap-3 px-3 py-1.5 text-left text-[12.5px] ${i === pick % suggestions.length ? 'bg-surface-2' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(c);
                  ref.current?.focus();
                }}
              >
                <span className="font-mono text-accent">{c.trim()}</span>
                <span className="text-muted">{d}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 focus-within:border-accent/60">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={channel !== 'office' && !agent}
          placeholder={placeholder}
          aria-label={`Message ${channel === 'office' ? '#office' : (agent?.name ?? 'agent')}`}
          onChange={(e) => {
            setText(e.target.value);
            setPick(0);
          }}
          onKeyDown={(e) => {
            if (suggestions.length && (e.key === 'Tab' || ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !text.includes(' ')))) {
              e.preventDefault();
              if (e.key === 'Tab') setText(suggestions[pick % suggestions.length][0]);
              else setPick((p) => p + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1));
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
            if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
          }}
          className="max-h-28 min-h-[22px] flex-1 resize-none bg-transparent focus-visible:outline-none text-[13.5px] leading-normal outline-none placeholder:text-muted [field-sizing:content] disabled:opacity-50"
        />
        <button
          aria-label="Send"
          onClick={send}
          disabled={!text.trim()}
          className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-[#04131a] disabled:bg-surface-2 disabled:text-muted"
        >
          <Icon name="send" size={15} />
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted">
        <span>Enter to send · Shift+Enter new line</span>
        {channel === 'office' && (
          <button onClick={() => void setAi(!ai.enabled)} className="hover:text-text" title={ai.available === false ? 'The claude command was not found on the server machine' : undefined}>
            AI {ai.enabled ? `on · ${ai.model}` : 'off'}
            {ai.enabled && ai.available === false ? ' · claude not found' : ''}
          </button>
        )}
      </div>
    </div>
  );
}
