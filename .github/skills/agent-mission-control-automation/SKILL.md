---
name: agent-mission-control-automation
description: Drive, test, and map the Agent Mission Control desktop app (Tauri 2 + Phaser) on macOS. Use to launch a debug .app build on the built-in laptop display, run a full functional run-through, read the UI through macOS Accessibility, check live Copilot CLI data, and verify Tauri-only features (raw details, Open in Editor, Analytics Chat). Adapted from the github-copilot-app-automation skill in copilot-app-for-beginners.
---

# Agent Mission Control Automation

Use this skill to run the real desktop app and to confirm that its features
work with live Copilot CLI data. Playwright tests the renderer with fixtures.
This skill tests the parts that Playwright cannot reach: the Tauri backend,
the file watcher, the analytics database, and the Copilot SDK.

## Choose the Right Surface

| Need | Surface | Notes |
|---|---|---|
| Renderer behavior, layout, routes, dialogs | Playwright (`npm test`) | Deterministic fixtures through `window.__missionControlFixture`. Fast. Run this first. |
| Backend parsing, analytics, privacy allowlist | `cd src-tauri && cargo test` | Unit tests. No UI. |
| Live data, Tauri commands, watcher, tray, window | This skill (real `.app` + Accessibility) | Uses your real `~/.copilot/session-state`. |

Do not repeat in the live app what Playwright already covers. Use the live
app for the items in [run-through-checklist.md](references/run-through-checklist.md)
that are marked **Live only**.

## Build and Launch

```bash
npm run build:frontend
cargo tauri build --debug --bundles app --no-sign
bash .github/skills/agent-mission-control-automation/scripts/launch-app.sh
```

`launch-app.sh` does these steps:

1. Stops an earlier automation instance of the same bundle.
2. Stops with an error if another copy of Agent Mission Control runs. The
   single-instance plugin sends a new launch to a running copy with the same
   bundle identifier, so the test would go to the wrong app.
3. Writes the window-state file so that the window opens on the **built-in
   laptop display** (default). Set `AMC_DISPLAY=main` to keep the saved position.
4. Opens the bundle in the background (`open -g -n`) and waits for the window.
5. Confirms that the window is on the built-in display and prints the process ID.

The installed app (`/Applications/Agent Mission Control.app`) and the debug
bundle use the same window-state file. The first launch saves a backup. When
you finish, quit the automation instance, then run:

```bash
bash .github/skills/agent-mission-control-automation/scripts/restore-window-state.sh
```

The first scan of a large `~/.copilot/session-state` (more than 1,000
sessions) takes 30–60 seconds. The splash shows **Initializing mission
control…** until the scan completes. Wait for it before you read the UI.

## Address the App with Accessibility

- Address the app by its **absolute `.app` path**. The bundle identifier
  `com.danwahlin.copilotmissioncontrol` matches the installed app too, so a
  bundle-identifier lookup is ambiguous. A bare debug binary
  (`target/debug/copilot-mission-control`) is not addressable at all.
- The web content is one `AXWebArea` named **Agent Mission Control**. It is
  empty for a few seconds after launch. Read it again if it has no children.
- `<button>` elements support an accessibility press in the background. This
  includes the session picker options, **Inspector**, **Reveal raw local
  details**, the suggested Analytics Chat prompts, and the route buttons.
- Toggle buttons with `aria-pressed` show as `AXCheckBox`. The route buttons
  accept a press. The Inspector **Tools/Turns** pills and filter pills do not
  expose a press action. Use Playwright for those, or use the keyboard.
- Coordinate clicks do not reach the WKWebView while the window is not the
  key window. Do not bring the app to the front to work around this. Use a
  named control or the keyboard.
- If an action returns `interrupted`, the user is using the app. Read the
  window state again, then try the same action again.

The full control map is in [app-map.md](references/app-map.md).

## Safety Rules

- The live app reads your real Copilot CLI history. Do not copy prompts,
  file paths, raw tool arguments, or command output into repository files.
  The **Reveal raw local details** panel shows that data. Read it only to
  confirm that the feature works.
- **Analytics Chat** sends a request to Copilot and uses premium requests.
  Ask one short question per check, and use a suggested prompt.
- **Open in Editor** opens VS Code on the user's screen. Use it only when the
  user agrees that a window can open.
- **Reset counters** in Settings changes the visible counters until the next
  restart. It does not delete Copilot files.
- Do not toggle MCP servers in the Analytics Chat MCP table. That writes the
  user's `~/.copilot/m-mcp-servers.json`.

## Run-Through Procedure

1. Run `npm test`, `npm run test:mcp`, and `cd src-tauri && cargo test`.
   Fix failures first.
2. Build and launch with the commands above.
3. Work through [run-through-checklist.md](references/run-through-checklist.md).
   For each item, record the expected and the observed result.
4. For each defect, write a failing test (Playwright fixture or Rust unit
   test), fix the code, and run the test again.
5. Rebuild the bundle and repeat the **Live only** items that the fix touches.
6. Quit the automation instance and restore the window state.

## Known Data Facts (Copilot CLI)

- Copilot CLI writes token totals only in `session.shutdown`. Live sessions
  show **pending** tokens until the session shuts down or resumes.
- `assistant.message` no longer has `outputTokens`.
- MCP tool names use `<server>-<tool>`, and server names can have hyphens
  (`computer-use-click`).
- `--continue` creates a new local session record. Do not expect the same
  session ID.
