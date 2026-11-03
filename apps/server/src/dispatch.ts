import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import type { DispatchState } from '@ai-office/shared';
import { saveSetting, setting } from './db.ts';
import { redact } from './hooks.ts';
import { checkAvailable, claudeCommand, parseStream } from './manager.ts';

/**
 * Tasks from the office: start a NEW `claude -p` agent in a project folder. Nothing is sent into a
 * running terminal session (Claude Code has no way to do that). The agent is a normal Claude Code
 * session, so the hooks bring its robot into the office; its final reply is posted to its DM.
 *
 * Opt-in and safe by default: off until switched on, read-only (`plan`) permission mode unless the
 * user picks `acceptEdits`, and only folders saved in Settings or where the office has seen an agent work.
 */

const MAX_TASK = 4000;
const MAX_RUNNING = 3;
const LIMIT_MS = 30 * 60_000;
const MAX_KEPT_PROJECTS = 12;
const MAX_SAVED_FOLDERS = 30;
const MAX_OUT = 4_000_000;

export interface DispatchDeps {
  /** is there a robot for this session id yet? (the hooks may not be installed) */
  hasAgent(id: string): boolean;
  /** an update to publish */
  changed(): void;
  /** the task finished, failed or was stopped */
  finished(r: { id: string; project: string; task: string; ok: boolean; stopped: boolean; text: string }): void;
  /** the hooks did not bring a robot in, so the user can't watch it */
  noRobot(id: string, project: string): void;
}

interface Running {
  id: string;
  task: string;
  cwd: string;
  project: string;
  startedAt: number;
  child: ChildProcess;
  stopped: boolean;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export class Dispatcher {
  enabled: boolean;
  mode: DispatchState['mode'];
  available: boolean | null = null;
  private deps: DispatchDeps;
  private running = new Map<string, Running>();
  private seen: string[];
  /** folders the user added by hand in Settings: always offered, never pushed out by the seen list */
  private saved: string[];
  /** folders the user removed from the list: never offered again until added by hand */
  private hidden: string[];

  constructor(deps: DispatchDeps) {
    this.deps = deps;
    this.enabled = setting('dispatch_enabled') === '1';
    this.mode = setting('dispatch_mode') === 'acceptEdits' ? 'acceptEdits' : 'plan';
    try {
      const hidden = JSON.parse(setting('dispatch_hidden') ?? '[]') as unknown;
      this.hidden = Array.isArray(hidden) ? hidden.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      this.hidden = [];
    }
    try {
      const saved = JSON.parse(setting('dispatch_projects') ?? '[]') as unknown;
      this.seen = Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string').slice(0, MAX_KEPT_PROJECTS) : [];
    } catch {
      this.seen = [];
    }
    try {
      const saved = JSON.parse(setting('dispatch_folders') ?? '[]') as unknown;
      this.saved = Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string').slice(0, MAX_SAVED_FOLDERS) : [];
    } catch {
      this.saved = [];
    }
    if (this.enabled) void this.refreshAvailable();
  }

  /** Save a folder by path (`~` allowed). It must be an absolute path to an existing folder. */
  addFolder(raw: string): { ok: true } | { ok: false; error: string } {
    let p = raw.trim();
    if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1));
    if (!p || !isAbsolute(p)) return { ok: false, error: 'Use the full path, like /Users/you/project (or ~/project).' };
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      return { ok: false, error: `No folder at ${p}.` };
    }
    if (!isDir(real)) return { ok: false, error: `${p} is not a folder.` };
    if (this.hidden.includes(real)) {
      this.hidden = this.hidden.filter((p) => p !== real);
      saveSetting('dispatch_hidden', JSON.stringify(this.hidden));
    }
    if (this.saved.includes(real)) return { ok: true };
    if (this.saved.length >= MAX_SAVED_FOLDERS) return { ok: false, error: `At most ${MAX_SAVED_FOLDERS} saved folders. Remove one first.` };
    this.saved = [...this.saved, real];
    saveSetting('dispatch_folders', JSON.stringify(this.saved));
    this.deps.changed();
    return { ok: true };
  }

  /** Remove any folder from the list, added or seen. A seen folder stays hidden until it is added again. */
  removeFolder(path: string): void {
    this.saved = this.saved.filter((p) => p !== path);
    saveSetting('dispatch_folders', JSON.stringify(this.saved));
    this.seen = this.seen.filter((p) => p !== path);
    saveSetting('dispatch_projects', JSON.stringify(this.seen));
    if (!this.hidden.includes(path)) {
      this.hidden = [...this.hidden, path];
      saveSetting('dispatch_hidden', JSON.stringify(this.hidden));
    }
    this.deps.changed();
  }

  private folders(): { path: string; name: string; saved: boolean }[] {
    const all = [...this.saved, ...this.seen.filter((p) => !this.saved.includes(p))];
    return all.filter(isDir).map((path) => ({ path, name: basename(path), saved: this.saved.includes(path) }));
  }

  /** Note a folder an agent worked in; the most recent comes first. */
  remember(cwd: string): void {
    if (!cwd || this.seen[0] === cwd || this.hidden.includes(cwd)) return;
    this.seen = [cwd, ...this.seen.filter((p) => p !== cwd)].slice(0, MAX_KEPT_PROJECTS);
    saveSetting('dispatch_projects', JSON.stringify(this.seen));
    this.deps.changed();
  }

  state(): DispatchState {
    return {
      enabled: this.enabled,
      mode: this.mode,
      projects: this.folders(),
      last: setting('dispatch_last') ?? null,
      running: [...this.running.values()].map((r) => ({ id: r.id, task: r.task.slice(0, 200), project: r.project, startedAt: r.startedAt })),
      available: this.available,
    };
  }

  async setEnabled(on: boolean): Promise<void> {
    this.enabled = on;
    saveSetting('dispatch_enabled', on ? '1' : '0');
    this.deps.changed();
    if (on) await this.refreshAvailable();
  }

  setMode(mode: string): void {
    if (mode !== 'plan' && mode !== 'acceptEdits') return;
    this.mode = mode;
    saveSetting('dispatch_mode', mode);
    this.deps.changed();
  }

  private async refreshAvailable(): Promise<void> {
    this.available = await checkAvailable();
    this.deps.changed();
  }

  /** The folder a task may run in: one saved in Settings or seen with an agent, and it must still exist. */
  resolve(cwd: string | undefined): string | null {
    if (!cwd || !(this.saved.includes(cwd) || this.seen.includes(cwd)) || !isDir(cwd)) return null;
    return cwd;
  }

  /** Start a task. Returns the new agent's id (its DM is `dm:<id>`) or why not. */
  start(task: string, cwd: string): { ok: true; id: string; project: string } | { ok: false; error: string } {
    if (!this.enabled) return { ok: false, error: 'Tasks from the office are off. Turn them on in Settings, or with `/tasks on`.' };
    const text = task.trim().slice(0, MAX_TASK);
    if (!text) return { ok: false, error: 'Write the task first.' };
    const dir = this.resolve(cwd);
    if (!dir) return { ok: false, error: 'Unknown project folder. Add it in Settings → Folder, or start Claude Code there once.' };
    if (this.running.size >= MAX_RUNNING) return { ok: false, error: `${MAX_RUNNING} tasks are already running. Wait for one to finish or stop it.` };

    const id = randomUUID();
    const args = ['-p', '--permission-mode', this.mode, '--output-format', 'stream-json', '--verbose', '--session-id', id];
    const child = spawn(claudeCommand(), args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    const run: Running = { id, task: text, cwd: dir, project: basename(dir), startedAt: Date.now(), child, stopped: false };
    this.running.set(id, run);
    saveSetting('dispatch_last', dir);

    let out = '';
    let err = '';
    let done = false;
    const finish = (ok: boolean, body: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(watch);
      this.running.delete(id);
      this.deps.changed();
      this.deps.finished({ id, project: run.project, task: text, ok, stopped: run.stopped, text: body });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(false, `Stopped after ${LIMIT_MS / 60_000} minutes.`);
    }, LIMIT_MS);
    // if the hooks are not installed no robot appears: say so once, so the silence isn't a mystery
    const watch = setTimeout(() => {
      if (!done && !this.deps.hasAgent(id)) this.deps.noRobot(id, run.project);
    }, 20_000);
    child.stdout.on('data', (d: Buffer) => {
      out += d;
      if (out.length > MAX_OUT) out = out.slice(-MAX_OUT / 2); // keep the tail: the result line is last
    });
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish(false, e.code === 'ENOENT' ? "Couldn't find Claude Code on this machine. Set `ai.command` in office.config.json." : `Couldn't start Claude Code: ${e.message}`),
    );
    child.on('close', (code) => {
      // redact line by line so the reply keeps its line breaks
      const text = parseStream(out).text.split('\n').map((l) => redact(l, 1000)).join('\n').slice(0, MAX_TASK);
      if (run.stopped) return finish(false, text || 'Stopped.');
      if (code === 0 && text) return finish(true, text);
      finish(false, `Exit ${code}. ${redact(err || text, 300)}`);
    });
    child.stdin.end(text);
    this.deps.changed();
    return { ok: true, id, project: run.project };
  }

  stop(id: string): boolean {
    const r = this.running.get(id);
    if (!r) return false;
    r.stopped = true;
    r.child.kill('SIGTERM');
    return true;
  }

  /** Server shutting down: don't leave agents running that nobody can see. */
  stopAll(): void {
    for (const r of this.running.values()) r.child.kill('SIGTERM');
  }
}
