# AI Virtual Office: System Plan

> A lightweight, local-only **isometric sci-fi office** (painted room backdrop + sprite props) where Claude Code agents show up as 3D **Mini Robot** characters. They spawn, walk to their department, work, take breaks, raise a hand when blocked, and leave when they finish. A Slack-style panel lets you watch and chat with them.
>
> Status: **New build, personal project.** Inspired by [W17ant/Claude-Office](https://github.com/W17ant/Claude-Office) (MIT).
> Character: [Mini Robot](https://sketchfab.com/3d-models/mini-robot-3454c84d6eff4a9dabbfadbfd1f56524) by **Onur**, CC BY 4.0, so attribution is required. (This replaced the Baby Rigged Robot planned at first.)

---

## 1. Goals and constraints

| Goal | What it means |
|---|---|
| **Light** | 1 Node process plus 1 static web app. No Docker, Redis, Postgres, or Electron. Idle CPU near 0. Server RAM under 80 MB. |
| **Local-only** | Binds to `127.0.0.1`. Nothing leaves the machine except optional `claude -p` chat replies. |
| **Real-time** | Hook → screen latency under 150 ms. |
| **Runs on a MacBook Air** | 60 fps with up to 12 robots on screen. 3D drops to 30 fps or pauses when idle or when the tab is hidden. |
| **Zero-friction install** | `npm i && npm start`, plus one hooks block pasted into `~/.claude/settings.json`. |

**Non-goals for v1:** multi-user use, cloud hosting, controlling agents (only watching and talking), or a mobile layout.

---

## 2. What we keep and what we change from Claude-Office

| Claude-Office | This project | Why |
|---|---|---|
| 2D isometric pixel sprites | **Painted isometric sci-fi room (PNG) + restyled sprite props + 3D rigged robot drawn with a fixed orthographic camera** | Keeps the illustrated look and is far lighter than modelling a full 3D room |
| Bash hook script that `curl`s the server | **Native `type: "http"` hooks** posting straight to the server | No shell process per tool call, so it's lighter and works the same on every OS |
| Only `PreToolUse` and `PostToolUse` | Session, turn, tool, **subagent**, permission and notification events | Gives real spawn and leave moments, plus the "raise hand" state |
| Express + better-sqlite3 | **Hono + `ws` + `node:sqlite`** (built into Node 24) | Smaller install with no native build step |
| Electron `.dmg` | Browser tab, with **Tauri** as a later option | Electron adds about 150 MB; Tauri adds about 10 MB |
| Chat watcher polling via cron | Server calls `claude -p` on demand | No polling loop |

---

## 3. Architecture

```
┌──────────────────────┐   HTTP POST (hooks, 1s timeout, non-blocking)
│ Claude Code sessions │ ───────────────────────────────────────────┐
│ (main + subagents)   │                                            ▼
└──────────────────────┘                          ┌───────────────────────────────┐
                                                  │  office-server  (Node 24)     │
                                                  │  ─ Hono HTTP  :3334           │
   claude -p --model haiku  ◄──── chat replies ── │  ─ Event normalizer           │
                                                  │  ─ Agent state machine        │
                                                  │  ─ Role resolver              │
                                                  │  ─ node:sqlite (office.db)    │
                                                  │  ─ ws broadcast  /ws          │
                                                  └──────────────┬────────────────┘
                                                                 │ WebSocket (JSON patches)
                                                                 ▼
                                                  ┌───────────────────────────────┐
                                                  │  office-web (served on :3334; │
                                                  │  Vite dev server :5173)       │
                                                  │  ─ R3F scene + robots         │
                                                  │  ─ zustand store              │
                                                  │  ─ Chat panel (Slack-style)   │
                                                  └───────────────────────────────┘
```

The server is the **single source of truth**. The browser only renders the state it receives, so a refresh or a second tab rebuilds the office instantly from `GET /api/state`.

---

## 4. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Node 24 LTS** (22.18+ works) | The server runs its `.ts` files directly through Node's type stripping, so there's no build step. Also uses `node:sqlite`, native `fetch`, and `--watch` in dev. |
| HTTP | **Hono** (+ `@hono/node-server`) | About 14 KB with typed routes |
| Realtime | **ws** | One socket per tab |
| DB | **node:sqlite** | Falls back to better-sqlite3 if needed |
| Frontend | **Vite + React 19 + TypeScript** | |
| Scene | **three + @react-three/fiber + @react-three/drei** with an `OrthographicCamera` locked to the backdrop's isometric angle | `useGLTF`, `useAnimations`, `SkeletonUtils.clone` for robots; backdrop and props are textured planes in the same scene |
| Room art | `bg-main-area.png` (2400×1792) + restyled props in `Assets/sci-fi/` | Shipped as WebP: backdrop ~300 KB, props ~30–60 KB each |
| Post FX | None by default | The painted room already glows. Optional Bloom on robots only. |
| State | **zustand** | |
| UI | Tailwind CSS v4 | Chat panel and HUD |
| Asset pipeline | **Blender 4.x (CLI) + gltf-transform** | Decimate, compress, merge animations |
| Chat AI | `claude -p --model haiku --output-format json` | Can be turned off. Uses your existing Claude Code login. |
| Shared types | `packages/shared` (TS) | Event and state contracts used by both server and web |

---

## 5. Event capture (Claude Code hooks)

`npm run install-hooks` (`scripts/install-hooks.mjs`) merges these into `~/.claude/settings.json`:

- **Backup:** it saves the old file as `settings.json.bak-<timestamp>` first.
- **Safe to re-run:** it replaces only its own entries, which it marks with an `X-AI-Office` header. `npm run uninstall-hooks` removes them.
- **Events:** 14 of them: `SessionStart/End`, `UserPromptSubmit`, `Pre/PostToolUse`, `PostToolUseFailure`, `SubagentStart/Stop`, `Stop`, `Notification`, `PermissionRequest`, `TaskCreated/Completed`, `PreCompact`.
- **Token:** read from `.data/token` (mode 0600) and written into the header. `--env` sends `$OFFICE_TOKEN` instead.
- **DDEV:** use `--url http://ai-office.ddev.site:3334/hook`.

```json
{ "type": "http", "url": "http://127.0.0.1:3334/hook", "timeout": 1,
  "headers": { "Authorization": "Bearer <token>", "X-AI-Office": "1" } }
```

**Safety rules for the hook endpoint:**

- It always returns `200` with an empty body, so it never blocks, approves, or denies anything.
- If the server is down, Claude Code treats the connection failure as non-blocking, so your coding is never affected.
- `timeout: 1` caps the worst-case delay.
- The server responds first and processes after (`setImmediate`).
- A missing or wrong token gets `401`, and the event is dropped.

**Normalized domain event** (shared type):

```ts
type OfficeEvent = {
  id: string; ts: number;
  sessionId: string;            // main Claude Code session
  agentId: string;              // sessionId for main agent, agent_id for subagents
  parentAgentId?: string;
  kind: 'spawn' | 'leave' | 'prompt' | 'tool_start' | 'tool_end' | 'tool_fail'
      | 'blocked' | 'notify' | 'turn_done' | 'task_created' | 'task_done' | 'compact';
  tool?: string;                // Bash, Edit, Read, WebFetch, Task…
  summary?: string;             // short, redacted ("Edit src/App.tsx", "npm test")
  cwd: string; project: string; // basename(cwd), used as the "team" label
  agentType?: string;           // Explore, Plan, general-purpose, custom
};
```

**Redaction:** never store the full `tool_input`. Keep only the tool name, the file basename or a command truncated to 60 characters, and strip anything that looks like a token or secret (`/[A-Za-z0-9_\-]{24,}/`, `KEY=`, `TOKEN=`).

> **Verify with a real session (still open):** do tool events fired *inside* a subagent carry `agent_id`? The server uses `agent_id` when it's present; otherwise the event goes to the main session's robot. If real payloads lack it, the fallback is to send tool events to the most recently started subagent that hasn't stopped.

---

## 6. Agent lifecycle (state machine)

```
            spawn                      tool_start
  (none) ─────────► ARRIVING ─walk─► AT_DESK ◄────────────┐
                                       │  │                │
                         tool_start    │  │ 20s no events  │ any event
                     ┌─────────────────┘  ▼                │
                     ▼                  IDLE ──45s──► BREAK (coffee/lounge)
                  WORKING(activity)                        │
                     │   blocked (PermissionRequest/Notification)
                     ▼
                  BLOCKED (raise hand, ! bubble, chat ping)
  turn_done ─► DONE (stretch/celebrate 3s) ─► IDLE
  leave (SubagentStop / SessionEnd / 10 min stale) ─► LEAVING ─walk─► CLAUDE door ─► removed
  idle 3 min+ or PreCompact ─► CHARGING (charging pad)
```

As built in `apps/server/src/state.ts`, the agent statuses are `arriving · working · blocked · idle · break · charging · done · leaving`. All timers live in `office.config.json`. Each status claims a free **spot** at a prop, and the spots come from `props.json`. If a prop is full, the agent falls back to its own desk, then the lounge.

**The tool determines the activity, which picks the zone and the animation:**

| Event / tool | Activity | Prop it walks to | Animation |
|---|---|---|---|
| `Edit`, `Write`, `NotebookEdit` | coding | own workstation desk (8 on the left floor, facing the window) | `stand_type` |
| `Read`, `Grep`, `Glob`, `LS` | researching | archive (2 filing cabinets side by side + printer on its stand) | `stand_scan` |
| `Bash` | running | server bank under the command deck | `stand_type` |
| `WebFetch`, `WebSearch`, `mcp__*` | browsing | comms holo-screens by the window | `stand_type` |
| `Task` / `Agent` (spawning a subagent) | delegating | own desk | `point` + new robot enters by the door |
| Plan agents, plan mode | planning | holo-table ring | `think` |
| `TodoWrite`, `TaskCreate` | planning | whiteboard | `think` |
| `PermissionRequest`, `Notification` | blocked | approval terminal (command deck) | `raise_hand` |
| idle 45 s | break | coffee station (2 machines on the back-wall bench) | `drink` |
| idle 45 s while someone else is already on a break | break | lounge dais | `idle` / `wave` |
| idle 3 min+, `PreCompact` | recharging | charging pads (3) | `sleep` |
| `TaskCompleted`, `Stop` | done | ship bell | `celebrate` |
| `SessionStart`/`SubagentStart`, `SessionEnd`/`SubagentStop` | arriving / leaving | the CLAUDE door | `walk` |

**Anti-jitter:** zone changes are debounced by 2 seconds, so a Read→Edit→Read burst keeps the robot at its desk instead of sprinting around the room.

---

## 7. Roles ("IT company")

Each robot gets a role, a department zone, and a visual variant (body tint + one accessory attached to a bone).

| Role | Assigned when | Look |
|---|---|---|
| **CEO (you)** | Fixed avatar in the corner office. Reacts to `UserPromptSubmit` (walks to the robot, "briefs" it). | Gold trim |
| **Lead Engineer** | Main Claude Code session | Blue, headset |
| **Researcher** | Subagent `agent_type = Explore` | Teal, visor |
| **Architect** | `agent_type = Plan` | Purple, blueprint tablet |
| **Engineer** | `general-purpose` | Orange, toolbelt |
| **QA / Debugger** | Custom agent with a name matching `test\|qa\|debug\|review` | Red, magnifier |
| **DevOps** | Custom agent with a name matching `deploy\|ci\|infra\|devops` | Green, hard hat |
| **Designer** | Custom agent with a name matching `ui\|design\|frontend` | Pink, beret |

The rules live in `office.config.json` (regex → role), so new custom agents slot in without code changes. The **project** (`basename(cwd)`) appears as a name tag, so two sessions in different repos read as two teams.

---

## 8. The environment (isometric, painted)

**Art direction:** a dark gunmetal sci-fi office with cyan neon, holo-screens and a city window, drawn as one **isometric illustration** (`Assets/room/bg-main-area.png`, 2400×1792; the version without hanging ceiling lamps). The office props are the original office sprites **restyled to match** (`Assets/sci-fi/…`: dark metal, cyan glow, glowing screens, holo-glass boards). The canvas design ("AI Office UI") is the reference layout.

**How it's drawn (one R3F scene, painter's order):**

1. **Backdrop:** the room PNG on a full-frame plane at the back.
2. **Props and robots:** each prop sprite is a textured plane anchored at its bottom-centre "foot" point. Each robot is the 3D GLB. Everything is **sorted by foot Y every frame** (`renderOrder`), so a robot walks in front of a desk when it's below it and behind it when it's above it.
3. **Foreground cut-outs:** parts of the painted room that must cover robots (the front railings of the command deck and the lounge dais) are cut out of the backdrop as separate transparent PNGs, drawn on top at their own foot Y.

**Camera:** orthographic, fixed at the backdrop's isometric angle. Zoom (1×–2.5×) and pan are allowed. There's no rotation, because the painting only has one angle.

**Floor plan (from the backdrop):**

```
  window wall (left)                         back wall (right)
  city window · comms holo-screens ·         coffee bench (2 machines) · bell · CLAUDE door ·
  whiteboard · filing cabinets ×2            mission board · status screen
  printer on stand                           ┌──────── command deck (raised, stairs) ────────┐
          holo-table ring                    │ CEO desk · approval terminal · server bank    │
                                             │ charging pads ×3                              │
  workstations ×8, all facing the window     └───────────────────────────────────────────────┘
  rows 1–2: 1 desk · rows 3–5: 2 desks            lounge dais (plants)
```

**Props file** (`apps/web/src/scene/props.json`, done): one entry per prop with `id`, `kind`, `sprite` (or `sprites` for multi-part props), `foot: [x%, y%]`, `width` (% of room width), an optional `z` draw-order override, `spots: [[x%, y%], …]` (where a robot stands) and `level` (`floor` or `deck`). Some props also have `busySprite`/`failSprite` (coffee machine, printer, filing cabinet). It was exported from the canvas, and the server reads the same file to build its spot pools.

**Movement:**
- A **walk grid** of isometric tiles (about 32 × 32) laid over the floor. Each tile is `walkable`, `blocked` or `deck`. The deck connects to the floor only through the stair tiles.
- A* on that grid, then smoothed. Robots walk at a fixed speed and loop `walk` while moving. On the deck, the robot's screen position is lifted by the deck height.
- The grid and the props' `interactSpots` are authored in a **`?helper` mode**: click tiles to toggle them and drag props into place, then export JSON. This is the same idea as Claude-Office's furniture helper.

**Desk assignment:** first free workstation. A subagent takes the desk nearest its parent.

**Overhead UI:** DOM name tags positioned from each robot's head point (projected to screen). Hidden when zoomed out, except for blocked agents. On the wallboard only blocked tags show.

**Lighting:** the room's light is painted in. Robots get one hemisphere light plus a cyan rim light, so they sit in the scene. No shadow maps: each robot gets a soft blob shadow sprite.

**Living details (P4):** prop states swap sprites (`coffee-off` → `coffee-on` while an agent drinks, `printer` → `printer-working` while reading, `printer-broken` on `PostToolUseFailure`, filing cabinet opens). Neon strips pulse from a small additive overlay. The bell swings on `TaskCompleted`.

---

## 9. Character pipeline (the main technical risk)

**The model as delivered** (`Assets/mini_robot/scene.gltf`): **257k triangles**, 25 rigid parts (head, screen face, ears, cap, neck, body, chest, backpack, arms, arm joints, legs), 2 materials, 7 textures at 4096². **No skeleton and no animations.** Each part mesh covers both sides (one mesh holds both upper arms, another both legs).

**Done:** `scripts/build-robot.sh` (`npm run build:robot`) outputs `apps/web/public/models/robot.opt.glb`: **36k triangles, 1024² WebP textures, meshopt, 0.7 MB**, with all 25 parts kept. The steps are dedup, weld, simplify 8% (error 0.0015), prune, resize, WebP and meshopt.

**Still open: how to animate it** (§9 steps 4–5 below assume a skeleton, which this model doesn't have).

- **Recommended: rigid procedural animation.** At build time, split each two-sided part into left and right halves and add pivot nodes at the shoulders, elbows, hips and neck. Then animate in code: walk, idle bob, typing, raise hand, drink, wave, celebrate, think. There's no Blender or Mixamo step, the file stays tiny and cheap to run, and it suits a hard-surface robot. Legs stay stiff (a cute waddle).
- **Alternative: Mixamo auto-rig.** Merge the parts, export FBX from Blender and auto-rig it as a humanoid to get skinned clips. This gives natural motion, but the hard parts bend at the joints and it's heavier to run.

**P0 asset spike, done once and scripted so it can be re-run:**

1. Download the glTF from Sketchfab, open it in Blender, and confirm the bone hierarchy, skin weights, and any included actions.
2. **Decimate** to about **15–25k triangles** (Collapse, preserve UVs). Use a Shrinkwrap/weight-transfer pass if the decimation breaks deformation.
3. **Bake textures** to a single **1024² atlas** (base color + emissive, plus ORM if needed).
4. **Animations:** pick one of two paths:
   - **a) Mixamo:** if the rig is humanoid-ish, upload the FBX and auto-map idle, walk, sitting typing, sitting idle, drinking, waving, thinking, and celebrate.
   - **b) Hand-key in Blender:** for a non-humanoid robot rig. Short loops (1–2 s each) are enough at this camera distance.
   - Clips needed: `idle`, `walk`, `sit_type`, `sit_idle`, `stand_type`, `stand_scan`, `think`, `drink`, `raise_hand`, `wave`, `celebrate`, `point`.
5. Export **one GLB** with all actions as NLA tracks.
6. Run `gltf-transform optimize robot.glb robot.opt.glb --compress meshopt --texture-compress webp --texture-size 1024`.

**Target:** under **1.5 MB** GLB, under 25k triangles, and 1 material.

**Runtime:**

- Load once with `useGLTF`. Each agent gets `SkeletonUtils.clone(scene)`, which shares geometry and textures and gives every robot its own skeleton.
- Each robot gets its own `AnimationMixer`, with 0.25 s crossfades between clips.
- Role tint is a cloned material with a changed `emissive`/`color`. That's the only per-instance material.
- Accessories (headset, hard hat, and so on) are tiny GLBs parented to the head or hand bone.
- **LOD:** past 30 units from the camera, update the mixer at 15 Hz instead of every frame.

**Matching the painted room:** the robot is rendered with the orthographic camera at the backdrop's angle, using a light toon ramp and a thin dark outline (an inverted-hull outline pass), so it reads like the illustration instead of a glossy 3D model. Robots only need 4 facing directions (the isometric diagonals).

**Lighter fallback (if the Air struggles):** bake each clip × 4 directions into sprite sheets from Blender at the same camera angle, and draw robots as sprites. That drops the live skinned meshes completely.

**Attribution:** the About dialog and README include: *"Mini Robot" by Onur, CC BY 4.0, linked to the original (https://sketchfab.com/3d-models/mini-robot-3454c84d6eff4a9dabbfadbfd1f56524), with a note that it was modified (decimated, textures resized, animated).*

---

## 10. Chat panel (Slack-style)

Right-side panel, about 360 px wide and collapsible.

| Channel | Content |
|---|---|
| **#office** | The "Office Manager" AI. Ask "what's everyone doing?", "who's stuck?", "summarize today". |
| **#activity** | An auto feed built from events, no AI needed: "🔵 Lead Engineer (tackld) started editing `TaskCard.tsx`". |
| **@agent-name** (one DM per robot) | That agent's timeline. You can ask it questions, and the manager AI answers *as* that agent using its recent events. |

- **Manager AI:** the server builds a compact context (current agents, last 30 events, git branch per project) and runs `claude -p --model haiku`. Replies come back over WS. A global **AI toggle** sets the token cost to zero when it's off.
- **Slash commands** (no AI, instant): `/status`, `/agents`, `/who <role>`, `/clear`, `/sim`, `/ai on|off`.
- **Clicking a robot** opens its DM. **Clicking a message** flies the camera to that robot.
- **Blocked alert:** when an agent raises its hand, a chat ping and an optional browser `Notification` fire.

**P5 experiment, "Whisper to agent":** queue a message for a specific agent. On that agent's next `PostToolUse`, the hook response returns it as `additionalContext`, so the real Claude Code agent reads your note mid-task. This turns the office from view-only into lightly interactive. It needs verification against the hooks output schema, and it should be opt-in per message.

---

## 11. Data model (`.data/office.db` in the project, git-ignored; `DATA_DIR` overrides)

```sql
events   (id PK, ts, session_id, agent_id, kind, tool, summary, project, json)  -- pruned after 7 days
messages (id PK, ts, channel, author, body, meta)                               -- chat history (P3)
settings (key PK, value)                                                        -- ai_enabled, theme, etc.
```

In-memory state is authoritative while the server runs. Agents aren't persisted: after a restart, an agent reappears at its desk on its next hook event (no walk-in).

---

## 12. Server API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/hook` | Claude Code hook intake (Bearer token) · built |
| `GET` | `/api/health` | Liveness, agent count, demo state · built |
| `GET` | `/api/state` | Full snapshot: agents, recent events, demo state · built |
| `GET` | `/api/events?agent=&limit=` | Timeline for a DM · built |
| `POST` | `/api/sim` | `{ on }`: start or stop the scripted demo · built |
| `GET/POST` | `/api/chat/:channel` | History and send message · P3 |
| `WS` | `/ws` | First message is a `snapshot`, then batched arrays (about 20 per second) of `agent`, `agent.remove`, `event`, `sim` · built |

The token is generated on first run into `.data/token` (mode `0600`). `OFFICE_TOKEN` overrides it. One port (`:3334`) serves the hooks, the API, the WebSocket and the built UI. In dev, Vite runs on `:5173` and proxies `/api` and `/ws`.

---

## 12b. Running on DDEV

`.ddev/config.yaml` (DDEV v1.24.3+):

- **Container:** `webserver_type: generic` and `nodejs_version: "24"`.
- **Daemons:** `npm run dev:server` and `npm run dev:web` run as `web_extra_daemons`.
- **Ports:** `3334` (server; https 3335) and `5173` (Vite; http 5172).
- **Bindings:** `HOST=0.0.0.0` and `VITE_HOST=0.0.0.0` so the DDEV router can reach the server and Vite. `VITE_HMR_HOST=ai-office.ddev.site` makes hot reload work through the router.
- **Install:** a `post-start` hook runs `npm install` and restarts the daemons.
- **Hooks:** Claude Code runs on the Mac, so install the hooks there with `--url http://ai-office.ddev.site:3334/hook` (plain http, so Node doesn't need to trust mkcert).
- **Chat AI (P3):** `claude -p` isn't in the container. The plan is to install the Claude CLI in `.ddev/web-build/Dockerfile` and authenticate with a `claude setup-token` token in `.ddev/.env` (`CLAUDE_CODE_OAUTH_TOKEN`).

---

## 13. Repo layout

✓ = exists now (P1 scaffold) · the rest is planned.

```
AI-Ofiice/
├─ package.json              ✓ npm workspaces; dev / build / start / install-hooks
├─ office.config.json        ✓ desks, timers, role regex, AI settings
├─ .ddev/config.yaml         ✓
├─ docs/PLAN.md, UI-PLAN.md  ✓
├─ apps/
│  ├─ server/src/
│  │  ├─ index.ts            ✓ Hono + ws bootstrap, batched broadcast, static UI
│  │  ├─ hooks.ts            ✓ normalise + redact
│  │  ├─ state.ts            ✓ agent state machine, timers, desks, spot claiming
│  │  ├─ roles.ts            ✓
│  │  ├─ sim.ts              ✓ scripted demo
│  │  ├─ db.ts               ✓ node:sqlite
│  │  ├─ config.ts           ✓ ports, host, data dir, token
│  │  └─ chat.ts               slash commands + claude -p bridge (P3)
│  └─ web/src/
│     ├─ App.tsx             ✓ P1 debug view (agents table + activity log + demo toggle)
│     ├─ store.ts            ✓ zustand, fed by ws with reconnect
│     ├─ styles.css          ✓ Tailwind v4 + UI-PLAN tokens, offline fonts
│     ├─ scene/props.json    ✓ prop sprites, foot points, spots (from the canvas)
│     ├─ scene/Office.tsx      ortho camera, backdrop, props, painter's sort (P2)
│     ├─ scene/walkgrid.json   iso tile grid (P2)
│     ├─ scene/Robot.tsx       clone + mixer + toon/outline (P2)
│     ├─ scene/nav.ts          A* on the iso grid (P2)
│     ├─ scene/Helper.tsx      ?helper: edit grid and props, export JSON (P2)
│     └─ chat/Panel.tsx        (P3)
├─ packages/shared/src/      ✓ OfficeEvent, AgentState, ServerMessage types
├─ Assets/
│  ├─ room/bg-main-area.png  ✓ painted isometric room
│  ├─ sci-fi/…               ✓ restyled props + printer stand
│  ├─ appliances/ culture/ decoration/ furniture/  ✓ original sprites
│  ├─ source/                  Sketchfab robot download (git-ignored)
│  ├─ room/fg-*.png            foreground cut-outs (railings)
│  └─ blender/process.py       decimate + bake + export (P0)
└─ scripts/
   ├─ install-hooks.mjs      ✓
   └─ build-assets.sh          blender → gltf-transform (P0)
```

---

## 14. Performance budget

| Item | Budget |
|---|---|
| Web JS bundle (gzipped) | under 450 KB (three is most of it) |
| Scene assets total | under 3 MB |
| Draw calls with 12 robots | under 80 |
| Frame time on a MacBook Air (M-series) | under 12 ms |
| Render loop | `frameloop="demand"` when no robot is moving or animating. Paused on `visibilitychange`. |
| DPR | capped at 1.5 |
| Server idle CPU / RAM | ~0% / under 80 MB |

---

## 15. Milestones

| Phase | Scope | Done when |
|---|---|---|
| **P0 – Asset spike** (1–2 days) | Decimate and animate the robot. Set up the ortho camera on the backdrop and match its isometric angle. Toon/outline look test. 12 clones walking over the room. | 12 robots run at 60 fps on the Air, the GLB is under 1.5 MB, and robots look like part of the painting |
| **P1 – Event backbone** · *scaffold built, tested with demo payloads* | Server, hooks installer, normalizer, state machine, WS. A 2D debug list in the web app. | Real sessions + subagents appear and leave correctly, and `agent_id` attribution is verified *(remaining: run against a real Claude Code session)* |
| **P2 – Isometric office** | Props file, `?helper` mode, walk grid + A*, deck and stairs, foreground cut-outs, desk allocation, state→animation, overhead tags, role tints. | Watching a real Claude Code task "reads" correctly without looking at the terminal |
| **P3 – Chat** | #activity feed, DMs, slash commands, manager AI via `claude -p`, AI toggle, blocked pings. | You can ask "who's stuck?" and get a correct answer |
| **P4 – Polish** | Day/night, ambient events, sim mode, settings drawer, About/attribution. | The demo runs with no Claude session (`?sim`) |
| **P5 – Optional** | Whisper-to-agent, Tauri desktop wrapper, CEO avatar interactions, cost/token HUD (from the transcript). | Each is optional |

---

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| 3D robot looks pasted onto the painted room | Toon ramp + outline + rim light. If it still clashes, bake to sprite sheets (§9). |
| Robots appear in front of railings they should be behind | Foreground cut-out PNGs drawn by foot Y (§8) |
| The painting fixes the layout, so props can't move freely | Props that agents use are separate sprites. Repainting is only needed for built-in features (door, deck, holo ring). |
| Robot rig is non-humanoid, so Mixamo can't map it | Hand-key 12 short loops in Blender (path b). Budget about 1 day. |
| Decimation breaks skinning | Decimate a copy, then use Data Transfer → vertex groups from the original mesh. |
| Subagent tool events lack `agent_id` | Fall back to the most recently started open subagent (see §5) |
| Hook endpoint slows Claude Code | HTTP hook, `timeout: 1`, respond-then-process, non-blocking on failure |
| Secrets leak into the office DB | Redact at intake (§5) and never persist full `tool_input` |
| Token cost from chat | Manager AI uses Haiku, is off by default, and slash commands are free |
| Sketchfab license | Credit Onur ("Mini Robot", CC BY 4.0) in the UI and README, and note the modifications |

---

## 17. What I need from you and what's optional

**Needed to start building:**

1. ~~A connected folder~~ **Done:** `Documents/GitHub/Claude/AI-Ofiice` (holds `Assets/`, including the room and `Assets/sci-fi/`).
2. **Blender 4.x installed** locally (`brew install --cask blender`). The asset script runs headless, but the decimation results need your eyes.
3. **The robot download.** Sketchfab needs you to be logged in to download. Grab the **glTF** (or the original `.blend` if offered) and drop it into `Assets/source/`.

4. **The room background's source**, if it exists in layers (PSD, Procreate, or the AI tool's project), so the railings can be separated cleanly. Without it, I cut them out of the flat PNG by hand.

**Helpful but optional:**

- A **Mixamo** login (free Adobe account) if the rig turns out to be humanoid.
- Your **Figma** (already connected) if you want to design the chat panel/HUD first. Otherwise I'll use the `ui-ux-pro-max` skill for a dark sci-fi panel.
- **No new skills are required.** If you want one, a three.js / React Three Fiber skill would help in P2, and we can draft it together with `skill-creator` once patterns settle.

---

## 18. Open decisions

1. ~~Camera~~ **Decided:** fixed isometric angle from the painted room, with zoom and pan.
2. ~~Max desks~~ **Decided:** 8 workstations in one room. Extra agents fall back to the lounge.
3. **Chat AI default:** off (zero cost) or on with Haiku?
4. **Desktop wrapper later:** Tauri, or stay as a browser tab?
