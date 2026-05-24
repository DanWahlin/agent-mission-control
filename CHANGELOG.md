# Changelog

All notable changes to Copilot Mission Control.

## [0.1.0] - Initial release

- First standalone release of the Copilot Mission Control dashboard.
- Decorated, resizable Tauri 2 window (not an overlay) with persistent size/position.
- Single Phaser 4 scene rendering districts, ops panel, replay timeline, and session inspector.
- Rust `AgentProvider` trait with `CopilotProvider` impl that scans `~/.copilot/session-state/`,
  allowlists fields, and emits push updates via a debounced `notify = 8` filesystem watcher.
- Curated CC0 Tiny Swords asset subset in `assets/kingdom/tiny-swords/`.
- Playwright test suite covering scene behavior and multi-viewport layout regressions.
