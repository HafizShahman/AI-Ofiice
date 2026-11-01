# AI Office — notes for Claude Code

Personal project (new build). A light, local-only **isometric sci-fi office** where Claude Code agents appear as robots that walk to the prop matching what they're doing. Inspired by W17ant/Claude-Office (MIT).

- Full plan: `docs/PLAN.md` · UI spec: `docs/UI-PLAN.md`
- Visual design: the "AI Office UI" canvas on claude.ai (Live office, First run, Settings, ⌘K palette, Wallboard, props board). It's the reference for layout and look.

## Status

- **P1 event backbone: built** (hooks → server → WebSocket → debug view) and tested with demo payloads. **Not yet tested against a real Claude Code session.**
- **Robot model:** `Assets/mini_robot/` holds "Mini Robot" by Onur (CC BY 4.0). It has **no skeleton or animations**: 25 rigid parts, and each part mesh covers both sides. `npm run build:robot` → `apps/web/public/models/robot.opt.glb` (36k tris, 0.7 MB, parts kept).
- **Next, in order:**
  1. Run a real session with hooks installed. Check whether tool events inside a subagent carry `agent_id` (see `normalize()` in `apps/server/src/hooks.ts`).
  2. **P0 robot:** the decision is pending. Recommended: rigid procedural animation. Split two-sided parts into L/R halves at build time, add pivots at shoulders, elbows, hips and neck, and animate in code (walk, idle, type, raise_hand, drink, wave, celebrate, think). The alternative is a Mixamo auto-rig.
  3. **P2 isometric office:** an R3F orthographic camera matched to the backdrop angle; backdrop + prop sprites + robots drawn in painter's order by foot y; walk grid + A*; `?helper` editor; railing cut-outs.

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
ddev start             # alternative: runs server + Vite as DDEV daemons
```

Demo without Claude Code: the "Run demo" button, `POST /api/sim {"on":true}`, or `OFFICE_SIM=1`.

## Architecture

- `apps/server/src/`, Node 22.18+/24, **runs the .ts files directly** (type stripping, no build):
  - `index.ts`: Hono routes (`POST /hook`, `/api/state|events|health|sim`), WebSocket `/ws` (first a snapshot, then batched arrays every 50 ms), and the static web build
  - `hooks.ts`: normalise a hook payload into an `OfficeEvent`; redact
  - `state.ts`: the agent state machine (`arriving·working·blocked·idle·break·charging·done·leaving`), desk allocation, spot claiming from `props.json`, idle/break/charge timers (in `office.config.json`)
  - `roles.ts` (role regex in `office.config.json`), `db.ts` (node:sqlite at `.data/office.db`), `sim.ts`, `config.ts` (`HOST`, `PORT`, `DATA_DIR`, token in `.data/token`)
- `apps/web/`: Vite + React 19 + Tailwind v4 (tokens from UI-PLAN §5) + zustand. `App.tsx` is the P1 debug view for now.
- `apps/web/src/scene/props.json`: **single source of prop positions**, read by both server and web. Coordinates are **% of the 2400×1792 room image** (`Assets/room/bg-main-area.png`). `foot` is the bottom-centre anchor, `width` is a % of room width, `z` overrides draw order, and `spots` are where robots stand.
- `packages/shared/src/index.ts`: type-only contracts (`OfficeEvent`, `AgentState`, `ServerMessage`).

## Rules

- **The hook endpoint must never affect a real session:** answer `200` with an empty body immediately and process afterwards. Never approve, deny or block anything.
- **Privacy:** never store full `tool_input`. Keep only the tool name and a short redacted summary (`summarize()`/`redact()` in hooks.ts).
- **Server TypeScript must be erasable syntax only:** no `enum`, `namespace` or constructor parameter properties. Use `.ts` extensions in relative imports, and `import type` for `@ai-office/shared`.
- **Light:** no Docker services, Electron or extra databases. Keep the web bundle small (see the PLAN §14 budget).
- **Art:** props use the restyled sprites in `Assets/sci-fi/`. The originals are in `Assets/{appliances,culture,decoration,furniture}`. Keep the dark gunmetal + cyan look.
- **Credits are required (CC BY 4.0):** "Mini Robot" by Onur — https://sketchfab.com/3d-models/mini-robot-3454c84d6eff4a9dabbfadbfd1f56524 — modified. Keep it in the README and the in-app About.
- `Assets/mini_robot/*` (54 MB source) is git-ignored except `license.txt`. `Claude outputs/` holds stale plan copies and is ignored.
