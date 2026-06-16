# Manual Activity Demo (Mission Control smoke run)

A repeatable, manual "light up every sector" run for **Agent Mission Control**.
Use it to visually confirm that live Copilot CLI activity flows from
`~/.copilot/session-state/` into the dashboard (sectors, pulses, session
inspector, History) after a UI or backend change.

This is **not** an automated test — it is a runbook you execute from a Copilot
CLI session while watching the app window. The automated coverage lives in
`tests/app.spec.ts` and `tests/mission-control.spec.ts`.

## Prerequisites

1. Build and launch the app from this repo so it reflects your local changes:
   ```bash
   npm start            # build:frontend + cargo tauri dev (opens the window)
   ```
   Quit any **installed** release build first (`/Applications/Agent Mission
   Control.app`) — it will not contain un-released fixes.
2. Run the demo steps below **from a Copilot CLI session** (this is what writes
   `events.jsonl`). The app scans every session under
   `~/.copilot/session-state/`, so the session you run from appears in the
   session dropdown.

> Heads-up: the live session you run from must **not** be filtered out as a
> Mission Control analytics-chat session. Only a `system.message` whose content
> *starts with* the analytics marker, or a `session.start` with
> `clientName = "copilot-mission-control-analytics"`, is excluded. An ordinary
> coding session is always shown.

## Sector → tool mapping

Categories come from `src-tauri/provider-schemas/copilot.json`
(`tool_category_rules`). The scanner classifies each tool call by substring:

| Sector (UI)  | Category key | Trigger substrings                         | Demo action |
|--------------|--------------|--------------------------------------------|-------------|
| Edits        | `edits`      | `edit`, `create`, `apply_patch`, `write`   | write/edit files in a temp dir |
| Reads        | `library`    | `view`, `read`, `grep`, `rg`, `glob`, `search` | view/grep/glob the repo |
| Commands     | `terminal`   | `bash`, `shell`, `sql`, `test`             | shell + SQL calls |
| Web/Docs     | `signal`     | `web`, `fetch`, `docs`, `github`           | web search / web fetch |
| Sub-Agents   | `delegates`  | `agent`, `task`                            | launch a `task` sub-agent |
| Skills       | `skills`     | `skill`, `memory`                          | a memory call (or a `skill` invocation) |
| Intent       | `court`      | `ask`, `intent`, `plan`, `schedule`        | a schedule/intent call |
| MCP          | `mcp`        | MCP allowlist / name contains `mcp` + `-`  | call a real `*-mcp-*` tool |
| Hooks        | `hooks`      | `hook.start` / `hook.end` events           | fire automatically if Copilot hooks are configured |

## Steps

Run these from a Copilot CLI session while watching the app. Each bullet names
the sector it lights up.

1. **Edits + Commands** — create a temp working directory and write files:
   ```bash
   mkdir -p /tmp/amc-demo && cd /tmp/amc-demo
   printf 'alpha\nbravo\ncharlie\n' > data.txt
   printf '{ "demo": true }\n' > config.json
   ```
   Then use the agent's `create`/`edit` tools to add and modify a file in
   `/tmp/amc-demo` (these map to **Edits**).
2. **Reads** — read and search:
   - `view` a temp file, `glob` for `src/scenes/*.ts`, `grep` for a symbol.
3. **Commands** — run a `bash` command and a `sql` query (both `terminal`).
4. **Web/Docs** — run a `web_search` and a `web_fetch`.
5. **Sub-Agents** — launch a short `task` (e.g. an `explore` agent) — maps to
   `delegates`.
6. **Skills** — make a memory call (e.g. `store_memory`/`vote_memory`) or invoke
   a `skill`. Both map to `skills`.
7. **Intent** — call `manage_schedule` (list) or another ask/intent/plan tool.
8. **MCP** — call a real MCP tool whose name contains `mcp` + `-`, e.g.
   `github-mcp-server-get_file_contents` for `owner=DanWahlin`,
   `repo=agent-mission-control`, `path=README.md`.
9. **Hooks** — if you have Copilot CLI hooks configured, `hook.start`/`hook.end`
   events are emitted automatically on tool use and populate the Hooks sector.

## What to look for in the app

- The session you ran from is selectable in the **session dropdown** (active
  sessions sort to the top).
- Sector tiles for **Edits, Reads, Commands, Web/Docs, Sub-Agents, Skills,
  Intent, MCP** show non-zero counts; pulses animate across the mission map.
- Open the **session/sector inspector** and filter recent calls by MCP, hooks,
  skills, sub-agents, or failures.
- The **History** route aggregates the activity (event mix, top tools, model
  mix, tokens).

## Cleanup

```bash
rm -rf /tmp/amc-demo            # remove the temp working directory
```

- Drop any demo SQL tables you created in the session database.
- If you stored a throwaway memory for the Skills sector, down-vote/remove it.
- The activity recorded in the session's `events.jsonl` is the app's data
  source; it is intentionally left in place so the run remains visible.
