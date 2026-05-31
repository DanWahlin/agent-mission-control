#!/usr/bin/env node
// Quick visual-check script: launch headed Chromium against the dist/ build
// and snap screenshots at several window sizes with the test fixture and a
// session selected so I can verify layout fixes without rebuilding the
// Tauri shell or fighting screencapture TCC permissions.
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const FIXTURE = {
  available: true,
  source: 'snap-script',
  scanned_sessions: 4,
  active_sessions: 2,
  total_events: 1240,
  total_tool_calls: 312,
  total_input_tokens: 924800,
  total_output_tokens: 330700,
  sessions: [
    { id: 'a1b2c3d4', title: 'Audit Layout Constants', repository: 'copilot-mission-control', branch: 'main', updated_at: new Date().toISOString(), is_active: true, status: 'working', event_count: 482, tool_count: 137, write_count: 24, read_count: 58, command_count: 22, web_count: 8, task_count: 11, error_count: 0, output_tokens: 64200, input_tokens: 184000, last_tool: 'apply_patch', last_event_kind: 'tool.execution_start', last_event_category: 'forge', stale_seconds: 4, git_root: '/Users/danwahlin/Desktop/projects/copilot-mission-control', recent_tool_calls: Array.from({ length: 14 }, (_, i) => ({ ts: new Date(Date.now() - i * 3000).toISOString(), tool: ['apply_patch', 'view', 'bash'][i % 3], category: ['forge', 'library', 'terminal'][i % 3], success: true })) },
    { id: 'e5f6a7b8', title: 'Run Test Suite', repository: 'copilot-mission-control', branch: 'feature/x', updated_at: new Date().toISOString(), is_active: true, status: 'needs-attention', event_count: 312, tool_count: 87, write_count: 4, read_count: 22, command_count: 14, web_count: 1, task_count: 3, error_count: 2, output_tokens: 24200, input_tokens: 92000, last_tool: 'bash', last_event_kind: 'tool.execution_complete', last_event_category: 'alert', stale_seconds: 18, git_root: '/Users/danwahlin/repo', recent_tool_calls: Array.from({ length: 8 }, (_, i) => ({ ts: new Date(Date.now() - i * 5000).toISOString(), tool: 'bash', category: 'terminal', success: i !== 3 })) },
    { id: 'c9d0e1f2', title: 'Refactor inspector panel', repository: 'docs', branch: 'main', updated_at: new Date().toISOString(), is_active: false, status: 'idle', event_count: 188, tool_count: 42, write_count: 0, read_count: 12, command_count: 0, web_count: 16, task_count: 0, error_count: 0, output_tokens: 14200, input_tokens: 38000, last_tool: 'web_fetch', last_event_kind: 'tool.execution_start', last_event_category: 'signal', stale_seconds: 920 },
  ],
  tools: [
    { name: 'view', category: 'library', count: 64 },
    { name: 'apply_patch', category: 'forge', count: 38 },
    { name: 'bash', category: 'terminal', count: 24 },
    { name: 'rg', category: 'library', count: 22 },
    { name: 'task', category: 'delegates', count: 11 },
    { name: 'web_fetch', category: 'signal', count: 8 },
  ],
  recent_events: Array.from({ length: 14 }, (_, i) => ({
    session_id: i % 2 === 0 ? 'a1b2c3d4' : 'e5f6a7b8',
    timestamp: new Date(Date.now() - i * 4000).toISOString(),
    kind: i === 3 ? 'tool.execution_complete' : 'tool.execution_start',
    tool: ['apply_patch', 'view', 'bash', 'rg', 'web_fetch', 'task'][i % 6],
    category: ['forge', 'library', 'terminal', 'library', 'signal', 'delegates'][i % 6],
    success: i !== 3,
  })),
  alerts: ['1 recent tool failure needs review.'],
  generated_at_ms: Date.now(),
};

const PORT = 4291;
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', path.join(root, 'dist')], { stdio: 'ignore' });
    proc.on('error', reject);
    setTimeout(() => resolve(proc), 800);
  });
}
async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      await new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/`, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej));
      return;
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('server did not respond');
}

async function snap(browser, w, h, label, selectFirstSession, themeMode = 'dark') {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.addInitScript((args) => {
    window.__missionControlFixture = args.fixture;
    try { window.localStorage.setItem('cmc_theme', args.theme); } catch {}
  }, { fixture: FIXTURE, theme: themeMode });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => {
    const game = window.__phaserGame;
    if (!game) return false;
    const s = game.scene?.getScene?.('mission-control');
    return !!s && game.scene.isActive('mission-control');
  }, { timeout: 15000, polling: 100 });
  await page.waitForTimeout(800);
  if (selectFirstSession) {
    await page.evaluate(() => {
      const game = window.__phaserGame;
      const scene = game.scene.getScene('mission-control');
      const first = scene.activity?.sessions?.[0];
      if (first) scene.selectSessionById?.(first.id);
    });
    await page.waitForTimeout(300);
  }
  const out = path.join(root, `tmp-snap-${label}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await ctx.close();
  console.log(`  → ${out}`);
}

(async () => {
  const server = await startServer();
  try {
    await waitForServer();
    const browser = await chromium.launch();
    try {
      await snap(browser, 1600, 1000, '1600x1000-dark-selected', true, 'dark');
      await snap(browser, 1600, 1000, '1600x1000-light-selected', true, 'light');
      await snap(browser, 1920, 1200, '1920x1200-dark-selected', true, 'dark');
      await snap(browser, 1280, 800, '1280x800-dark-selected', true, 'dark');
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
})();
