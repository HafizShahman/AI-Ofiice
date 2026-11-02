import type { BoardItem, ServerMessage } from '@ai-office/shared';
import { clearDoneBoard, deleteBoard, insertBoard, listBoard, updateBoard } from './db.ts';

/**
 * The mission board: the user's own tasks and reminders. Kept on the server (SQLite) so a reminder
 * fires on time whether or not a browser tab is open: a due reminder goes `alerting` and stays so
 * until it is dismissed, snoozed or completed, so a tab opened later still shows it.
 */

const MAX_ITEMS = 200;
const MAX_TEXT = 280;
const MINUTE = 60_000;
const DAY = 86_400_000;

export interface When {
  due: number;
  repeat?: 'daily' | 'weekly';
  /** what is left of the text once the time is taken off the front */
  rest: string;
}

const UNIT: Record<string, number> = { m: MINUTE, h: 60 * MINUTE, d: DAY };

/**
 * Read a time off the start of "in 20m call Sam", "at 15:30 stand up", "tomorrow 9am pay rent" or
 * "daily 9:00 standup". `tz` is the browser's `getTimezoneOffset()` (minutes, UTC minus local), so
 * "15:30" means the user's 15:30 even when the server runs in another zone (DDEV is UTC).
 */
export function parseWhen(input: string, now: number, tz = new Date().getTimezoneOffset()): When | null {
  let s = input.trim();
  let repeat: When['repeat'];
  const rep = s.match(/^(daily|every\s+day|weekly|every\s+week)\b\s*/i);
  if (rep) {
    repeat = /week/i.test(rep[1]) ? 'weekly' : 'daily';
    s = s.slice(rep[0].length);
  }

  const rel = s.match(/^in\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\b\s*/i);
  if (rel && !repeat) {
    const n = Number(rel[1]);
    const due = now + n * UNIT[rel[2][0].toLowerCase()];
    return n > 0 ? { due, rest: tidy(s.slice(rel[0].length)) } : null;
  }

  const abs = s.match(/^(tomorrow\s+)?(at\s+)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\b\s*/i);
  if (!abs) return null;
  const [all, tomorrow, at, h, min, ampm] = abs;
  if (!tomorrow && !at && !min && !ampm) return null; // a bare number ("3 apples") is not a time
  if (!h && !tomorrow) return null;
  let hour = h ? Number(h) : 9; // "tomorrow remind me…" means 9:00
  const minute = min ? Number(min) : 0;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const local = new Date(now - tz * MINUTE); // read with the UTC getters: they give the user's wall clock
  local.setUTCHours(hour, minute, 0, 0);
  let t = local.getTime();
  if (tomorrow) t += DAY;
  else if (t <= now - tz * MINUTE) t += DAY;
  return { due: t + tz * MINUTE, repeat, rest: tidy(s.slice(all.length)) };
}

const tidy = (t: string) => t.replace(/^(?:to|that|about)\s+/i, '').trim();

/** The next occurrence of a repeating reminder after `now`. */
export function nextDue(due: number, repeat: 'daily' | 'weekly', now: number): number {
  const step = repeat === 'weekly' ? 7 * DAY : DAY;
  return now < due ? due : due + Math.ceil((now - due + 1) / step) * step;
}

export class Board {
  private push: (m: ServerMessage) => void;

  constructor(push: (m: ServerMessage) => void) {
    this.push = push;
    setInterval(() => this.tick(), 1000).unref();
    this.tick();
  }

  items(): BoardItem[] {
    return listBoard();
  }

  private changed(): void {
    this.push({ type: 'board', items: listBoard() });
  }

  /** Reminders whose time has come start alerting. */
  private tick(): void {
    const now = Date.now();
    let any = false;
    for (const i of listBoard()) {
      if (i.kind === 'reminder' && i.state === 'open' && i.due !== undefined && i.due <= now) {
        updateBoard(i.id, 'alerting', i.due, null);
        any = true;
      }
    }
    if (any) this.changed();
  }

  add(kind: BoardItem['kind'], text: string, opts: { due?: number; repeat?: 'daily' | 'weekly' } = {}): { ok: true; item: BoardItem } | { ok: false; error: string } {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!t) return { ok: false, error: 'Write something first.' };
    if (listBoard().length >= MAX_ITEMS) return { ok: false, error: `The board is full (${MAX_ITEMS} notes). Clear the done ones first.` };
    let due: number | undefined;
    if (kind === 'reminder') {
      if (typeof opts.due !== 'number' || !Number.isFinite(opts.due)) return { ok: false, error: 'A reminder needs a time.' };
      if (opts.due > Date.now() + 366 * DAY) return { ok: false, error: 'That is more than a year away.' };
      due = Math.round(opts.due);
    }
    const id = insertBoard({ kind, text: t, due, repeat: kind === 'reminder' ? opts.repeat : undefined });
    this.changed();
    this.push({ type: 'board.pin', id });
    return { ok: true, item: listBoard().find((i) => i.id === id)! };
  }

  private find(id: number): BoardItem | undefined {
    return listBoard().find((i) => i.id === id);
  }

  /** Tick a task done / open again. A reminder can only be completed (delete it to remove it). */
  toggle(id: number): void {
    const i = this.find(id);
    if (!i) return;
    if (i.state === 'done') {
      if (i.kind === 'task') updateBoard(id, 'open', null, null);
    } else updateBoard(id, 'done', i.due ?? null, Date.now());
    this.changed();
  }

  /** Dismiss an alerting reminder: a repeating one is set for its next time, the others are done. */
  ack(id: number): void {
    const i = this.find(id);
    if (!i || i.state !== 'alerting') return;
    if (i.repeat && i.due !== undefined) updateBoard(id, 'open', nextDue(i.due, i.repeat, Date.now()), null);
    else updateBoard(id, 'done', i.due ?? null, Date.now());
    this.changed();
  }

  snooze(id: number, minutes: number): void {
    const i = this.find(id);
    if (!i || i.kind !== 'reminder' || i.state === 'done') return;
    const m = Math.min(1440, Math.max(1, Math.round(minutes) || 10));
    updateBoard(id, 'open', Date.now() + m * MINUTE, null);
    this.changed();
  }

  remove(id: number): void {
    deleteBoard(id);
    this.changed();
  }

  clearDone(): void {
    clearDoneBoard();
    this.changed();
  }
}
