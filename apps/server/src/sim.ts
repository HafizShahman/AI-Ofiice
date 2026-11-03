import type { HookPayload } from './hooks.ts';

/**
 * Scripted demo: plays fake Claude Code hook payloads through the real pipeline,
 * so the office can be shown (and developed) without a live session.
 */
const S1 = 'sim-session-tackld';
const S2 = 'sim-session-ai-office';
const C1 = '/Users/demo/Projects/tackld';
const C2 = '/Users/demo/Projects/ai-office';

type Step = [delayMs: number, payload: HookPayload];

const tool = (session: string, cwd: string, name: string, input: Record<string, unknown>, agent?: [string, string]): Step[] => [
  [900, { hook_event_name: 'PreToolUse', session_id: session, cwd, tool_name: name, tool_input: input, agent_id: agent?.[0], agent_type: agent?.[1] }],
  [700, { hook_event_name: 'PostToolUse', session_id: session, cwd, tool_name: name, tool_input: input, agent_id: agent?.[0], agent_type: agent?.[1] }],
];

const RS: [string, string] = ['sim-researcher', 'Explore'];
const AR: [string, string] = ['sim-architect', 'Plan'];

/** What the demo agents "run on", keyed by agent_id (subagents) or session_id (leads). */
const DEMO: Record<string, [model: string, effort: string]> = {
  [S1]: ['claude-opus-5-5', 'high'],
  [S2]: ['claude-sonnet-5-5', 'medium'],
  [RS[0]]: ['claude-haiku-5-5', 'low'],
  [AR[0]]: ['claude-opus-5-5', 'xhigh'],
};

const SCRIPT: Step[] = [
  [500, { hook_event_name: 'SessionStart', session_id: S1, cwd: C1, source: 'startup' }],
  [1500, { hook_event_name: 'UserPromptSubmit', session_id: S1, cwd: C1 }],
  ...tool(S1, C1, 'Read', { file_path: `${C1}/src/components/TaskCard.tsx` }),
  ...tool(S1, C1, 'Task', { subagent_type: 'Explore', description: 'Find the Vite docs' }),
  [300, { hook_event_name: 'SubagentStart', session_id: S1, cwd: C1, agent_id: RS[0], agent_type: RS[1] }],
  [400, { hook_event_name: 'SubagentStart', session_id: S1, cwd: C1, agent_id: AR[0], agent_type: AR[1] }],
  ...tool(S1, C1, 'Edit', { file_path: `${C1}/src/components/TaskCard.tsx` }),
  ...tool(S1, C1, 'Grep', { pattern: 'useTasks' }, RS),
  ...tool(S1, C1, 'Read', { file_path: `${C1}/PLAN.md` }, AR),
  [600, { hook_event_name: 'SessionStart', session_id: S2, cwd: C2, source: 'startup' }],
  ...tool(S2, C2, 'Bash', { command: 'npm test -- --reporter=dot' }),
  [400, { hook_event_name: 'PermissionRequest', session_id: S1, cwd: C1, tool_name: 'WebFetch', tool_input: { url: 'https://vite.dev/guide/' }, agent_id: RS[0], agent_type: RS[1] }],
  ...tool(S1, C1, 'TodoWrite', { todos: [] }, AR),
  [900, { hook_event_name: 'PostToolUseFailure', session_id: S2, cwd: C2, tool_name: 'Bash', tool_input: { command: 'npm test' } }],
  ...tool(S2, C2, 'Edit', { file_path: `${C2}/apps/server/src/state.ts` }),
  ...tool(S1, C1, 'Write', { file_path: `${C1}/src/components/TaskList.tsx` }),
  [9000, { hook_event_name: 'PostToolUse', session_id: S1, cwd: C1, tool_name: 'WebFetch', tool_input: { url: 'https://vite.dev/guide/' }, agent_id: RS[0], agent_type: RS[1] }],
  ...tool(S1, C1, 'WebFetch', { url: 'https://vite.dev/guide/' }, RS),
  [800, { hook_event_name: 'SubagentStop', session_id: S1, cwd: C1, agent_id: RS[0], agent_type: RS[1] }],
  ...tool(S2, C2, 'Bash', { command: 'npm test' }),
  [1200, { hook_event_name: 'Stop', session_id: S2, cwd: C2 }],
  [1500, { hook_event_name: 'SubagentStop', session_id: S1, cwd: C1, agent_id: AR[0], agent_type: AR[1] }],
  [1200, { hook_event_name: 'Stop', session_id: S1, cwd: C1 }],
  [6000, { hook_event_name: 'SessionEnd', session_id: S2, cwd: C2, reason: 'prompt_input_exit' }],
];

export class Sim {
  private timer: NodeJS.Timeout | null = null;
  private feed: (p: HookPayload) => void;

  constructor(feed: (p: HookPayload) => void) {
    this.feed = feed;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    let i = 0;
    const next = () => {
      const [delay, payload] = SCRIPT[i % SCRIPT.length];
      this.timer = setTimeout(() => {
        const demo = DEMO[payload.agent_id ?? payload.session_id ?? ''];
        this.feed(demo ? { ...payload, model: demo[0], effort: { level: demo[1] } } : payload);
        i++;
        if (i % SCRIPT.length === 0) this.timer = setTimeout(next, 8000); // pause, then loop
        else next();
      }, delay);
    };
    next();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
