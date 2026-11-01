import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { ChatMessage, OfficeEvent } from '@ai-office/shared';
import { config } from './config.ts';

const KEEP_DAYS = 7;

const db = new DatabaseSync(join(config.dataDir, 'office.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    kind TEXT NOT NULL, tool TEXT, summary TEXT, project TEXT, json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_agent_ts ON events (agent_id, ts);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, channel TEXT NOT NULL,
    author TEXT NOT NULL, body TEXT NOT NULL, meta TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const insert = db.prepare(
  'INSERT OR IGNORE INTO events (id, ts, session_id, agent_id, kind, tool, summary, project, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
const recentAll = db.prepare('SELECT json FROM events ORDER BY ts DESC LIMIT ?');
const recentAgent = db.prepare('SELECT json FROM events WHERE agent_id = ? ORDER BY ts DESC LIMIT ?');
const prune = db.prepare('DELETE FROM events WHERE ts < ?');
const pruneMsgs = db.prepare('DELETE FROM messages WHERE ts < ?');
const countKind = db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ? AND ts >= ?');
const insertMsg = db.prepare('INSERT INTO messages (ts, channel, author, body, meta) VALUES (?, ?, ?, ?, ?)');
const channelMsgs = db.prepare('SELECT id, ts, channel, author, body, meta FROM messages WHERE channel = ? ORDER BY id DESC LIMIT ?');
const clearMsgs = db.prepare('DELETE FROM messages WHERE channel = ?');
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

export function saveEvent(e: OfficeEvent): void {
  insert.run(e.id, e.ts, e.sessionId, e.agentId, e.kind, e.tool ?? null, e.summary ?? null, e.project, JSON.stringify(e));
}

export function recentEvents(limit = 100, agentId?: string): OfficeEvent[] {
  const rows = (agentId ? recentAgent.all(agentId, limit) : recentAll.all(limit)) as { json: string }[];
  return rows.map((r) => JSON.parse(r.json) as OfficeEvent).reverse();
}

export function pruneOld(): void {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  prune.run(cutoff);
  pruneMsgs.run(cutoff);
}

export function countEvents(kind: OfficeEvent['kind'], since: number): number {
  return Number((countKind.get(kind, since) as { n: number }).n);
}

// ── chat ───────────────────────────────────────────────────────────────────

type Meta = Pick<ChatMessage, 'name' | 'tone' | 'agentId'>;

export function saveMessage(m: Omit<ChatMessage, 'id'>): ChatMessage {
  const meta: Meta = { name: m.name, tone: m.tone, agentId: m.agentId };
  const r = insertMsg.run(m.ts, m.channel, m.author, m.body, JSON.stringify(meta));
  return { ...m, id: Number(r.lastInsertRowid) };
}

export function channelHistory(channel: string, limit = 200): ChatMessage[] {
  const rows = channelMsgs.all(channel, limit) as { id: number; ts: number; channel: string; author: ChatMessage['author']; body: string; meta: string | null }[];
  return rows.reverse().map((r) => ({ id: r.id, ts: r.ts, channel: r.channel, author: r.author, body: r.body, ...(r.meta ? (JSON.parse(r.meta) as Meta) : {}) }));
}

export function clearChannel(channel: string): void {
  clearMsgs.run(channel);
}

// ── settings ───────────────────────────────────────────────────────────────

export function setting(key: string): string | undefined {
  return (getSetting.get(key) as { value: string } | undefined)?.value;
}

export function saveSetting(key: string, value: string): void {
  putSetting.run(key, value);
}
