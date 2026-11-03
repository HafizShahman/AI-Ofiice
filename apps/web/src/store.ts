import { create } from 'zustand';
import type { AgentState, AiState, Approval, BoardItem, DispatchState, ChatMessage, OfficeEvent, ServerMessage } from '@ai-office/shared';

export type Connection = 'connecting' | 'open' | 'closed';

interface OfficeStore {
  connection: Connection;
  retries: number;
  /** bumped on every snapshot, so a listener can tell a re-sync from live changes */
  epoch: number;
  agents: Record<string, AgentState>;
  /** every agent name seen this session, so #activity can name agents that already left */
  names: Record<string, string>;
  events: OfficeEvent[];
  sim: boolean;
  /** selected agent id (mirrored to ?agent=) */
  selected: string | null;
  following: boolean;
  chatOpen: boolean;
  ai: AiState;
  doneToday: number;
  approvalsOn: boolean;
  approvalWaitSec: number;
  /** open permission requests by id */
  approvals: Record<string, Approval>;
  dispatch: DispatchState;
  /** the mission board's notes */
  board: BoardItem[];
  /** counts up each time a note is handed to the CEO to pin (the CEO walks to the board) */
  pinTick: number;
  /** side-panel channel: "activity", "office" or "dm:<agentId>" */
  channel: string;
  chat: Record<string, ChatMessage[]>;
  typing: Record<string, boolean>;
  unread: Record<string, number>;
  /** bumped to ask the composer to take focus ("/" key, Open DM) */
  focusTick: number;
  apply(msgs: ServerMessage[]): void;
  openChannel(channel: string, focus?: boolean): void;
  setHistory(channel: string, msgs: ChatMessage[]): void;
  select(id: string | null): void;
  setFollowing(on: boolean): void;
  toggleChat(): void;
  setConnection(c: Connection, retries?: number): void;
}

const MAX_EVENTS = 300;

/** `?channel=activity|office|dm:<agentId>` deep link (the channel is mirrored back to the URL). */
const linkedChannel = new URLSearchParams(location.search).get('channel');

export const useOffice = create<OfficeStore>((set) => ({
  connection: 'connecting',
  retries: 0,
  epoch: 0,
  agents: {},
  names: {},
  events: [],
  sim: false,
  selected: new URLSearchParams(location.search).get('agent'),
  following: false,
  chatOpen: true,
  ai: { enabled: false, model: 'haiku', contextEvents: 30, available: null },
  doneToday: 0,
  approvalsOn: false,
  approvalWaitSec: 45,
  approvals: {},
  board: [],
  pinTick: 0,
  dispatch: { enabled: false, mode: 'plan', projects: [], last: null, running: [], available: null },
  channel: linkedChannel && /^(activity|office|dm:.+)$/.test(linkedChannel) ? linkedChannel : 'office',
  chat: {},
  typing: {},
  unread: {},
  focusTick: 0,
  openChannel: (channel, focus = false) => {
    const url = new URL(location.href);
    if (channel === 'office') url.searchParams.delete('channel');
    else url.searchParams.set('channel', channel);
    history.replaceState(null, '', url);
    set((s) => ({ channel, chatOpen: true, unread: { ...s.unread, [channel]: 0 }, focusTick: focus ? s.focusTick + 1 : s.focusTick }));
    if (channel !== 'activity' && !useOffice.getState().chat[channel]) void loadChannel(channel);
  },
  setHistory: (channel, msgs) => set((s) => ({ chat: { ...s.chat, [channel]: msgs } })),
  select: (selected) => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set('agent', selected);
    else url.searchParams.delete('agent');
    history.replaceState(null, '', url);
    set({ selected, following: false });
  },
  setFollowing: (following) => set({ following }),
  toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
  setConnection: (connection, retries = 0) => set({ connection, retries }),
  // one store update per server batch, so event bursts don't cause a render per event
  apply: (msgs) =>
    set((s) => {
      let { agents, events, sim, names, ai, doneToday, chat, typing, unread, approvals, approvalsOn, approvalWaitSec, dispatch, board, pinTick } = s;
      let { epoch } = s;
      let reload = false;
      for (const m of msgs) {
        if (m.type === 'snapshot') {
          epoch++;
          agents = Object.fromEntries(m.state.agents.map((a) => [a.id, a]));
          names = { ...names, ...Object.fromEntries(m.state.agents.map((a) => [a.id, a.name])) };
          events = m.state.events;
          sim = m.state.sim;
          ai = m.state.ai;
          doneToday = m.state.doneToday;
          dispatch = m.state.dispatch;
          board = m.state.board;
          approvalsOn = m.state.approvals.enabled;
          approvalWaitSec = m.state.approvals.waitSec;
          approvals = Object.fromEntries(m.state.approvals.pending.map((a) => [a.id, a]));
          chat = {}; // (re)connected: history is re-read from the server
          typing = {};
          reload = true;
        } else if (m.type === 'agent') {
          agents = { ...agents, [m.agent.id]: m.agent };
          if (names[m.agent.id] !== m.agent.name) names = { ...names, [m.agent.id]: m.agent.name };
        } else if (m.type === 'agent.remove') {
          const { [m.id]: _gone, ...rest } = agents;
          agents = rest;
        } else if (m.type === 'event') {
          events = [...events, m.event].slice(-MAX_EVENTS);
          if (m.event.kind === 'turn_done') doneToday++;
        } else if (m.type === 'sim') {
          sim = m.on;
        } else if (m.type === 'ai') {
          ai = m.ai;
        } else if (m.type === 'board') {
          board = m.items;
        } else if (m.type === 'board.pin') {
          pinTick++;
        } else if (m.type === 'dispatch') {
          dispatch = m.dispatch;
        } else if (m.type === 'approvals') {
          approvalsOn = m.enabled;
          approvalWaitSec = m.waitSec;
        } else if (m.type === 'approval') {
          approvals = { ...approvals, [m.approval.id]: m.approval };
        } else if (m.type === 'approval.done') {
          const { [m.id]: _done, ...rest } = approvals;
          approvals = rest;
        } else if (m.type === 'typing') {
          typing = { ...typing, [m.channel]: m.on };
        } else if (m.type === 'chat.clear') {
          chat = { ...chat, [m.channel]: [] };
        } else if (m.type === 'chat') {
          const ch = m.message.channel;
          const list = chat[ch];
          if (list && !list.some((x) => x.id === m.message.id)) chat = { ...chat, [ch]: [...list, m.message].slice(-500) };
          const looking = s.chatOpen && s.channel === ch;
          if (!looking && m.message.author !== 'you') unread = { ...unread, [ch]: (unread[ch] ?? 0) + 1 };
        }
      }
      const selected = s.selected && !agents[s.selected] && s.selected !== 'ceo' ? null : s.selected;
      if (reload && s.channel !== 'activity') queueMicrotask(() => void loadChannel(s.channel));
      return { epoch, agents, events, sim, selected, names, ai, doneToday, chat, typing, unread, approvals, approvalsOn, approvalWaitSec, dispatch, board, pinTick };
    }),
}));

/** Connect to /ws with backoff; the server is the source of truth, so a reconnect just re-reads the snapshot. */
export function connect(): () => void {
  let ws: WebSocket | null = null;
  let retries = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    useOffice.getState().setConnection('connecting', retries);
    ws = new WebSocket(url);
    ws.onopen = () => {
      retries = 0;
      useOffice.getState().setConnection('open');
    };
    ws.onmessage = (ev) => {
      const data = JSON.parse(String(ev.data)) as ServerMessage | ServerMessage[];
      useOffice.getState().apply(Array.isArray(data) ? data : [data]);
    };
    ws.onclose = () => {
      if (stopped) return;
      retries++;
      useOffice.getState().setConnection('closed', retries);
      timer = setTimeout(open, Math.min(1000 * 2 ** (retries - 1), 10_000));
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}

export async function toggleSim(on: boolean): Promise<void> {
  await fetch('/api/sim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }) });
}

const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' } } as const;

export async function loadChannel(channel: string): Promise<void> {
  const r = await fetch(`/api/chat/${encodeURIComponent(channel)}`);
  if (r.ok) useOffice.getState().setHistory(channel, (await r.json()) as ChatMessage[]);
}

export async function sendChat(channel: string, body: string): Promise<void> {
  await fetch(`/api/chat/${encodeURIComponent(channel)}`, { ...JSON_POST, body: JSON.stringify({ body, tz: new Date().getTimezoneOffset() }) });
}

export async function setAi(on: boolean): Promise<void> {
  await fetch('/api/ai', { ...JSON_POST, body: JSON.stringify({ on }) });
}

export async function setApprovals(enabled: boolean): Promise<void> {
  await fetch('/api/approvals', { ...JSON_POST, body: JSON.stringify({ enabled }) });
}

export async function setApprovalWait(waitSec: number): Promise<void> {
  await fetch('/api/approvals', { ...JSON_POST, body: JSON.stringify({ waitSec }) });
}

export async function setAiOptions(opts: { model?: string; contextEvents?: number }): Promise<void> {
  await fetch('/api/ai', { ...JSON_POST, body: JSON.stringify(opts) });
}

/** Answer a held AskUserQuestion: per question, the chosen option indexes and/or free text. */
export async function answerQuestions(id: string, answers: { picked: number[]; other?: string }[]): Promise<void> {
  await fetch(`/api/approvals/${encodeURIComponent(id)}`, { ...JSON_POST, body: JSON.stringify({ decision: 'answer', answers }) });
}

export async function decideApproval(id: string, decision: 'allow' | 'deny' | 'terminal'): Promise<void> {
  await fetch(`/api/approvals/${encodeURIComponent(id)}`, { ...JSON_POST, body: JSON.stringify({ decision }) });
}

/** Start a task: a new agent in a known project folder. Opens its DM on success; resolves to an error text or null. */
export async function sendTask(task: string, cwd: string, channel: string): Promise<string | null> {
  const r = await fetch('/api/dispatch', { ...JSON_POST, body: JSON.stringify({ task, cwd, channel }) });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; id?: string };
  if (!r.ok || !j.ok || !j.id) return j.error ?? 'Could not start the task.';
  useOffice.getState().openChannel(`dm:${j.id}`);
  return null;
}

export async function setDispatch(opts: { enabled?: boolean; mode?: 'plan' | 'acceptEdits' }): Promise<void> {
  await fetch('/api/dispatch', { ...JSON_POST, body: JSON.stringify(opts) });
}

export async function addFolder(path: string): Promise<string | null> {
  const r = await fetch('/api/dispatch', { ...JSON_POST, body: JSON.stringify({ addFolder: path }) });
  if (r.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return j.error ?? 'Could not add the folder.';
}

export async function removeFolder(path: string): Promise<void> {
  await fetch('/api/dispatch', { ...JSON_POST, body: JSON.stringify({ removeFolder: path }) });
}
export async function stopTask(id: string): Promise<void> {
  await fetch('/api/dispatch', { ...JSON_POST, body: JSON.stringify({ stop: id }) });
}

export type BoardOp =
  | { op: 'add'; kind: 'task'; text: string }
  | { op: 'add'; kind: 'reminder'; text: string; due: number; repeat?: 'daily' | 'weekly' }
  | { op: 'toggle' | 'ack' | 'delete'; id: number }
  | { op: 'snooze'; id: number; minutes: number }
  | { op: 'clearDone' };

/** A change to the mission board. Resolves to an error text, or null when it worked. */
export async function boardOp(body: BoardOp): Promise<string | null> {
  const r = await fetch('/api/board', { ...JSON_POST, body: JSON.stringify(body) });
  if (r.ok) return null;
  return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not change the board.';
}
