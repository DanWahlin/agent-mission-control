// Captures README screenshots of the dashboard against a rich
// deterministic fixture. Expects a static server already running at
// http://localhost:4173 serving dist/.
//   npm run build:frontend
//   (cd dist && python3 -m http.server 4173) &
//   node scripts/snap-readme.mjs
//
// Outputs:
//   docs/img/dashboard.png         (panels visible, 1440x900 @ 2x)
//   docs/img/focus-mode.png        (panels hidden, 1440x900 @ 2x)

import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const fixture = {
  available: true,
  source: 'playwright-readme-fixture',
  scanned_sessions: 3,
  active_sessions: 1,
  total_events: 1820,
  total_tool_calls: 558,
  total_output_tokens: 207000,
  total_input_tokens: 567000,
  sessions: [
    {
      id: 'alpha123', title: 'Polish mission layout', repository: 'copilot-mission-control',
      branch: 'main', updated_at: '', is_active: true, status: 'working',
      event_count: 920, tool_count: 312, write_count: 71, read_count: 169,
      command_count: 197, web_count: 12, task_count: 3, error_count: 0,
      output_tokens: 138000, last_tool: 'apply_patch',
      last_event_kind: 'tool.execution_start', last_event_category: 'forge',
      stale_seconds: 4,
    },
    {
      id: 'beta4567', title: 'Add Claude provider', repository: 'copilot-mission-control',
      branch: 'feat/claude', updated_at: '', is_active: false, status: 'idle',
      event_count: 540, tool_count: 154, write_count: 22, read_count: 60,
      command_count: 48, web_count: 18, task_count: 5, error_count: 1,
      output_tokens: 48000, last_tool: 'view',
      last_event_kind: 'tool.execution_complete', last_event_category: 'library',
      stale_seconds: 320,
    },
    {
      id: 'gamma890', title: 'Docs research', repository: 'docs',
      branch: 'main', updated_at: '', is_active: false, status: 'idle',
      event_count: 360, tool_count: 92, write_count: 4, read_count: 14,
      command_count: 6, web_count: 41, task_count: 0, error_count: 0,
      output_tokens: 21000, last_tool: 'web_fetch',
      last_event_kind: 'tool.execution_complete', last_event_category: 'signal',
      stale_seconds: 900,
    },
  ],
  tools: [
    { name: 'view', category: 'library', count: 134 },
    { name: 'apply_patch', category: 'forge', count: 71 },
    { name: 'bash', category: 'terminal', count: 197 },
    { name: 'rg', category: 'library', count: 35 },
    { name: 'task', category: 'delegates', count: 3 },
    { name: 'web_fetch', category: 'signal', count: 12 },
    { name: 'mcp.workiq', category: 'mcp', count: 1 },
  ],
  recent_events: [
    { session_id: 'alpha123', timestamp: '2026-05-22T17:00:00Z', kind: 'tool.execution_start', tool: 'apply_patch', category: 'forge', success: true },
    { session_id: 'alpha123', timestamp: '2026-05-22T16:59:00Z', kind: 'tool.execution_complete', tool: 'view', category: 'library', success: true },
    { session_id: 'alpha123', timestamp: '2026-05-22T16:58:00Z', kind: 'tool.execution_start', tool: 'bash', category: 'terminal', success: true },
    { session_id: 'beta4567', timestamp: '2026-05-22T16:55:00Z', kind: 'tool.execution_start', tool: 'rg', category: 'library', success: true },
    { session_id: 'gamma890', timestamp: '2026-05-22T16:50:00Z', kind: 'tool.execution_complete', tool: 'web_fetch', category: 'signal', success: true },
  ],
  alerts: [],
  generated_at_ms: Date.now(),
};

async function snap({ width, height, panelsHidden, out }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.addInitScript((arg) => {
    window.__missionControlFixture = arg.fixture;
    try { localStorage.setItem('cmc_panels_hidden', arg.panelsHidden ? '1' : '0'); } catch (_) {}
    try { localStorage.setItem('cmc_muted', '1'); } catch (_) {}
  }, { fixture, panelsHidden });
  await page.goto('http://localhost:4173/game/index.html');
  await page.waitForSelector('canvas', { timeout: 15000 });
  await page.waitForFunction(() => {
    const g = window.__phaserGame;
    if (!g) return false;
    const scene = g.scene?.getScene?.('mission-control');
    return !!scene && g.scene.isActive('mission-control');
  }, { timeout: 15000, polling: 100 });
  await page.waitForTimeout(2200);
  await mkdir(dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: false });
  await ctx.close();
  await browser.close();
  console.log('wrote', out);
}

const W = 1440;
const H = 900;

await snap({ width: W, height: H, panelsHidden: false, out: 'docs/img/dashboard.png' });
await snap({ width: W, height: H, panelsHidden: true,  out: 'docs/img/focus-mode.png' });
await snap({ width: 1600, height: 900, panelsHidden: false, out: 'docs/img/dashboard-wide.png' });
await snap({ width: 1280, height: 800, panelsHidden: true,  out: 'docs/img/focus-mode-compact.png' });
