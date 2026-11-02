import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SettingsInfo } from '@ai-office/shared';
import { config, ROOT } from './config.ts';
import { MODELS } from './chat.ts';

/** The header scripts/install-hooks.mjs puts on every hook it writes. */
const MARK = 'X-AI-Office';

interface HookGroup {
  hooks?: { url?: string; timeout?: number; headers?: Record<string, string> }[];
}

/** Look for AI Office hooks in the Claude Code settings files this server can read (user, then this project's local file). */
function findHooks(): SettingsInfo['hooks'] {
  const files = [join(homedir(), '.claude', 'settings.json'), join(ROOT, '.claude', 'settings.local.json')];
  const readable = files.filter((f) => existsSync(f));
  if (!readable.length) return { installed: null, file: null, url: null, permissionTimeoutSec: null };
  for (const file of readable) {
    try {
      const hooks = (JSON.parse(readFileSync(file, 'utf8')) as { hooks?: Record<string, HookGroup[]> }).hooks ?? {};
      const ours = (g: HookGroup) => (g.hooks ?? []).find((h) => h.headers?.[MARK]);
      const first = Object.values(hooks).flat().map(ours).find(Boolean);
      if (!first) continue;
      const perm = (hooks.PermissionRequest ?? []).map(ours).find(Boolean);
      return { installed: true, file, url: first.url ?? null, permissionTimeoutSec: perm?.timeout ?? null };
    } catch {
      /* unreadable or not JSON: treat as not installed */
    }
  }
  return { installed: false, file: null, url: null, permissionTimeoutSec: null };
}

export function settingsInfo(): SettingsInfo {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string };
  return {
    version: pkg.version ?? '0.0.0',
    hooks: findHooks(),
    roles: config.roles,
    timers: config.timers,
    desks: config.desks,
    models: MODELS,
  };
}
