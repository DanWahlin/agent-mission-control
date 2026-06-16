/**
 * Visual layout snapshot tool for Agent Mission Control.
 *
 * Boots `dist/index.html` in headless Chromium at a sequence of
 * viewport sizes (with the deterministic fixture installed) and writes
 * one PNG per size to ../.snapshots/ at the repo root. Intended as a
 * developer aid for iterating on the dashboard layout — *not* a CI
 * gate. Layout regressions are still asserted in
 * `tests/mission-control.spec.ts`.
 *
 * Usage:
 *   node scripts/snap-layouts.ts                  # default viewport set
 *   node scripts/snap-layouts.ts 1440x900 800x600 # custom sizes
 *
 * Requires the http server on :4173 (run `npm run build:frontend`
 * first). The script starts and stops its own server.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { chromium } = require('playwright');

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const outDir = path.join(repoRoot, '.snapshots');

const DEFAULT_VIEWPORTS = [
  { name: '1024x768',   width: 1024, height: 768 },
  { name: '1280x800',   width: 1280, height: 800 },
  { name: '1440x900',   width: 1440, height: 900 },
  { name: '1512x982',   width: 1512, height: 982 },
  { name: '1920x1080',  width: 1920, height: 1080 },
  { name: '2560x1440',  width: 2560, height: 1440 },
];

const KINGDOM_FIXTURE = {
  available: true,
  source: 'snap-layouts',
  scanned_sessions: 4,
  active_sessions: 2,
  total_events: 184,
  total_tool_calls: 70,
  total_output_tokens: 25_300,
  sessions: [
    { id: 'alpha123', title: 'Build Mission Control', repository: 'copilot-mission-control', branch: 'main', updated_at: '', is_active: true, status: 'working', event_count: 82, tool_count: 23, write_count: 8, read_count: 9, command_count: 4, web_count: 1, task_count: 1, error_count: 0, output_tokens: 4200, last_tool: 'apply_patch', last_event_kind: 'tool.execution_start', last_event_category: 'forge', stale_seconds: 12 },
    { id: 'beta4567', title: 'Review Tests', repository: 'copilot-mission-control', branch: 'main', updated_at: '', is_active: true, status: 'needs-attention', event_count: 64, tool_count: 17, write_count: 2, read_count: 7, command_count: 6, web_count: 0, task_count: 2, error_count: 1, output_tokens: 2920, last_tool: 'bash', last_event_kind: 'tool.execution_complete', last_event_category: 'alert', stale_seconds: 25 },
    { id: 'gamma890', title: 'Research UI', repository: 'docs', branch: 'main', updated_at: '', is_active: false, status: 'idle', event_count: 38, tool_count: 7, write_count: 0, read_count: 3, command_count: 0, web_count: 4, task_count: 0, error_count: 0, output_tokens: 1000, last_tool: 'web_fetch', last_event_kind: 'tool.execution_start', last_event_category: 'signal', stale_seconds: 900 },
  ],
  tools: [
    { name: 'view', category: 'library', count: 14 },
    { name: 'apply_patch', category: 'forge', count: 8 },
    { name: 'bash', category: 'terminal', count: 7 },
    { name: 'rg', category: 'library', count: 5 },
    { name: 'task', category: 'delegates', count: 3 },
    { name: 'web_fetch', category: 'signal', count: 4 },
  ],
  recent_events: [
    { session_id: 'alpha123', timestamp: '2026-05-21T07:15:00Z', kind: 'tool.execution_start',    tool: 'apply_patch', category: 'forge',    success: true  },
    { session_id: 'beta4567', timestamp: '2026-05-21T07:14:00Z', kind: 'tool.execution_complete', tool: 'tool complete', category: 'alert',    success: false },
    { session_id: 'alpha123', timestamp: '2026-05-21T07:13:00Z', kind: 'tool.execution_start',    tool: 'view',        category: 'library',  success: true  },
    { session_id: 'gamma890', timestamp: '2026-05-21T07:12:00Z', kind: 'tool.execution_start',    tool: 'web_fetch',   category: 'signal',   success: true  },
  ],
  alerts: ['1 recent tool failure needs review.'],
  generated_at_ms: Date.now(),
};

function parseViewportArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) return DEFAULT_VIEWPORTS;
  return args.map(a => {
    const m = a.match(/^(\d+)x(\d+)$/);
    if (!m) throw new Error(`Invalid viewport ${a}; expected WxH (e.g. 1440x900)`);
    return { name: a, width: Number(m[1]), height: Number(m[2]) };
  });
}

function startServer() {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error(`Missing ${distDir}/index.html — run \`npm run build:frontend\` first.`);
    process.exit(1);
  }
  const child = spawn('python3', ['-m', 'http.server', '4173', '--directory', distDir], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(child), 800);
    child.on('error', err => { clearTimeout(t); reject(err); });
  });
}

async function snapshot(page, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.addInitScript(fixture => {
    window.__missionControlFixture = fixture;
  }, KINGDOM_FIXTURE);
  await page.goto('http://localhost:4173/index.html');
  await page.waitForFunction(() => {
    const g = window.__phaserGame;
    return !!g && g.scene?.isActive?.('mission-control');
  }, { timeout: 10_000 });
  // Settle a beat so the first renderActivity has run.
  await page.waitForTimeout(600);
  const outPath = path.join(outDir, `${viewport.name}.png`);
  await page.screenshot({ path: outPath, fullPage: false });
  console.log(`  ✓ ${viewport.name.padEnd(12)} → ${path.relative(repoRoot, outPath)}`);
}

(async () => {
  const viewports = parseViewportArgs();
  fs.mkdirSync(outDir, { recursive: true });

  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    console.log(`Capturing ${viewports.length} viewport(s) → ${path.relative(repoRoot, outDir)}/`);
    for (const vp of viewports) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await snapshot(page, vp);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
