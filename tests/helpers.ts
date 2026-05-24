/**
 * Playwright test helpers for Copilot Mission Control.
 *
 * The app is a single-scene Phaser canvas (`mission-control`) inside a
 * Tauri window; in tests we serve `dist/` over plain HTTP at port 4173
 * (see `playwright.config.ts`) so the renderer runs without Tauri.
 */

type Page = import('@playwright/test').Page;

const GAME_URL = 'http://localhost:4173/game/index.html';
export { GAME_URL };

/**
 * Wait for the Phaser game to boot and for the Mission Control scene to
 * become active. Returns after the canvas is mounted and the scene
 * registry reports the `mission-control` scene running.
 */
export async function waitForGame(page: Page) {
  await page.waitForSelector('canvas', { timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const game = (window as any).__phaserGame;
      if (!game) return false;
      const scene = game.scene?.getScene?.('mission-control');
      return !!scene && game.scene.isActive('mission-control');
    },
    { timeout: 10_000, polling: 100 },
  );
  // Small settle pause so the first renderActivity has a chance to draw.
  await page.waitForTimeout(500);
}

/** Read the Mission Control scene's reported status. */
export async function getMissionStatus(page: Page) {
  return page.evaluate(() => (window as any).__missionControl?.getStatus?.() ?? null);
}
