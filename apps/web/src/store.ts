import { create } from 'zustand';
import type { AgentState, OfficeEvent, ServerMessage } from '@ai-office/shared';

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
  apply(msgs: ServerMessage[]): void;
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
      let { agents, events, sim, names } = s;
      for (const m of msgs) {
        if (m.type === 'snapshot') {
          agents = Object.fromEntries(m.state.agents.map((a) => [a.id, a]));
          names = { ...names, ...Object.fromEntries(m.state.agents.map((a) => [a.id, a.name])) };
          events = m.state.events;
          sim = m.state.sim;
        } else if (m.type === 'agent') {
          agents = { ...agents, [m.agent.id]: m.agent };
          if (names[m.agent.id] !== m.agent.name) names = { ...names, [m.agent.id]: m.agent.name };
        } else if (m.type === 'agent.remove') {
          const { [m.id]: _gone, ...rest } = agents;
          agents = rest;
        } else if (m.type === 'event') {
          events = [...events, m.event].slice(-MAX_EVENTS);
        } else if (m.type === 'sim') {
          sim = m.on;
        }
      }
      const selected = s.selected && !agents[s.selected] && s.selected !== 'ceo' ? null : s.selected;
      return { agents, events, sim, selected, names };
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
