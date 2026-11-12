#!/usr/bin/env node
// Codex CLI command hook: forwards the hook's JSON (stdin) to the AI Office server and exits 0 with no
// output, so Codex is never blocked or altered. Installed by `npm run install-codex-hooks`.
//   AI_OFFICE_URL    default http://127.0.0.1:3334/hook/codex
//   AI_OFFICE_TOKEN  default: read from <project>/.data/token
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.AI_OFFICE_URL ?? 'http://127.0.0.1:3334/hook/codex';
if (process.env.AI_OFFICE_INTERNAL) process.exit(0); // the office's own Codex runs (manager answers) are not agents to show
let token = process.env.AI_OFFICE_TOKEN;
if (!token) {
  try {
    token = readFileSync(join(process.env.DATA_DIR ?? join(ROOT, '.data'), 'token'), 'utf8').trim();
  } catch {
    process.exit(0);
  }
}
let body = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) body += chunk;
// a task started from the office names its own id, so its robot and DM match (see providers/codex.ts)
const taskId = process.env.AI_OFFICE_TASK_ID;
if (taskId) {
  try {
    body = JSON.stringify({ ...JSON.parse(body), office_task_id: taskId });
  } catch {
    /* send as is */
  }
}
try {
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(1500) });
} catch {
  /* server not running: stay silent */
}
process.exit(0);
