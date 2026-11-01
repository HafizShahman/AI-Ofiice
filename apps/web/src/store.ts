import { create } from 'zustand';
import type { AgentState, AiState, ChatMessage, OfficeEvent, ServerMessage } from '@ai-office/shared';

export type Connection = 'connecting' | 'open' | 'closed';

interface OfficeStore {
  connection: Connection;
  retries: number;
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

export const useOffice = create<OfficeStore>((set) => ({
  connection: 'connecting',
  retries: 0,
  agents: {},
  names: {},
  events: [],
  sim: false,
  selected: new URLSearchParams(location.search).get('agent'),
  following: false,
  chatOpen: true,
  ai: { enabled: false, model: 'haiku', available: null },
  doneToday: 0,
  channel: 'office',
  chat: {},
  typing: {},
  unread: {},
  focusTick: 0,
  openChannel: (channel, focus = false) => {
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
      let { agents, events, sim, names, ai, doneToday, chat, typing, unread } = s;
      let reload = false;
      for (const m of msgs) {
        if (m.type === 'snapshot') {
          agents = Object.fromEntries(m.state.agents.map((a) => [a.id, a]));
          names = { ...names, ...Object.fromEntries(m.state.agents.map((a) => [a.id, a.name])) };
          events = m.state.events;
          sim = m.state.sim;
          ai = m.state.ai;
          doneToday = m.state.doneToday;
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
      return { agents, events, sim, selected, names, ai, doneToday, chat, typing, unread };
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
  await fetch(`/api/chat/${encodeURIComponent(channel)}`, { ...JSON_POST, body: JSON.stringify({ body }) });
}

export async function setAi(on: boolean): Promise<void> {
  await fetch('/api/ai', { ...JSON_POST, body: JSON.stringify({ on }) });
}
