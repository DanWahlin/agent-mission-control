# Agent Mission Control App Map

- captured: 2026-10-07, macOS, debug bundle of 0.2.16 (Tauri 2.12, WKWebView)
- window: 1600x1000 points by default, minimum 1100x720
- privacy: session titles, repository names, and branches are examples only.
  Do not commit real values from a live scan.

Accessibility names come from the `aria-label` and `title` attributes in
`src/index.html` and `src/hud.ts`. When you change one of them, update this map
and the selectors in `tests/app.spec.ts`.

## Window and Tray

| Item | Role | Notes |
|---|---|---|
| `Agent Mission Control` | `AXWindow` | Decorated, resizable. The window-state plugin restores size and position. |
| `Agent Mission Control` | `AXWebArea` | All app content. |
| Tray: `Show / Hide Agent Mission Control` | menu item | Toggles the window. |
| Tray: `Quit (⌘Q)` | menu item | Quits the app. |

## Top Bar

| Accessibility name | Role | Action |
|---|---|---|
| `Show Home` | `AXCheckBox` (route) | Mission map and dashboard panels. |
| `Show global History analytics` | `AXCheckBox` (route) | History route. |
| `Ask Analytics Chat` | `AXCheckBox` (route) | Analytics Chat route. |
| `Hide side panels for focus mode` | `AXCheckBox` | Focus mode on Home. On other routes the name is `Panel visibility is only available on Home`. |
| `Open settings` | `AXButton` | Settings dialog. |
| `Switch to light theme` / `Switch to dark theme` | `AXButton` | Light and dark theme. |

## Home (Mission Control dashboard)

Group: `Mission Control dashboard`.

### Selected Session panel

| Item | Role | Notes |
|---|---|---|
| `Running sessions (N)` | text | `Recent sessions (none active)` when no session is active. |
| Session trigger, for example `● All Active Sessions 3 active` | `AXButton` | Opens the picker. `aria-expanded` shows the state. |
| `Select Copilot session` | `AXGroup` | Picker list. Each option is an `AXButton`. The current option has `aria-current="true"`. Idle sessions follow an `IDLE` heading. |
| `Last:`, `Tool:`, `Age:`, `Tokens in/out:`, `Model:` | text | `Tokens in/out: pending` when an active session has no token data yet. |
| `Live operations tempo` | `AXGroup` | Activity Rate: `Past hour`, `Past 5 min`, 24 hourly cells. Each cell description is `<range>: N activity items, N tool calls, N turns`. |
| `Open selected session in editor` | `AXButton` | Tauri `open_in_editor` (vscode://). Not shown for **All Active Sessions**. |
| `Open inspector for selected session` | `AXButton` | Inspector dialog. Disabled when the session has no tool calls. |

### Recent Activity Feed

Up to 30 rows: `<session> · <event label>` and an age (`8s ago`). On replay,
the title changes to `Recent Activity Feed · replay cursor`.

### Mission map (Phaser canvas)

Nine sectors around the hub. The canvas has no accessibility nodes. Read the
counts from the sector details panel or from Playwright (`getMissionStatus`).

| Key | Label |
|---|---|
| `edits` | Edits |
| `library` | Reads |
| `terminal` | Commands |
| `signal` | Web/Docs |
| `hooks` | Hooks |
| `delegates` | Sub-Agents |
| `skills` | Skills |
| `court` | Intent |
| `mcp` | MCP |

### Sector details panel

Shows the selected sector: signal count, top tool, average duration, and
`Open details for <sector> sector` (`AXPopUpButton`), which opens the Inspector
filtered to that sector.

### Replay bar

| Accessibility name | Role | Notes |
|---|---|---|
| `Pause recent activity replay` / `Play recent activity replay` | `AXButton` | |
| `Recent activity replay position` | `AXSlider` | Arrow keys, Home, End. Details text: `<scope> turn replay · N / N · live · <time>`. |
| `Replay is live` / `Jump to live` | `AXButton` | |

## Inspector dialog

Title `Inspector · <session>`. Subtitle `<repo> / <branch> · N calls · N turns`.

| Item | Role | Notes |
|---|---|---|
| `Close inspector` | `AXButton` | Escape also closes it. |
| `Tools`, `Turns` | `AXCheckBox` (pill) | No background press action. |
| `Tool filters`: All, MCP, Hooks, Skills, Sub-agents, Failures | pills | |
| Details | list | Tool, Category, Status, Started, Duration, Turn, Model, Call ref, Type, Provider, Privacy. |
| `Reveal raw local details` | `AXButton` | Tauri `get_raw_tool_call_details`. After the reveal: `Refresh raw local details`. Shows local raw data. Do not copy it. |

## History route

Heading `COPILOT MISSION ARCHIVE`.

| Item | Role | Notes |
|---|---|---|
| `History views` | `AXTabGroup` | `OVERVIEW`, `DAILY LOG` radio buttons. The selected tab is saved in `cmc_history_tab`. |
| `Filter History by session` | `AXPopUpButton` | Overview only. |
| `History summary metrics` | group | Sessions indexed, Events, Tool calls, Models used, Input tokens, Output tokens. |
| Overview cards | groups | Models Used, Top Tools, Activity Rolling 24 Hours, Activity Last 7 Days, Activity Breakdown, High Activity Sessions, Recent Sessions. |
| Daily Log | groups | Calendar (month and year selects, PREV, NEXT, TODAY, day buttons), Daily Debrief (KPIs, Mission Summary, Activity Rate, What I Worked On, Models, export sections). |

## Analytics Chat route

Heading `Mission Analytics Chat`.

| Item | Role | Notes |
|---|---|---|
| Status | text | `Waiting for analytics ingestion`, `Analyzing Copilot history…`, or `Ready · N sessions · N recent facts`. |
| `About Mission Analytics Chat token usage` | `AXButton` | Opens the token notice. |
| `Suggested analytics prompts` | `AXGroup` | 9 prompt buttons and `Hide suggested prompts`. |
| `Ask an analytics question` | `AXTextField` | Composer. |
| `Ask` | `AXButton` | Sends the question (uses Copilot requests). |
| `New Chat` | `AXButton` | Clears the transcript. |
| Answer | groups | `ASSISTANT` text, then artifacts (cards, tables, charts) and caveats. A caveat that starts with `Copilot SDK answer generation was unavailable` means the SDK path failed and the answer came from local analytics. |

## Dialogs

| Dialog | Open from | Close |
|---|---|---|
| Settings | `Open settings` | `Close settings`, `Done`, Escape. Has `App theme` (Space, Medieval Kingdom), `Sector pulses` (Every event, Grouped), and `Reset visible activity counters`. |
| Attention Center | Attention entry on Home (only when there are problems) | `Close Attention Center`, Escape. |
| Possible Copilot schema drift | Automatic, when the scan sees unknown event types | `Report schema drift`, `Dismiss`, `Close schema drift dialog`. |
| Welcome to Mission Analytics Chat | First visit to Analytics Chat, or the `?` button | `I understand`, Escape. |
| Update banner | Automatic, when a newer release exists | `View Release` (opens the release page), `Dismiss update notification`. |

## Tauri commands (renderer → backend)

| Command | Used by |
|---|---|
| `get_agent_activity` | Home scan (watcher push and 30 s poll) |
| `get_agent_activity_with_history` | History route |
| `get_copilot_activity` | Legacy alias of `get_agent_activity` |
| `get_analytics_status`, `get_analytics_usage_summary`, `get_engineering_digest` | History, Daily Log, Analytics Chat |
| `ask_analytics_chat` | Analytics Chat (Copilot SDK + Mission Control Insights MCP server) |
| `set_mcp_server_enabled` | Analytics Chat MCP table toggle |
| `read_copilot_definition`, `open_copilot_definition` | Analytics Chat skill and agent artifacts |
| `get_raw_tool_call_details` | Inspector raw reveal |
| `open_in_editor` | Open in Editor |
| `open_external_url` | Update banner, schema drift report |

## Local state

| Path | Content |
|---|---|
| `~/.copilot/session-state/<id>/events.jsonl` | Copilot CLI events (read only) |
| `~/Library/Application Support/com.danwahlin.copilotmissioncontrol/.window-state.json` | Window position (window-state plugin) |
| `~/Library/Application Support/com.danwahlin.copilotmissioncontrol/analytics/analytics.sqlite3` | Analytics database. Open it read-only with `sqlite3 "file:<path>?immutable=1"` while the app runs. |
| `localStorage` keys `cmc_*` | Theme, app theme, sector pulse mode, panels, History tab, chat notice, mission preferences |
