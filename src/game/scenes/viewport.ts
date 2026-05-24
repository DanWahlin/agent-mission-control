// Shared viewport dimensions for the Copilot Mission Control scene.
//
// We re-export `W` and `H` as live values that callers refresh by
// invoking `refreshDimensions()` whenever the window resizes. The
// mission layout (`computeLayout()` in MissionControl.ts) reads these
// every render, so simply calling refresh + Phaser's `scale.resize()`
// is enough to relayout the entire view.
//
// The HTML top bar (#topbar) is `TOPBAR_H` pixels tall and the canvas
// mounts inside `#game` (position: fixed; top: 40px; bottom: 0). So
// the canvas height is always `innerHeight - TOPBAR_H`; we report that
// here so the scene lays out for the area it actually has rather than
// the full window — otherwise the bottom replay strip gets clipped
// and the ops bar floats too far from the top.

export const TOPBAR_H = 40;

export let W = window.innerWidth;
export let H = Math.max(0, window.innerHeight - TOPBAR_H);

export function refreshDimensions() {
  W = window.innerWidth;
  H = Math.max(0, window.innerHeight - TOPBAR_H);
}
