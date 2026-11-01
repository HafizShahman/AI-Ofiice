# AI Virtual Office: UI Plan

> Companion to `PLAN.md`. This covers layout, screens, components, design tokens, and interactions for the web app (`apps/web`).
> Stack: Vite, React 19, Tailwind v4, React Three Fiber, zustand. Dark-only, desktop-first, runs locally.

---

## 1. UI principles

1. **The office is the hero.** The 3D scene takes about 70% of the screen. The UI frames it and never covers the middle of the room.
2. **Readable at a glance.** From across the desk you should be able to tell who's working, who's stuck, and who just finished, without reading text.
3. **Every robot is also a row.** Anything you can click in 3D can also be reached from the roster or the keyboard. 3D is never the only way in.
4. **Calm by default, loud only when needed.** Motion and color are saved for *blocked*, *failed* and *done*. Everything else stays quiet.
5. **Light on the GPU.** Panels use solid translucent fills, not `backdrop-filter` blur over the WebGL canvas. Blur is an optional setting.

---

## 2. Layout (desktop, 1440 px or wider)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ◈ AI OFFICE   [All projects ▾]    ● 4 working  ◐ 2 idle  ✋ 1 blocked  ✓ 12 done   ⌘K  ⚙ │  TopBar 48px
├──────────────────────────────────────────────────────────────────┬───────────────────────┤
│                                                                  │ # office        AI ●  │
│   ┌ toast ───────────────────────┐                               │ # activity       12   │
│   │ ✋ Researcher needs permission│        3D OFFICE SCENE        │ ─ Agents ───────────  │
│   └──────────────────────────────┘                               │ @ lead-eng  ●         │
│                                                                  │ @ researcher ✋        │
│        [robot]  [robot]   [robot]                                │ @ architect ◐         │
│         ▔▔▔▔     ▔▔▔▔      ▔▔▔▔                                  ├───────────────────────┤
│                                                                  │                       │
│  ┌ Inspector (when a robot is selected) ┐                        │   message list        │
│  │ 🔵 Lead Engineer · tackld            │                        │   (virtualized)       │
│  │ Editing  TaskCard.tsx    00:42       │                        │                       │
│  │ ─ timeline ─────────────────────────│                        │                       │
│  │ [Open DM] [Follow cam] [Whisper]     │                        │                       │
│  └──────────────────────────────────────┘          [⟲][+][−][◎] │                       │
├──────────────────────────────────────────────────────────────────┤ ┌───────────────────┐ │
│ Roster ▸ [LE ● Edit] [RS ✋ Perm] [AR ◐ Idle] [EN ● Bash] …      │ │ Message / command │ │  Roster 56px
└──────────────────────────────────────────────────────────────────┴─┴───────────────────┴─┘
                                                                     Chat panel 380px
```

**Z-index scale:** scene 0, overhead tags 10, roster and inspector 20, toasts 40, drawers 60, dialogs and command palette 100.

### Responsive behavior

| Width | Behavior |
|---|---|
| 1440 px and up | Full layout as shown above |
| 1024 to 1439 px | Chat panel narrows to 340 px. The roster shows only initials and a status icon. |
| 768 to 1023 px | Chat becomes an overlay drawer (toggle `C`). The scene goes full width. |
| Under 768 px | **View-only.** The scene fills the screen, the roster becomes a list, and chat opens as a bottom sheet. Mobile isn't a goal, but it shouldn't break. |

---

## 3. Screens and states

| State | When | What the user sees |
|---|---|---|
| **First run / setup** | No hook event received yet *and* the hooks aren't detected in settings | A centered setup card over a dimmed office: ① server running ✓ ② hooks installed (copy-able command `npm run install-hooks`) ③ "Start any Claude Code session". A secondary button says **Try demo (sim)**. |
| **Empty office** | Server connected, no active agents | Lights dim to 40% and one cleaning-drone robot idles. Center caption reads "Waiting for Claude Code…" with a quiet **Run demo** link. |
| **Live** | 1 or more agents | Normal layout |
| **Busy** | More than 8 agents | Overhead tags collapse to icon-only. The roster scrolls horizontally inside its own strip, never the page. |
| **Disconnected** | WebSocket drops | A 32 px amber banner under the TopBar reads "Reconnecting… (3)". The scene freezes in grayscale at 50% saturation. It auto-retries with backoff, and a **Retry now** button is available. |
| **Wallboard mode** | Press `F` or use the TopBar menu | All chrome is hidden. The camera tours the room slowly, large counters sit bottom-left, and the latest 3 activity lines are shown. Made for a second monitor. Press `Esc` to exit. |
| **Sim mode** | `?sim` or `/sim` | A purple "SIMULATION" ribbon sits top-left, so fake agents are never mistaken for real ones. |

---

## 4. Components

### 4.1 TopBar (48 px)
- **Left:** logo mark and wordmark "AI OFFICE" (mono).
- **Project filter:** a dropdown of projects (from `basename(cwd)`). Choosing one dims robots from other projects to 25% and filters the roster and #activity.
- **Center: live counters** for working, idle, blocked and done today. Each is a button that filters the roster to that status. Numbers use tabular figures.
- **Right:** ⌘K palette, AI toggle (a pill showing "AI on · Haiku" or "AI off"), and ⚙ settings.

### 4.2 Roster dock (bottom, 56 px)
- A chip for each agent showing role avatar initials, a status icon, and a short activity verb ("Edit", "Bash", "Perm").
- Chip order: blocked → working → idle → done. Within each group the newest comes first.
- Click to select (fly the camera there and open the Inspector). Double-click to follow. Arrow keys move between chips and `Enter` selects.
- Subagents sit visually *under* their parent: an indented chip with a thin connector line.

### 4.3 Overhead tag (in 3D, drei `<Html>`)
```
 ┌───────────────────────────┐
 │ ● Lead Engineer · tackld  │   ← name + project, 12px
 │ Editing TaskCard.tsx      │   ← activity, 11px mono, truncates to 28 chars
 └────────────▽──────────────┘
```
- **States:** working (cyan dot pulses slowly), idle (gray, no activity line), blocked (amber border + ✋ + "Needs permission", gentle bob), failed (red flash for 1.5 s, then back to normal), done (green ✓ + "Done" for 3 s).
- **Level of detail:** full tag when zoomed in, icon-only when zoomed out, hidden in wallboard mode except for blocked agents.
- `pointer-events: none`, except the blocked badge, which is clickable and jumps to the permission prompt context.

### 4.4 Inspector (floating card, top-right, 320 × auto)
- Moved from bottom-left: in the isometric room, the bottom-left holds the workstations, while the top-right is empty wall and ceiling. It shows the last 3 events; the stats sit in one line under the name.
- **Header:** role icon and name, project, status pill, elapsed time on the current activity.
- **Now:** current tool and redacted summary.
- **Timeline:** the last 15 events as a compact vertical list with icon, verb, target and relative time. Errors are shown in red with a label.
- **Stats row:** tools used, edits, commands, run time.
- **Actions:** **Open DM** · **Follow camera** · **Whisper** (P5, disabled with a tooltip until then).
- **Close:** `Esc`, the ✕ button, or clicking an empty floor.

### 4.5 Chat panel (right, 380 px)
- **Channel list** (collapsible to icons): `# office`, `# activity` (unread count), then **Agents** as DMs with live status dots. Agents that have left go into a collapsed "Today" group.
- **Message list:** virtualized (react-virtuoso), with grouped consecutive messages and sticky day separators.
  - **Human** messages are right-aligned with a subtle fill.
  - **Office Manager AI** messages are left-aligned with a robot avatar and a small "AI" tag.
  - **System or activity** lines are compact single rows with an icon, mono target, and timestamp. They aren't bubbles, so the feed stays dense.
  - Code or file references render as mono chips. Clicking one selects the related robot.
- **Composer:** a multi-line input. `Enter` sends, `Shift+Enter` adds a new line. Typing `/` opens a slash-command popover (`/status /agents /who /sim /ai /clear`) with arg hints. When AI is off, the placeholder reads "AI is off. Slash commands still work."
- **Typing indicator:** three dots and "Office Manager is thinking…", plus a **Stop** button if a reply takes more than 2 s.
- **Unread jump:** a "↓ 5 new" pill when you've scrolled up.

### 4.6 Toasts (top-left of scene)
- Shown only for **blocked**, **failed after 3 retries**, and **session finished**. At most 3 stack at once, and they auto-dismiss after 5 s except blocked toasts, which stay until resolved.
- Each toast has a **Show** button that selects the robot. Announced with `aria-live="polite"`.

### 4.7 Settings drawer (right, 400 px)
- Sections:
  - **General:** theme accent, 12/24 h clock.
  - **Scene:** quality Low/Med/High (DPR, bloom, shadows), blur panels, reduced motion, day/night follows clock.
  - **AI:** on/off, model, max context events.
  - **Notifications:** browser notifications for blocked agents, sound on/off.
  - **Hooks:** shows the status and lets you re-run the installer command.
  - **Roles:** a read-only view of the regex → role map, editable in `office.config.json`.
  - **About:** version, *"Mini Robot" by Onur, CC BY 4.0 (modified)*, and Claude-Office credit.

### 4.8 Command palette (⌘K, using `cmdk`)
- Jump to an agent, switch channel, filter by project, toggle wallboard, AI, sim or quality, and run any slash command.

### 4.9 Camera control cluster (bottom-right of scene)
- Reset view `⟲`, zoom in/out, and focus on selected `◎`. Each is 36 px visible with a 44 px hit area and a tooltip.

---

## 5. Design tokens (Tailwind v4 `@theme`)

### 5.1 Colors

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#070B14` | Page and scene fog |
| `--color-surface` | `#0E1524` @ 92% | Panels (solid, no blur by default) |
| `--color-surface-2` | `#141D31` | Hover, selected rows, inputs |
| `--color-border` | `#22304A` | Dividers, panel outlines |
| `--color-text` | `#E6EDF7` | Primary text (15.8:1 on bg) |
| `--color-text-muted` | `#8A9BB8` | Secondary text (6.9:1 on bg) |
| `--color-accent` | `#22D3EE` | Cyan: brand, focus ring, working state, emissive strips |
| `--color-accent-2` | `#E879F9` | Magenta: AI and Office Manager, sim ribbon |
| `--color-success` | `#34D399` | Done |
| `--color-warning` | `#FBBF24` | Blocked or needs permission |
| `--color-danger` | `#F87171` | Failed tool |
| `--color-idle` | `#64748B` | Idle or break |

**Status always pairs color with an icon and a word** (● Working, ◐ Idle, ✋ Blocked, ✕ Failed, ✓ Done), so it never relies on color alone.

### 5.2 Role colors (the same values tint the robot's emissive material in 3D)

| Role | Color | Icon (lucide) |
|---|---|---|
| CEO (you) | `#FACC15` gold | `crown` |
| Lead Engineer | `#60A5FA` blue | `headset` |
| Researcher | `#2DD4BF` teal | `scan-search` |
| Architect | `#A78BFA` purple | `drafting-compass` |
| Engineer | `#FB923C` orange | `wrench` |
| QA / Debugger | `#F87171` red | `bug` |
| DevOps | `#4ADE80` green | `server-cog` |
| Designer | `#F472B6` pink | `palette` |

### 5.3 Typography (self-hosted via `@fontsource`, works offline)

| Role | Font | Sizes |
|---|---|---|
| UI and chat body | **IBM Plex Sans** 400/500/600 | 13 / 14 / 16 |
| HUD, labels, counters, file paths, tags | **JetBrains Mono** 400/500 | 11 / 12 / 13, `tabular-nums` |
| Wordmark and wallboard numbers | **Share Tech Mono** | 20 / 48 |

The chat body is 14 px with a 1.5 line height. Text never goes below 11 px, and 11 px is reserved for mono overhead tags.

### 5.4 Spacing, radius, elevation
- **Spacing:** a 4 px grid, using 4 / 8 / 12 / 16 / 24 / 32.
- **Radius:** chips 6, cards and panels 10, dialogs 14.
- **Elevation:** panels get a 1 px border plus `0 8px 24px rgb(0 0 0 / .35)`. **Glow** is only used on the focus ring and the blocked state: `0 0 0 2px var(--color-accent)` or `0 0 12px var(--color-warning)`.

### 5.5 Motion tokens

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 150 ms | Hover, press |
| `--dur-base` | 220 ms | Panels, toasts in |
| `--dur-exit` | 150 ms | Things leaving |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | Entering |
| Camera fly | 600 ms, damped spring | Select robot |

`prefers-reduced-motion` (or the setting) turns off camera fly (it jumps instead), the tag pulse, the wallboard tour, and the bloom shimmer. Robot walk animations stay, because they carry meaning.

---

## 6. Key interactions

| Action | Result |
|---|---|
| Hover robot | Cyan outline (drei `<Outlines>`), cursor pointer, tag expands |
| Click robot or roster chip | Select: camera flies to it, Inspector opens, chip highlights, URL becomes `?agent=<id>` |
| Double-click / `Shift+F` | Follow camera stays on the robot as it walks. Any manual drag exits follow. |
| Click a file chip in chat | Selects the robot that touched it most recently |
| Agent becomes blocked | Robot raises hand, tag turns amber, toast appears, the DM gets a system line, and a browser notification fires (if enabled) |
| New agent spawns | Teleport-pad flash, roster chip slides in (stagger 40 ms), #activity line |
| Agent leaves | Robot walks to the pad and fades. The chip fades and moves to "Today". |
| `UserPromptSubmit` | The CEO robot walks to the Lead Engineer, plays a 1.5 s "brief" gesture, and walks back |

### Keyboard shortcuts
`⌘K` palette · `/` focus composer · `C` toggle chat · `F` wallboard · `[` `]` previous/next agent · `Esc` close or deselect · `1–8` filter by status · `?` shortcut sheet

**Deep links:** `?agent=`, `?channel=`, `?project=`, `?sim`, `?wallboard`. These let you bookmark a wallboard view on a second screen.

---

## 7. Accessibility checklist

- Every 3D interaction has a DOM equivalent (roster, palette, keyboard).
- Focus ring: 2 px cyan with a 2 px offset, never removed.
- Icon-only buttons have an `aria-label` and a tooltip.
- #activity and toasts use `aria-live="polite"`. Blocked alerts use `assertive`.
- Contrast: all text is at least 4.5:1, and the muted tokens are verified against both `bg` and `surface`.
- The canvas has `role="img"` with a live `aria-label` summary, for example "Office: 4 working, 1 blocked".

---

## 8. Performance rules for the UI layer

- Panels are plain DOM over the canvas. **No blur by default**, because `backdrop-filter` over WebGL costs GPU on every frame.
- Overhead tags: at most 12 `<Html>` elements, and they skip their transform update when off-screen (`occlude` off, manual frustum check).
- Event bursts are batched into one zustand update per animation frame, so 50 hook events per second don't cause 50 React renders.
- Chat and timeline lists are virtualized and capped at 500 rendered messages per channel, with older ones loaded on scroll.
- Quality presets:
  - **Low:** DPR 1, no bloom, no outlines.
  - **Med:** DPR 1.25, bloom.
  - **High:** DPR 1.5, bloom, contact shadow.
  - It auto-drops one level if the frame time stays above 20 ms for 3 s.

---

## 9. Libraries (UI only)

| Need | Pick | Size note |
|---|---|---|
| Icons | `lucide-react` | Tree-shaken |
| Dialog, Tooltip, Dropdown, Tabs | `@radix-ui/react-*` (only these 4) | Accessible primitives |
| Command palette | `cmdk` | About 5 KB |
| Virtual lists | `react-virtuoso` | Handles chat-style reverse scroll |
| Fonts | `@fontsource/ibm-plex-sans`, `@fontsource/jetbrains-mono`, `@fontsource/share-tech-mono` | Offline, no Google CDN |
| Class merge | `clsx` + `tailwind-merge` | |

No full component kit. Everything else is hand-rolled with Tailwind to keep the bundle small.

---

## 10. File structure (`apps/web/src`)

```
ui/
├─ layout/      AppShell.tsx  TopBar.tsx  RosterDock.tsx  WallboardOverlay.tsx
├─ agent/       Inspector.tsx  AgentChip.tsx  StatusPill.tsx  Timeline.tsx
├─ chat/        ChatPanel.tsx  ChannelList.tsx  MessageList.tsx  MessageItem.tsx
│               ActivityLine.tsx  Composer.tsx  SlashMenu.tsx  TypingIndicator.tsx
├─ overlays/    Toasts.tsx  ConnectionBanner.tsx  SetupCard.tsx  SimRibbon.tsx
├─ settings/    SettingsDrawer.tsx  sections/*.tsx
├─ palette/     CommandPalette.tsx
├─ primitives/  Button.tsx  IconButton.tsx  Chip.tsx  Kbd.tsx  Tooltip.tsx
└─ tokens.css   (@theme tokens from §5)
scene/
├─ OverheadTag.tsx  CameraRig.tsx  CameraControls.tsx  SelectionOutline.tsx
store/
├─ agents.ts  ui.ts (selection, filters, panels, quality)  chat.ts  connection.ts
```

---

## 11. Build order (mapped to PLAN.md phases)

| Phase | UI work |
|---|---|
| **P1** | `tokens.css`, AppShell, TopBar counters, a debug roster (DOM only, no 3D), ConnectionBanner, SetupCard |
| **P2** | OverheadTag, selection outline, CameraRig (fly/follow), Inspector, RosterDock, camera controls, quality presets |
| **P3** | ChatPanel (channels, virtualized list, activity lines, composer, slash menu), Toasts, browser notifications |
| **P4** | Wallboard mode, command palette, settings drawer, sim ribbon, shortcut sheet, About/attribution, reduced-motion pass |
| **P5** | Whisper action in Inspector and DM, CEO briefing animation polish |

---

## 12. Open UI decisions

1. **Chat panel side:** right (Slack-like, as planned) or left?
2. **Inspector placement:** floating card over the scene (planned) or a tab inside the chat panel?
3. **Mockup first:** a clickable HTML mockup of this layout, or design it in Figma, before building?
4. **Wallboard on a second monitor:** worth prioritizing into P2?
