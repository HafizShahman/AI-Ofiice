#!/usr/bin/env node
// First-time setup: which AI do you use, which one is the default, and what this machine needs.
//
//   npm run setup                                   # asks
//   npm run setup -- --ai codex --yes               # no questions: Codex only
//   npm run setup -- --ai both --default codex --model gpt-5-codex --yes
//   npm run setup -- --server http://host:3334      # the office server runs on another machine
//   npm run setup -- --no-hooks                     # only save the choice
//
// It detects the system and the installed CLIs, saves the choice (to the running server, or straight into
// .data/office.db when it is not running) and runs the hook installer of each chosen AI.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = process.platform === 'win32';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};

const AIS = {
  claude: { label: 'Claude Code', bin: 'claude', models: ['haiku', 'sonnet', 'opus'], install: 'https://claude.com/claude-code', installer: 'install-hooks.mjs', hookPath: '/hook' },
  codex: { label: 'Codex', bin: 'codex', models: ['default', 'gpt-5-codex', 'gpt-5'], install: 'npm i -g @openai/codex', installer: 'install-codex-hooks.mjs', hookPath: '/hook/codex' },
};
const IDS = Object.keys(AIS);

/** Same lookup as the server (apps/server/src/providers/cli.ts): PATH, then the usual install folders. */
function find(name) {
  const names = WINDOWS ? [`${name}.exe`, `${name}.cmd`] : [name];
  const home = homedir();
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    ...(WINDOWS && process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : []),
  ];
  for (const d of dirs)
    for (const n of names) {
      try {
        accessSync(join(d, n), constants.X_OK);
        return join(d, n);
      } catch {
        /* next */
      }
    }
  return null;
}

const officeConfig = JSON.parse(readFileSync(join(ROOT, 'office.config.json'), 'utf8'));
const server = (opt('--server') ?? `http://127.0.0.1:${process.env.PORT ?? officeConfig.server?.port ?? 3334}`).replace(/\/+$/, '');
const remote = !!opt('--server') && !/\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]?/.test(server + '/');
const interactive = !flag('--yes') && process.stdin.isTTY && process.stdout.isTTY;
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
/** Ctrl+C / Ctrl+D at a question: leave quietly, nothing has been changed by the question itself. */
const ask = (q) =>
  rl.question(q).catch(() => {
    console.log('\nSetup cancelled.');
    process.exit(130);
  });

/** A numbered question; Enter takes the default. */
async function pick(question, options, fallback) {
  if (!rl) return fallback;
  console.log(`\n${question}`);
  options.forEach(([, text], i) => console.log(`  ${i + 1}) ${text}${options[i][0] === fallback ? '  (default)' : ''}`));
  for (;;) {
    const a = (await ask('> ')).trim().toLowerCase();
    if (!a) return fallback;
    const hit = options[Number(a) - 1] ?? options.find(([id]) => id === a);
    if (hit) return hit[0];
    console.log(`Type a number from 1 to ${options.length}.`);
  }
}
async function yes(question, fallback = true) {
  if (!rl) return fallback;
  const a = (await ask(`\n${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return a ? a.startsWith('y') : fallback;
}

// ── 1. the machine ───────────────────────────────────────────────────────────
const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] ?? process.platform;
const found = Object.fromEntries(IDS.map((id) => [id, find(AIS[id].bin)]));
console.log('AI Office setup\n');
console.log(`  System       ${OS} ${release()} (${process.arch}), Node ${process.version}`);
for (const id of IDS) console.log(`  ${AIS[id].label.padEnd(12)} ${found[id] ?? 'not found'}`);
console.log(`  Office       ${server}${remote ? '  (another machine)' : ''}`);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) console.log('\n! The office server needs Node 22.18 or newer. Update Node before `npm run dev`.');

// ── 2. which AI, which default, which model ──────────────────────────────────
const detected = found.claude && found.codex ? 'both' : found.codex ? 'codex' : 'claude';
let use = opt('--ai')?.toLowerCase();
if (use && ![...IDS, 'both'].includes(use)) {
  console.error(`--ai takes claude, codex or both (got "${use}").`);
  process.exit(1);
}
use ??= await pick('Which AI do you use?', [['claude', 'Claude Code'], ['codex', 'Codex (OpenAI)'], ['both', 'Both']], detected);
const chosen = use === 'both' ? IDS : [use];

let def = opt('--default')?.toLowerCase();
if (def && !chosen.includes(def)) {
  console.error(`--default must be one of the chosen AIs: ${chosen.join(', ')}.`);
  process.exit(1);
}
def ??= chosen.length === 1 ? chosen[0] : await pick('Which one is the default? It answers questions in the office and runs new tasks.', chosen.map((id) => [id, AIS[id].label]), 'claude');

const models = AIS[def].models;
let model = opt('--model');
model ??= await pick(
  `Model for ${AIS[def].label}?${def === 'codex' ? ' "default" leaves it to Codex\'s own config.' : ' Haiku is fastest and cheapest.'}`,
  models.map((m) => [m, m]),
  def === 'claude' ? (officeConfig.ai?.model ?? models[0]) : models[0],
);

for (const id of chosen) if (!found[id] && !remote) console.log(`\n! ${AIS[id].label} was not found on this machine. Install it (${AIS[id].install}), sign in once with \`${AIS[id].bin}\`, then run setup again or just start a session.`);

// ── 3. save the choice ───────────────────────────────────────────────────────
const body = { claude: chosen.includes('claude'), codex: chosen.includes('codex'), provider: def, model, setup: true };
let saved = false;
try {
  const r = await fetch(`${server}/api/ai`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server }, body: JSON.stringify(body), signal: AbortSignal.timeout(2500) });
  saved = r.ok;
  if (saved) console.log(`\nSaved to the running office (${server}).`);
} catch {
  /* not running: write the database instead */
}
if (!saved && remote) console.log(`\n! Couldn't reach ${server}. Start the office there and run setup again, or pick the AIs in its Settings → Office Manager.`);
if (!saved && !remote) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = resolve(process.env.DATA_DIR ?? join(ROOT, '.data'));
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'office.db'));
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    put.run('claude_enabled', body.claude ? '1' : '0');
    put.run('codex_enabled', body.codex ? '1' : '0');
    put.run('ai_provider', def);
    put.run(def === 'claude' ? 'ai_model' : `ai_model_${def}`, model);
    put.run('setup_done', '1');
    db.close();
    saved = true;
    console.log('\nSaved (the office reads it when it starts).');
  } catch (e) {
    console.log(`\n! Couldn't save the choice (${e.message}). Pick the AIs in the office instead: Settings → Office Manager.`);
  }
}

// ── 4. hooks for each chosen AI ──────────────────────────────────────────────
const node = (script, extra) => spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...extra], { stdio: 'inherit' }).status === 0;
if (!flag('--no-hooks')) {
  for (const id of chosen) {
    const where = id === 'claude' ? '~/.claude/settings.json' : '~/.codex/hooks.json';
    if (!(await yes(`Install the ${AIS[id].label} hooks in ${where}? (a backup is kept)`))) continue;
    const extra = remote || opt('--server') ? ['--url', server + AIS[id].hookPath] : [];
    if (!node(AIS[id].installer, extra)) console.log(`! The ${AIS[id].label} hook installer failed; run \`node scripts/${AIS[id].installer}\` to see why.`);
    else if (id === 'codex') await codexFeature();
  }
  // an AI that is no longer used should stop posting to the office
  for (const id of IDS.filter((i) => !chosen.includes(i))) {
    const file = id === 'claude' ? join(homedir(), '.claude', 'settings.json') : join(homedir(), '.codex', 'hooks.json');
    const mark = id === 'claude' ? 'X-AI-Office' : 'codex-hook.mjs';
    if (existsSync(file) && readFileSync(file, 'utf8').includes(mark) && (await yes(`${AIS[id].label} still has AI Office hooks. Remove them?`, false))) node(AIS[id].installer, ['--remove']);
  }
}

/** Codex only runs hooks with `codex_hooks = true` under [features] in ~/.codex/config.toml. */
async function codexFeature() {
  const file = join(homedir(), '.codex', 'config.toml');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (/^\s*codex_hooks\s*=\s*true/m.test(text)) return;
  if (!(await yes('Codex only runs hooks with `codex_hooks = true` under [features] in ~/.codex/config.toml. Add it?'))) return;
  let next;
  if (/^\s*codex_hooks\s*=/m.test(text)) next = text.replace(/^(\s*)codex_hooks\s*=.*$/m, '$1codex_hooks = true');
  else if (/^\[features\]\s*$/m.test(text)) next = text.replace(/^\[features\]\s*$/m, '[features]\ncodex_hooks = true');
  else next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}[features]\ncodex_hooks = true\n`;
  mkdirSync(dirname(file), { recursive: true });
  if (text) copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  writeFileSync(file, next);
  console.log(`Updated ${file}`);
}

rl?.close();

// ── 5. what to run next ──────────────────────────────────────────────────────
const built = existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html'));
console.log(`\nDone: ${chosen.map((id) => AIS[id].label + (id === def && chosen.length > 1 ? ' (default)' : '')).join(' + ')}, model ${model}.\n\nNext${remote ? ' (on the machine that runs the office)' : ''}:`);
if (!existsSync(join(ROOT, 'node_modules'))) console.log('  npm install');
if (!built) console.log('  npm run build            # once: the web UI the server serves');
console.log('  npm start                # the office on ' + (remote ? server : `http://127.0.0.1:${new URL(server).port || 3334}`));
console.log(`  npm run install-service  # optional: start it at login (${WINDOWS ? 'Task Scheduler' : process.platform === 'darwin' ? 'launchd' : 'systemd --user'})`);
console.log(`Then start a ${chosen.map((id) => AIS[id].label).join(' or ')} session: its robot walks in on the first event.`);
if (WINDOWS) console.log('\nWindows: run these in PowerShell. Open a new window first if Node or the AI was just installed.');
