import { test, expect } from '@playwright/test';
import { GAME_URL, waitForGame } from './helpers';

test.describe('Copilot Mission Control app shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(GAME_URL);
    await waitForGame(page);
  });

  test('top bar shows brand and theme toggle', async ({ page }) => {
    await expect(page.locator('#topbar .brand')).toContainText('Copilot Mission Control');
    await expect(page.locator('#theme-btn')).toBeVisible();
  });

  test('theme toggle persists to localStorage and flips body class', async ({ page }) => {
    const before = await page.evaluate(() => localStorage.getItem('cmc_theme'));
    expect(before).not.toBe('light');
    await expect(page.locator('body')).not.toHaveClass(/theme-light/);
    await page.locator('#theme-btn').click();
    const after = await page.evaluate(() => localStorage.getItem('cmc_theme'));
    expect(after).toBe('light');
    await expect(page.locator('body')).toHaveClass(/theme-light/);
    await page.locator('#theme-btn').click();
    const restored = await page.evaluate(() => localStorage.getItem('cmc_theme'));
    expect(restored).toBe('dark');
    await expect(page.locator('body')).not.toHaveClass(/theme-light/);
  });

  test('canvas mounts at full window size', async ({ page }) => {
    const dims = await page.evaluate(() => {
      const game = (window as any).__phaserGame;
      return { w: game?.config?.width ?? 0, h: game?.config?.height ?? 0 };
    });
    expect(dims.w).toBeGreaterThan(800);
    expect(dims.h).toBeGreaterThan(500);
  });
});
