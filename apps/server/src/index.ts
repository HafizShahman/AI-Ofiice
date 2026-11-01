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
import { normalize, permissionDetail, type HookPayload } from './hooks.ts';
import { Approvals } from './approvals.ts';
import { Office } from './state.ts';
import { countEvents, pruneOld, recentEvents, saveEvent } from './db.ts';
import { Sim } from './sim.ts';
import { Chat, midnight, validChannel } from './chat.ts';
import { ownSessions } from './manager.ts';

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

// remember each agent's last status so a fresh "blocked" can ping the chat
const lastStatus = new Map<string, AgentState['status']>();
const pinged = new Map<string, number>(); // "name|tool|summary" → ts, so a looping demo or retry doesn't flood #office
let chat: Chat | null = null;

const office = new Office({
  agent: (a) => {
    dirty.set(a.id, a);
    if (a.status === 'blocked' && lastStatus.get(a.id) !== 'blocked' && chat) {
      const what = a.tool ? ` · ${a.tool}${a.summary ? ` → ${a.summary}` : ''}` : '';
      const line = `✋ ${a.name} needs permission${what}. ${approvals.enabled ? 'Allow or deny it here, or in' : 'Answer it in'} that agent's terminal.`;
      const key = `${a.name}|${a.tool}|${a.summary}`;
      if (Date.now() - (pinged.get(key) ?? 0) > 5 * 60_000) chat.system('office', line, 'warn', a.id);
      pinged.set(key, Date.now());
      chat.system(`dm:${a.id}`, line, 'warn', a.id);
    }
    lastStatus.set(a.id, a.status);
  },
  remove: (id) => {
    dirty.set(id, null);
    lastStatus.delete(id);
  },
});

const approvals = new Approvals((m) => outbox.push(m));
// once an agent moves on, a permission it was waiting on has been settled one way or another
const SETTLES = new Set<OfficeEvent['kind']>(['tool_start', 'tool_end', 'tool_fail', 'turn_done', 'prompt', 'leave']);

function apply(e: OfficeEvent) {
  saveEvent(e);
  office.apply(e);
  outbox.push({ type: 'event', event: e });
  if (SETTLES.has(e.kind)) approvals.clearAgent(e.agentId);
}

/** Hook payloads from the demo (real hooks go through POST /hook). */
function ingest(p: HookPayload) {
  if (p.session_id && ownSessions.has(p.session_id)) return; // the Office Manager's own claude -p run
  const e = normalize(p);
  if (!e) return;
  apply(e);
  if (approvals.enabled && p.hook_event_name === 'PermissionRequest' && e.sessionId.startsWith('sim-')) approvals.holdSim(e, permissionDetail(e.tool ?? '', p.tool_input ?? {}));
}

const sim = new Sim(ingest);
chat = new Chat({ office, push: (m) => outbox.push(m), sim, setSim: (on) => setSim(on), approvals });

let warnedShort = 0;
approvals.onShortHookTimeout = () => {
  if (Date.now() - warnedShort < 10 * 60_000) return;
  warnedShort = Date.now();
  chat!.system(
    'office',
    `Claude Code gave up on the permission hook after about a second, so "approve from the office" can't hold the request. Re-run \`npm run install-hooks\` (same options as before): it gives the PermissionRequest hook ${approvals.waitMs / 1000 + 10} s.`,
    'warn',
  );
};

approvals.onDone = (a, outcome) => {
  if (outcome === 'allow' || outcome === 'deny') office.resume(a.agentId);
  const who = office.agents.get(a.agentId)?.name ?? 'The agent';
  const what = `${a.tool} \`${a.detail.replace(/`/g, "'")}\``;
  const demo = a.sim ? ' (demo: nothing real was approved)' : '';
  const line =
    outcome === 'allow' ? `✓ You allowed ${what} for ${who} from the office${demo}.`
    : outcome === 'deny' ? `✕ You denied ${what} for ${who} from the office${demo}.`
    : outcome === 'terminal' ? `${who}'s request went back to its terminal.`
    : outcome === 'timeout' ? `No answer in ${approvals.waitMs / 1000}s: ${who}'s request went back to its terminal.`
    : null;
  if (!line) return;
  chat!.system(`dm:${a.agentId}`, line, outcome === 'allow' ? 'ok' : outcome === 'deny' ? 'fail' : 'info', a.agentId);
  if (outcome === 'allow' || outcome === 'deny') chat!.system('office', line, outcome === 'allow' ? 'ok' : 'fail', a.agentId);
};

const snapshot = () => ({
  agents: office.snapshot(),
  events: recentEvents(100),
  sim: sim.running,
  ai: chat!.ai,
  approvals: approvals.state(),
  doneToday: countEvents('turn_done', midnight()),
});

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

// Browser-facing writes must come from the office UI itself: JSON only (forces a CORS
// preflight we never answer) and, when the browser sends an Origin, the same host.
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'POST') {
    const origin = c.req.header('origin');
    const json = (c.req.header('content-type') ?? '').startsWith('application/json');
    if (!json || (origin && new URL(origin).host !== c.req.header('host'))) return c.body(null, 403);
  }
  await next();
});

// Claude Code HTTP hooks post here. Answer 200 with an empty body at once: the office never
// slows down, blocks, approves or denies anything in a real session. The one exception is opt-in:
// with "approve from the office" on, a PermissionRequest is held until you click Allow / Deny
// (or it times out and Claude Code asks in the terminal as usual).
app.post('/hook', async (c) => {
  if (!authorised(c.req.header('authorization'))) return c.body(null, 401);
  let payload: HookPayload | null = null;
  try {
    payload = (await c.req.json()) as HookPayload;
  } catch {
    /* ignore malformed bodies */
  }
  if (!payload) return c.body(null, 200);
  const p = payload;
  // only hold it when an office tab is open to answer it; otherwise the terminal asks at once
  if (approvals.enabled && clients.size > 0 && p.hook_event_name === 'PermissionRequest' && !(p.session_id && ownSessions.has(p.session_id))) {
    const e = normalize(p);
    if (e) {
      apply(e);
      const decision = await approvals.hold(e, permissionDetail(e.tool ?? '', p.tool_input ?? {}), c.req.raw.signal);
      return decision ? c.json(decision) : c.body(null, 200);
    }
  }
  setImmediate(() => ingest(p));
  return c.body(null, 200);
});

app.get('/api/health', (c) => c.json({ ok: true, agents: office.agents.size, sim: sim.running }));

app.get('/api/state', (c) => c.json(snapshot()));

app.get('/api/events', (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 500);
  return c.json(recentEvents(limit, c.req.query('agent') || undefined) satisfies OfficeEvent[]);
});

app.post('/api/sim', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { on?: boolean };
  setSim(body.on ?? !sim.running);
  return c.json({ sim: sim.running });
});

app.get('/api/chat/:channel', (c) => {
  const channel = c.req.param('channel');
  if (!validChannel(channel)) return c.json([], 400);
  return c.json(chat!.history(channel));
});

app.post('/api/chat/:channel', async (c) => {
  const channel = c.req.param('channel');
  const body = (await c.req.json().catch(() => ({}))) as { body?: string };
  if (!validChannel(channel) || typeof body.body !== 'string') return c.body(null, 400);
  void chat!.handle(channel, body.body); // the reply arrives over the WebSocket
  return c.body(null, 202);
});

app.post('/api/approvals', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
  approvals.setEnabled(body.enabled ?? !approvals.enabled);
  return c.json(approvals.state());
});

app.post('/api/approvals/:id', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { decision?: string };
  const d = body.decision;
  if (d !== 'allow' && d !== 'deny' && d !== 'terminal') return c.body(null, 400);
  return approvals.decide(c.req.param('id'), d) ? c.body(null, 204) : c.body(null, 404);
});

app.post('/api/ai', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { on?: boolean };
  await chat!.setAi(body.on ?? !chat!.ai.enabled);
  return c.json(chat!.ai);
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
    send(ws, { type: 'snapshot', state: snapshot() });
    ws.on('close', () => clients.delete(ws));
  });
});

pruneOld();
setInterval(pruneOld, 3_600_000).unref();

if (process.argv.includes('--sim') || process.env.OFFICE_SIM === '1') setSim(true);
