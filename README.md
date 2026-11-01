# AI Office

A light, local-only **isometric sci-fi office** where your Claude Code agents show up as robots. They walk in, go to the prop that matches what they're doing (desk, archive, server bank, holo-table, coffee bar…), raise a hand when they need permission, and walk out when they finish.

- **Plan:** [`docs/PLAN.md`](docs/PLAN.md) · **UI:** [`docs/UI-PLAN.md`](docs/UI-PLAN.md) · **Design:** the "AI Office UI" canvas on claude.ai
- **Status:** P2 first pass. The browser shows the isometric office with animated robots, a roster, an inspector, a blocked-permission toast and an #activity feed. The raw P1 debug list is at `?debug`. Robots path-find around furniture (walk grid + A*), and `?helper` is a drag-and-drop layout editor. The side panel has #activity, #office (the AI Office Manager) and a DM per robot. Next: polish (P4).

## How it works

```
Claude Code ──HTTP hooks──▶ office server (Node, :3334) ──WebSocket──▶ browser
                               │  normalise + redact → state machine → SQLite (.data/office.db)
```

The `/hook` endpoint always answers `200` straight away with an empty body, so the office can never slow down, block, approve or deny anything in a real session. If the server is down, Claude Code carries on normally.

## Run it

Requires Node **22.18+** (24 recommended): the server runs its TypeScript directly, with no build step.

### Local

```bash
npm install
npm run install-hooks        # once: adds the hooks to ~/.claude/settings.json (with a backup)
npm run dev                  # server :3334 + Vite UI http://127.0.0.1:5173
```

### DDEV

```bash
ddev start                                                     # server + Vite run as DDEV daemons
npm run install-hooks -- --url http://ai-office.ddev.site:3334/hook   # on your Mac, not in the container
open https://ai-office.ddev.site:5173
```

### Demo without Claude Code

Click **Run demo** in the UI, or start the server with `--sim` (`OFFICE_SIM=1`). Demo agents are marked as a simulation.

## Hooks

`scripts/install-hooks.mjs` adds HTTP hooks for these events: `SessionStart/End`, `UserPromptSubmit`, `Pre/PostToolUse`, `PostToolUseFailure`, `SubagentStart/Stop`, `Stop`, `Notification`, `PermissionRequest`, `TaskCreated/Completed` and `PreCompact`.

- **Auth:** a shared token from `.data/token` (mode 0600) goes in the `Authorization` header. Use `--env` to read it from `$OFFICE_TOKEN` instead of storing it in settings.
- **Re-running:** the installer is safe to re-run. `npm run uninstall-hooks` removes only the AI Office entries.
- **Privacy:** full tool input is never stored. The server keeps the tool name plus a short, redacted summary: a file basename, a command cut to 60 characters with secrets masked, or a host name.

## Layout

```
apps/server/      Hono + ws + node:sqlite. hooks.ts (normalise/redact), state.ts (agent state machine), sim.ts
apps/web/         Vite + React + Tailwind v4 + zustand. src/scene/props.json = prop positions on the room
packages/shared/  Event, agent and WebSocket message types
scripts/          install-hooks.mjs, build-robot.sh, build-art.py (npm run build:art)
Assets/           room background, original sprites, sci-fi/ restyled sprites
.ddev/            DDEV config
office.config.json  desks, idle/break/charge timers, role rules, AI settings
```

## Using the office

- **Mouse:** drag to pan, wheel to zoom, click a robot to inspect it, double-click to follow it.
- **Keys:** `[` `]` previous/next agent · `Shift+F` follow · `Esc` deselect · `+` `−` zoom · `0` reset view · `C` side panel.
- **URL:** `?agent=<id>` selects an agent · `?helper` layout editor (drag spots, props, walkable areas; Save writes props.json under `npm run dev`) · `?debug` raw state · `?parts` colours the robot's animated segments · `?pose=wave` forces a pose.
- **Chat:** `/` focuses the composer. Slash commands are free: `/status`, `/agents`, `/who <role>`, `/ai on|off`, `/sim`, `/clear`, `/help`.

## The Office Manager (AI)

Off by default. Turn it on with the **AI** pill in the top bar or `/ai on`. Each question runs one `claude -p --model haiku` call **on the machine running the office server**, using your Claude Code login. It gets only the office state (agents, their recent tool names and the short redacted summaries, recent chat), no tools, no hooks and no MCP servers, and nothing is saved by Claude Code. In a robot's DM it answers as that agent, from that agent's events.

Under DDEV the server runs inside the container, where `claude` isn't installed, so the AI shows as unavailable. Run `npm run dev` on your machine to use it (or point `ai.command` in `office.config.json` at another binary).

## Credits

- Character: based on ["Mini Robot"](https://sketchfab.com/3d-models/mini-robot-3454c84d6eff4a9dabbfadbfd1f56524) by [Onur](https://sketchfab.com/onurpearl), licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). Modified: decimated, textures resized and recompressed, animated. Source in `Assets/mini_robot/` (see its `license.txt`); `npm run build:robot` rebuilds `apps/web/public/models/robot.opt.glb`.
- Inspired by [Claude-Office](https://github.com/W17ant/Claude-Office) (MIT).
