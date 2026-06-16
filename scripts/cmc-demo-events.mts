#!/usr/bin/env node
// Drives a burst of real-shape events through the actual Copilot session-state
// pipeline so Mission Control animates with live data (real watcher pushes,
// real token accumulation, real pulse spawns). Intended for capturing the
// hero GIFs for the README + GitHub Pages without faking the renderer.
//
// Usage:
//   1. Open Mission Control (cargo tauri dev, or the installed app)
//   2. Start a screen recorder (macOS: Cmd+Shift+5 → record selection
//      over the Mission Control window)
//   3. node scripts/cmc-demo-events.mts
//      └─ optional flags:
//           --duration <seconds>   total runtime (default: 25)
//           --cleanup              delete the demo session at end
//           --keep                 leave it in place (default)
//           --sid <uuid>           reuse a specific session id
//   4. Stop recording when "Done!" prints
//   5. Convert .mov → .gif:
//        ffmpeg -i in.mov -vf "fps=15,scale=1280:-1:flags=lanczos,
//          split[s0][s1];[s0]palettegen=stats_mode=diff[p];
//          [s1][p]paletteuse=dither=bayer:bayer_scale=5" -loop 0 out.gif

import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const DURATION_S = Number(argVal('--duration') ?? 10);
const CLEANUP    = args.includes('--cleanup');
const SID        = argVal('--sid') ?? `cmc-demo-${Date.now().toString(36)}`;

const SESSION_ROOT = join(homedir(), '.copilot', 'session-state', SID);
const EVENTS_PATH  = join(SESSION_ROOT, 'events.jsonl');
const WORKSPACE_PATH = join(SESSION_ROOT, 'workspace.yaml');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

let parentId = null;
async function emit(type, data, when = Date.now()) {
  const id = randomUUID();
  const event = { type, data, id, timestamp: new Date(when).toISOString(), parentId };
  parentId = id;
  await appendFile(EVENTS_PATH, JSON.stringify(event) + '\n');
}

// Mirror Mission Control's tool→sector mapping so the burst hits every
// sector inside the short demo window. Order is interleaved so the FIRST
// EIGHT entries cover all eight sectors — a single 6-8 tool turn at
// offset 0 already lights up most of the map, and a 10 s run that fires
// 2-3 turns is guaranteed to cover every sector at least once.
//   apply_patch       → edits      (Edits)
//   view / rg         → library    (Reads)
//   bash              → terminal   (Commands)
//   web_fetch         → signal     (Web/Docs)
//   task              → delegates  (Sub-Agents)
//   store_memory      → skills     (Skills)
//   context7-…        → mcp        (MCP — anything with '-' routes there)
//   report_intent     → court      (Intent)
const TOOLS = [
  { name: 'apply_patch',                  args: { path: '/Users/me/project/src/App.tsx' },                          latencyMs: 180 }, // edits
  { name: 'view',                         args: { path: '/Users/me/project/src/components/Header.tsx' },            latencyMs:  80 }, // library
  { name: 'bash',                         args: { command: 'npm run typecheck' },                                   latencyMs: 220 }, // terminal
  { name: 'web_fetch',                    args: { url: 'https://docs.tauri.app/v2/window' },                        latencyMs: 320 }, // signal
  { name: 'task',                         args: { name: 'design-critique' },                                        latencyMs: 380 }, // delegates
  { name: 'store_memory',                 args: { subject: 'auth flow' },                                           latencyMs:  90 }, // skills
  { name: 'context7-resolve-library-id',  args: { libraryName: 'Tauri' },                                           latencyMs: 280 }, // mcp
  { name: 'report_intent',                args: { intent: 'Planning the demo loop' },                               latencyMs:  60 }, // court
  // After the first 8, keep mixing categories so subsequent turns stay varied.
  { name: 'rg',                           args: { pattern: 'useEffect' },                                           latencyMs: 110 }, // library
  { name: 'apply_patch',                  args: { path: '/Users/me/project/src/api/auth.ts' },                      latencyMs: 200 }, // edits
  { name: 'bash',                         args: { command: 'npm test -- --run' },                                   latencyMs: 360 }, // terminal
  { name: 'context7-get-library-docs',    args: { libraryId: '/tauri/tauri-v2' },                                   latencyMs: 260 }, // mcp
  { name: 'view',                         args: { path: '/Users/me/project/README.md' },                            latencyMs:  90 }, // library
  { name: 'web_fetch',                    args: { url: 'https://github.com/tauri-apps/tauri' },                     latencyMs: 320 }, // signal
  { name: 'apply_patch',                  args: { path: '/Users/me/project/README.md' },                            latencyMs: 200 }, // edits
  { name: 'task',                         args: { name: 'security-review' },                                        latencyMs: 360 }, // delegates
];

function pickTools(turnIdx) {
  // Each turn picks a small slice of the deck. Keeping it to 3-4 tools
  // per turn means each pulse has time to land before the next one
  // launches — at the 300 ms watcher debounce that's ~1-2 pulses per
  // push instead of 5+ overlapping each other. We use an explicit
  // offset schedule so the first two turns together cover all 8
  // sectors (offset 0 → edits/library/terminal/signal, offset 4 →
  // delegates/skills/mcp/court) and later turns rotate through
  // varied slices.
  const SCHEDULE = [
    { offset: 0, count: 4 }, // edits, library, terminal, signal
    { offset: 4, count: 4 }, // delegates, skills, mcp, court
    { offset: 2, count: 3 }, // terminal, signal, delegates
    { offset: 6, count: 3 }, // mcp, court, edits (wraps)
    { offset: 8, count: 3 }, // library, edits, terminal (wraps)
  ];
  const slot = SCHEDULE[turnIdx % SCHEDULE.length];
  return Array.from({ length: slot.count }, (_, i) => TOOLS[(slot.offset + i) % TOOLS.length]);
}

async function main() {
  await mkdir(SESSION_ROOT, { recursive: true });
  // Match the real workspace.yaml shape Copilot CLI writes. Mission Control
  // pulls `repository`, `branch`, and `summary` from this file for the
  // session card / status pill, so set them to friendly demo values.
  await writeFile(WORKSPACE_PATH, [
    `id: ${SID}`,
    `cwd: ${process.cwd()}`,
    `git_root: ${process.cwd()}`,
    `repository: copilot-mission-control`,
    `host_type: github`,
    `branch: demo/live-preview`,
    `summary: Mission Control demo session`,
    `summary_count: 1`,
    `created_at: ${ts()}`,
    `updated_at: ${ts()}`,
  ].join('\n') + '\n');
  await writeFile(EVENTS_PATH, '');

  console.log(`▶ Streaming demo events into ~/.copilot/session-state/${SID}/`);
  console.log(`  Duration: ${DURATION_S}s · Cleanup at end: ${CLEANUP ? 'yes' : 'no'}`);
  console.log(`  Start your screen recorder now, then watch Mission Control…\n`);

  const startedAt = Date.now();

  await emit('session.start', {
    sessionId: SID,
    version: 1,
    producer: 'copilot-agent',
    copilotVersion: '1.0.52',
    startTime: ts(),
    context: {
      cwd: process.cwd(),
      gitRoot: process.cwd(),
      branch: 'demo/live-preview',
      repository: 'copilot-mission-control',
      hostType: 'github',
    },
  });
  await emit('user.message', {
    content: 'Walk through a typical edit-test-doc loop on the dashboard.',
    interactionId: randomUUID(),
  });

  // Seed input tokens via a compaction event so the Tokens · 24h card
  // shows non-zero on the first paint. (Rust reads compactionTokensUsed
  // → input_tokens / output_tokens; see agent.rs:856-869.)
  await emit('session.compaction_complete', {
    compactionTokensUsed: { inputTokens: 42_000, outputTokens: 1_800 },
  });

  let turnIdx = 0;
  while (Date.now() - startedAt < DURATION_S * 1000) {
    const turnId = String(turnIdx);
    const interactionId = randomUUID();
    await emit('assistant.turn_start', { turnId, interactionId });

    const tools = pickTools(turnIdx);
    // Single assistant.message that batches every tool call this turn —
    // matches how Copilot really emits multi-tool turns. Carries
    // outputTokens which the Rust normalizer accumulates into the
    // session's output_tokens total.
    const calls = tools.map(t => ({
      toolCallId: `toolu_demo_${randomUUID().slice(0, 12)}`,
      name: t.name,
      arguments: t.args,
      type: 'function',
    }));
    await emit('assistant.message', {
      messageId: randomUUID(),
      content: '',
      toolRequests: calls,
      outputTokens: 600 + Math.floor(Math.random() * 1600), // 600-2200/turn
      interactionId,
    });

    // Fire start+complete for each tool with realistic latency. We
    // pad the inter-tool sleep with an extra fixed gap so pulses
    // arrive at roughly one-per-half-second instead of stacking on
    // top of each other (which read as a "fire hose" of activity).
    for (const [i, t] of tools.entries()) {
      const callId = calls[i].toolCallId;
      await emit('tool.execution_start', { toolCallId: callId, toolName: t.name, arguments: t.args });
      await sleep(Math.max(80, t.latencyMs * 0.4));
      // Most tools succeed; flip occasional bash to a failure so the
      // ops summary occasionally lights up an alert.
      const success = !(t.name === 'bash' && Math.random() < 0.12);
      await emit('tool.execution_complete', {
        toolCallId: callId,
        model: 'claude-opus-4.7',
        interactionId,
        success,
        result: success
          ? { content: 'ok' }
          : { content: 'exit code 1', detailedContent: 'demo failure' },
        toolTelemetry: {},
      });
      await sleep(250 + Math.max(80, t.latencyMs * 0.5));
    }

    await emit('assistant.turn_end', { turnId });

    // Every other turn, emit another compaction event so input tokens
    // tick up visibly during the short recording window.
    if (turnIdx > 0 && turnIdx % 2 === 0) {
      await emit('session.compaction_complete', {
        compactionTokensUsed: {
          inputTokens: 18_000 + Math.floor(Math.random() * 9_000),
          outputTokens: 900 + Math.floor(Math.random() * 800),
        },
      });
    }

    turnIdx++;
    // Brief "thinking" pause between turns. Real Copilot turns have
    // a moment of model latency where no tool events fire — keeping
    // a short pause here gives the dashboard a moment for pulses to
    // fade before the next burst arrives. Tuned shorter (400-800 ms)
    // than real latency so 10 s recordings still get 3+ turn cycles.
    await sleep(400 + Math.floor(Math.random() * 400));
  }

  // Final flourish: a clean shutdown with tokenDetails so the totals
  // settle at the displayed numbers.
  const finalIn = 42_000 + turnIdx * 19_000;
  const finalOut = 1_800 + turnIdx * 4_500;
  await emit('session.shutdown', {
    tokenDetails: {
      input:       { tokenCount: finalIn },
      cache_write: { tokenCount: 8_500 },
      output:      { tokenCount: finalOut },
    },
  });

  console.log(`\n✔ Done! Fired ${turnIdx} turn cycles over ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
  console.log(`  Stop your screen recorder now.`);
  if (CLEANUP) {
    await rm(SESSION_ROOT, { recursive: true, force: true });
    console.log(`  Cleaned up ${SESSION_ROOT}`);
  } else {
    console.log(`  Demo session kept at: ${SESSION_ROOT}`);
    console.log(`  Delete it with:  rm -rf "${SESSION_ROOT}"`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
