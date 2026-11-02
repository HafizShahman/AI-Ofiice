import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardItem } from '@ai-office/shared';
import { anchorEls, BOARD_BOX } from '../scene/anchors.ts';
import { playReminder } from '../sound/cues.ts';
import { boardOp, useOffice } from '../store.ts';
import { Icon } from './icons.tsx';
import { usePrefs, useUi } from './prefs.ts';
import { timeOfDay } from './util.tsx';

/**
 * The mission board: your tasks and reminders. The painted board on the back wall is the way in
 * (click it for a card, expand the card for the full overlay); notes you hand over are pinned by the
 * CEO, who walks to the board. A due reminder raises an on-screen alert (ReminderAlerts) until you
 * answer it. The notes live on the server, so reminders fire with no tab open.
 */

const MIN = 60_000;

/** "14:30" today, "Tue 14:30" later. */
function whenText(ts: number): string {
  const d = new Date(ts);
  const day = new Date().toDateString() === d.toDateString() ? '' : `${d.toLocaleDateString([], { weekday: 'short' })} `;
  return day + timeOfDay(ts);
}

const toLocalInput = (ts: number) => new Date(ts - new Date().getTimezoneOffset() * MIN).toISOString().slice(0, 16);

function useLists() {
  const board = useOffice((s) => s.board);
  return useMemo(() => {
    const open = board.filter((i) => i.state !== 'done');
    return {
      alerting: open.filter((i) => i.state === 'alerting'),
      reminders: open.filter((i) => i.kind === 'reminder').sort((a, b) => Number(b.state === 'alerting') - Number(a.state === 'alerting') || (a.due ?? 0) - (b.due ?? 0)),
      tasks: open.filter((i) => i.kind === 'task'),
      done: board.filter((i) => i.state === 'done').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
    };
  }, [board]);
}

// ── the painted board in the scene ───────────────────────────────────────────

/** A clickable area over the painted board, plus a small badge with the counts (amber while a reminder is due). */
export function BoardHotspot() {
  const box = useRef<HTMLButtonElement>(null);
  const badge = useRef<HTMLButtonElement>(null);
  const { alerting, reminders, tasks } = useLists();
  const mode = useUi((s) => s.board);

  useEffect(() => {
    const { x, y, w, h } = BOARD_BOX;
    anchorEls.set('board:box', { el: box.current!, rx: x, ry: y, w, h });
    anchorEls.set('board:badge', { el: badge.current!, rx: x, ry: y - h / 2 + 8 });
    return () => {
      anchorEls.delete('board:box');
      anchorEls.delete('board:badge');
    };
  }, []);

  const toggle = () => useUi.getState().setBoard(useUi.getState().board === 'closed' ? 'card' : 'closed');
  const upcoming = reminders.length - alerting.length;
  return (
    <>
      <button
        ref={box}
        data-ui
        aria-label="Open the mission board"
        title="Mission board"
        onClick={toggle}
        className={`pointer-events-auto absolute left-0 top-0 rounded-xl border-2 will-change-transform hover:border-accent/80 hover:bg-accent/10 focus-visible:border-accent ${
          alerting.length ? 'animate-pulse border-warning/80 bg-warning/10' : mode !== 'closed' ? 'border-accent/60' : 'border-transparent'
        }`}
        style={{ display: 'none' }}
      />
      <button
        ref={badge}
        data-ui
        onClick={toggle}
        title="Open the mission board"
        className={`pointer-events-auto absolute left-0 top-0 flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[11px] shadow-[0_4px_12px_rgb(0_0_0/.4)] will-change-transform ${
          alerting.length ? 'border-warning bg-[#1d1708] text-warning' : 'border-border bg-[#0b1220]/90 text-muted hover:text-text'
        }`}
        style={{ display: 'none' }}
      >
        <Icon name={alerting.length ? 'bell' : 'check'} size={11} />
        {alerting.length ? `${alerting.length} due now` : `${tasks.length} to do${upcoming ? ` · ${upcoming} reminder${upcoming === 1 ? '' : 's'}` : ''}`}
      </button>
    </>
  );
}

// ── adding a note ────────────────────────────────────────────────────────────

/** Hand a task or a reminder to the CEO. */
function QuickAdd({ autoFocus = false }: { autoFocus?: boolean }) {
  const [kind, setKind] = useState<'task' | 'reminder'>('task');
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [repeat, setRepeat] = useState<'' | 'daily' | 'weekly'>('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (k: 'task' | 'reminder') => {
    setKind(k);
    if (k === 'reminder' && !due) setDue(toLocalInput(Date.now() + 10 * MIN));
  };
  const tomorrow9 = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return toLocalInput(d.getTime());
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    const at = new Date(due).getTime();
    if (kind === 'reminder' && !Number.isFinite(at)) return setErr('Pick a time for the reminder.');
    setBusy(true);
    setErr(null);
    const e = await boardOp(kind === 'task' ? { op: 'add', kind, text: body } : { op: 'add', kind, text: body, due: at, repeat: repeat || undefined });
    setBusy(false);
    if (e) return setErr(e);
    setText('');
  };

  const chip = 'rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:text-text';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div role="group" aria-label="Note type" className="flex shrink-0 overflow-hidden rounded-md border border-border text-[12px]">
          <button onClick={() => pick('task')} aria-pressed={kind === 'task'} className={`px-2.5 py-1.5 ${kind === 'task' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text'}`}>
            Task
          </button>
          <button onClick={() => pick('reminder')} aria-pressed={kind === 'reminder'} className={`px-2.5 py-1.5 ${kind === 'reminder' ? 'bg-warning/15 text-warning' : 'text-muted hover:text-text'}`}>
            Reminder
          </button>
        </div>
        <input
          autoFocus={autoFocus}
          value={text}
          maxLength={280}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
          }}
          placeholder={kind === 'task' ? 'Tell the CEO what to add…' : 'What should the CEO remind you of?'}
          aria-label={kind === 'task' ? 'New task' : 'New reminder'}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 text-[13px] outline-none placeholder:text-muted focus:border-accent/60"
        />
        <button onClick={() => void submit()} disabled={!text.trim() || busy} className="h-9 shrink-0 rounded-md bg-accent px-3 text-[13px] font-medium text-[#04131a] disabled:bg-surface-2 disabled:text-muted">
          Pin it
        </button>
      </div>
      {kind === 'reminder' && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            aria-label="Remind me at"
            className="h-8 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-accent/60 [color-scheme:dark]"
          />
          <button className={chip} onClick={() => setDue(toLocalInput(Date.now() + 10 * MIN))}>
            in 10 min
          </button>
          <button className={chip} onClick={() => setDue(toLocalInput(Date.now() + 60 * MIN))}>
            in 1 h
          </button>
          <button className={chip} onClick={() => setDue(tomorrow9())}>
            tomorrow 9:00
          </button>
          <select value={repeat} onChange={(e) => setRepeat(e.target.value as typeof repeat)} aria-label="Repeat" className="h-8 rounded-md border border-border bg-surface px-1.5 text-[12px]">
            <option value="">once</option>
            <option value="daily">every day</option>
            <option value="weekly">every week</option>
          </select>
        </div>
      )}
      {err && (
        <p role="alert" className="text-[12px] text-warning">
          {err}
        </p>
      )}
    </div>
  );
}

// ── one note ─────────────────────────────────────────────────────────────────

function Note({ item }: { item: BoardItem }) {
  const done = item.state === 'done';
  const alerting = item.state === 'alerting';
  const tick = () => void boardOp({ op: item.kind === 'reminder' && alerting ? 'ack' : 'toggle', id: item.id });
  return (
    <li className={`group flex items-start gap-2 rounded-md border px-2.5 py-2 text-[13px] ${alerting ? 'border-warning/60 bg-warning/8' : 'border-border bg-surface/60'}`}>
      <button
        onClick={tick}
        aria-label={done ? `Reopen: ${item.text}` : `Mark done: ${item.text}`}
        disabled={done && item.kind === 'reminder'}
        className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${done ? 'border-success bg-success/20 text-success' : 'border-muted hover:border-accent'}`}
      >
        {done && <Icon name="check" size={11} strokeWidth={3} />}
      </button>
      <span className="min-w-0 flex-1">
        <span className={`block break-words leading-snug ${done ? 'text-muted line-through' : ''}`}>{item.text}</span>
        {item.kind === 'reminder' && item.due !== undefined && (
          <span className={`mt-0.5 flex items-center gap-1 font-mono text-[11px] ${alerting ? 'text-warning' : 'text-muted'}`}>
            <Icon name="bell" size={10} />
            {alerting ? 'due now' : whenText(item.due)}
            {item.repeat && <span className="rounded bg-surface-2 px-1">{item.repeat}</span>}
          </span>
        )}
      </span>
      <button onClick={() => void boardOp({ op: 'delete', id: item.id })} aria-label={`Delete: ${item.text}`} title="Delete" className="shrink-0 rounded p-0.5 text-muted opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100">
        <Icon name="x" size={13} />
      </button>
    </li>
  );
}

function NoteList({ items, empty }: { items: BoardItem[]; empty: string }) {
  return items.length ? (
    <ul className="flex flex-col gap-1.5">
      {items.map((i) => (
        <Note key={i.id} item={i} />
      ))}
    </ul>
  ) : (
    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted">{empty}</p>
  );
}

// ── the card (click the board) ───────────────────────────────────────────────

const CARD_MAX = 5;

export function BoardCard() {
  const mode = useUi((s) => s.board);
  usePrefs((s) => s.clock24);
  const { reminders, tasks } = useLists();
  if (mode !== 'card') return null;
  const close = () => useUi.getState().setBoard('closed');
  return (
    <section data-ui aria-label="Mission board" className="absolute bottom-4 left-4 z-[2000] flex max-h-[calc(100%-2rem)] w-[360px] max-w-[calc(100%-2rem)] flex-col gap-3 overflow-y-auto rounded-[10px] border border-border bg-surface/97 p-3 shadow-[0_8px_24px_rgb(0_0_0/.45)]">
      <header className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="whitespace-nowrap font-display text-[15px] tracking-[0.1em]">MISSION BOARD</h2>
          <p className="font-mono text-[11px] text-muted">
            {tasks.length} to do · {reminders.length} reminder{reminders.length === 1 ? '' : 's'}
          </p>
        </div>
        <button onClick={() => useUi.getState().setBoard('overlay')} className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:text-text" title="Open the full board">
          Expand
        </button>
        <button onClick={close} aria-label="Close the board" className="shrink-0 rounded p-1 text-muted hover:text-text">
          <Icon name="x" size={14} />
        </button>
      </header>
      <QuickAdd />
      {reminders.length > 0 && (
        <div>
          <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">Reminders</h3>
          <NoteList items={reminders.slice(0, CARD_MAX)} empty="" />
          {reminders.length > CARD_MAX && <p className="mt-1 text-[11px] text-muted">+{reminders.length - CARD_MAX} more in the full board</p>}
        </div>
      )}
      <div>
        <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">To do</h3>
        <NoteList items={tasks.slice(0, CARD_MAX)} empty="Nothing to do. Hand the CEO a task above." />
        {tasks.length > CARD_MAX && <p className="mt-1 text-[11px] text-muted">+{tasks.length - CARD_MAX} more in the full board</p>}
      </div>
    </section>
  );
}

// ── the overlay (expand the card) ────────────────────────────────────────────

export function BoardOverlay() {
  const mode = useUi((s) => s.board);
  usePrefs((s) => s.clock24);
  const { reminders, tasks, done } = useLists();
  useEffect(() => {
    if (mode !== 'overlay') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement).closest('input, select, textarea')) return;
      useUi.getState().setBoard('card');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);
  if (mode !== 'overlay') return null;
  const col = 'flex min-h-0 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-[#0b1220]/70 p-3';
  const head = 'font-mono text-[11px] uppercase tracking-[0.1em] text-muted';
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4" onPointerDown={(e) => e.target === e.currentTarget && useUi.getState().setBoard('card')}>
      <div role="dialog" aria-label="Mission board" className="flex max-h-[88vh] w-full max-w-[1040px] flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-[0_24px_64px_rgb(0_0_0/.6)]">
        <header className="flex items-center gap-3">
          <h2 className="font-display text-xl tracking-[0.1em]">MISSION BOARD</h2>
          <span className="font-mono text-[12px] text-muted">pinned by the CEO</span>
          <button onClick={() => useUi.getState().setBoard('card')} className="ml-auto rounded border border-border px-2.5 py-1 text-[12px] text-muted hover:text-text">
            Shrink
          </button>
          <button onClick={() => useUi.getState().setBoard('closed')} aria-label="Close the board" className="rounded p-1 text-muted hover:text-text">
            <Icon name="x" size={16} />
          </button>
        </header>
        <QuickAdd autoFocus />
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto md:grid-cols-3">
          <section className={col} aria-label="Reminders">
            <h3 className={head}>Reminders · {reminders.length}</h3>
            <NoteList items={reminders} empty="No reminders. Add one above, or type /remind in the chat." />
          </section>
          <section className={col} aria-label="To do">
            <h3 className={head}>To do · {tasks.length}</h3>
            <NoteList items={tasks} empty="Nothing to do." />
          </section>
          <section className={col} aria-label="Done">
            <h3 className={`${head} flex items-center`}>
              Done · {done.length}
              {done.length > 0 && (
                <button onClick={() => void boardOp({ op: 'clearDone' })} className="ml-auto rounded border border-border px-1.5 py-0.5 normal-case tracking-normal hover:text-text">
                  Clear
                </button>
              )}
            </h3>
            <NoteList items={done} empty="Finished notes land here." />
          </section>
        </div>
      </div>
    </div>
  );
}

// ── the alert ────────────────────────────────────────────────────────────────

const CHIME_EVERY_MS = 30_000;

/**
 * A reminder that has come due stays on screen (also in wallboard mode) until you mark it done or
 * snooze it, chimes again every 30 s, flashes the tab title, and, if browser notifications are on
 * and the tab is hidden, sends one.
 */
export function ReminderAlerts() {
  const { alerting } = useLists();
  const any = alerting.length > 0;

  useEffect(() => {
    if (!any) return;
    const t = setInterval(playReminder, CHIME_EVERY_MS);
    return () => clearInterval(t);
  }, [any]);

  useEffect(() => {
    if (!any) return;
    const original = document.title;
    const label = `🔔 ${alerting[0].text.slice(0, 40)}`;
    let on = false;
    const t = setInterval(() => (document.title = (on = !on) ? label : original), 1000);
    return () => {
      clearInterval(t);
      document.title = original;
    };
  }, [any, alerting]);

  const told = useRef(new Set<number>());
  useEffect(() => {
    for (const i of alerting) {
      if (told.current.has(i.id)) continue;
      told.current.add(i.id);
      if (!usePrefs.getState().notify || !document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') continue;
      try {
        const n = new Notification('Reminder', { body: i.text, tag: `ai-office-reminder-${i.id}`, requireInteraction: true, silent: true });
        n.onclick = () => {
          window.focus();
          useUi.getState().setBoard('card');
          n.close();
        };
      } catch {
        /* some browsers only allow notifications from a service worker */
      }
    }
  }, [alerting]);

  if (!any) return null;
  return (
    <div role="alert" aria-live="assertive" className="pointer-events-none fixed left-1/2 top-4 z-[3000] flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2">
      {alerting.map((i) => (
        <div key={i.id} className="pointer-events-auto rounded-xl border-2 border-warning bg-[#1d1708] p-4 shadow-[0_12px_40px_rgb(0_0_0/.6),0_0_28px_rgb(251_191_36/.35)]">
          <div className="flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.12em] text-warning">
            <span className="relative grid size-6 place-items-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-warning/40 motion-reduce:hidden" />
              <Icon name="bell" size={16} />
            </span>
            Reminder
            {i.due !== undefined && <span className="ml-auto text-warning/70">{timeOfDay(i.due)}</span>}
          </div>
          <p className="mt-2 break-words text-[18px] font-medium leading-snug">{i.text}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            <button onClick={() => void boardOp({ op: 'ack', id: i.id })} className="rounded-md bg-warning px-3 py-1.5 font-medium text-[#1d1708]">
              {i.repeat ? 'Got it' : 'Done'}
            </button>
            <button onClick={() => void boardOp({ op: 'snooze', id: i.id, minutes: 10 })} className="rounded-md border border-warning/50 px-3 py-1.5 text-warning hover:bg-warning/10">
              Snooze 10 min
            </button>
            <button onClick={() => void boardOp({ op: 'snooze', id: i.id, minutes: 60 })} className="rounded-md border border-warning/50 px-3 py-1.5 text-warning hover:bg-warning/10">
              1 hour
            </button>
            <button onClick={() => useUi.getState().setBoard('overlay')} className="ml-auto text-[12px] text-muted hover:text-text">
              Open board
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
