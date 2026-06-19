# Changelog

All notable changes to Agent Mission Control.
## [0.2.4] - 2026-06-19

### ⚙️ CI/CD & Build

- Release v0.2.4
## [0.2.3] - 2026-06-18

### ⚙️ CI/CD & Build

- Release v0.2.3
## [0.2.2] - 2026-06-17

### 🐛 Bug Fixes

- Fix cross-midnight day bucketing for per-model token totals in History

### ⚙️ CI/CD & Build

- Release v0.2.2
## [0.2.1] - 2026-06-16

### 🐛 Bug Fixes

- Rename forge category to edits and fix analytics-chat session filter

### ⚙️ CI/CD & Build

- Release v0.2.1
## [0.2.0] - 2026-06-16

### 🚀 Features & Improvements

- Rebrand the app to Agent Mission Control with a new hero image and updated repo links

### ⚙️ CI/CD & Build

- Release v0.2.0
## [0.1.12] - 2026-06-06

### 🚀 Features & Improvements

- Enhance README with detailed descriptions for History, Daily Log, and Analytics Chat features

### 🐛 Bug Fixes

- Fix Activity Rate header status

### ⚙️ CI/CD & Build

- Release v0.1.12
## [0.1.11] - 2026-06-04

### 🚀 Features & Improvements

- Add history and chat images
- Add analytics chat section to documentation and update build script

### 🐛 Bug Fixes

- Fix installed app executable resolution

### ⚙️ CI/CD & Build

- Release v0.1.11

### 📦 Updates

- Update analytics chat section header for clarity
## [0.1.10] - 2026-06-03

### 🚀 Features & Improvements

- Add Mission Analytics Chat insights
- Add Copilot definition review artifacts
- Feat: enhance definition review with additional fields and editor integration
- Add history loading dialog, move model from nabar, add agent evaluation and tests
- Add MCP usage analytics chat

### 🐛 Bug Fixes

- Update mission control fixtures
- Fix analytics token rollups

### ⚙️ CI/CD & Build

- Release v0.1.10
- Update release UI state
## [0.1.9] - 2026-05-30

### 🚀 Features & Improvements

- Feat: update dashboard and focus mode GIFs for improved visual representation

### 🐛 Bug Fixes

- Fix: align history chart bars
- Fix: render history bars without inline styles

### ⚙️ CI/CD & Build

- Release v0.1.9
## [0.1.8] - 2026-05-29

### 🚀 Features & Improvements

- Feat: add global history analytics feature with detailed session tracking
- Feat: add mission layout and types for Copilot activity

### ⚙️ CI/CD & Build

- Release v0.1.8

### 💼 Other

- Refine mission control history UI
## [0.1.7] - 2026-05-28

### ⚙️ CI/CD & Build

- Release v0.1.7
## [0.1.6] - 2026-05-27

### 📚 Documentation

- Update image links in README to use absolute URLs
- Update image links in README to use relative URLs

### ⚙️ CI/CD & Build

- Release v0.1.6
## [0.1.5] - 2026-05-27

### ⚙️ CI/CD & Build

- Release v0.1.5
## [0.1.4] - 2026-05-27

### 🔧 Refactoring

- Clean up release asset uploads

### ⚙️ CI/CD & Build

- Release v0.1.4
## [0.1.3] - 2026-05-27

### ⚙️ CI/CD & Build

- Update release install instructions
- Release v0.1.3
## [0.1.2] - 2026-05-27

### 🚀 Features & Improvements

- Update README for clarity and improved descriptions of features

### ⚙️ CI/CD & Build

- Make frontend build cross-platform
- Release v0.1.2
## [0.1.1] - 2026-05-26

### 🚀 Features & Improvements

- Add MCP district, polish UX, fix tray + transcript
- Address code review backlog: tests, refactors, dynamic hover radius
- Add mystical comet trail + arrival sigil to event pulses
- Fix dark-mode pedestal circles + Summary card spacing + hash padding
- Drop idle district grey-out + add hash chip backdrop
- Add focus-mode toggle + web-like transcript scrolling
- Drop Agent Arcade references, add README + landing screenshots
- Exclude cache_read from input_tokens; add subCompact for Tokens card
- Add animated GIF previews + retire kingdom terminology in docs
- Add hero banner above landing-page copy/stage grid
- Add session inspector and polish dashboard UI
- Update icons and enhance frontend build process
- Add remote provider schemas
- Enhance token tracking and reporting in session summaries and HUD
- Add schema drift reporting and UI components for Copilot events
- Improve mission control live activity

### 🐛 Bug Fixes

- Per-category tools, sticky hover, bootstrap pulse fix + cleanups
- Fix Selected Session content overflowing the panel
- Fix tool categorization so every tool call lands in a real quarter
- Fix sprite overflow in quarter halos (center on halo, tighter box)
- Fix session-scoped mission metrics

### 🔧 Refactoring

- Rename Guild Hall short label from Agents to Sub-Agents for clarity
- Rename districts -> quarters; rewrite hero copy for the 'why'
- Rename Kingdom of Agents to Copilot Mission Control
- Refactor dashboard UI ownership

### 📚 Documentation

- Redesign docs landing site with kingdom-themed hero, carousel, and districts
- Remove shortcuts section from docs site, keep highlight phrase unbreakable
- Always show dashboard.gif first in landing-page carousel
- Recolor landing page from the hero banner art

### ⚙️ CI/CD & Build

- Tighten Tokens · 24h sub-text spacing so 'out' fits on narrow cards
- Stop full scene rebuild on every pulse arrival
- Grow buildings + castle to fill space in focus mode
- Tighten hero spacing — content now starts under the navbar
- Swap medieval building sprites to space theme (atlas-based)
- Tighten hero top spacing above the banner
- Release v0.1.1

### 🎨 Styling

- Grid-style layout polish: cards, Selected Session, LIVE button
- Polish focus mode: layout, selection bug, eye icon
- Combine s2+s3 atlas, refresh sprites, halos, icons, and center layout

### 📦 Updates

- Reflow action buttons + bump default window size

### 💼 Other

- Initial commit: Kingdom of Agents v0.1.0
- Navbar model chip, MCP allowlist, clearer token labels
- Anchor pulses at castle center + optimize trail hot path
- Keep Selected Session buttons side-by-side; shrink labels at narrow widths
- Defer renderActivity while comet pulses are flying
- Polish work-mix bars + eye toggle sizing
- Label each district with its in-app tool category
- Lift hero headline above the gifs as a full-width band
- Make hero headline a single line
- Recover compaction tokens that fall outside the 8 MiB tail window
- Tighten selected-session tokens line to 'Tokens in/out: X/Y'
- Strip kingdom-era category names from activity feed and last-event line
- Original images
- Ensure window visibility on show and toggle actions
- Refine mission dashboard activity details
