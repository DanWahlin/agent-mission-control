# AGENTS.md

## Project Overview

Copilot Mission Control is a windowed, decorated, resizable Tauri 2 desktop app that visualizes live activity from the [GitHub Copilot CLI](https://github.com/github/copilot-cli). It runs as an opaque normal-level window (not an overlay) so devs can park it on a second monitor while interacting with Copilot CLI in their primary terminal.

The architecture is **provider-agnostic by design** — the `AgentProvider` trait in `src-tauri/src/agent.rs` is the privacy boundary, and `CopilotProvider` is the only implementation that ships today. Adding Claude Code, Codex, or other CLIs is a matter of dropping in another provider (see "Adding a Provider" below).

## Repository Structure

```
src/game/                — Frontend code (TypeScript, Phaser 4)
src/game/scenes/         — Phaser scenes
  MissionControl.ts      — The product. One scene; the entire dashboard
  viewport.ts            — W/H exports + refreshDimensions() (resize helper)
src/game/game.ts         — Single-scene Phaser bootstrap (~55 lines)
src/game/index.html      — Slim 32 px top bar + #game div
src/game/hud.js          — Panels toggle + theme toggle + mute (M key)
src-tauri/               — Tauri 2 Rust backend
  src/lib.rs             — Tauri commands + tray + window-state plugin
  src/agent.rs           — AgentProvider trait + CopilotProvider + fs watcher
  tauri.conf.json        — Windowed, decorated, resizable, opaque, 1280×800
assets/space/              — Space-themed sprite atlas (Phaser texture)
  atlas.png                — Combined atlas: spritesheet2 (top) + spritesheet3 (bottom)
  atlas.json               — Phaser JSONArray frame definitions (56 named frames)
  source/                  — Original spritesheets used to build atlas.png
assets/icon.png            — App icon (square, used by tools that need a single PNG)
docs/                    — GitHub Pages site
  img/                   — README + landing-page screenshots (regenerable)
scripts/release.js       — Version bump + git-cliff + tag + push
scripts/snap-readme.mjs  — Playwright screenshotter for docs/img/
tests/                   — Playwright (Chromium, headless)
  app.spec.ts                — App shell smoke tests
  mission-control.spec.ts    — Scene behavior + multi-viewport layout regressions
  helpers.ts                 — waitForGame() + getMissionStatus()
.github/workflows/
  build.yml              — Build & Release on v* tags
  ci.yml                 — type-check + build + Playwright on PRs
  deploy-pages.yml       — docs/ → GitHub Pages on push to main
```

## Tech Stack

- **Desktop shell:** Tauri 2 — decorated, resizable, opaque window. Tray icon with Show/Hide and Quit. Window size and position persisted via `tauri-plugin-window-state`.
- **Frontend:** Phaser 4 (Graphics + Image sprites), TypeScript (ES2022, strict, `verbatimModuleSyntax: true`, `.js` import extensions).
- **Backend:** Rust 2021. Owns `~/.copilot/session-state/` scanning, normalization, allowlisting, and the `notify = 8` filesystem watcher that pushes updates to the renderer via `window.__cmcOnAgentActivityChanged()` calls.
- **Tests:** Playwright headless Chromium. The renderer is fully testable without Tauri because `window.__missionControlFixture` lets a test inject deterministic activity data.

## Build & Run

```bash
npm install                # install deps + regenerate package-lock
npm run build:frontend     # tsc + copy HTML/Phaser/assets to dist/
npm run build              # frontend + cargo build
npm start                  # frontend + cargo tauri dev (launches the window)
```

## Testing

```bash
npm test                                          # full suite (build + Playwright)
npx playwright test tests/mission-control.spec.ts # scene tests only
npx playwright test --headed                      # visible browser
```

The Playwright `webServer` config serves `dist/` over `python3 -m http.server 4173`. The current suite is **27 tests** covering startup, dashboard panels, replay/scrubber, session selection, ops mode classification, and a six-viewport layout regression.

## Key Patterns

- **`MissionControlScene` extends `Phaser.Scene` directly.** There is no `BaseScene`. The scene paints its own full-window backdrop in `create()` (depth -100) and redraws it on `scale.resize`.
- **Single scene.** Boot Phaser → instantiate `MissionControlScene` → resize listener calls `refreshDimensions()` + `scale.resize(W, H)` so the scene re-lays-out the dashboard on every window change.
- **Push-driven updates.** The Rust watcher debounces FS events (~300 ms) and calls `win.eval("window.__cmcOnAgentActivityChanged && window.__cmcOnAgentActivityChanged()")`. The 30 s poll in the scene is a fallback for environments where the watcher fails to attach.
- **Privacy invariant.** The `AgentProvider::scan()` boundary is the only place where Copilot session data is read. Only allowlisted fields cross into `AgentEventSummary` / `AgentSessionSummary` — never raw prompts, tool args, command output, file paths, or diffs.
- **`window.__phaserGame`** is set so Playwright can reach into the scene registry without DOM scraping.
- **LocalStorage keys** are prefixed `cmc_` (e.g., `cmc_muted`, `cmc_panels_hidden`, `cmc_prefs`).

## Adding a Provider

The whole point of the `AgentProvider` trait is making this cheap. To add Claude Code, Codex, or a custom CLI:

1. Implement a `ClaudeCodeProvider` struct in `src-tauri/src/agent.rs` (or its own module) with `id()`, `label()`, `is_available()`, `state_root()`, and `scan() -> ProviderScan`.
2. In `scan()`, walk the provider's local state directory (`~/.claude/projects/<project>/<sid>.jsonl`, `~/.codex/sessions/<id>/`, etc.) and build `AgentSessionSummary` / `AgentToolMetric` / `AgentEventSummary` records. **Allowlist fields** — no raw prompts/args/output/paths/diffs.
3. Set `provider: "claude"` (or similar) on each summary so the renderer can color/icon-differentiate later.
4. Add the provider to `default_providers()`.

The watcher automatically attaches to each provider's `state_root()`, the merger handles top-N truncation globally across providers, and the renderer is provider-agnostic.

## Regenerating the README previews

`docs/img/dashboard.gif` and `docs/img/focus-mode.gif` are the animated previews referenced from the README and the GitHub Pages landing page. A static `docs/img/dashboard.png` is also written as the social `og:image` fallback. Regenerate them after any noticeable UI change:

```bash
npm run build:frontend
(cd dist && python3 -m http.server 4173) &
node scripts/snap-readme-gifs.mjs   # 5 s loops at 1280 wide / 15 fps
kill %1
```

The script uses the same deterministic rich fixture as the old PNG script and then drives a scripted burst of `tool.execution_start` events over 5 seconds so sector counts tick up and pulses fly through the map. Requires `ffmpeg` on PATH (used for two-pass palette + GIF encode). If you change the fixture, mirror the changes back into the README's "What it does" copy so the GIF still matches the description.

## Releasing

```bash
npm run release <version>    # e.g. npm run release 0.2.0
```

`scripts/release.js`:

1. Bumps version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
2. Regenerates `CHANGELOG.md` from git via `git-cliff` (config: `cliff.toml`).
3. Commits everything, creates a `v<version>` tag, and pushes to `origin`.
4. The `Build & Release` workflow takes over: builds macOS (universal), Windows, and Linux installers, then attaches them to the GitHub Release.

All three version files must be updated together for installer filenames to be correct — the script does this automatically.
