// Copilot Mission Control — single-scene bootstrap.
//
// One Phaser game, one scene, no game-switcher, no ready screen.
// Boots directly into the Mission Control view as soon as the window
// has real dimensions. Window size/position is restored across
// launches by `tauri-plugin-window-state` on the Rust side, so we just
// sync Phaser to whatever viewport the user ends up with.

import { W, H, refreshDimensions } from './scenes/viewport.js';
import { MissionControlScene } from './scenes/MissionControl.js';

declare const Phaser: any;

let game: any = null;

function initGame() {
  refreshDimensions();

  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: W,
    height: H,
    backgroundColor: '#0a0e22',
    scene: [MissionControlScene],
    render: {
      // The mission sprites are detailed painted atlas frames, not
      // pixel art. Linear filtering preserves their source detail when
      // Phaser scales them to fit responsive sector cards.
      pixelArt: false,
      antialias: true,
      antialiasGL: true,
      roundPixels: false,
    },
    fps: { target: 60 },
  });

  (window as any).__phaserGame = game;
}

// Boot when the viewport has real dimensions. Tauri can take a beat
// after window restoration before `innerWidth`/`innerHeight` settle.
function tryBoot() {
  if (game) return;
  if (window.innerWidth > 200 && window.innerHeight > 200) initGame();
}

tryBoot();
if (!game) {
  // First-paint fallback if the window wasn't ready synchronously.
  setTimeout(tryBoot, 50);
  setTimeout(tryBoot, 200);
}

// Live resize: relayout the canvas without restarting the scene. The
// mission scene's `computeLayout()` is responsive — it samples W/H
// every render — so a simple `scale.resize()` is enough.
let resizeDebounce: number | null = null;
window.addEventListener('resize', () => {
  if (resizeDebounce) clearTimeout(resizeDebounce);
  resizeDebounce = window.setTimeout(() => {
    if (!game) {
      tryBoot();
      return;
    }
    refreshDimensions();
    try { game.scale.resize(W, H); } catch { /* ignore */ }
  }, 100) as unknown as number;
});
