import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { OfficeEvent } from '@ai-office/shared';
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

export function saveEvent(e: OfficeEvent): void {
  insert.run(e.id, e.ts, e.sessionId, e.agentId, e.kind, e.tool ?? null, e.summary ?? null, e.project, JSON.stringify(e));
}

export function recentEvents(limit = 100, agentId?: string): OfficeEvent[] {
  const rows = (agentId ? recentAgent.all(agentId, limit) : recentAll.all(limit)) as { json: string }[];
  return rows.map((r) => JSON.parse(r.json) as OfficeEvent).reverse();
}

export function pruneOld(): void {
  prune.run(Date.now() - KEEP_DAYS * 86_400_000);
}
