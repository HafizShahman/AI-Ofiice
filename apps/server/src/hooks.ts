import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { EventKind, OfficeEvent } from '@ai-office/shared';

/** The parts of a Claude Code hook payload we read. Everything else is ignored and never stored. */
export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  message?: string;
  /** Notification only: permission_prompt, idle_prompt, auth_success, elicitation_dialog… */
  notification_type?: string;
  [key: string]: unknown;
}

const KIND: Record<string, EventKind> = {
  SessionStart: 'spawn',
  SessionEnd: 'leave',
  SubagentStart: 'spawn',
  SubagentStop: 'leave',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool_start',
  PostToolUse: 'tool_end',
  PostToolUseFailure: 'tool_fail',
  PermissionRequest: 'blocked',
  Notification: 'notify',
  Stop: 'turn_done',
  TaskCreated: 'task_created',
  TaskCompleted: 'task_done',
  PreCompact: 'compact',
};

/** Turn one hook POST into an office event, or null for events we don't visualise. */
export function normalize(p: HookPayload): OfficeEvent | null {
  const name = p.hook_event_name ?? '';
  let kind = KIND[name];
  if (!kind || !p.session_id) return null;
  // the harness's internal hand-back call at the end of every subagent; not a real tool
  if (p.tool_name === 'SubagentHandback') return null;

  // A permission prompt notification also means the agent is waiting on you. "Claude is waiting
  // for your input" (idle_prompt) does NOT: the turn is over and nothing needs approving.
  if (kind === 'notify') {
    const t = p.notification_type;
    if (t ? t === 'permission_prompt' : /needs your permission|permission to use/i.test(String(p.message ?? ''))) kind = 'blocked';
  }

  const isSub = Boolean(p.agent_id);
  const cwd = p.cwd ?? '';
  return {
    id: randomUUID(),
    ts: Date.now(),
    sessionId: p.session_id,
    agentId: isSub ? String(p.agent_id) : p.session_id,
    parentAgentId: isSub ? p.session_id : undefined,
    kind,
    tool: p.tool_name,
    summary: p.tool_name ? summarize(p.tool_name, p.tool_input ?? {}) || undefined : undefined,
    cwd,
    project: cwd ? basename(cwd) : 'unknown',
    agentType: p.agent_type,
  };
}

// ── redaction ──────────────────────────────────────────────────────────────

const SECRET_ASSIGN = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi;
const LONG_TOKEN = /[A-Za-z0-9_\-+/=]{24,}/g;

export function redact(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').replace(SECRET_ASSIGN, '$1=••••').replace(LONG_TOKEN, '••••').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * A longer, still-redacted line for a pending permission (shown on the Allow / Deny buttons so you
 * can see what you're approving). Kept in memory only while the request is open; never stored.
 */
export function permissionDetail(tool: string, input: Record<string, unknown>): string {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  switch (tool) {
    case 'Bash':
      return redact(str(input.command), 300);
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'Read':
      return file ? redact(file.split('/').slice(-3).join('/'), 120) : tool;
    case 'WebFetch':
      try {
        const u = new URL(str(input.url));
        return redact(u.host + u.pathname, 120);
      } catch {
        return 'a web page';
      }
    default:
      return summarize(tool, input) || tool;
  }
}

/** One short, safe line about a tool call: file basename, truncated command, host — never the full input. */
export function summarize(tool: string, input: Record<string, unknown>): string {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'Read':
      return file ? basename(file) : '';
    case 'Bash':
      return redact(str(input.command));
    case 'Grep':
    case 'Glob':
      return redact(str(input.pattern), 40);
    case 'WebFetch':
      try {
        return new URL(str(input.url)).hostname;
      } catch {
        return 'web page';
      }
    case 'WebSearch':
      return redact(str(input.query), 40);
    case 'Task':
    case 'Agent':
      return redact(str(input.subagent_type) || str(input.description), 40);
    default:
      if (tool.startsWith('mcp__')) {
        const [, server = '', action = ''] = tool.split('__');
        return `${server} · ${action}`;
      }
      return '';
  }
}
