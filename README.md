# AI Office

A light, local-only **isometric sci-fi office** where your Claude Code agents show up as robots. They walk in, go to the prop that matches what they're doing (desk, archive, server bank, holo-table, coffee bar…), raise a hand when they need permission, and walk out when they finish.

<p align="center"><img src="docs/media/office-3d.png" alt="AI Office: robots working in the 3D sci-fi office, with roster and chat panel" width="900"></p>

- **Plan:** [`docs/PLAN.md`](docs/PLAN.md) · **UI:** [`docs/UI-PLAN.md`](docs/UI-PLAN.md) · **Design:** the "AI Office UI" canvas on claude.ai
- **Features:** a 3D room (limited orbit, day/night, bloom; `?view=2d` for the painted one), path-finding robots, roster and inspector, #activity / #office / per-agent chat, an opt-in AI Office Manager, approving permission prompts from the office, sound, a mission board with reminders, a wallboard mode and a ⌘K palette.

| Orbit the room | Approve a permission prompt |
| --- | --- |
| <img src="docs/media/office-3d-orbit.png" alt="Orbited 3D view" width="440"> | <img src="docs/media/approve.png" alt="Blocked agent with Allow / Deny" width="440"> |

## What you need

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| **Node.js 22.18+** (24 recommended) | [nodejs.org](https://nodejs.org) | [nodejs.org](https://nodejs.org) | your package manager, or [nodejs.org](https://nodejs.org) |
| **Git** | `xcode-select --install` or [git-scm.com](https://git-scm.com) | [git-scm.com](https://git-scm.com) | `sudo apt install git` |
| **Claude Code** (the agents you watch) | [claude.com/claude-code](https://claude.com/claude-code) | [claude.com/claude-code](https://claude.com/claude-code) | [claude.com/claude-code](https://claude.com/claude-code) |
| **Desktop app only:** Rust | [rustup.rs](https://rustup.rs) | rustup-init.exe from [rustup.rs](https://rustup.rs) + Visual Studio Build Tools (C++) | rustup, plus the packages under [Desktop app](#desktop-app) |
| **Rebuilding the 3D room only:** Blender 5.x | [blender.org](https://www.blender.org) | [blender.org](https://www.blender.org) | [blender.org](https://www.blender.org) |

Nothing else is needed: no Docker, no database server. The office keeps its data in `.data/` inside the project.

> **Platform status:** macOS is tested end to end. Windows and Linux have their install paths written but are **not yet tested**; the notes below say where.

## Install

Pick your system. Each one ends at the same step: [choose how to open the office](#choose-how-to-open-the-office).

### macOS

```bash
git clone https://github.com/HafizShahman/AI-Ofiice.git
cd AI-Ofiice
npm install
npm run build                 # builds the web UI the server serves
npm run install-hooks         # once: adds the hooks to ~/.claude/settings.json (a backup is made)
```

Open a new terminal before the first `npm run dev` if `node` was just installed.

### Windows

Run these in PowerShell (not the old Command Prompt):

```powershell
git clone https://github.com/HafizShahman/AI-Ofiice.git
cd AI-Ofiice
npm install
npm run build
npm run install-hooks
```

Windows is **untested**. If `claude` isn't found by the server, install Claude Code with the official installer and open a new PowerShell window.

### Linux

```bash
git clone https://github.com/HafizShahman/AI-Ofiice.git
cd AI-Ofiice
npm install
npm run build
npm run install-hooks
```

Linux is **untested**. The login service uses `systemd --user`, so it needs a desktop or user session with systemd.

## Choose how to open the office

After the install steps above, pick one. You can use several.

### Web: in your browser

**Development** (live reload, for working on the code):

```bash
npm run dev                   # server on :3334 + UI at http://127.0.0.1:5273
```

**Always on** (the server starts at login; the browser is only a viewer):

```bash
npm run install-service       # macOS: launchd · Windows: Task Scheduler · Linux: systemd --user
npm run install-service -- --status      # is it answering on :3334?
```

Then open **http://127.0.0.1:3334**. Stop any `npm run dev` first, since both use port 3334. After changing the web code, run `npm run build` again; the server serves the new files without a restart.

Remove the login service with `npm run uninstall-service`. Logs are in `.data/server.log` (on macOS: `~/Library/Logs/AI Office/server.log`).

On macOS the installer warns if the project sits in `~/Documents`, `~/Desktop` or `~/Downloads`: background jobs can be blocked from those folders. Move the project, or give `node` Full Disk Access.

### Own window (no browser tabs)

```bash
npm run app                   # starts the server if needed and opens the office in its own window
npm run app -- --wallboard    # the wallboard view, for a second monitor
```

On macOS and Windows it uses Edge, Chrome, Brave or Chromium in app mode, with its own profile in `.data/app-profile`, so your browser tabs stay untouched. On Linux it looks for a Chromium-family browser on the PATH and otherwise opens the default browser. In Safari, use File → Add to Dock.

### Desktop app

A native window with a tray icon. The tray shows how many agents are blocked, and the wallboard can sit on top. It starts the server if nothing answers on the port, and leaves a running server alone. Closing the window hides it to the tray; **Quit** exits and stops a server the app started.

It runs from this checkout, so do `npm run build` first. Then:

```bash
npm run desktop               # build and run (first build takes 1–2 minutes)
npm run desktop:build         # release app: apps/desktop/src-tauri/target/release/bundle/
```

- **macOS:** the release build is `…/bundle/macos/AI Office.app`. Install Xcode Command Line Tools (`xcode-select --install`) and Rust (rustup), then open a new terminal, or run `. "$HOME/.cargo/env"`.
- **Windows (untested):** build on Windows. You need WebView2 (preinstalled on Windows 10/11), Visual Studio Build Tools with the "Desktop development with C++" workload, and Rust from rustup-init.exe using the MSVC toolchain.
- **Linux (untested):** the Tauri prerequisites for Debian/Ubuntu are `libwebkit2gtk-4.1-dev build-essential libssl-dev libayatana-appindicator3-dev librsvg2-dev`, plus Rust from rustup. Other distributions: see Tauri's [Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

Environment variables, if you need them: `AI_OFFICE_ROOT` (project folder), `AI_OFFICE_PORT` (port), `AI_OFFICE_NODE` (Node binary). Browser notifications don't work inside the app's web view; use the tray badge instead.

## Try it without Claude Code

Click **Run demo** in the UI, open `http://127.0.0.1:5273/?sim`, or start the server with `OFFICE_SIM=1`. Demo agents are marked as a simulation.

## How it works

```
Claude Code ──HTTP hooks──▶ office server (Node, :3334) ──WebSocket──▶ browser or app window
                               │  normalise + redact → state machine → SQLite (.data/office.db)
```

The `/hook` endpoint always answers `200` straight away with an empty body, so the office can never slow down, block, approve or deny anything in a real session. If the server is down, Claude Code carries on normally.

### Hooks

`npm run install-hooks` adds HTTP hooks for `SessionStart/End`, `UserPromptSubmit`, `Pre/PostToolUse`, `PostToolUseFailure`, `SubagentStart/Stop`, `Stop`, `Notification`, `PermissionRequest`, `TaskCreated/Completed` and `PreCompact`.

- **Re-running** is safe. `npm run uninstall-hooks` removes only the AI Office entries.
- **Auth:** a shared token in `.data/token` (mode 0600) goes in the `Authorization` header. Use `--env` to read it from `$OFFICE_TOKEN` instead.
- **Other server:** `npm run install-hooks -- --url http://<host>:3334/hook`.
- **Privacy:** full tool input is never stored. The server keeps the tool name plus a short, redacted summary: a file basename, a command cut to 60 characters with secrets masked, or a host name.

## Using the office

- **Mouse:** drag to pan, wheel to zoom, click a robot to inspect it, double-click to follow it.
- **Keys:** `[` `]` previous/next agent · `Shift+F` follow · `Esc` deselect · `+` `−` zoom · `0` reset view · `C` side panel.
- **URL:** `?agent=<id>` selects an agent · `?helper` layout editor (drag spots and props; Save works under `npm run dev`) · `?debug` raw state · `?view=2d` painted room · `?parts` colours the robot's animated segments · `?pose=wave` forces a pose.
- **Chat:** `/` focuses the composer. Slash commands are free: `/status`, `/agents`, `/who <role>`, `/ai on|off`, `/approvals on|off`, `/sim`, `/clear`, `/help`.

## The Office Manager (AI)

Off by default. Turn it on with the **AI** pill in the top bar or `/ai on`. Each question runs one `claude -p --model haiku` call **on the machine running the office server**, using your Claude Code login. It gets only the office state (agents, their recent tool names and redacted summaries, recent chat), no tools, no hooks and no MCP servers. In a robot's DM it answers as that agent, from that agent's events.

If `claude` isn't on the server's PATH, the AI shows as unavailable; point `ai.command` in `office.config.json` at the binary.

## Answering permission prompts from the office

Off by default. When a robot raises its hand, click **Approve from the office…** (or type `/approvals on`). While an office tab is open, a permission request waits in the office with **Allow**, **Deny** and **Terminal** (send it back to the terminal now). If you don't answer within `approvals.waitSec` (45 s, in `office.config.json`), Claude Code asks in the terminal as usual.

- Re-run `npm run install-hooks` once after updating: the permission hook needs a longer timeout than the other hooks.
- **Allow really runs the command or edit.** The office shows what is being asked (the command, file or host) before you click.

## Layout

```
apps/server/      Hono + ws + node:sqlite. hooks.ts (normalise/redact), state.ts (agent state machine), sim.ts
apps/web/         Vite + React + Tailwind v4 + zustand. src/scene/props.json = prop positions on the 2D room
apps/desktop/     Tauri shell (tray, window, server start). src-tauri/ is the Rust side
packages/shared/  Event, agent and WebSocket message types
scripts/          install-hooks, install-service, open-app, build-robot.sh, build-room.sh, build-art.py
Assets/           room art, Blender sources (3D room, props), original sprites, sci-fi/ restyled sprites
office.config.json  desks, idle/break/charge timers, role rules, AI settings
```

### Rebuilding the 3D room (optional)

Only needed if you change the room or props in Blender. Install Blender 5.x (the script finds `/Applications/Blender.app` on macOS, or set `BLENDER=/path/to/blender`), then:

```bash
npm run build:room
```

It writes `apps/web/public/models/room.glb` and `apps/web/src/scene/room3d.json`. Robot model and 2D art have their own scripts: `npm run build:robot` and `npm run build:art` (Python with Pillow).

## Credits

- Character: based on ["Mini Robot"](https://sketchfab.com/3d-models/mini-robot-3454c84d6eff4a9dabbfadbfd1f56524) by [Onur](https://sketchfab.com/onurpearl), licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). Modified: decimated, textures resized and recompressed, animated. Source in `Assets/mini_robot/` (see its `license.txt`).
- Inspired by [Claude-Office](https://github.com/W17ant/Claude-Office) (MIT).
