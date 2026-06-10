import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { GAME_URL, waitForGame } from './helpers';

const runLive = process.env.RUN_CODEX_LIVE_E2E === '1';

test.describe('Live Codex E2E mapping', () => {
  test.skip(!runLive, 'Set RUN_CODEX_LIVE_E2E=1 to run real Codex CLI live E2E.');
  test.setTimeout(180_000);

  test('runs Codex and verifies normalized UI surfaces update', async ({ page }) => {
    const workspace = await mkdtemp(join(tmpdir(), 'cmc-codex-live-'));
    const startedAt = Date.now();
    const liveEvents: any[] = [];
    await writeFile(join(workspace, 'input.txt'), 'Mission Control live Codex test input.\n', 'utf8');

    await exposeLiveCodexBridge(page, () => latestCodexActivity(startedAt, liveEvents));
    await page.goto(GAME_URL);
    await waitForGame(page);

    const codex = spawn('codex', [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '--cd',
      workspace,
      'Create codex-live-output.txt containing exactly codex-live-e2e-ok, verify it with a shell command, then stop.',
    ], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let jsonBuffer = '';
    codex.stdout.on('data', chunk => {
      const text = String(chunk);
      stdout += text;
      jsonBuffer += text;
      const lines = jsonBuffer.split(/\r?\n/);
      jsonBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { liveEvents.push(JSON.parse(line)); }
        catch { /* Non-JSON status lines are ignored. */ }
      }
    });
    codex.stderr.on('data', chunk => { stderr += String(chunk); });

    try {
      await expect.poll(() => Promise.resolve(latestCodexActivity(startedAt, liveEvents).total_tool_calls), {
        timeout: 120_000,
        intervals: [1_000, 2_000, 5_000],
      }).toBeGreaterThan(0);

      await expect.poll(async () => page.locator('#dom-feed .cmc-feed-row').count(), {
        timeout: 60_000,
      }).toBeGreaterThan(0);
      await expect.poll(async () => Number(await page.locator('[data-cmc-action="replay-seek"]').getAttribute('aria-valuemax')), {
        timeout: 60_000,
      }).toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(() => {
        const scene = (window as any).__phaserGame?.scene?.getScene?.('mission-control');
        const quarters = scene?.quarters ?? [];
        const commandCount = quarters.find((q: any) => q.key === 'terminal')?.count ?? 0;
        const signalCount = quarters.find((q: any) => q.key === 'signal')?.count ?? 0;
        return {
          replayTotal: scene?.replayState?.total ?? 0,
          sectorCount: commandCount + signalCount,
        };
      }), { timeout: 60_000 }).toEqual(expect.objectContaining({
        replayTotal: expect.any(Number),
        sectorCount: expect.any(Number),
      }));
      await expect.poll(() => page.evaluate(() => {
        const scene = (window as any).__phaserGame?.scene?.getScene?.('mission-control');
        const quarters = scene?.quarters ?? [];
        return (quarters.find((q: any) => q.key === 'terminal')?.count ?? 0)
          + (quarters.find((q: any) => q.key === 'signal')?.count ?? 0);
      }), { timeout: 60_000 }).toBeGreaterThan(0);
      await expect.poll(async () => page.locator('#dom-session').textContent(), {
        timeout: 60_000,
      }).toMatch(/Codex|Command|Web|activity|tool/i);

      const exitCode = await waitForExit(codex, 20_000);
      if (exitCode !== null) {
        expect(exitCode, `Codex stdout:\n${stdout}\nCodex stderr:\n${stderr}`).toBe(0);
      } else {
        codex.kill();
      }

      await page.locator('[data-cmc-action="replay-toggle"]').click();
      await expect(page.locator('[data-cmc-action="replay-toggle"]')).toHaveAttribute('aria-label', /Resume|Pause/);
    } finally {
      if (!codex.killed) codex.kill();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

async function exposeLiveCodexBridge(page: Page, getActivity: () => unknown) {
  await page.exposeFunction('__cmcLiveCodexActivity', getActivity);
  await page.addInitScript(() => {
    localStorage.setItem('cmc_agent_provider', 'codex');
    localStorage.removeItem('cmc_prefs');
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === 'get_agent_providers') {
          return [
            { id: 'codex', display_name: 'OpenAI Codex', short_name: 'Codex', available: true, version: 'live-test' },
          ];
        }
        if (command === 'get_agent_activity_for_provider' || command === 'get_agent_activity_for_provider_with_history') {
          return (window as any).__cmcLiveCodexActivity();
        }
        return null;
      },
    };
  });
}

function latestCodexActivity(startedAt: number, liveEvents: any[] = []) {
  if (liveEvents.length > 0) {
    const session = parseCodexValues(liveEvents, 'codexlive', startedAt);
    const events = eventsFromToolCalls(session);
    return activityFromSession(session, events, 'codex-live-e2e-json');
  }
  const file = latestCodexRollout(startedAt);
  if (!file) return emptyCodexActivity();
  const session = parseCodexRollout(file);
  const events = eventsFromToolCalls(session);
  return activityFromSession(session, events, 'codex-live-e2e-rollout');
}

function activityFromSession(session: any, events: any[], source: string) {
  return {
    available: true,
    source,
    scanned_sessions: 1,
    active_sessions: session.is_active ? 1 : 0,
    total_events: Math.max(events.length, session.event_count),
    total_tool_calls: session.tool_count,
    total_input_tokens: session.input_tokens,
    total_output_tokens: session.output_tokens,
    total_turns: session.turn_count,
    sessions: [session],
    tools: summarizeTools(session.recent_tool_calls),
    recent_events: events,
    alerts: [],
    generated_at_ms: Date.now(),
  };
}

function latestCodexRollout(startedAt: number) {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return null;
  const files = walk(root)
    .filter(file => /rollout-.*\.jsonl$/.test(file))
    .filter(file => statSync(file).mtimeMs >= startedAt - 5_000)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

function parseCodexRollout(file: string) {
  const lines = require('node:fs').readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const id = file.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/)?.[1]?.slice(0, 8) ?? 'codexlive';
  const modified = statSync(file).mtimeMs;
  return parseCodexValues(lines.map(line => JSON.parse(line)), id, modified);
}

function parseCodexValues(values: any[], id: string, modified: number) {
  const session: any = {
    provider: 'codex',
    id,
    title: 'Codex live E2E',
    repository: 'codex-live',
    branch: 'unknown',
    updated_at: new Date(modified).toISOString(),
    is_active: Date.now() - modified < 10 * 60_000,
    status: Date.now() - modified < 10 * 60_000 ? 'working' : 'idle',
    event_count: values.length,
    tool_count: 0,
    write_count: 0,
    read_count: 0,
    command_count: 0,
    web_count: 0,
    task_count: 0,
    delegates_count: 0,
    skills_count: 0,
    court_count: 0,
    mcp_count: 0,
    hooks_count: 0,
    error_count: 0,
    turn_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    last_tool: '',
    last_event_kind: '',
    last_event_category: '',
    last_event_timestamp: '',
    stale_seconds: Math.max(0, Math.floor((Date.now() - modified) / 1000)),
    recent_tool_calls: [],
    recent_turns: [],
    token_checkpoints: [],
  };
  const pending = new Map<string, any>();
  values.forEach((value, index) => {
    const payload = value.payload ?? value.msg ?? value;
    const item = payload.item ?? payload;
    const raw = normalizeRawEvent(payload.type ?? value.type ?? item.type ?? '');
    const timestamp = payload.started_at || payload.completed_at
      ? new Date((payload.started_at ?? payload.completed_at) * 1000).toISOString()
      : new Date(modified + index).toISOString();
    if (['task_started', 'turn_started', 'turn_started_event', 'item_started'].includes(raw) && String(item.type ?? '').includes('turn')) session.turn_count += 1;
    if (raw === 'token_count') {
      const usage = payload.info?.total_token_usage ?? {};
      session.input_tokens = Math.max(session.input_tokens, usage.input_tokens ?? 0);
      session.output_tokens = Math.max(session.output_tokens, usage.output_tokens ?? 0);
    }
    if (isLiveToolStart(raw, item)) {
      const tool = item.name ?? item.type ?? (raw === 'web_search_call' ? 'web_search' : 'tool');
      const category = categoryForTool(tool, raw);
      const callId = item.call_id ?? item.id ?? payload.call_id ?? `line-${index}`;
      const call = {
        tool,
        category,
        timestamp,
        success: true,
        call_id: callId,
        event_ref: `codex-${callId}`,
        details: [
          { label: 'Provider', value: 'codex' },
          { label: 'Privacy', value: 'arguments/output hidden' },
        ],
      };
      pending.set(call.call_id, call);
      session.recent_tool_calls.push(call);
      increment(session, category);
      session.tool_count += 1;
      session.last_tool = tool;
      session.last_event_kind = 'tool.execution_start';
      session.last_event_category = category;
      session.last_event_timestamp = timestamp;
    }
    if (isLiveToolEnd(raw, item)) {
      const callId = item.call_id ?? item.id ?? payload.call_id ?? `line-${index}`;
      const existing = pending.get(callId);
      if (existing) {
        existing.completed_at = timestamp;
        existing.success = true;
      }
    }
  });
  session.recent_tool_calls = dedupeCalls(session.recent_tool_calls).slice(-80);
  return session;
}

function normalizeRawEvent(raw: string) {
  return String(raw || '')
    .replace(/[.\-\s]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function isLiveToolStart(raw: string, item: any) {
  const itemType = normalizeRawEvent(item?.type ?? '');
  return ['function_call', 'custom_tool_call', 'web_search_call'].includes(raw)
    || raw.endsWith('_start')
    || raw.endsWith('_started')
    || (raw === 'item_started' && ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(itemType));
}

function isLiveToolEnd(raw: string, item: any) {
  const itemType = normalizeRawEvent(item?.type ?? '');
  return ['function_call_output', 'custom_tool_call_output', 'web_search_end'].includes(raw)
    || raw.endsWith('_end')
    || raw.endsWith('_completed')
    || (raw === 'item_completed' && ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(itemType));
}

function eventsFromToolCalls(session: any) {
  return session.recent_tool_calls
    .map((call: any) => ({
      provider: 'codex',
      session_id: session.id,
      timestamp: call.timestamp,
      kind: call.category === 'hooks' ? 'hook.start' : 'tool.execution_start',
      tool: call.tool,
      category: call.category,
      success: call.success !== false,
    }))
    .sort((a: any, b: any) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function summarizeTools(calls: any[]) {
  const counts = new Map<string, any>();
  for (const call of calls) {
    const key = `${call.tool}|${call.category}`;
    const current = counts.get(key) ?? { name: call.tool, category: call.category, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()];
}

function categoryForTool(tool: string, raw: string) {
  const name = String(tool).toLowerCase();
  if (raw === 'web_search_call' || name.includes('web_search')) return 'signal';
  if (name.startsWith('mcp__')) return 'mcp';
  if (['shell', 'shell_command', 'exec_command', 'command_execution', 'bash', 'exec'].includes(name)) return 'terminal';
  if (name.includes('patch') || name.includes('file')) return 'forge';
  if (name.includes('plan')) return 'court';
  return 'activity';
}

function increment(session: any, category: string) {
  if (category === 'terminal') session.command_count += 1;
  if (category === 'signal') session.web_count += 1;
  if (category === 'forge') session.write_count += 1;
  if (category === 'library') session.read_count += 1;
  if (category === 'mcp') session.mcp_count += 1;
  if (category === 'delegates') {
    session.task_count += 1;
    session.delegates_count += 1;
  }
  if (category === 'court') session.court_count += 1;
}

function dedupeCalls(calls: any[]) {
  const byId = new Map<string, any>();
  for (const call of calls) byId.set(call.call_id || `${call.timestamp}|${call.tool}`, call);
  return [...byId.values()];
}

function emptyCodexActivity() {
  return {
    available: true,
    source: 'codex-live-e2e',
    scanned_sessions: 0,
    active_sessions: 0,
    total_events: 0,
    total_tool_calls: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_turns: 0,
    sessions: [],
    tools: [],
    recent_events: [],
    alerts: [],
    generated_at_ms: Date.now(),
  };
}

function walk(dir: string): string[] {
  const fs = require('node:fs');
  const path = require('node:path');
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
