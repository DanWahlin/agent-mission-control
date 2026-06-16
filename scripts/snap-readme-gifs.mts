// Captures animated GIF previews of the dashboard against a rich
// deterministic fixture, injecting fresh tool events over a 5-second
// window so sectors light up and pulses fly through the mission map.
//
//   npm run build:frontend
//   (cd dist && python3 -m http.server 4173) &
//   node scripts/snap-readme-gifs.mts
//
// Outputs (5 s loops, 1440x900, 15 fps):
//   docs/img/dashboard.gif     (panels visible)
//   docs/img/focus-mode.gif    (panels hidden)
//   docs/img/dashboard.png     (single frame, for og:image fallback)
//
// Requires ffmpeg on PATH.

import { chromium } from '@playwright/test';
import { mkdir, rm, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

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
      last_event_kind: 'tool.execution_start', last_event_category: 'edits',
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
    { name: 'apply_patch', category: 'edits', count: 71 },
    { name: 'bash', category: 'terminal', count: 197 },
    { name: 'rg', category: 'library', count: 35 },
    { name: 'task', category: 'delegates', count: 3 },
    { name: 'web_fetch', category: 'signal', count: 12 },
    { name: 'mcp.workiq', category: 'mcp', count: 1 },
  ],
  recent_events: [
    { session_id: 'alpha123', timestamp: '2026-05-22T17:00:00Z', kind: 'tool.execution_start', tool: 'apply_patch', category: 'edits', success: true },
    { session_id: 'alpha123', timestamp: '2026-05-22T16:59:00Z', kind: 'tool.execution_complete', tool: 'view', category: 'library', success: true },
    { session_id: 'alpha123', timestamp: '2026-05-22T16:58:00Z', kind: 'tool.execution_start', tool: 'bash', category: 'terminal', success: true },
    { session_id: 'beta4567', timestamp: '2026-05-22T16:55:00Z', kind: 'tool.execution_start', tool: 'rg', category: 'library', success: true },
    { session_id: 'gamma890', timestamp: '2026-05-22T16:50:00Z', kind: 'tool.execution_complete', tool: 'web_fetch', category: 'signal', success: true },
  ],
  alerts: [],
  generated_at_ms: Date.now(),
};

// Pulse-friendly mix: every entry is tool.execution_start so the
// scene spawns a flying pulse. Cadence is roughly one pulse every
// 350-450 ms over 5 seconds so multiple pulses are usually in
// flight simultaneously — which is what real Copilot CLI activity
// actually looks like during a busy session.
const SCRIPT = [
  { delayMs: 250,  session: 'alpha123', tool: 'view',        category: 'library'   },
  { delayMs: 600,  session: 'alpha123', tool: 'apply_patch', category: 'edits'     },
  { delayMs: 950,  session: 'alpha123', tool: 'bash',        category: 'terminal'  },
  { delayMs: 1350, session: 'beta4567', tool: 'rg',          category: 'library'   },
  { delayMs: 1750, session: 'alpha123', tool: 'view',        category: 'library'   },
  { delayMs: 2100, session: 'alpha123', tool: 'apply_patch', category: 'edits'     },
  { delayMs: 2500, session: 'gamma890', tool: 'web_fetch',   category: 'signal'    },
  { delayMs: 2900, session: 'alpha123', tool: 'bash',        category: 'terminal'  },
  { delayMs: 3300, session: 'alpha123', tool: 'task',        category: 'delegates' },
  { delayMs: 3650, session: 'alpha123', tool: 'view',        category: 'library'   },
  { delayMs: 4000, session: 'beta4567', tool: 'mcp.workiq',  category: 'mcp'       },
  { delayMs: 4350, session: 'alpha123', tool: 'apply_patch', category: 'edits'     },
  { delayMs: 4700, session: 'alpha123', tool: 'bash',        category: 'terminal'  },
];

const RECORD_MS = 5200; // pad slightly past last event so its pulse lands
const VIEWPORT  = { width: 1440, height: 900 };
const GIF_FPS   = 15;
const GIF_WIDTH = 1280;

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.split('\n').slice(-15).join('\n')}`));
    });
  });
}

async function videoToGif(videoPath, gifPath) {
  // Two-pass palette generation for clean colors. stats_mode=diff
  // weights moving regions (the pulses, sigils) over the mostly-
  // static dashboard, which gives the brand greens/oranges room
  // in the 256-color palette.
  const palettePath = join(tmpdir(), `cmc-gif-palette-${Date.now()}.png`);
  const vf = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  await runFfmpeg(['-y', '-i', videoPath,
    '-vf', `${vf},palettegen=stats_mode=diff`, palettePath]);
  await runFfmpeg(['-y', '-i', videoPath, '-i', palettePath,
    '-lavfi', `${vf}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', '0', gifPath]);
  await rm(palettePath, { force: true });
}

async function recordSession({ panelsHidden, outGif, outFirstFrame }) {
  const videoDir = join(tmpdir(), `cmc-gif-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
  await mkdir(videoDir, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  const page = await ctx.newPage();

  await page.addInitScript((arg) => {
    window.__missionControlFixture = arg.fixture;
    try { localStorage.setItem('cmc_panels_hidden', arg.panelsHidden ? '1' : '0'); } catch (_) {}
    try { localStorage.setItem('cmc_muted', '1'); } catch (_) {}
  }, { fixture, panelsHidden });

  await page.goto('http://localhost:4173/index.html');
  await page.waitForSelector('canvas', { timeout: 15000 });
  await page.waitForFunction(() => {
    const g = window.__phaserGame;
    if (!g) return false;
    const scene = g.scene?.getScene?.('mission-control');
    return !!scene && g.scene.isActive('mission-control');
  }, { timeout: 15000, polling: 100 });
  await page.waitForTimeout(700); // let the first paint settle

  // Capture a still of the first stable frame for og:image fallback.
  if (outFirstFrame) {
    await mkdir(dirname(outFirstFrame), { recursive: true });
    await page.screenshot({ path: outFirstFrame, fullPage: false });
  }

  // Drive a scripted burst of events into the page. The scene
  // dedupes events by (timestamp|session|kind|tool|category|success)
  // so we mint fresh ISO timestamps per pulse. We also bump the
  // matching tools[] counter and the session's tool_count/event_count
  // so the summary numbers tick up as the animation plays. We pre-seed
  // each session's recent_tool_calls so the chip counts start at a
  // healthy baseline and visibly grow over the recording window.
  page.on('console', msg => {
    if (msg.type() === 'log' && msg.text().startsWith('[gif]')) {
      console.log('  page:', msg.text());
    }
  });

  await page.evaluate((script) => {
    const fix = window.__missionControlFixture;
    if (!fix) { console.log('[gif] no fixture!'); return; }
    if (!window.__cmcOnAgentActivityChanged) { console.log('[gif] no change hook!'); return; }
    // Pre-seed each session with recent_tool_calls so the per-sector
    // chip counts (compute24hCategoryCounts) start at the same numbers
    // the static README screenshot used to show.
    const now = Date.now();
    for (const s of fix.sessions) {
      s.recent_tool_calls = [];
    }
    const seed = [
      ['alpha123', 'apply_patch', 'edits',     22],
      ['alpha123', 'view',        'library',   58],
      ['alpha123', 'bash',        'terminal',  41],
      ['alpha123', 'rg',          'library',   12],
      ['alpha123', 'task',        'delegates',  3],
      ['beta4567', 'view',        'library',   18],
      ['beta4567', 'apply_patch', 'edits',      6],
      ['gamma890', 'web_fetch',   'signal',    11],
      ['gamma890', 'view',        'library',    4],
      ['alpha123', 'mcp.workiq',  'mcp',        1],
    ];
    let stagger = 60_000;
    for (const [sid, tool, cat, count] of seed) {
      const sess = fix.sessions.find(s => s.id === sid);
      if (!sess) continue;
      for (let i = 0; i < count; i++) {
        stagger += 11_000;
        sess.recent_tool_calls.push({
          tool, category: cat, success: true,
          timestamp: new Date(now - stagger).toISOString(),
        });
      }
    }
    let injected = 0;
    const fireOne = (step) => {
      const stamp = new Date(Date.now()).toISOString();
      fix.recent_events.unshift({
        session_id: step.session,
        timestamp: stamp,
        kind: 'tool.execution_start',
        tool: step.tool,
        category: step.category,
        success: true,
      });
      if (fix.recent_events.length > 80) fix.recent_events.length = 80;
      const tool = fix.tools.find(t => t.name === step.tool);
      if (tool) tool.count += 1;
      const session = fix.sessions.find(s => s.id === step.session);
      if (session) {
        session.event_count = (session.event_count || 0) + 1;
        session.tool_count = (session.tool_count || 0) + 1;
        if (step.category === 'edits') session.write_count = (session.write_count || 0) + 1;
        if (step.category === 'library') session.read_count = (session.read_count || 0) + 1;
        if (step.category === 'terminal') session.command_count = (session.command_count || 0) + 1;
        if (step.category === 'signal') session.web_count = (session.web_count || 0) + 1;
        if (step.category === 'delegates') session.task_count = (session.task_count || 0) + 1;
        session.last_tool = step.tool;
        session.last_event_kind = 'tool.execution_start';
        session.last_event_category = step.category;
        session.stale_seconds = 0;
        session.recent_tool_calls = session.recent_tool_calls || [];
        session.recent_tool_calls.unshift({
          tool: step.tool, category: step.category, success: true, timestamp: stamp,
        });
        if (session.recent_tool_calls.length > 120) session.recent_tool_calls.length = 120;
      }
      fix.total_tool_calls += 1;
      fix.total_events += 1;
      fix.generated_at_ms = Date.now();
      window.__cmcOnAgentActivityChanged();
      injected++;
    };
    // Trigger an initial render so the pre-seeded recent_tool_calls
    // flow into the chip counts before the first event fires.
    window.__cmcOnAgentActivityChanged();
    for (const step of script) {
      setTimeout(() => fireOne(step), step.delayMs);
    }
    setTimeout(() => console.log('[gif] injected', injected, 'events'), script[script.length - 1].delayMs + 200);
  }, SCRIPT);

  await page.waitForTimeout(RECORD_MS);

  const video = page.video();
  await ctx.close();
  await browser.close();

  const webmPath = await video.path();
  await mkdir(dirname(outGif), { recursive: true });
  await videoToGif(webmPath, outGif);
  await rm(videoDir, { recursive: true, force: true });
  console.log('wrote', outGif);
}

await recordSession({
  panelsHidden: false,
  outGif: 'docs/img/dashboard.gif',
  outFirstFrame: 'docs/img/dashboard.png',
});
await recordSession({
  panelsHidden: true,
  outGif: 'docs/img/focus-mode.gif',
  outFirstFrame: null,
});
