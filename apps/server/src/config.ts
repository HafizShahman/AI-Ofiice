import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

interface FileConfig {
  server: { port: number };
  desks: number;
  timers: { idleAfterSec: number; breakAfterSec: number; chargeAfterSec: number; staleAfterSec: number; doneHoldSec: number };
  roles: { role: string; match: string }[];
  approvals?: { waitSec?: number };
  ai: { enabled: boolean; model: string; contextEvents: number; command?: string; timeoutSec?: number };
}

const file = JSON.parse(readFileSync(join(ROOT, 'office.config.json'), 'utf8')) as FileConfig;

const dataDir = resolve(process.env.DATA_DIR ?? join(ROOT, '.data'));
mkdirSync(dataDir, { recursive: true });

/** Shared secret for the /hook endpoint. Kept in .data/token (0600), or OFFICE_TOKEN overrides it. */
function loadToken(): string {
  if (process.env.OFFICE_TOKEN) return process.env.OFFICE_TOKEN;
  const path = join(dataDir, 'token');
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return readFileSync(path, 'utf8').trim();
}

export const config = {
  ...file,
  host: process.env.HOST ?? '127.0.0.1', // DDEV sets 0.0.0.0
  port: Number(process.env.PORT ?? file.server.port),
  dataDir,
  token: loadToken(),
  webDist: join(ROOT, 'apps/web/dist'),
};
