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
