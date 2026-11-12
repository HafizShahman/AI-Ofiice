import type { Provider } from '@ai-office/shared';
import { config } from '../config.ts';
import type { HookPayload } from '../hooks.ts';
import { makeCli, runOnce } from './cli.ts';

/**
 * OpenAI Codex CLI hooks, mapped onto the Claude-shaped payload `normalize()` already understands.
 *
 * Codex runs command hooks that get a JSON object on stdin with the same field names Claude Code uses
 * (hook_event_name, session_id, cwd, tool_name, tool_input, model, transcript_path). What differs is
 * the vocabulary of the tools, so they are renamed here to the ones the office knows
 * (shell → Bash, apply_patch → Edit, …): roles, props and sounds all key off those names.
 *
 * Written from Codex's documentation, not yet run against a real Codex session; unknown fields are
 * ignored and unknown tools pass through unchanged, so a mismatch degrades to a generic "working" robot.
 */
export const PROVIDER: Provider = 'codex';

const SHELL = new Set(['shell', 'local_shell', 'exec_command', 'shell_command', 'container.exec', 'bash', 'Bash']);
const PATCH = new Set(['apply_patch', 'applypatch', 'Edit', 'Write']);
const WEB = new Set(['web_search', 'web.search']);

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(String).join(' ') : '');

/** The file a `*** Begin Patch` block touches first ("*** Update File: src/a.ts"), else ''. */
function patchFile(patch: string): string {
  return /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m.exec(patch)?.[1]?.trim() ?? '';
}

export function fromCodex(raw: HookPayload): HookPayload {
  const p: HookPayload = { ...raw };
  const input = rec(raw.tool_input);
  const tool = String(raw.tool_name ?? '');

  if (SHELL.has(tool)) {
    p.tool_name = 'Bash';
    p.tool_input = { command: text(input.command) || text(input.cmd) };
  } else if (PATCH.has(tool)) {
    p.tool_name = 'Edit';
    p.tool_input = { file_path: text(input.file_path) || patchFile(text(input.command) || text(input.input) || text(input.patch)) };
  } else if (WEB.has(tool)) {
    p.tool_name = 'WebSearch';
    p.tool_input = { query: text(input.query) };
  } else if (tool && !tool.startsWith('mcp__') && /^[\w.-]+$/.test(tool) && tool.includes('.') && !tool.includes('__')) {
    // some builds name MCP tools "server.tool"
    const [server, ...rest] = tool.split('.');
    p.tool_name = `mcp__${server}__${rest.join('.')}`;
  }

  // a task started from the office (AI_OFFICE_TASK_ID, added by scripts/codex-hook.mjs) uses that id as
  // its session, so its robot is `dm:<id>` from the start, as with Claude tasks
  if (typeof raw.office_task_id === 'string' && /^[\w-]{8,64}$/.test(raw.office_task_id)) p.session_id = raw.office_task_id;
  delete p.office_task_id;

  // Codex has no subagent hooks and no effort field; its model comes in the payload.
  delete p.agent_id;
  delete p.agent_type;
  return p;
}

// ── running Codex ───────────────────────────────────────────────────────────

const cli = makeCli('codex', () => process.env.OFFICE_CODEX_COMMAND ?? config.ai.codexCommand);
export const spawnCodex = cli.spawn;
export const checkCodex = cli.check;

/** `codex exec` arguments: read-only for questions and plan tasks, workspace-write for acceptEdits tasks. The prompt comes on stdin. */
export function execArgs(o: { cwd: string; sandbox: 'read-only' | 'workspace-write'; model: string; lastMessageFile: string }): string[] {
  return ['exec', '--skip-git-repo-check', '--sandbox', o.sandbox, '-C', o.cwd, '--output-last-message', o.lastMessageFile, ...(o.model && o.model !== 'default' ? ['-m', o.model] : []), '-'];
}

/** One question to Codex: read-only sandbox. Codex has no system prompt flag, so the rules go first in the prompt. */
export function askCodex(system: string, prompt: string, model: string, timeoutMs: number): Promise<{ ok: boolean; text: string }> {
  return runOnce(cli, {
    label: 'Codex',
    hint: 'Install it, or set `OFFICE_CODEX_COMMAND` / `ai.codexCommand`, then restart the server.',
    args: (dir, lastMessageFile) => execArgs({ cwd: dir, sandbox: 'read-only', model, lastMessageFile }),
    input: `${system}\n\n${prompt}`,
    timeoutMs,
    answerInFile: true,
  });
}
