# Copilot Instructions — Copilot Mission Control

## Language & Framework Conventions

### TypeScript

- Target **ES2022** with strict mode (`tsconfig.renderer.json`).
- `verbatimModuleSyntax: true` — use `import type { ... }` for type-only imports.
- Use `declare const Phaser: any;` — Phaser is loaded as a global via a `<script>` tag, not imported as a module.
- Use `.js` extensions in import paths (TypeScript compiles to ES modules served directly by the browser).
- No bundler — the project uses plain `tsc` output served as ES modules.
- Use single quotes for strings.
- Prefer explicit types over `any` for application objects; use `any` only at the Phaser API boundary.

### Rust (Tauri backend)

- Rust 2021. Follow standard idioms (snake_case, `Result` error handling).
- Tauri **v2** APIs — `tauri::Manager` for window access, `tauri::tray::TrayIconBuilder` for the tray.
- The `AgentProvider` trait in `src-tauri/src/agent.rs` is the privacy boundary. New providers MUST allowlist fields inside `scan()` — no raw prompts, tool args, command output, file paths, or diffs.

## Scene Conventions

There is **one** Phaser scene, `MissionControlScene`, in `src/game/scenes/MissionControl.ts`. It extends `Phaser.Scene` directly (no `BaseScene`).

- `create()` paints its own backdrop at depth `-100`, registers a `scale.resize` handler to repaint it, and listens for `shutdown` once to release timers/listeners/audio/graphics.
- `window.__phaserGame` is set so Playwright can reach into the scene registry.

## Backend Conventions

- All renderer-facing data comes from one Tauri command: `get_agent_activity`. (`get_copilot_activity` exists as a legacy alias and delegates to the same merger.)
- The watcher in `agent.rs` debounces filesystem events with an `AtomicBool pending` flag + sleeping spawn thread (~300 ms trailing edge), then calls `win.eval("window.__cmcOnAgentActivityChanged && window.__cmcOnAgentActivityChanged()")`.
- Window size and position are persisted automatically by `tauri-plugin-window-state` — do not hand-roll a window-state file.

## Test Conventions

- **Runner:** Playwright (Chromium, headless), single worker, no retries.
- **Tests:** `tests/app.spec.ts` (app shell smoke), `tests/mission-control.spec.ts` (scene behavior + multi-viewport layout).
- **Helpers:** `tests/helpers.ts` exports `waitForGame()` and `getMissionStatus()`. Keep helpers minimal.
- **Fixtures:** `window.__missionControlFixture` lets a test inject a deterministic `AgentActivity` object that the scene picks up in place of a real Tauri scan.
- **Build first:** `npm run build:frontend` must run before tests (`npm test` does this automatically).
- **Canvas offset:** the 32 px top bar means click coordinates must be offset by `canvas.getBoundingClientRect().left/top` — see the `canvasOffset` helper in `mission-control.spec.ts`.

## Asset Rules

- **Tiny Swords:** only the curated CC0 subset in `assets/kingdom/tiny-swords/` (with its `LICENSE.txt`). Never mix in the paid pack.
- **Naming:** lowercase-kebab-case for asset filenames.
- **PNG** for sprites/UI. WAV would go in a future `assets/sounds/` directory (none today).

## Maintenance Matrix

| Change Made | Files to Update |
|-------------|-----------------|
| **Scene behavior changed** | Update `tests/mission-control.spec.ts`; run all 27 tests |
| **Top bar HTML/CSS changed** | Update `tests/app.spec.ts` selectors if id/class names change |
| **Rust command added/removed** | Update `src-tauri/capabilities/main.json` permissions; `cargo check`; verify renderer invocation site |
| **AgentProvider added** | Add to `default_providers()`; verify allowlist in `scan()`; watcher attaches automatically |
| **Window config changed** | Update `src-tauri/tauri.conf.json`; verify on macOS + Windows; window-state plugin restores last session |
| **Version bumped** | Use `npm run release <version>` — never hand-edit `package.json`/`tauri.conf.json`/`Cargo.toml` versions individually |
| **docs/ changed** | Push to `main` triggers `deploy-pages.yml`; preview with `python3 -m http.server -d docs` |
| **CHANGELOG updated** | Managed by git-cliff via `npm run release`; do not hand-edit |

## Privacy Invariant (do not violate)

The renderer must never receive raw prompts, raw tool arguments, command output, file paths, or diffs. The `AgentProvider::scan()` boundary is the single allowlist point. Any new field added to `AgentSessionSummary` or `AgentEventSummary` should be reviewed against this rule.
