import { open } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { OfficeEvent } from '@ai-office/shared';
import { label, type HookPayload } from './hooks.ts';

/**
 * Claude Code's hooks say how hard an agent is thinking (`effort`) but not which model it runs on.
 * The transcript does: every assistant line carries `message.model`. We read the tail of that file,
 * keep that one short string and drop the rest; nothing else from the transcript is stored or sent.
 * This only works where the server can see ~/.claude (on your Mac, not inside DDEV).
 */

const TAIL = 256 * 1024;
const SAFE_ID = /^[\w-]+$/;

const jsonl = (v: unknown): string | undefined => (typeof v === 'string' && isAbsolute(v) && v.endsWith('.jsonl') ? v : undefined);

/** The transcript file of the agent a hook payload belongs to. */
export function transcriptOf(p: HookPayload): string | undefined {
  const main = jsonl(p.transcript_path);
  if (!p.agent_id) return main;
  const own = jsonl(p.agent_transcript_path); // only SubagentStop sends it
  if (own) return own;
  // otherwise where Claude Code puts it: <project dir>/<session>/subagents/agent-<id>.jsonl
  if (!main || !p.session_id || !SAFE_ID.test(p.session_id) || !SAFE_ID.test(p.agent_id)) return undefined;
  return join(dirname(main), p.session_id, 'subagents', `agent-${p.agent_id}.jsonl`);
}

/** The model of the last assistant message in a transcript, or null (no file, nothing yet). */
export async function readModel(file: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, TAIL);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift(); // the window starts mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      try {
        const row = JSON.parse(lines[i]) as { type?: string; message?: { model?: unknown } };
        const model = row.type === 'assistant' ? label(row.message?.model) : undefined; // "<synthetic>" fails label()
        if (model) return model;
      } catch {
        /* a line cut by the window */
      }
    }
  } catch {
    /* no such file from here, e.g. the server runs in DDEV */
  } finally {
    await fh?.close().catch(() => {});
  }
  return null;
}

const MIN_GAP_MS = 1000;
const RETRY_MS = 1500;
const RETRIES = 6;

export interface ModelSink {
  known(agentId: string): boolean;
  set(agentId: string, model: string): void;
}

/** Looks a model up after an agent's events: while it is unknown, and again at turn edges (/model can change it). */
export class ModelWatch {
  private tried = new Map<string, number>();
  private busy = new Set<string>();
  private sink: ModelSink;

  constructor(sink: ModelSink) {
    this.sink = sink;
  }

  note(agentId: string, kind: OfficeEvent['kind'], p: HookPayload): void {
    const file = transcriptOf(p);
    if (!file) return;
    const known = this.sink.known(agentId);
    if (known && kind !== 'prompt' && kind !== 'turn_done') return;
    this.look(agentId, file, known ? 0 : RETRIES);
  }

  private look(agentId: string, file: string, retries: number): void {
    const now = Date.now();
    if (this.busy.has(agentId) || now - (this.tried.get(agentId) ?? 0) < MIN_GAP_MS) return;
    this.tried.set(agentId, now);
    this.busy.add(agentId);
    void readModel(file)
      .then((model) => {
        if (model) this.sink.set(agentId, model);
        // a subagent's transcript can lag its first hooks, and a busy one sends no more for a while: retry on a timer
        else if (retries > 0) {
          setTimeout(() => {
            if (this.tried.has(agentId) && !this.sink.known(agentId)) this.look(agentId, file, retries - 1);
          }, RETRY_MS).unref();
        }
      })
      .finally(() => this.busy.delete(agentId));
  }

  forget(agentId: string): void {
    this.tried.delete(agentId);
    this.busy.delete(agentId);
  }
}
