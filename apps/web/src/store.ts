import { create } from 'zustand';
import type { AgentState, OfficeEvent, ServerMessage } from '@ai-office/shared';

export type Connection = 'connecting' | 'open' | 'closed';

interface OfficeStore {
  connection: Connection;
  retries: number;
  agents: Record<string, AgentState>;
  events: OfficeEvent[];
  sim: boolean;
  apply(msgs: ServerMessage[]): void;
  setConnection(c: Connection, retries?: number): void;
}

const MAX_EVENTS = 300;

export const useOffice = create<OfficeStore>((set) => ({
  connection: 'connecting',
  retries: 0,
  agents: {},
  events: [],
  sim: false,
  setConnection: (connection, retries = 0) => set({ connection, retries }),
  // one store update per server batch, so event bursts don't cause a render per event
  apply: (msgs) =>
    set((s) => {
      let { agents, events, sim } = s;
      for (const m of msgs) {
        if (m.type === 'snapshot') {
          agents = Object.fromEntries(m.state.agents.map((a) => [a.id, a]));
          events = m.state.events;
          sim = m.state.sim;
        } else if (m.type === 'agent') {
          agents = { ...agents, [m.agent.id]: m.agent };
        } else if (m.type === 'agent.remove') {
          const { [m.id]: _gone, ...rest } = agents;
          agents = rest;
        } else if (m.type === 'event') {
          events = [...events, m.event].slice(-MAX_EVENTS);
        } else if (m.type === 'sim') {
          sim = m.on;
        }
      }
      return { agents, events, sim };
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
