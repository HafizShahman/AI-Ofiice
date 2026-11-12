import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/** What every command-line AI (Codex) needs: find the binary, check it runs, ask it one question. */

const WINDOWS = process.platform === 'win32';

export interface Cli {
  /** the command in use */
  command(): string;
  spawn(args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams;
  /** can it run `--version`? Looks the binary up again first, since it may have been installed since the server started */
  check(): Promise<boolean>;
}

/** `configured` is an explicit path (env var or office.config.json); otherwise PATH and the usual install folders. */
export function makeCli(name: string, configured: () => string | undefined): Cli {
  const find = (): string => {
    const fixed = configured();
    if (fixed) return fixed;
    const names = WINDOWS ? [`${name}.exe`, `${name}.cmd`] : [name];
    const home = homedir();
    const dirs = [
      ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
      join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(home, '.npm-global', 'bin'),
      join(home, '.bun', 'bin'),
      ...(WINDOWS && process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : []),
    ];
    for (const d of dirs)
      for (const n of names) {
        try {
          accessSync(join(d, n), constants.X_OK);
          return join(d, n);
        } catch {
          /* next */
        }
      }
    return name;
  };
  let command = find();
  const spawnCommand = (args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams => {
    // npm installs CLI entry points as .cmd shims on Windows. Node cannot execute those shims
    // directly (spawn throws EINVAL), so bypass the shim and run the package entry point.
    if (WINDOWS && /\.(cmd|bat)$/i.test(command) && name === 'codex') {
      const entry = join(dirname(command), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(entry)) return spawn(process.execPath, [entry, ...args], options) as ChildProcessWithoutNullStreams;
    }
    return spawn(command, args, options) as ChildProcessWithoutNullStreams;
  };
  const cli: Cli = {
    command: () => command,
    spawn: spawnCommand,
    check() {
      command = find();
      return new Promise((resolve) => {
        let child: ChildProcessWithoutNullStreams;
        try {
          child = cli.spawn(['--version'], { cwd: tmpdir(), stdio: 'ignore' });
        } catch {
          resolve(false);
          return;
        }
        const t = setTimeout(() => {
          child.kill();
          resolve(false);
        }, 10_000);
        child.on('error', () => {
          clearTimeout(t);
          resolve(false);
        });
        child.on('close', (code) => {
          clearTimeout(t);
          resolve(code === 0);
        });
      });
    },
  };
  return cli;
}

export interface RunOnce {
  label: string;
  /** how to tell the user to point the office at the binary */
  hint: string;
  /** receives a scratch folder (the run's cwd) and the path of an answer file inside it */
  args(dir: string, answerFile: string): string[];
  /** goes to stdin */
  input: string;
  timeoutMs: number;
  /** true: the answer is the file `args` told the CLI to write (stdout is the fallback); false: stdout */
  answerInFile: boolean;
}

/** One question to a CLI AI, run outside any project. AI_OFFICE_INTERNAL makes the hook forwarder skip it, so it never shows as a robot. Never throws. */
export function runOnce(cli: Cli, o: RunOnce): Promise<{ ok: boolean; text: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'ai-office-ask-'));
  const answerFile = join(dir, 'answer.txt');
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: { ok: boolean; text: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve(r);
    };
    const child = cli.spawn(o.args(dir, answerFile), { cwd: dir, env: { ...process.env, AI_OFFICE_INTERNAL: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, text: `The Office Manager (${o.label}) took longer than ${o.timeoutMs / 1000}s and was stopped.` });
    }, o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ ok: false, text: e.code === 'ENOENT' ? `Couldn't find ${o.label} (\`${cli.command()}\`) on this machine. ${o.hint}` : `Couldn't start \`${cli.command()}\`: ${e.message}` }),
    );
    child.on('close', (code) => {
      let text = out.trim();
      if (o.answerInFile) {
        try {
          text = readFileSync(answerFile, 'utf8').trim() || text;
        } catch {
          /* stdout */
        }
      }
      if (code === 0 && text) finish({ ok: true, text });
      else finish({ ok: false, text: `The Office Manager (${o.label}) failed (exit ${code}). ${(err.trim() || text).split('\n').slice(-3).join(' ').slice(0, 300)}` });
    });
    child.stdin.end(o.input);
  });
}
