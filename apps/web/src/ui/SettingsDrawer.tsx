import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SettingsInfo } from '@ai-office/shared';
import { useDaylight, type Mode } from '../scene/daylight.ts';
import { previewVolume, toggleSound } from '../sound/cues.ts';
import { useSound } from '../sound/engine.ts';
import { setAi, setAiOptions, setApprovals, setApprovalWait, setDispatch, addFolder, removeFolder, toggleSim, useOffice } from '../store.ts';
import { Icon } from './icons.tsx';
import { ACCENTS, setNotify, usePrefs, useUi, type Accent, type Quality } from './prefs.ts';

const INSTALL = 'npm run install-hooks';

/** UI-PLAN §4.7: the settings drawer. Server-side settings are saved on the server, the rest in this browser. */
export function SettingsDrawer() {
  const open = useUi((s) => s.settingsOpen);
  const close = () => useUi.getState().setSettings(false);
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeBtn.current?.focus();
    let live = true;
    fetch('/api/settings')
      .then((r) => (r.ok ? (r.json() as Promise<SettingsInfo>) : Promise.reject(new Error(String(r.status)))))
      .then((i) => live && (setInfo(i), setFailed(false)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60]" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <aside
        role="dialog"
        aria-label="Settings"
        className="absolute inset-y-0 right-0 flex w-[400px] max-w-full flex-col border-l border-border bg-surface shadow-[-12px_0_32px_rgb(0_0_0/.45)]"
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Icon name="gear" size={16} className="text-accent" />
          <h2 className="flex-1 font-display text-lg tracking-[0.08em]">SETTINGS</h2>
          <button ref={closeBtn} onClick={close} aria-label="Close settings" title="Close (Esc)" className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          <General />
          <Scene />
          <Ai info={info} />
          <Approvals info={info} />
          <Tasks />
          <Folder />
          <Notifications />
          <Hooks info={info} failed={failed} />
          <Roles info={info} />
          <About info={info} />
        </div>
      </aside>
    </div>
  );
}

// ── sections ────────────────────────────────────────────────────────────────

function General() {
  const accent = usePrefs((s) => s.accent);
  const clock24 = usePrefs((s) => s.clock24);
  const set = usePrefs((s) => s.set);
  return (
    <Section title="General">
      <Row label="Accent colour">
        <div className="flex gap-2" role="radiogroup" aria-label="Accent colour">
          {(Object.keys(ACCENTS) as Accent[]).map((a) => (
            <button
              key={a}
              role="radio"
              aria-checked={accent === a}
              aria-label={a}
              title={a}
              onClick={() => set({ accent: a })}
              className={`size-6 rounded-full border-2 ${accent === a ? 'border-text' : 'border-transparent'}`}
              style={{ background: ACCENTS[a] }}
            />
          ))}
        </div>
      </Row>
      <Row label="Clock" hint="Timestamps in chat and #activity">
        <Segmented label="Clock" value={clock24 ? '24' : '12'} options={[['24', '24 h'], ['12', '12 h']]} onChange={(v) => set({ clock24: v === '24' })} />
      </Row>
    </Section>
  );
}

const MODES: [Mode, string][] = [['auto', 'Auto'], ['day', 'Day'], ['night', 'Night']];
const QUALITIES: [Quality, string][] = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

function Scene() {
  const quality = usePrefs((s) => s.quality);
  const reduce = usePrefs((s) => s.reduceMotion);
  const view3d = usePrefs((s) => s.view3d);
  const set = usePrefs((s) => s.set);
  const mode = useDaylight((s) => s.mode);
  const sim = useOffice((s) => s.sim);
  return (
    <Section title="Scene">
      <Row label="3D room" hint="Off shows the painted 2D office (lighter on the GPU). In 3D, right-drag or Shift-drag turns the camera.">
        <Toggle label="3D room" on={view3d} onChange={(v) => set({ view3d: v })} />
      </Row>
      <Row label="Lighting" hint="Auto follows your clock (N)">
        <Segmented label="Lighting" value={mode} options={MODES} onChange={(m) => useDaylight.getState().setMode(m)} />
      </Row>
      <Row label="Resolution" hint="Caps the canvas pixel ratio: 1×, 1.5× or 2×. Lower is lighter on the GPU.">
        <Segmented label="Resolution" value={quality} options={QUALITIES} onChange={(q) => set({ quality: q })} />
      </Row>
      <Row label="Reduce motion" hint="The camera jumps instead of flying, and the wallboard tour stays still. Robots still walk.">
        <Toggle label="Reduce motion" on={reduce} onChange={(v) => set({ reduceMotion: v })} />
      </Row>
      <Row label="Demo" hint="Fills the office with simulated agents so you can see it work without Claude Code.">
        <Toggle label="Run demo" on={sim} onChange={(v) => void toggleSim(v)} />
      </Row>
    </Section>
  );
}

function Ai({ info }: { info: SettingsInfo | null }) {
  const ai = useOffice((s) => s.ai);
  const models = info?.models ?? ['haiku', 'sonnet', 'opus'];
  return (
    <Section title="Office Manager (AI)">
      <Row label="Answer questions with AI" hint="Runs one claude -p call per question, with your Claude Code login.">
        <Toggle label="Office Manager" on={ai.enabled} onChange={(v) => void setAi(v)} />
      </Row>
      {ai.enabled && ai.available === false && <Note tone="warn">The claude command was not found on the machine running the server.</Note>}
      <Row label="Model" hint="Haiku is fastest and cheapest.">
        <select
          aria-label="Model"
          value={ai.model}
          onChange={(e) => void setAiOptions({ model: e.target.value })}
          className="h-8 rounded-md border border-border bg-surface-2 px-2 text-[13px]"
        >
          {!models.includes(ai.model) && <option value={ai.model}>{ai.model}</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {m[0].toUpperCase() + m.slice(1)}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Context events" hint="How many recent events the manager sees. More costs more tokens.">
        <Slider label="Context events" value={ai.contextEvents} min={5} max={100} step={5} unit="" onCommit={(n) => void setAiOptions({ contextEvents: n })} />
      </Row>
    </Section>
  );
}

function Approvals({ info }: { info: SettingsInfo | null }) {
  const on = useOffice((s) => s.approvalsOn);
  const waitSec = useOffice((s) => s.approvalWaitSec);
  const timeout = info?.hooks.permissionTimeoutSec ?? null;
  // install-hooks gives the permission hook waitSec + 10 s; a longer wait than the installed one is cut short by Claude Code
  const short = timeout !== null && waitSec + 10 > timeout;
  return (
    <Section title="Approvals">
      <Row label="Approve from the office" hint="Hold permission prompts and questions so you can answer them here. Off: the terminal asks as usual.">
        <Toggle label="Approve from the office" on={on} onChange={(v) => void setApprovals(v)} />
      </Row>
      <Row label="Wait time" hint="After this long an unanswered request goes back to the terminal.">
        <Slider label="Wait time" value={waitSec} min={5} max={120} step={5} unit=" s" onCommit={(n) => void setApprovalWait(n)} />
      </Row>
      {short && (
        <Note tone="warn">
          Claude Code gives up on the held hook after {timeout} s. Re-run <code className="font-mono">{INSTALL} -- --wait {waitSec}</code> (plus your usual <code className="font-mono">--url</code> / <code className="font-mono">--settings</code>) so it waits that long.
        </Note>
      )}
    </Section>
  );
}

function Tasks() {
  const d = useOffice((s) => s.dispatch);
  return (
    <Section title="Tasks from the office">
      <Row label="Start agents from chat" hint="Adds a Task mode to the composer and /task. Each task starts a NEW claude -p agent in a project folder; nothing is sent into a running terminal. Off by default.">
        <Toggle label="Start agents from chat" on={d.enabled} onChange={(v) => void setDispatch({ enabled: v })} />
      </Row>
      {d.enabled && (
        <>
          <Row label="What a task may do" hint="Read-only: the agent investigates and proposes a plan, changes nothing. Can edit: it may also change files in the project (no shell commands without approval).">
            <Segmented label="Task permissions" value={d.mode} options={[['plan', 'Read-only'], ['acceptEdits', 'Can edit']]} onChange={(m) => void setDispatch({ mode: m })} />
          </Row>
          <Note tone="info">
            Needs the office server on the same machine as <code className="font-mono">claude</code>, and the hooks installed to see the robot.
            {d.available === false ? ' The claude command was not found.' : ''}
          </Note>
        </>
      )}
    </Section>
  );
}

/** Every folder the office knows: the ones you added (Remove) and the ones an agent has worked in. */
function Folder() {
  const projects = useOffice((s) => s.dispatch.projects);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    if (!path.trim()) return;
    const err = await addFolder(path);
    setError(err);
    if (!err) setPath('');
  };
  return (
    <Section title="Folder">
      <p className="text-[12px] text-muted">Folders you add here appear in the Task picker. Type the full path, e.g. <code className="font-mono">~/Sites/my-app</code>.</p>
      <div className="flex gap-2">
        <input
          aria-label="Folder path"
          value={path}
          placeholder="/Users/you/project or ~/project"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 font-mono text-[12px]"
        />
        <button onClick={() => void add()} className="rounded border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2">
          Add
        </button>
      </div>
      {error && <p role="alert" className="text-[12px] text-warning">{error}</p>}
      <ul className="space-y-1">
        {projects.map((p) => (
          <li key={p.path} className="flex items-center gap-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate font-mono" title={p.path}>
              {p.path}
            </span>
            {!p.saved && <span className="text-muted">seen</span>}
            <button aria-label={`Remove ${p.name}`} onClick={() => void removeFolder(p.path)} className="text-muted hover:text-warning">
              Remove
            </button>
          </li>
        ))}
        {!projects.length && <li className="text-[12px] text-muted">No folders yet.</li>}
      </ul>
    </Section>
  );
}

function Notifications() {
  const soundOn = useSound((s) => s.on);
  const volume = useSound((s) => s.volume);
  const notify = usePrefs((s) => s.notify);
  const supported = typeof Notification !== 'undefined';
  const denied = supported && Notification.permission === 'denied';
  return (
    <Section title="Notifications">
      <Row label="Sound" hint="Footsteps, typing and chimes (M)">
        <Toggle label="Sound" on={soundOn} onChange={() => void toggleSound()} />
      </Row>
      {soundOn && (
        <Row label="Volume">
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(e) => {
              useSound.getState().setVolume(Number(e.target.value) / 100);
              previewVolume();
            }}
            className="h-1 w-32 accent-accent"
          />
        </Row>
      )}
      <Row label="Notify when blocked" hint="A browser notification when an agent needs you and this tab is in the background.">
        <Toggle label="Browser notifications" on={notify} disabled={!supported || denied} onChange={(v) => void setNotify(v)} />
      </Row>
      {!supported && <Note>This browser has no notification support.</Note>}
      {denied && <Note tone="warn">Notifications are blocked for this site: allow them in the browser’s site settings, then switch this on.</Note>}
    </Section>
  );
}

function Hooks({ info, failed }: { info: SettingsInfo | null; failed: boolean }) {
  const [copied, setCopied] = useState(false);
  const h = info?.hooks;
  return (
    <Section title="Hooks">
      {failed ? (
        <Note tone="warn">Couldn’t reach the server.</Note>
      ) : !h ? (
        <Note>Checking…</Note>
      ) : h.installed === null ? (
        <Note>This server can’t see <code className="font-mono">~/.claude</code>, so it can’t tell. The first event from a session proves they work.</Note>
      ) : h.installed ? (
        <Note tone="ok">
          Installed in <code className="break-all font-mono">{h.file}</code>
          {h.url && (
            <>
              {' '}→ <code className="break-all font-mono">{h.url}</code>
            </>
          )}
        </Note>
      ) : (
        <Note tone="warn">No AI Office hooks found in your Claude Code settings. Run the installer on your Mac:</Note>
      )}
      <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{INSTALL}</code>
        <button
          aria-label="Copy the install command"
          title="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(INSTALL).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 hover:text-text"
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      </div>
      <p className="mt-1.5 text-[12px] text-muted">To use another server URL add <code className="font-mono">--url http://host:3334/hook</code>. Hooks load without restarting Claude Code.</p>
    </Section>
  );
}

function Roles({ info }: { info: SettingsInfo | null }) {
  if (!info) return null;
  const t = info.timers;
  return (
    <Section title="Roles and timers">
      <p className="mb-2 text-[12px] text-muted">Read-only. Edit <code className="font-mono">office.config.json</code> and restart the server.</p>
      <table className="w-full text-left text-[12.5px]">
        <tbody>
          {info.roles.map((r) => (
            <tr key={r.role} className="border-t border-border/60">
              <td className="py-1 pr-3 capitalize">{r.role}</td>
              <td className="py-1 font-mono text-[11.5px] text-muted">{r.match}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[12px] text-muted">
        {info.desks} desks · idle after {t.idleAfterSec} s · break after {t.breakAfterSec} s · charging after {t.chargeAfterSec} s
      </p>
    </Section>
  );
}

function About({ info }: { info: SettingsInfo | null }) {
  return (
    <Section title="About">
      <p className="text-[13px]">Claude AI Office{info ? ` · v${info.version}` : ''}</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
        Local only: nothing leaves your machine except the optional Office Manager’s <code className="font-mono">claude -p</code> calls.
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        “Mini Robot” by Onur,{' '}
        <a className="text-accent underline" href="https://sketchfab.com/3d-models/mini-robot-3454c84d6eff4a9dabbfadbfd1f56524" target="_blank" rel="noreferrer">
          sketchfab.com
        </a>
        , licensed{' '}
        <a className="text-accent underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
          CC BY 4.0
        </a>
        , modified (split into parts and animated in code).
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        Inspired by{' '}
        <a className="text-accent underline" href="https://github.com/W17ant/Claude-Office" target="_blank" rel="noreferrer">
          Claude-Office
        </a>{' '}
        by W17ant (MIT).
      </p>
      <p className="mt-2 text-[12px]">
        <a className="text-muted underline hover:text-text" href="?debug">
          Open the debug view
        </a>
      </p>
    </Section>
  );
}

// ── controls ────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border/70 py-4 last:border-b-0">
      <h3 className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{title}</h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode }) {
  const cls = tone === 'warn' ? 'border-warning/40 bg-warning/8 text-warning' : tone === 'ok' ? 'border-success/40 bg-success/8 text-success' : 'border-border text-muted';
  return <p className={`rounded-md border px-3 py-2 text-[12px] leading-snug ${cls}`}>{children}</p>;
}

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 rounded-full border transition-colors disabled:opacity-40 ${on ? 'border-accent bg-accent/30' : 'border-border bg-surface-2'}`}
    >
      <span className={`absolute top-0.5 size-3.5 rounded-full transition-all ${on ? 'left-[18px] bg-accent' : 'left-0.5 bg-muted'}`} />
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md border border-border p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`rounded px-2.5 py-1 text-[12px] ${value === v ? 'bg-accent/18 text-accent' : 'text-muted hover:text-text'}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A range input that shows the value while dragging and saves it when you let go. */
function Slider({ value, min, max, step, unit, onCommit, label }: { value: number; min: number; max: number; step: number; unit: string; onCommit: (n: number) => void; label: string }) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="h-1 w-28 accent-accent"
      />
      <span className="w-12 text-right font-mono text-[12px] tabular-nums">
        {shown}
        {unit}
      </span>
    </div>
  );
}
