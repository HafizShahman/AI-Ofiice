import type { AiProviderInfo, Provider } from '@ai-office/shared';
import { config } from '../config.ts';
import { ask, checkAvailable as checkClaude, type AskResult } from '../manager.ts';
import { askCodex, checkCodex } from './codex.ts';

/**
 * The AIs the office can talk to. One is the default (saved as `ai_provider`); a task can name another.
 * Claude Code is the only one with the Artifact tool, so pages ("make a chart") are Claude-only.
 */

export const PROVIDERS: Provider[] = ['claude', 'codex'];
export const LABEL: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Aliases `claude --model` accepts. Codex: "default" leaves the model to Codex's own config; `/ai model <id>` takes any id. */
export const MODELS: Record<Provider, string[]> = { claude: ['haiku', 'sonnet', 'opus'], codex: ['default', 'gpt-5-codex', 'gpt-5'] };

export const isProvider = (v: unknown): v is Provider => v === 'claude' || v === 'codex';

export function validModel(p: Provider, model: string): boolean {
  return p === 'claude' ? MODELS.claude.includes(model) : /^[\w.:-]{1,64}$/.test(model);
}

export function info(models: Record<Provider, string>, available: Record<Provider, boolean | null>): AiProviderInfo[] {
  return PROVIDERS.map((id) => ({ id, label: LABEL[id], models: MODELS[id].includes(models[id]) ? MODELS[id] : [...MODELS[id], models[id]], model: models[id], available: available[id] }));
}

export const check = (p: Provider): Promise<boolean> => (p === 'codex' ? checkCodex() : checkClaude());

export interface AskWith {
  provider: Provider;
  model: string;
  /** Claude only; ignored for other providers */
  artifacts?: boolean;
}

export async function askAi(system: string, prompt: string, w: AskWith): Promise<AskResult> {
  const ms = (config.ai.timeoutSec ?? 60) * 1000;
  if (w.provider === 'codex') return askCodex(system, prompt, w.model, ms);
  return ask(system, prompt, { artifacts: w.artifacts, model: w.model });
}
