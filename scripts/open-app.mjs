#!/usr/bin/env node
// Opens the office in its own app window (no tabs, no address bar), starting the server first if it
// isn't running. The window is only a viewer: the hooks keep posting to the server either way.
//
//   npm run app                      # the office
//   npm run app -- --wallboard       # the wallboard view (put it on a second monitor)
//   npm run app -- --server-only     # just make sure the server is running
//   npm run app -- --dry-run         # print what would run
//   npm run app -- --port 4000
//
// It uses a Chromium browser's app mode: Edge (always present on Windows 10/11), else Chrome, Brave or
// Chromium. The app window has its own profile (.data/app-profile), so it never touches your browser's
// tabs and keeps its own settings (sound, accent...). With none of those installed it falls back to the
// default browser; on Safari use File > Add to Dock for the same effect.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dry = flag('--dry-run');
const config = JSON.parse(readFileSync(join(ROOT, 'office.config.json'), 'utf8'));
const port = Number(opt('--port', process.env.PORT ?? config.server?.port ?? 3334));
const base = `http://127.0.0.1:${port}`;
const url = flag('--wallboard') ? `${base}/?wallboard` : base;
const dataDir = resolve(process.env.DATA_DIR ?? join(ROOT, '.data'));
const profile = join(dataDir, 'app-profile');

const alive = () =>
  fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })
    .then((r) => r.ok)
    .catch(() => false);

async function ensureServer() {
  if (await alive()) return;
  if (!existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html')))
    console.error('Note: the web app is not built (npm run build), so the server will have no UI to serve.');
  console.log(`Starting the server on :${port}…`);
  if (dry) return;
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(join(dataDir, 'server.log'), 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'apps', 'server', 'src', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  closeSync(log);
  for (let i = 0; i < 40; i++) {
    if (await alive()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`The server didn't answer within 10 s. See ${join(dataDir, 'server.log')}.`);
  process.exit(1);
}

/** Absolute paths of Chromium-family browsers, in order of preference. */
function browsers() {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    const rel = [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ];
    return rel.flatMap((r) => roots.map((root) => join(root, ...r)));
  }
  if (process.platform === 'darwin') {
    const app = (name, bin = name) => [`/Applications/${name}.app/Contents/MacOS/${bin}`, join(env.HOME ?? '', 'Applications', `${name}.app`, 'Contents', 'MacOS', bin)];
    return [app('Microsoft Edge'), app('Google Chrome'), app('Brave Browser'), app('Chromium')].flat();
  }
  const names = ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'brave-browser', 'chromium', 'chromium-browser'];
  return names.flatMap((n) => (env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, n)));
}

function openApp() {
  const exe = browsers().find((p) => existsSync(p));
  if (!exe) {
    console.log('No Edge, Chrome, Brave or Chromium found: opening the default browser instead.');
    const [cmd, cmdArgs] =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    console.log(`$ ${[cmd, ...cmdArgs].join(' ')}`);
    if (!dry) spawnSync(cmd, cmdArgs, { stdio: 'ignore' });
    return;
  }
  const flags = [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1440,900', '--no-first-run', '--no-default-browser-check'];
  console.log(`$ ${[exe, ...flags].join(' ')}`);
  if (dry) return;
  spawn(exe, flags, { detached: true, stdio: 'ignore' }).unref();
}

await ensureServer();
if (!flag('--server-only')) openApp();
