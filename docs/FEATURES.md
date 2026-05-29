# Features

## Global History analytics

The **History** route is a full-screen app view for aggregate Copilot CLI activity across all scanned sessions. It lives next to Mission Control in the topbar and can be opened with `#history`; `#mission` returns to the live mission map.

History includes summary KPIs, 24-hour and 7-day activity charts, model mix, event mix, top tools, recent sessions, and sanitized failure history. It describes observed scanner data, not perfect lifetime analytics, because long Copilot session files are read through a bounded tail window.

Privacy rules match the app bridge: History only renders allowlisted summaries such as counts, timestamps, categories, model IDs, tool names, short session IDs, repository/branch summaries, and success/failure state. It never displays prompts, raw tool arguments, command output, file paths, diffs, raw event JSON, or local session-state paths.
