#!/usr/bin/env node
// Adds AI Office command hooks to the Codex CLI's hooks file (with a backup), or removes them with --remove.
//
//   npm run install-codex-hooks
//   npm run install-codex-hooks -- --url http://host:3334/hook/codex
//   npm run install-codex-hooks -- --file /path/to/hooks.json     (default ~/.codex/hooks.json)
//   npm run uninstall-codex-hooks
//
// Codex only runs hooks when the feature is on: put `[features]` / `codex_hooks = true` in ~/.codex/config.toml
// (this script prints a reminder and does not edit the TOML).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const file = resolve(opt('--file', join(homedir(), '.codex', 'hooks.json')));
const url = opt('--url', '');
const forwarder = join(ROOT, 'scripts', 'codex-hook.mjs');
const MARK = 'codex-hook.mjs';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'];

// The URL goes in as an argument, not an env prefix: `VAR=x cmd` and single quotes mean nothing to Windows shells.
const q = process.platform === 'win32' ? (s) => `"${s}"` : (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const command = `${q(process.execPath)} ${q(forwarder)}${url ? ` ${q(url)}` : ''}`;

const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
if (existsSync(file)) {
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(file, backup);
  console.log(`Backup: ${backup}`);
}
cfg.hooks ??= {};
const ours = (g) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes(MARK));
for (const ev of Object.keys(cfg.hooks)) {
  cfg.hooks[ev] = cfg.hooks[ev].filter((g) => !ours(g));
  if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
}
if (!args.includes('--remove')) {
  for (const ev of EVENTS) (cfg.hooks[ev] ??= []).push({ ...(ev.endsWith('ToolUse') || ev === 'PermissionRequest' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: 5 }] });
  console.log(`Installed ${EVENTS.length} AI Office hooks for Codex.\nMake sure ~/.codex/config.toml has:\n  [features]\n  codex_hooks = true`);
} else {
  console.log('Removed the AI Office hooks from Codex.');
}
if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log(`Updated ${file}`);
