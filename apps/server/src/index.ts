import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentState, OfficeEvent, ServerMessage } from '@ai-office/shared';
import { config } from './config.ts';
import { normalize, type HookPayload } from './hooks.ts';
import { Office } from './state.ts';
import { pruneOld, recentEvents, saveEvent } from './db.ts';
import { Sim } from './sim.ts';

// ── realtime fan-out: batch changes and flush ~20×/s so event bursts don't flood the browser ──

const clients = new Set<WebSocket>();
const dirty = new Map<string, AgentState | null>(); // null = removed
const outbox: ServerMessage[] = [];

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
setInterval(() => {
  if (!dirty.size && !outbox.length) return;
  const batch: ServerMessage[] = [...outbox.splice(0)];
  for (const [id, a] of dirty) batch.push(a ? { type: 'agent', agent: structuredClone(a) } : { type: 'agent.remove', id });
  dirty.clear();
  const payload = JSON.stringify(batch);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(payload);
}, 50).unref();

const office = new Office({
  agent: (a) => dirty.set(a.id, a),
  remove: (id) => dirty.set(id, null),
});

function ingest(p: HookPayload) {
  const e = normalize(p);
  if (!e) return;
  saveEvent(e);
  office.apply(e);
  outbox.push({ type: 'event', event: e });
}

const sim = new Sim(ingest);

function setSim(on: boolean) {
  if (on) sim.start();
  else {
    sim.stop();
    office.dismiss((a) => a.sessionId.startsWith('sim-'));
  }
  outbox.push({ type: 'sim', on });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const app = new Hono();
const expected = Buffer.from(`Bearer ${config.token}`);

function authorised(header: string | undefined): boolean {
  const got = Buffer.from(header ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// Claude Code HTTP hooks post here. Always answer 200 with an empty body at once:
// the office must never slow down, block, approve or deny anything in a real session.
app.post('/hook', async (c) => {
  if (!authorised(c.req.header('authorization'))) return c.body(null, 401);
  let payload: HookPayload | null = null;
  try {
    payload = (await c.req.json()) as HookPayload;
  } catch {
    /* ignore malformed bodies */
  }
  if (payload) setImmediate(() => ingest(payload));
  return c.body(null, 200);
});

app.get('/api/health', (c) => c.json({ ok: true, agents: office.agents.size, sim: sim.running }));

app.get('/api/state', (c) => c.json({ agents: office.snapshot(), events: recentEvents(100), sim: sim.running }));

app.get('/api/events', (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 500);
  return c.json(recentEvents(limit, c.req.query('agent') || undefined) satisfies OfficeEvent[]);
});

app.post('/api/sim', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { on?: boolean };
  setSim(body.on ?? !sim.running);
  return c.json({ sim: sim.running });
});

// built web app (npm run build); in dev, Vite serves it on :5173 and proxies here
if (existsSync(config.webDist)) {
  app.use('/*', serveStatic({ root: config.webDist }));
  app.get('*', serveStatic({ path: `${config.webDist}/index.html` }));
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`AI Office server on http://${config.host}:${info.port}  (hook: POST /hook, ws: /ws)`);
});

// ── WebSocket ────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (!req.url?.startsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    send(ws, { type: 'snapshot', state: { agents: office.snapshot(), events: recentEvents(100), sim: sim.running } });
    ws.on('close', () => clients.delete(ws));
  });
});

pruneOld();
setInterval(pruneOld, 3_600_000).unref();

if (process.argv.includes('--sim') || process.env.OFFICE_SIM === '1') setSim(true);
