import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { AgentState, ChatMessage, OfficeEvent } from '@ai-office/shared';
import { config } from './config.ts';

/**
 * The Office Manager: answers questions about the office by running `claude -p` on this
 * machine with a compact, already-redacted picture of the office (agents + recent events +
 * recent chat). No tools, no hooks, no MCP, nothing saved: one cheap Haiku call per question.
 */

const CONFIGURED = process.env.OFFICE_AI_COMMAND ?? config.ai.command;
const IN_DDEV = process.env.IS_DDEV_PROJECT === 'true';

/**
 * Find the Claude Code binary. A shell alias (e.g. `alias claude=~/.claude/local/claude` from
 * the old local installer) is invisible to a spawned process, so look in PATH and then in the
 * usual install locations.
 */
function findClaude(): string {
  if (CONFIGURED) return CONFIGURED;
  const home = homedir();
  const candidates = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'claude')),
    join(home, '.local', 'bin', 'claude'), // native installer
    join(home, '.claude', 'local', 'claude'), // old "local" npm install (shell alias)
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.bun', 'bin', 'claude'),
  ];
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return 'claude';
}

let COMMAND = findClaude();
console.log(`Office Manager command: ${COMMAND}${IN_DDEV ? ' (inside DDEV)' : ''}`);
const TIMEOUT_MS = (config.ai.timeoutSec ?? 60) * 1000;

/** Session ids of our own `claude -p` runs, so their hook events (if any slip through) are ignored. */
export const ownSessions = new Set<string>();

const fmtTime = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
const ago = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

export function describeAgent(a: AgentState, all: Map<string, AgentState>, now = Date.now()): string {
  const parent = a.parentId ? all.get(a.parentId) : undefined;
  const parts = [
    `${a.name} (role ${a.role}${a.agentType ? `, ${a.agentType}` : ''})`,
    `project ${a.project}`,
    a.parentId ? `subagent of ${parent?.name ?? 'a session that left'}` : 'main session',
    `status ${a.status} for ${ago(now - a.statusSince)}`,
    `doing: ${a.activity}`,
  ];
  if (a.tool) parts.push(`last tool ${a.tool}${a.summary ? ` "${a.summary}"` : ''}`);
  if (a.status === 'blocked') parts.push('WAITING FOR THE USER TO APPROVE A PERMISSION in the terminal');
  parts.push(`${a.counts.tools} tool calls, ${a.counts.edits} edits, ${a.counts.commands} commands, ${a.counts.failures} failed`);
  parts.push(`in the office ${ago(now - a.startedAt)}`);
  return '- ' + parts.join('; ');
}

export function buildContext(opts: {
  agents: Map<string, AgentState>;
  events: OfficeEvent[];
  chat: ChatMessage[];
  doneToday: number;
  sim: boolean;
}): string {
  const { agents, events, chat } = opts;
  const now = Date.now();
  const name = (id: string) => agents.get(id)?.name ?? (id.startsWith('sim-') ? 'demo agent' : 'an agent that left');
  const list = [...agents.values()];
  const count = (f: (a: AgentState) => boolean) => list.filter(f).length;
  const lines = [
    `Now: ${new Date(now).toString().slice(0, 24)}`,
    opts.sim ? 'NOTE: the demo simulation is running; demo agents are not real Claude Code sessions.' : '',
    `Office: ${count((a) => a.status === 'working' || a.status === 'arriving')} working, ${count((a) => a.status === 'blocked')} blocked, ${count((a) => ['idle', 'break', 'charging'].includes(a.status))} idle, ${opts.doneToday} turns finished today.`,
    '',
    'Agents in the office:',
    ...(list.length ? list.map((a) => describeAgent(a, agents, now)) : ['(nobody)']),
    '',
    `Recent events, oldest first (${events.length}):`,
    ...events.map((e) => `${fmtTime(e.ts)} ${name(e.agentId)} [${e.project}] ${e.kind}${e.tool ? ` ${e.tool}` : ''}${e.summary ? ` "${e.summary}"` : ''}`),
  ];
  if (chat.length) {
    lines.push('', 'Earlier in this conversation:');
    for (const m of chat) lines.push(`${m.author === 'you' ? 'User' : m.name ?? 'Office Manager'}: ${m.body.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  return lines.filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n');
}

const BASE = `You are the Office Manager of "AI Office", a small app that shows the user's Claude Code agents as robots in a sci-fi office. You only know what is in the OFFICE STATE the user message gives you: the agents, their status and their recent tool events. Answer the user's question from it.
Rules:
- Be brief: one to four short sentences, or a short "- " list. No headings, no tables.
- Use agent names exactly as written (e.g. "Lead Engineer #2") so the app can link them.
- Put file names, commands and hosts in \`backticks\`.
- If the state doesn't answer the question, say what you can see instead. Never invent files, results or agents.
- You can't control agents or approve permissions. For a blocked agent, tell the user to answer the prompt in that agent's terminal.`;

export function systemPrompt(asAgent?: AgentState): string {
  if (!asAgent) return BASE;
  return `${BASE}
- In this conversation you speak AS "${asAgent.name}" (${asAgent.role}, project ${asAgent.project}), in the first person, about your own work. Base it only on your own events in the state; you don't remember anything beyond them.`;
}

export interface AskResult {
  ok: boolean;
  text: string;
}

/** One `claude -p` call. Never throws. */
export function ask(system: string, prompt: string): Promise<AskResult> {
  const sessionId = randomUUID();
  ownSessions.add(sessionId);
  const args = [
    '-p',
    '--model', config.ai.model,
    '--system-prompt', system,
    '--tools', '',
    '--max-turns', '1',
    '--output-format', 'text',
    '--session-id', sessionId,
    '--no-session-persistence',
    '--strict-mcp-config',
    '--settings', JSON.stringify({ disableAllHooks: true }),
  ];
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: AskResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      setTimeout(() => ownSessions.delete(sessionId), 60_000).unref();
      resolve(r);
    };
    // run outside any project so project hooks/CLAUDE.md don't load
    const child = spawn(COMMAND, args, { cwd: tmpdir(), env: { ...process.env, AI_OFFICE_INTERNAL: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, text: `The Office Manager took longer than ${TIMEOUT_MS / 1000}s and was stopped.` });
    }, TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({
        ok: false,
        text:
          e.code === 'ENOENT'
            ? IN_DDEV
              ? "The office server is running inside DDEV, where Claude Code isn't installed. Run `ddev stop`, then `npm run dev` on your Mac, and open http://127.0.0.1:5173."
              : `Couldn't find Claude Code (\`${COMMAND}\`) on this Mac: not in the server's PATH or the usual install folders. Run \`which claude\` in a terminal and put that path in \`ai.command\` in office.config.json, then restart \`npm run dev\`.`
            : `Couldn't start \`${COMMAND}\`: ${e.message}`,
      }),
    );
    child.on('close', (code) => {
      const text = out.trim();
      if (code === 0 && text) finish({ ok: true, text });
      else finish({ ok: false, text: `The Office Manager failed (exit ${code}). ${(err.trim() || text).split('\n').slice(-3).join(' ').slice(0, 300)}` });
    });
    child.stdin.end(prompt);
  });
}

/** Can we run the command at all? (`claude --version`) */
export function checkAvailable(): Promise<boolean> {
  if (!CONFIGURED) COMMAND = findClaude(); // it may have been installed since the server started
  return new Promise((resolve) => {
    const child = spawn(COMMAND, ['--version'], { cwd: tmpdir(), stdio: 'ignore' });
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
}
