# AI Office — notes for Claude Code

Personal project (new build). A light, local-only **isometric sci-fi office** where Claude Code agents appear as robots that walk to the prop matching what they're doing. Inspired by W17ant/Claude-Office (MIT).

- Full plan: `docs/PLAN.md` · UI spec: `docs/UI-PLAN.md`
- Visual design: the "AI Office UI" canvas on claude.ai (Live office, First run, Settings, ⌘K palette, Wallboard, props board). It's the reference for layout and look.

## Status

- **P1 event backbone: built** (hooks → server → WebSocket → debug view) and tested with demo payloads **and a real Claude Code session** (2026-11-01, hooks → DDEV server).
  - **Subagent tool events do carry `agent_id` and `agent_type`**, on `SubagentStart`, `SubagentStop` and every tool event inside the subagent. `normalize()` attributes them correctly (`agentId` = subagent, `parentAgentId` = session). The parent's own events, including the `Agent` call, have none.
  - **Gotchas:** the parent's `Stop` (`turn_done`) fires while a *background* subagent is still working, so the lead must not go `done` while it has live children. The harness also emits a `SubagentHandback` pseudo-tool as a subagent's last call; filter it. Nested and parallel subagents are **untested**.
  - Hooks hot-load: editing the settings file takes effect mid-session. Local install: `npm run install-hooks -- --settings .claude/settings.local.json --url http://ai-office.ddev.site:3334/hook` (git-ignored, one project only).
- **Robot model:** `Assets/mini_robot/` holds "Mini Robot" by Onur (CC BY 4.0). It has **no skeleton or animations**: 25 rigid parts, and each part mesh covers both sides. `npm run build:robot` → `apps/web/public/models/robot.opt.glb` (36k tris, 0.7 MB, parts kept).
- **P0 robot: done, rigid procedural animation** (no build-time split needed). `scene/robot.ts` bakes the parts into one space (feet y=0, height 1, facing +Z), cuts each part into L/R halves by triangle, sorts halves into head/torso/armL/armR/legL/legR by position, merges per segment and material, and animates pivots in code: walk, idle, type, read, think, raise_hand, wave, drink, celebrate, charge. Cap + ears take the role colour. `?parts` colours the segments, `?pose=<name>` forces a pose.
- **P2 isometric office: first pass built** (2026-11-01), plain three.js (no R3F/drei, smaller bundle: 240 KB gz total).
  - `scene/OfficeScene.ts`: ortho camera in room-pixel space; backdrop + sprites are flat quads with `depthTest:false`, `renderOrder` = foot y; robots are 3D, tipped back 30° (2:1 iso), `transparent:true` so they sort in the same pass, z = y×4 so robots depth-test only against each other. Pan (drag), zoom (wheel, buttons, +/−/0), select (click), follow (double-click / Shift+F). Busy sprites swap when a robot is at that machine.
  - `scene/layout.ts`: spot id → room px, facing targets (`face` in props.json, else nearest sprite foot), floor↔deck routes via `nav.stairs`, role/status colours, activity text.
  - UI (`ui/`): top bar counters, roster, inspector card, blocked toast, #activity feed, first-run card. P1 debug view moved to `?debug`.
  - Server: `SubagentHandback` filtered; a lead whose `Stop` arrives with live subagents stays `working/delegating` and goes `done` when the last child leaves.
  - Art: `npm run build:art` (Python + Pillow) → `apps/web/public/art/*.webp` from `Assets/`.
- **Walk grid + A\* + `?helper` editor: built** (2026-11-01).
  - `scene/nav.ts`: one grid per level (`nav.cell`, 12 px) from `nav.areas` polygons minus obstacles (`nav.blocks` + an automatic 2:1 diamond footprint under every sprite prop, grown by one cell; `block:false` or a `block` polygon on a prop overrides it). Spots are carved open. 8-way A* (no corner cutting) + line-of-sight smoothing; floor ↔ deck via `nav.stairs` [bottom, top]. Unreachable → straight line.
  - `layout.ts` holds the live layout (`getLayout`/`setLayout`/`onLayoutChange`); the scene rebuilds sprites and re-paths robots on change.
  - `office/Helper.tsx` (`?helper`): drag spots, sprite feet (a single-sprite prop's spots move with it), facing points, area/obstacle corners, stairs; arrows nudge (Shift ×10), Delete removes; shows the walk grid, footprints and live robot paths. **Save** posts to the Vite dev plugin `/__helper/props` (vite.config.ts, dev only, same-origin) which writes props.json; the built app downloads it instead. `scene/serialize.ts` keeps the one-item-per-line format (round-trips byte-identical). The server reads props.json at start: restart it after adding/removing spots.
  - The nav polygons and the approval/server-bank spots were traced by eye: check them in `?helper`.
- **P3 chat: built** (2026-11-01).
  - Server `chat.ts`: channels `office` and `dm:<agentId>` (messages table), slash commands (`/status /agents /who /ai on|off /sim /clear /help`, free), blocked pings into #office (deduped 5 min per agent+tool) and the agent's DM. `manager.ts`: builds a compact, redacted context (agents + last `ai.contextEvents` events without tool_end + recent chat) and runs `claude -p --model haiku --system-prompt … --tools "" --max-turns 1 --no-session-persistence --strict-mcp-config --settings '{"disableAllHooks":true}' --session-id <uuid>` from the OS temp dir, prompt on stdin, 60 s timeout. Its session ids are ignored by `/hook`. In a DM it answers as that agent from that agent's events. `OFFICE_AI_COMMAND` / `ai.command` override the binary (a fake script works for tests).
  - AI is off by default; state is saved in `settings.ai_enabled` and pushed as `{type:'ai'}`. `available:false` = the command couldn't be run (e.g. the server runs in DDEV, where `claude` isn't installed: run `npm run dev` on the Mac for the Office Manager).
  - `/api/*` POSTs require `application/json` and a same-host Origin (blocks drive-by CSRF from other sites); the Vite proxy keeps the Host header for this.
  - Web: `ui/SidePanel.tsx` (channels, DMs with the agent's timeline merged in, composer with slash suggestions, typing indicator), `ui/Rich.tsx` (`code`, **bold**, agent names → select robot). Top-bar AI pill, inspector "Open DM", `/` focuses the composer.
- **Approve from the office: built** (2026-11-01, opt-in, saved as `settings.approvals_enabled`). Toggle: "Approve from the office…" link on a blocked agent, or `/approvals on|off`. Server `approvals.ts` holds the HTTP request, replies `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny"}}}`, releases empty on timeout / "Terminal" / the agent moving on (any later tool, turn end, prompt or leave) / Claude Code closing the request. A request dropped within 3 s posts a hint to re-run install-hooks (the installer now gives PermissionRequest `waitSec + 10` s; other hooks 1 s). Allow/Deny unblocks the robot at once and posts a line to #office and the DM. The detail shown (`permissionDetail()`: Bash command ≤300 chars redacted, file path tail, URL host+path) is memory-only. Demo requests are answerable but change nothing. `/api/approvals` (toggle) and `/api/approvals/:id` (decide) use the same JSON + same-origin guard.
  - **Untested against a real session:** whether Claude Code shows its terminal prompt while the hook is held, or only after the hook returns. Check it first; lower `approvals.waitSec` if the wait in the terminal is annoying.
- **Fixed:** the idle "Claude is waiting for your input" notification no longer marks the agent blocked (uses `notification_type`, `permission_prompt` only).
- **Next, in order:**
  1. **P4:** wallboard (`?wallboard`), settings drawer (AI, approvals, wait time, quality), ⌘K palette, About/credits, browser notification on blocked.
  2. Try the Office Manager under DDEV: install Claude Code in the web container and pass `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), or keep it a local-only feature.
  3. Draw calls (~7 per robot) and lazy-loading the helper if the bundle gets tight (251 KB gz now).

## Commands

```bash
npm install
npm run dev            # server :3334 (node --watch) + Vite :5173
npm run typecheck      # tsc for server and web
npm run build          # web → apps/web/dist (the server then serves it on :3334)
npm run install-hooks  # adds HTTP hooks to ~/.claude/settings.json (backup; idempotent)
                       #   DDEV: npm run install-hooks -- --url http://ai-office.ddev.site:3334/hook
npm run uninstall-hooks
npm run build:robot    # re-optimise the robot model
npm run build:art      # room + sprite WebPs for the web app (Python + Pillow)
ddev start             # alternative: runs server + Vite as DDEV daemons
```

Demo without Claude Code: the "Run demo" button, `POST /api/sim {"on":true}`, or `OFFICE_SIM=1`.

## Architecture

- `apps/server/src/`, Node 22.18+/24, **runs the .ts files directly** (type stripping, no build):
  - `index.ts`: Hono routes (`POST /hook`, `/api/state|events|health|sim|chat/:channel|ai`), WebSocket `/ws` (first a snapshot, then batched arrays every 50 ms), and the static web build
  - `hooks.ts`: normalise a hook payload into an `OfficeEvent`; redact
  - `state.ts`: the agent state machine (`arriving·working·blocked·idle·break·charging·done·leaving`), desk allocation, spot claiming from `props.json`, idle/break/charge timers (in `office.config.json`)
  - `chat.ts` (channels, slash commands, pings) + `manager.ts` (the `claude -p` Office Manager) + `approvals.ts` (opt-in Allow/Deny for permission prompts)
  - `roles.ts` (role regex in `office.config.json`), `db.ts` (node:sqlite at `.data/office.db`), `sim.ts`, `config.ts` (`HOST`, `PORT`, `DATA_DIR`, token in `.data/token`)
- `apps/web/`: Vite + React 19 + Tailwind v4 (tokens from UI-PLAN §5) + zustand. `App.tsx` = office shell (`?debug` = P1 debug view in `DebugView.tsx`). `scene/` = three.js office, `office/OfficeView.tsx` = canvas + tags + camera buttons, `office/Helper.tsx` = `?helper` layout editor, `ui/` = panels.
- `apps/web/src/scene/props.json`: **single source of prop positions**, read by both server and web. Coordinates are **% of the 2400×1792 room image** (`Assets/room/bg-main-area.png`). `foot` is the bottom-centre anchor, `width` is a % of room width, `z` overrides draw order, and `spots` are where robots stand, `face` where they look, `nav` = walkable areas, obstacles and stairs.
- `packages/shared/src/index.ts`: type-only contracts (`OfficeEvent`, `AgentState`, `ServerMessage`).

## Rules

- **The hook endpoint must never affect a real session:** answer `200` with an empty body immediately and process afterwards. Never approve, deny or block anything on its own. The single, opt-in exception is "approve from the office" (`approvals.ts`): with it on **and** an office tab connected, a `PermissionRequest` is held (≤ `approvals.waitSec`) until the user clicks Allow / Deny / Terminal; otherwise it is released empty so Claude Code asks in the terminal.
- **Privacy:** never store full `tool_input`. Keep only the tool name and a short redacted summary (`summarize()`/`redact()` in hooks.ts).
- **Server TypeScript must be erasable syntax only:** no `enum`, `namespace` or constructor parameter properties. Use `.ts` extensions in relative imports, and `import type` for `@ai-office/shared`.
- **Light:** no Docker services, Electron or extra databases. Keep the web bundle small (see the PLAN §14 budget).
- **Art:** props use the restyled sprites in `Assets/sci-fi/`. The originals are in `Assets/{appliances,culture,decoration,furniture}`. Keep the dark gunmetal + cyan look.
- **Credits are required (CC BY 4.0):** "Mini Robot" by Onur — https://sketchfab.com/3d-models/mini-robot-3454c84d6eff4a9dabbfadbfd1f56524 — modified. Keep it in the README and the in-app About.
- `Assets/mini_robot/*` (54 MB source) is git-ignored except `license.txt`. `Claude outputs/` holds stale plan copies and is ignored.
