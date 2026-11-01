# AI Office

A light, local-only **isometric sci-fi office** where your Claude Code agents show up as robots. They walk in, go to the prop that matches what they're doing (desk, archive, server bank, holo-table, coffee bar…), raise a hand when they need permission, and walk out when they finish.

- **Plan:** [`docs/PLAN.md`](docs/PLAN.md) · **UI:** [`docs/UI-PLAN.md`](docs/UI-PLAN.md) · **Design:** the "AI Office UI" canvas on claude.ai
- **Status:** P1 (event backbone). The browser shows a debug list of agents and events. The isometric office is P2.

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
scripts/          install-hooks.mjs
Assets/           room background, original sprites, sci-fi/ restyled sprites
.ddev/            DDEV config
office.config.json  desks, idle/break/charge timers, role rules, AI settings
```

## To verify in P1

- Do tool events fired *inside* a subagent carry `agent_id`? The server uses it when present; otherwise the event goes to the main session's robot.

## Credits

- Character: based on ["Mini Robot"](https://sketchfab.com/3d-models/mini-robot-3454c84d6eff4a9dabbfadbfd1f56524) by [Onur](https://sketchfab.com/onurpearl), licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). Modified: decimated, textures resized and recompressed, animated. Source in `Assets/mini_robot/` (see its `license.txt`); `npm run build:robot` rebuilds `apps/web/public/models/robot.opt.glb`.
- Inspired by [Claude-Office](https://github.com/W17ant/Claude-Office) (MIT).
