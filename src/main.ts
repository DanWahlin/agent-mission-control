// Agent Mission Control — single-scene bootstrap.
//
// One Phaser app, one scene, no switcher, no ready screen.
// Boots directly into the Mission Control view as soon as the window
// has real dimensions. Window size/position is restored across
// launches by `tauri-plugin-window-state` on the Rust side, so we just
// sync Phaser to whatever viewport the user ends up with.

import { W, H, refreshDimensions } from './scenes/viewport.js';
import { MissionControlScene } from './scenes/MissionControl.js';

declare const Phaser: any;

let game: any = null;

function initApp() {
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
  if (window.innerWidth > 200 && window.innerHeight > 200) initApp();
}

tryBoot();
if (!game) {
  // First-paint fallback if the window wasn't ready synchronously.
  setTimeout(tryBoot, 50);
  setTimeout(tryBoot, 200);
}

// Live resize: keep the canvas bounds tracking the window on the next
// animation frame. The scene debounces its heavier map/panel relayout.
let resizeFrame: number | null = null;
window.addEventListener('resize', () => {
  if (resizeFrame != null) return;
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = null;
    if (!game) {
      tryBoot();
      return;
    }
    refreshDimensions();
    try { game.scale.resize(W, H); } catch { /* ignore */ }
  });
});
