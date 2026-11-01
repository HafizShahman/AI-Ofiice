# Design reference (exported from the "AI Office UI" canvas)

These are the visual targets for P2–P4. The written spec is `docs/UI-PLAN.md`.

| Screen | Screenshot | Source | Phase |
|---|---|---|---|
| Live office: top bar, isometric room, alert, agent card, camera buttons, roster, chat panel | `screens/1-live-office.jpg` | `source/Main.dc.html` (+ `OfficeRoom.dc.html`) | P2 / P3 |
| Props & interactions: every prop, numbered, with what triggers it | `screens/2-props-and-interactions.jpg` | `source/Room.dc.html` | P2 |
| Wallboard: full-screen second-monitor view, only blocked tags | `screens/3-wallboard.jpg` | `source/Wallboard.dc.html` | P4 |
| First run / setup card | `screens/4-first-run.jpg` | `source/FirstRun.dc.html` | P1/P4 |
| Settings drawer | `screens/5-settings.jpg` | `source/Settings.dc.html` | P4 |
| ⌘K command palette | `screens/6-command-palette.jpg` | `source/Palette.dc.html` | P4 |

## Reading the sources

- **Styling:** each `.dc.html` is one screen as HTML with **inline styles**. Colours, spacing, radii and font sizes are exact and can be copied as they are.
- **Templating:** `{{name}}` holes, `<sc-for>` (repeat) and `<sc-if>` (branch) take their values from `renderVals()` in the `<script type="text/x-dc">` block at the bottom. That block also holds the sample data (agents, timelines).
- **Images:** paths are relative to the repo root (`Assets/...`). The room's prop list in `OfficeRoom.dc.html` matches `apps/web/src/scene/props.json`.

## Caveats

- **Fonts:** the screenshots were rendered without network access, so text falls back to system fonts. The real fonts are IBM Plex Sans, JetBrains Mono and Share Tech Mono.
- **Robots:** the white robots on the canvas are placeholders. The app uses the 3D Mini Robot (`apps/web/public/models/robot.opt.glb`).
