# Functional Run-Through Checklist

**Covered** means that a Playwright or Rust test checks the item. **Live only**
means that only the real app can check it. Do all the **Live only** items in
each run-through. Do the **Covered** items in the live app only when you
change the related code.

## Startup and window

| # | Check | Expected | Coverage |
|---|---|---|---|
| 1 | Launch with `launch-app.sh` | Window opens on the built-in display at 1600x1000. Splash shows, then the dashboard. | Live only |
| 2 | Tray menu | `Show / Hide` toggles the window. `Quit` quits. | Live only |
| 3 | Restart | Window size and position return. | Live only |

## Home

| # | Check | Expected | Coverage |
|---|---|---|---|
| 4 | Running sessions | Count agrees with active Copilot CLI sessions (activity in the last 10 minutes). | Live only |
| 5 | Live updates | Run a command in an active Copilot session. Feed and `Age` change in about 1 second (watcher). | Live only |
| 6 | Activity Rate | `Past hour` and `Past 5 min` are not `idle` while a session works. Hour cells show tool calls and turns. | Covered + Live |
| 7 | Tokens | Active session with no shutdown event shows `pending`. After shutdown or resume, real totals show. | Covered + Live |
| 8 | Session picker | Press an option. The panel, map, feed, and replay change to that session. | Covered + Live |
| 9 | Long names | A long branch name does not make the panel scroll sideways. | Covered |
| 10 | Sector details | Sector counts agree with the Inspector filter for that sector. | Covered |
| 11 | Inspector | Opens with tools, details, and privacy text. Escape closes it. | Covered |
| 12 | Raw reveal | `Reveal raw local details` loads raw arguments for the selected call. | Live only |
| 13 | Open in Editor | VS Code opens the session folder. | Live only (ask first) |
| 14 | Replay | Pause, scrub, jump to live. Feed shows `replay cursor`. | Covered |
| 15 | Focus mode | Side panels hide and come back. | Covered |

## History

| # | Check | Expected | Coverage |
|---|---|---|---|
| 16 | Overview KPIs | Values agree with the analytics database for the last 7 days. | Live only |
| 17 | 24 hours and 7 days charts | Today has a bar. Hover shows exact values. | Covered + Live |
| 18 | Daily Log | Today's Day Total tool calls and turns agree with `daily_rollups` for today. | Covered + Live |
| 19 | Month navigation | Past month selects its last day. Current month selects today. | Covered |
| 20 | Session filter | Overview changes to one session. | Covered |

## Analytics Chat

| # | Check | Expected | Coverage |
|---|---|---|---|
| 21 | Status | Reaches `Ready · N sessions · N recent facts`. | Live only |
| 22 | SDK answer | Ask `What's my MCP server usage?`. No `Copilot SDK answer generation was unavailable` caveat. | Live only (uses requests) |
| 23 | MCP table | Lists every MCP server seen in history, for example `computer-use`, with call counts that agree with `tool_rollups`. The answer text agrees with the table. | Covered + Live |
| 24 | Out-of-scope question | Answer says the question is out of scope. | Covered |

## Settings and theme

| # | Check | Expected | Coverage |
|---|---|---|---|
| 25 | Theme toggle | Dark and light both render. Choice survives restart. | Covered |
| 26 | App theme | Space and Medieval Kingdom sprites load. | Covered |
| 27 | Reset counters | Counters go to zero. Copilot files do not change. | Covered |

## Database checks

Open the database read-only while the app runs:

```bash
DB="$HOME/Library/Application Support/com.danwahlin.copilotmissioncontrol/analytics/analytics.sqlite3"
sqlite3 "file:$DB?immutable=1" "select local_day, event_count, tool_call_count, turn_count from daily_rollups order by local_day desc limit 3"
sqlite3 "file:$DB?immutable=1" "select tool_name, sum(call_count) from tool_rollups where tool_category='mcp' and local_day >= date('now','-6 day') group by 1 order by 2 desc limit 10"
```
