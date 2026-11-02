import type { Role } from '@ai-office/shared';
import { config } from './config.ts';

export const ROLE_LABEL: Record<Role, string> = {
  lead: 'Lead Engineer',
  researcher: 'Researcher',
  architect: 'Architect',
  engineer: 'Engineer',
  qa: 'QA',
  devops: 'DevOps',
  designer: 'Designer',
};

const rules = config.roles.map((r) => ({ role: r.role as Role, re: new RegExp(r.match, 'i') }));

/** Main sessions are the Lead Engineer; subagents get a role from their agent_type via office.config.json. */
export function resolveRole(agentType: string | undefined, isMain: boolean): Role {
  if (isMain) return 'lead';
  const t = agentType ?? '';
  for (const { role, re } of rules) if (re.test(t)) return role;
  return 'engineer';
}

/** A subagent whose type names its job (Explore, Plan, a reviewer…) keeps that role; general-purpose ones follow their work. */
export function rolePinned(agentType: string | undefined, isMain: boolean): boolean {
  if (isMain) return false;
  const t = agentType ?? '';
  return rules.some(({ role, re }) => role !== 'engineer' && re.test(t));
}

const TEST_CMD = /\b(test|jest|vitest|pytest|phpunit|playwright|cypress|lint|eslint|tsc|typecheck)\b/i;
const OPS_CMD = /\b(deploy|docker|kubectl|terraform|helm|ssh|ddev|systemctl|git push)\b/i;

/** The role a tool call looks like: reading and searching is research, plan tools are architecture, edits are engineering. Null = no signal. */
export function roleForTool(tool: string | undefined, summary: string | undefined): Role | null {
  const t = tool ?? '';
  const s = summary ?? '';
  if (['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'].includes(t) || t.startsWith('mcp__')) return 'researcher';
  if (['EnterPlanMode', 'ExitPlanMode', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(t)) return 'architect';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(t)) {
    if (/\.(test|spec)\./i.test(s)) return 'qa';
    if (/\.(css|scss|less|svg|html)$/i.test(s)) return 'designer';
    return 'engineer';
  }
  if (t === 'Bash') return TEST_CMD.test(s) ? 'qa' : OPS_CMD.test(s) ? 'devops' : null;
  if (t === 'Agent' || t === 'Task') return 'lead'; // delegating
  return null;
}

const TEXT_RULES: [Role, RegExp][] = [
  ['researcher', /\b(research|find|search|investigate|explore|look ?up|docs?|read)\b/i],
  ['architect', /\b(plan|architect|design the|approach|strategy)\b/i],
  ['qa', /\b(test|review|qa|debug|verify|check)\b/i],
  ['devops', /\b(deploy|ci|infra|devops|release|docker)\b/i],
  ['designer', /\b(ui|ux|design|frontend|css|style|layout)\b/i],
];

/** The role a task's wording suggests, or undefined. */
export function roleFromText(text: string): Role | undefined {
  return TEXT_RULES.find(([, re]) => re.test(text))?.[0];
}
