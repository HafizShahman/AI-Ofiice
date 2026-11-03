#!/usr/bin/env node
// Runs the AI Office server by itself when you log in, so hooks always have somewhere to post
// (the window or browser tab is only a viewer). One script, three systems:
//
//   macOS    launchd agent   ~/Library/LaunchAgents/com.ai-office.server.plist
//   Windows  Task Scheduler  task "AI Office" (runs at logon, no console window)
//   Linux    systemd --user  ~/.config/systemd/user/ai-office.service
//
//   npm run install-service                 # install and start now
//   npm run install-service -- --dry-run    # show what would be written, change nothing
//   npm run install-service -- --port 4000  # serve on another port (default: office.config.json)
//   npm run install-service -- --status     # is the server answering?
//   npm run uninstall-service
//
// The service runs this checkout's `apps/server/src/index.ts` with the Node that ran this script,
// serving the built UI (`npm run build` first). Logs go to .data/server.log (macOS: ~/Library/Logs/AI Office/server.log,
// because a login item may not touch files in ~/Documents, ~/Desktop or ~/Downloads, where .data/ might be).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
const remove = flag('--remove');
const config = JSON.parse(readFileSync(join(ROOT, 'office.config.json'), 'utf8'));
const port = Number(opt('--port', config.server?.port ?? 3334));
const dataDir = resolve(process.env.DATA_DIR ?? join(ROOT, '.data'));
const logFile = process.platform === 'darwin' ? join(homedir(), 'Library', 'Logs', 'AI Office', 'server.log') : join(dataDir, 'server.log');
// Prefer a path that survives upgrades (Homebrew's /opt/homebrew/bin/node, not .../Cellar/node/26.1.0/bin/node)
function stableNode() {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  try {
    const real = realpathSync(process.execPath);
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const c = join(dir, exe);
      if (existsSync(c) && realpathSync(c) === real) return c;
    }
  } catch {
    /* fall through */
  }
  return process.execPath;
}
const node = stableNode();
const entry = join(ROOT, 'apps', 'server', 'src', 'index.ts');
const nodeArgs = ['--disable-warning=ExperimentalWarning', entry];
// a login session's PATH is short: keep this shell's, so the server can find `claude`
const PATH = process.env.PATH ?? '';

const LABEL = 'com.ai-office.server';
const TASK = 'AI Office';
const SYSTEMD = 'ai-office.service';

function run(cmd, cmdArgs, { quiet = false, check = true } = {}) {
  console.log(`$ ${[cmd, ...cmdArgs].join(' ')}`);
  if (dry) return { status: 0, stdout: '' };
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8' });
  if (!quiet && r.stdout?.trim()) console.log(r.stdout.trim());
  if (check && r.status !== 0) {
    console.error(`  failed (${r.status}): ${(r.stderr || r.error?.message || '').trim()}`);
    process.exit(1);
  }
  return r;
}

function write(path, text, encoding = 'utf8') {
  console.log(`${dry ? 'Would write' : 'Writing'} ${path}`);
  if (dry) return console.log(text.replace(/^/gm, '  | '));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, encoding);
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── macOS: launchd ──────────────────────────────────────────────────────────

function macos() {
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  // bootout fails when it isn't loaded, which is fine
  run('launchctl', ['bootout', `${domain}/${LABEL}`], { quiet: true, check: false });
  if (remove) {
    if (existsSync(plist) && !dry) rmSync(plist);
    return console.log('Removed the AI Office login item.');
  }
  if (!dry) mkdirSync(dirname(logFile), { recursive: true });
  // macOS blocks background jobs from ~/Documents, ~/Desktop and ~/Downloads unless the program was granted access
  const protectedDir = ['Documents', 'Desktop', 'Downloads'].map((d) => join(homedir(), d)).find((d) => ROOT === d || ROOT.startsWith(d + '/'));
  if (protectedDir)
    console.warn(
      `Warning: this project is inside ${protectedDir}. macOS may stop the login item from reading it (exit code 78, or "Operation not permitted" in ${logFile}).\n` +
        `  Fix: move the project somewhere else (e.g. ~/Developer), or give ${node} access under System Settings > Privacy & Security > Full Disk Access.\n`,
    );
  const env = [`<key>PATH</key><string>${xml(PATH)}</string>`, `<key>PORT</key><string>${port}</string>`].join('\n      ');
  write(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[node, ...nodeArgs].map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
      ${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`,
  );
  run('launchctl', ['bootstrap', domain, plist]);
}

// ── Linux: systemd user unit ────────────────────────────────────────────────

function linux() {
  const unit = join(homedir(), '.config', 'systemd', 'user', SYSTEMD);
  if (remove) {
    run('systemctl', ['--user', 'disable', '--now', SYSTEMD], { check: false });
    if (existsSync(unit) && !dry) rmSync(unit);
    run('systemctl', ['--user', 'daemon-reload'], { check: false });
    return console.log('Removed the AI Office service.');
  }
  const q = (s) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  write(
    unit,
    `[Unit]
Description=AI Office server

[Service]
ExecStart=${[node, ...nodeArgs].map(q).join(' ')}
WorkingDirectory=${ROOT}
Environment=${q(`PATH=${PATH}`)}
Environment=PORT=${port}
Restart=on-failure
RestartSec=10
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`,
  );
  if (!dry) mkdirSync(dataDir, { recursive: true });
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', SYSTEMD]);
}

// ── Windows: Task Scheduler ─────────────────────────────────────────────────

function windows() {
  if (remove) {
    run('schtasks', ['/End', '/TN', TASK], { quiet: true, check: false });
    run('schtasks', ['/Delete', '/TN', TASK, '/F'], { check: false });
    for (const f of ['ai-office-task.xml', 'ai-office-run.vbs']) if (!dry) rmSync(join(dataDir, f), { force: true });
    return console.log('Removed the AI Office task.');
  }
  // wscript runs the .vbs without a console window; the .vbs runs node through cmd so output can go to the log
  const q = (s) => `"${s}"`;
  const inner = `${q(node)} ${nodeArgs.map(q).join(' ')} >> ${q(logFile)} 2>&1`;
  const vbs = join(dataDir, 'ai-office-run.vbs');
  const vbsStr = (s) => `"${s.replace(/"/g, '""')}"`;
  write(
    vbs,
    `Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = ${vbsStr(ROOT)}
sh.Environment("Process")("PORT") = "${port}"
sh.Run "cmd /c " & ${vbsStr(q(inner))}, 0, False
`,
    'utf8',
  );
  const taskXml = join(dataDir, 'ai-office-task.xml');
  write(
    taskXml,
    `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>${xml(q(vbs))}</Arguments>
      <WorkingDirectory>${xml(ROOT)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`,
    // schtasks wants UTF-16 with a byte-order mark
    'utf16le',
  );
  if (!dry) writeFileSync(taskXml, Buffer.concat([Buffer.from([0xff, 0xfe]), readFileSync(taskXml)]));
  run('schtasks', ['/Create', '/TN', TASK, '/XML', taskXml, '/F']);
  run('schtasks', ['/Run', '/TN', TASK]);
}

// ── status ──────────────────────────────────────────────────────────────────

async function status() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    console.log(`The server is answering on http://127.0.0.1:${port} (${j.agents} agents${j.sim ? ', demo running' : ''}).`);
  } catch {
    console.log(`Nothing answers on http://127.0.0.1:${port}. See ${logFile} if you installed the service.`);
    process.exitCode = 1;
  }
}

// ── main ────────────────────────────────────────────────────────────────────

if (flag('--status')) {
  await status();
} else {
  if (!remove && !existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html'))) {
    console.error('The web app is not built yet: run `npm run build` first, so the server has a UI to serve.');
    if (!dry) process.exit(1);
  }
  const platform = process.platform;
  if (platform === 'darwin') macos();
  else if (platform === 'win32') windows();
  else if (platform === 'linux') linux();
  else {
    console.error(`No service support for ${platform}: run \`npm start\` yourself.`);
    process.exit(1);
  }
  if (!remove && !dry) {
    console.log(`\nInstalled. The server starts at login and now. UI: http://127.0.0.1:${port}  ·  log: ${logFile}`);
    console.log('Check it with `npm run install-service -- --status`.');
  }
}
