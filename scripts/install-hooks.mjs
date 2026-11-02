#!/usr/bin/env node
// Adds the AI Office HTTP hooks to Claude Code's settings (with a backup), or removes them with --remove.
//
//   npm run install-hooks                                   # local:  http://127.0.0.1:3334/hook
//   npm run install-hooks -- --url http://ai-office.ddev.site:3334/hook   # DDEV
//   npm run install-hooks -- --env                          # send the token from $OFFICE_TOKEN instead of storing it
//   npm run uninstall-hooks
//
// Run this on your Mac (not inside DDEV): it edits ~/.claude/settings.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const settingsPath = resolve(opt('--settings', join(homedir(), '.claude', 'settings.json')));
const url = opt('--url', 'http://127.0.0.1:3334/hook');
const MARK = 'X-AI-Office';

const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Stop',
  'Notification', 'PermissionRequest',
  'TaskCreated', 'TaskCompleted', 'PreCompact',
];

function token() {
  if (process.env.OFFICE_TOKEN) return process.env.OFFICE_TOKEN;
  const dir = resolve(process.env.DATA_DIR ?? join(ROOT, '.data'));
  const path = join(dir, 'token');
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return readFileSync(path, 'utf8').trim();
}

// "Approve from the office" (opt-in in the app) holds PermissionRequest calls open for up to
// approvals.waitSec, so that one hook gets a little longer than that; every other hook gets 1 s.
// Questions (AskUserQuestion) are answered through a second PreToolUse hook that matches only that
// tool and gets the same longer timeout: the plain PreToolUse hook still records the event at once,
// and the header below tells the server which copy is the one to hold.
const HOLD = 'X-AI-Office-Hold';
const officeConfig = JSON.parse(readFileSync(join(ROOT, 'office.config.json'), 'utf8'));
// --wait <sec> overrides office.config.json (Settings → Approvals saves the wait time in the app, not in the file)
const permissionTimeout = (Number(opt('--wait', '')) || (officeConfig.approvals?.waitSec ?? 45)) + 10;

const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
if (existsSync(settingsPath)) {
  const backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(settingsPath, backup);
  console.log(`Backup: ${backup}`);
}

settings.hooks ??= {};
const ours = (group) => (group.hooks ?? []).some((h) => h.headers?.[MARK]);

// drop any previous AI Office entries first, so re-running is safe
for (const ev of Object.keys(settings.hooks)) {
  settings.hooks[ev] = settings.hooks[ev].filter((g) => !ours(g));
  if (!settings.hooks[ev].length) delete settings.hooks[ev];
}

if (!flag('--remove')) {
  const useEnv = flag('--env');
  const hook = {
    type: 'http',
    url,
    timeout: 1,
    headers: { Authorization: useEnv ? 'Bearer $OFFICE_TOKEN' : `Bearer ${token()}`, [MARK]: '1' },
    ...(useEnv ? { allowedEnvVars: ['OFFICE_TOKEN'] } : {}),
  };
  for (const ev of EVENTS) (settings.hooks[ev] ??= []).push({ hooks: [ev === 'PermissionRequest' ? { ...hook, timeout: permissionTimeout } : hook] });
  settings.hooks.PreToolUse.push({ matcher: 'AskUserQuestion', hooks: [{ ...hook, timeout: permissionTimeout, headers: { ...hook.headers, [HOLD]: '1' } }] });
  console.log(`Installed ${EVENTS.length} AI Office hooks (+1 held hook for AskUserQuestion) → ${url}`);
  if (useEnv) console.log(`Add to your shell profile:\n  export OFFICE_TOKEN=${token()}`);
} else {
  console.log('Removed the AI Office hooks.');
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`Updated ${settingsPath}`);
