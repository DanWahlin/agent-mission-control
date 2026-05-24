import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { GAME_URL, waitForGame } from './helpers';

const MISSION_FIXTURE = {
  available: true,
  source: 'playwright-fixture',
  scanned_sessions: 3,
  active_sessions: 2,
  total_events: 184,
  total_tool_calls: 47,
  total_output_tokens: 8120,
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
    { session_id: 'alpha123', timestamp: '2026-05-21T07:15:00Z', kind: 'tool.execution_start', tool: 'apply_patch', category: 'forge', success: true },
    { session_id: 'beta4567', timestamp: '2026-05-21T07:14:00Z', kind: 'tool.execution_complete', tool: 'tool complete', category: 'alert', success: false },
    { session_id: 'alpha123', timestamp: '2026-05-21T07:13:00Z', kind: 'tool.execution_start', tool: 'view', category: 'library', success: true },
    { session_id: 'gamma890', timestamp: '2026-05-21T07:12:00Z', kind: 'tool.execution_start', tool: 'web_fetch', category: 'signal', success: true },
  ],
  alerts: ['1 recent tool failure needs review.'],
  generated_at_ms: Date.now(),
};

const LONG_TOOL_NAME = 'bash-command-with-a-very-long-safe-label-for-turn-story-truncation';

async function installFixture(page: Page, fixture = MISSION_FIXTURE) {
  await page.addInitScript((fixtureArg) => {
    (window as any).__missionControlFixture = fixtureArg;
  }, fixture);
}

/** Returns the canvas bounding box so tests can map scene-space rects
 * to viewport coordinates. The 32 px top bar offsets the canvas down,
 * so plain `page.mouse.click(rect.x, rect.y)` would miss the target. */
async function canvasOffset(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
}

async function getMissionState(page: Page) {
  return page.evaluate(() => {
    const game = (window as any).__phaserGame;
    if (!game) return null;
    const scene = game.scene.getScene('mission-control') as any;
    if (!scene) return null;

    return {
      sceneName: scene.scene?.key,
      available: scene.activity?.available,
      source: scene.activity?.source,
      activeSessions: scene.activity?.active_sessions,
      toolCalls: scene.activity?.total_tool_calls,
      sessionCount: scene.activity?.sessions?.length ?? 0,
      quarterCount: scene.quarters?.length ?? 0,
      selectedSessionId: scene.selectedSession?.id,
      sessionPickerRows: scene.sessionPickerRows ?? [],
      activeEventPulseCount: scene.activeEventPulseCount ?? 0,
      quarterEventBadges: scene.quarterEventBadges ?? {},
      replayState: scene.replayState ?? { paused: false, cursor: 0, total: 0, atLive: true },
      opsMode: scene.opsSummary?.mode,
      opsAttention: scene.opsSummary?.attention,
      opsRecommendation: scene.opsSummary?.recommendation,
      insightLabels: (scene.insightCards ?? []).map((card: any) => card.label),
      scannedSessions: scene.activity?.scanned_sessions,
      screenW: window.innerWidth,
      screenH: window.innerHeight,
      layout: scene.layout ? {
        leftX: scene.layout.leftX,
        panelW: scene.layout.panelW,
        opsY: scene.layout.opsY,
        opsH: scene.layout.opsH,
        bottomY: scene.layout.bottomY,
        bottomH: scene.layout.bottomH,
        inspectorX: scene.layout.inspectorX,
        inspectorW: scene.layout.inspectorW,
        radiusX: scene.layout.radiusX,
        radiusY: scene.layout.radiusY,
        quarterR: scene.layout.quarterR,
        compact: scene.layout.compact,
      } : null,
      quarterRects: (scene.quarters ?? []).map((d: any) => ({
        key: d.key, x: d.x, y: d.y,
      })),
      inspectedQuarterKey: scene.inspectedQuarterKey ?? null,
      hoveredQuarterIndex: scene.hoveredQuarterIndex ?? -1,
    };
  });
}

function inspectorFixture() {
  const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
  const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
  beta.recent_tool_calls = [
    {
      tool: 'browser_navigate',
      category: 'mcp',
      timestamp: '2026-05-21T07:10:00Z',
      completed_at: '2026-05-21T07:10:01Z',
      success: true,
      duration_ms: 1000,
      model: 'gpt-5.5',
      call_id: 'call-mcp1',
      turn_id: 'turn-a1',
      target: 'browser_navigate',
      details: [
        { label: 'Type', value: 'MCP tool' },
        { label: 'Provider', value: 'copilot' },
        { label: 'Privacy', value: 'arguments/output hidden' },
      ],
      raw_args: 'SECRET_MCP /Users/dan/.env',
    },
    {
      tool: 'blog-writer',
      category: 'skills',
      timestamp: '2026-05-21T07:11:00Z',
      completed_at: '2026-05-21T07:11:02Z',
      success: true,
      duration_ms: 2000,
      model: 'gpt-5.5',
      call_id: 'call-skill1',
      turn_id: 'turn-a1',
      target: 'blog-writer',
      details: [
        { label: 'Type', value: 'Skill' },
        { label: 'Provider', value: 'copilot' },
        { label: 'Privacy', value: 'arguments/output hidden' },
      ],
      prompt: 'SECRET_SKILL',
    },
    {
      tool: LONG_TOOL_NAME,
      category: 'terminal',
      timestamp: '2026-05-21T07:13:00Z',
      completed_at: '',
      success: true,
      model: 'gpt-5.5',
      call_id: 'call-bash-long',
      turn_id: 'turn-tail',
      target: LONG_TOOL_NAME,
      details: [
        { label: 'Type', value: 'Command tool' },
        { label: 'Provider', value: 'copilot' },
        { label: 'Privacy', value: 'arguments/output hidden' },
      ],
    },
    {
      tool: 'code-reviewer',
      category: 'delegates',
      timestamp: '2026-05-21T07:12:00Z',
      completed_at: '2026-05-21T07:12:04Z',
      success: false,
      duration_ms: 4000,
      model: 'gpt-5.5',
      call_id: 'call-agent1',
      turn_id: 'turn-a1',
      target: 'code-reviewer',
      details: [
        { label: 'Type', value: 'Sub-agent' },
        { label: 'Provider', value: 'copilot' },
        { label: 'Privacy', value: 'arguments/output hidden' },
        { label: 'Mode', value: 'background' },
      ],
      command: 'SECRET_AGENT',
    },
  ];
  beta.recent_turns = [
    {
      id: 'turn-a1',
      started_at: '2026-05-21T07:09:30Z',
      ended_at: '2026-05-21T07:12:10Z',
      status: 'failed',
      tool_count: 3,
      tools: ['browser_navigate', 'blog-writer', 'code-reviewer'],
      failure_count: 1,
      categories: ['delegates', 'mcp', 'skills'],
      model: 'gpt-5.5',
      output_tokens: 3210,
      partial: false,
      duration_ms: 160000,
    },
    {
      id: 'turn-tail',
      started_at: '2026-05-21T07:13:00Z',
      ended_at: '',
      status: 'running',
      tool_count: 1,
      tools: [LONG_TOOL_NAME],
      failure_count: 0,
      categories: ['terminal'],
      model: 'gpt-5.5',
      output_tokens: 0,
      partial: true,
    },
  ];
  return fixture;
}

function overflowingInspectorFixture() {
  const fixture = inspectorFixture();
  const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
  beta.recent_tool_calls = Array.from({ length: 36 }, (_, index) => ({
    tool: `tool-${String(index + 1).padStart(2, '0')}`,
    category: index % 3 === 0 ? 'mcp' : index % 3 === 1 ? 'skills' : 'delegates',
    timestamp: new Date(Date.parse('2026-05-21T07:00:00Z') + index * 1000).toISOString(),
    completed_at: new Date(Date.parse('2026-05-21T07:00:00Z') + index * 1000 + 500).toISOString(),
    success: index % 7 !== 0,
    duration_ms: 500,
    model: 'gpt-5.5',
    call_id: `call-overflow-${index + 1}`,
    turn_id: 'turn-a1',
    target: `tool-${index + 1}`,
    details: [
      { label: 'Type', value: index % 3 === 0 ? 'MCP tool' : index % 3 === 1 ? 'Skill' : 'Sub-agent' },
      { label: 'Provider', value: 'copilot' },
      { label: 'Privacy', value: 'arguments/output hidden' },
    ],
  }));
  return fixture;
}

test.describe('Copilot Mission Control — Startup', () => {
  test.beforeEach(async ({ page }) => {
    await installFixture(page);
    await page.goto(GAME_URL);
    await waitForGame(page);
  });

  test('renders Copilot CLI activity as mission insights', async ({ page }) => {
    const state = await getMissionState(page);
    expect(state).not.toBeNull();
    expect(state!.sceneName).toBe('mission-control');
    expect(state!.available).toBe(true);
    expect(state!.source).toBe('playwright-fixture');
    expect(state!.activeSessions).toBe(2);
    expect(state!.toolCalls).toBe(47);
    expect(state!.sessionCount).toBe(3);
    expect(state!.quarterCount).toBe(8);
    expect(state!.scannedSessions).toBe(3);
    expect(state!.insightLabels).toContain('Tokens · 24h');
    expect(state!.opsAttention).toBe('review');
    expect(state!.opsRecommendation).toMatch(/failed.*in /);
    expect(state!.selectedSessionId).toBe('beta4567');
  });

  test('top bar HUD elements are present', async ({ page }) => {
    await expect(page.locator('#topbar .brand')).toBeVisible();
    await expect(page.locator('#topbar-metrics .topbar-metric')).toHaveCount(4);
    await expect(page.locator('#topbar-metrics')).toContainText('Active');
    await expect(page.locator('#topbar-metrics')).toContainText(/Tokens\s*\d+\/\d+k?/);
    await expect(page.locator('#theme-btn')).toBeVisible();
  });
});

test.describe('Copilot Mission Control — Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await installFixture(page);
    await page.goto(GAME_URL);
    await waitForGame(page);
  });

  test('dashboard renders fixture activity without manual refresh', async ({ page }) => {
    const state = await getMissionState(page);
    expect(state!.toolCalls).toBe(47);
    expect(state!.sessionCount).toBe(3);
    await expect(page.locator('#dom-workmix')).toBeVisible();
    await expect(page.locator('#dom-workmix')).toContainText('Recent work mix');
    await expect(page.locator('#dom-workmix [data-cmc-action="workmix-scope"]')).toBeVisible();
    await expect(page.locator('#dom-workmix .cmc-work-row')).toHaveCount(6);
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      };
      return {
        workMix: rect('#dom-workmix'),
        lastWorkRow: rect('#dom-workmix .cmc-work-row:last-child'),
        feed: rect('#dom-feed'),
        replay: rect('#dom-replay'),
      };
    });
    expect(layout.workMix).toBeTruthy();
    expect(layout.lastWorkRow).toBeTruthy();
    expect(layout.feed).toBeTruthy();
    expect(layout.replay).toBeTruthy();
    expect(layout.lastWorkRow!.bottom).toBeLessThanOrEqual(layout.workMix!.bottom - 8);
    expect(layout.feed!.top).toBeGreaterThanOrEqual(layout.workMix!.bottom + 8);
    expect(layout.feed!.bottom).toBeLessThanOrEqual(layout.replay!.top - 8);
  });

  test('bootstrap suppresses live pulses so historical events do not animate', async ({ page }) => {
    // The 4 events in MISSION_FIXTURE.recent_events are the snapshot
    // history — they were already counted by the backend. Animating
    // them as "live" pulses on cold start makes boxes flow into
    // buildings while the 24h badge counts never change, which reads
    // as "is anything actually working?". The bootstrapCompleted flag
    // gates the pulse queue so initial ingest is silent.
    await page.waitForTimeout(800);
    const state = await getMissionState(page);
    expect(state!.activeEventPulseCount).toBe(0);
    // Badges only increment from arrived live pulses, so they should
    // stay empty during bootstrap.
    expect(Object.keys(state!.quarterEventBadges).length).toBe(0);
    // Replay log still ingested the events — just without pulses.
    expect(state!.replayState.total).toBe(4);
  });

  test('post-bootstrap watcher push queues live pulses for new events', async ({ page }) => {
    // Wait for bootstrap to fully settle.
    await page.waitForTimeout(800);
    // Inject a NEW event into the fixture and trigger the watcher
    // hook the Rust backend uses (window.__cmcOnAgentActivityChanged).
    // bootstrapCompleted is now true → pulses should fire.
    const queued = await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      const newEvent = {
        session_id: 'alpha123',
        timestamp: new Date().toISOString(),
        kind: 'tool.execution_start',
        tool: 'bash',
        category: 'terminal',
        success: true,
      };
      fixture.recent_events = [newEvent, ...fixture.recent_events];
      (window as any).__cmcOnAgentActivityChanged?.();
      return true;
    });
    expect(queued).toBe(true);
    // Pulses are queued with PULSE_STAGGER_MS delay and ~900ms duration
    // — sample mid-flight before they arrive.
    await page.waitForTimeout(250);
    const mid = await getMissionState(page);
    expect(mid!.activeEventPulseCount).toBeGreaterThan(0);
  });

  test('replay timeline ingests events into the log and stays live by default', async ({ page }) => {
    const state = await getMissionState(page);
    expect(state!.replayState.total).toBe(4);
    expect(state!.replayState.cursor).toBe(4);
    expect(state!.replayState.atLive).toBe(true);
    expect(state!.replayState.paused).toBe(false);
    await expect(page.locator('#dom-replay [data-cmc-action="replay-toggle"]')).toBeVisible();
    await expect(page.locator('#dom-replay [data-cmc-action="replay-seek"]')).toBeVisible();
  });

  test('clicking pause freezes replay; clicking live resumes', async ({ page }) => {
    await page.locator('#dom-replay [data-cmc-action="replay-toggle"]').click();
    await page.waitForTimeout(120);
    let state = await getMissionState(page);
    expect(state!.replayState.paused).toBe(true);

    await page.locator('#dom-replay [data-cmc-action="replay-live"]').click();
    await page.waitForTimeout(120);
    state = await getMissionState(page);
    expect(state!.replayState.paused).toBe(false);
    expect(state!.replayState.atLive).toBe(true);
  });

  test('clicking the timeline scrubs the cursor backward', async ({ page }) => {
    const before = await getMissionState(page);
    expect(before!.replayState.total).toBe(4);
    const track = page.locator('#dom-replay [data-cmc-action="replay-seek"]');
    const box = await track.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.click(box!.x + box!.width * 0.25, box!.y + box!.height / 2);
    await page.waitForTimeout(120);
    const after = await getMissionState(page);
    expect(after!.replayState.cursor).toBeLessThan(before!.replayState.cursor);
    expect(after!.replayState.atLive).toBe(false);
  });

  test('clicking a running session selects it for inspection', async ({ page }) => {
    const before = await getMissionState(page);
    expect(before!.selectedSessionId).toBe('beta4567');
    await page.locator('#dom-session [data-cmc-action="session-select"]').selectOption('alpha123');
    await page.waitForTimeout(150);

    const after = await getMissionState(page);
    expect(after!.selectedSessionId).toBe('alpha123');
  });

  test('inspector filters MCP, skills, and sub-agent calls with safe details', async ({ page }) => {
    await page.addInitScript((fixture) => { (window as any).__missionControlFixture = fixture; }, inspectorFixture());
    await page.goto(GAME_URL);
    await waitForGame(page);

    const state = await getMissionState(page);
    expect(state!.selectedSessionId).toBe('beta4567');
    await page.locator('#dom-session [data-cmc-action="inspector"]').click();
    await expect(page.locator('#inspector-overlay')).toHaveClass(/visible/);
    await expect(page.locator('#inspector-title')).toContainText('Review Tests');

    let text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('Safe details');
    expect(text).toContain('code-reviewer');
    expect(text).toContain('Sub-agent');
    expect(text).toContain('arguments/output hidden');
    expect(text).not.toContain('SECRET_AGENT');
    expect(text).not.toContain('SECRET_MCP');
    expect(text).not.toContain('/Users/dan/.env');

    await page.locator('[data-inspector-tab="mcp"]').click();
    text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('browser_navigate');
    expect(text).toContain('MCP tool');
    expect(text).not.toContain('SECRET_MCP');

    await page.locator('[data-inspector-tab="skills"]').click();
    text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('blog-writer');
    expect(text).toContain('Skill');
    expect(text).not.toContain('SECRET_SKILL');

    await page.keyboard.press('Escape');
    await expect(page.locator('#inspector-overlay')).not.toHaveClass(/visible/);
  });

  test('inspector turn mode shows turn-by-turn story and related tools', async ({ page }) => {
    await page.addInitScript((fixture) => { (window as any).__missionControlFixture = fixture; }, inspectorFixture());
    await page.goto(GAME_URL);
    await waitForGame(page);

    await page.locator('#dom-session [data-cmc-action="inspector"]').click();
    await expect(page.locator('#inspector-overlay')).toHaveClass(/visible/);
    await page.locator('[data-inspector-mode="turns"]').click();
    await page.locator('[data-turn-id="turn-a1"]').click();

    let text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('Turn story');
    expect(text).toContain('failed');
    expect(text).toContain('browser_navigate, blog-writer, code-reviewer');
    expect(text).toContain('Tool details');
    expect(text).toContain('MCP tool · 1.0s');
    expect(text).toContain('Sub-agent · failed');
    expect(text).toContain('Tools in this turn (3)');
    expect(text).toContain('code-reviewer');

    await page.locator('[data-turn-id="turn-tail"]').click();
    text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('partial tail window');
    expect(text).toContain('running');
    expect(text).toContain('bash-command-with-a-very-long-safe-label-for-...');
    expect(text).not.toContain(LONG_TOOL_NAME);
  });

  test('HTML inspector uses native scroll containers for long lists', async ({ page }) => {
    await page.addInitScript((fixture) => { (window as any).__missionControlFixture = fixture; }, overflowingInspectorFixture());
    await page.goto(GAME_URL);
    await waitForGame(page);

    await page.locator('#dom-session [data-cmc-action="inspector"]').click();
    await expect(page.locator('#inspector-overlay')).toHaveClass(/visible/);
    const list = page.locator('#inspector-list');
    await expect(list.locator('[data-tool-key]').first()).toContainText('tool-36');
    const before = await list.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    expect(before.max).toBeGreaterThan(0);
    const scrollbarStyle = await list.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        gutter: style.scrollbarGutter,
        color: style.scrollbarColor,
      };
    });
    expect(scrollbarStyle.gutter).toContain('stable');
    expect(scrollbarStyle.color).not.toBe('auto');
    const box = await list.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test('navbar model chip mirrors the selected session and updates on session switch', async ({ page }) => {
    // Inject a fixture where each session reports a different model
    // so we can verify the chip swaps when the selection changes.
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    fixture.sessions[0].last_model = 'gpt-5.5';   // alpha123
    fixture.sessions[1].last_model = 'claude-sonnet-4.6'; // beta4567 (default-selected: review)
    fixture.sessions[2].last_model = 'gpt-4.1';   // gamma890

    await page.addInitScript((f) => { (window as any).__missionControlFixture = f; }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    // beta4567 is the default-selected session (review attention) →
    // chip should show its model and not be hidden.
    await expect(page.locator('#model-chip')).toHaveText('claude-sonnet-4.6');
    await expect(page.locator('#model-chip')).not.toHaveClass(/empty/);

    // Select alpha123 → chip should switch to its model.
    await page.locator('#dom-session [data-cmc-action="session-select"]').selectOption('alpha123');
    await page.waitForTimeout(150);

    await expect(page.locator('#model-chip')).toHaveText('gpt-5.5');
  });

  test('navbar model chip stays hidden when no session reports a model', async ({ page }) => {
    // Default fixture has no `last_model` on any session. The chip
    // should render with the `empty` class (display: none) so we
    // never flash a blank pill.
    await expect(page.locator('#model-chip')).toHaveClass(/empty/);
    await expect(page.locator('#model-chip')).toHaveText('');
  });

  test('hovering a quarter makes it the sticky-inspected quarter and persists across reload', async ({ page }) => {
    // Move the pointer into a known quarter (Library / Reads). The
    // sticky-hover model promotes whatever the cursor enters into
    // `inspectedQuarterKey` and persists it to localStorage so the
    // inspector resumes on the same quarter after a window restart.
    const before = await getMissionState(page);
    const library = before!.quarterRects.find((d: any) => d.key === 'library');
    expect(library).toBeTruthy();

    const off = await canvasOffset(page);
    await page.mouse.move(off.x + library.x, off.y + library.y);
    // updateHoveredQuarter runs on Phaser's update() tick; give it a
    // few frames to register the new hover position.
    await page.waitForTimeout(150);

    const hovered = await getMissionState(page);
    expect(hovered!.inspectedQuarterKey).toBe('library');
    expect(hovered!.hoveredQuarterIndex).toBeGreaterThanOrEqual(0);

    // Move the pointer OUT of the ring. The sticky-hover model
    // intentionally KEEPS `inspectedQuarterKey` pointing at library —
    // that's the whole point. The hover index should clear back to -1.
    await page.mouse.move(off.x + 5, off.y + 5);
    await page.waitForTimeout(150);
    const released = await getMissionState(page);
    expect(released!.hoveredQuarterIndex).toBe(-1);
    expect(released!.inspectedQuarterKey).toBe('library');

    // Verify it was written to localStorage under the new key.
    const stored = await page.evaluate(() => {
      const raw = window.localStorage.getItem('cmc_prefs');
      return raw ? JSON.parse(raw) : null;
    });
    expect(stored).toBeTruthy();
    expect(stored.inspectedQuarterKey).toBe('library');

    // Reload and confirm the scene restores the sticky quarter.
    await page.reload();
    await waitForGame(page);
    const restored = await getMissionState(page);
    expect(restored!.inspectedQuarterKey).toBe('library');
  });

  test('loadMissionPrefs migrates legacy pinnedDistrictKey to inspectedQuarterKey', async ({ page }) => {
    // Seed localStorage with the v0.1 legacy field name BEFORE the
    // scene boots so loadMissionPrefs has a chance to migrate it.
    // Existing users have this key already; it must continue to be
    // honored across the district -> quarter rename.
    await page.addInitScript(() => {
      window.localStorage.setItem('cmc_prefs', JSON.stringify({
        pinnedDistrictKey: 'court',
        replayPaused: false,
      }));
    });
    await page.goto(GAME_URL);
    await waitForGame(page);

    const state = await getMissionState(page);
    expect(state!.inspectedQuarterKey).toBe('court');

    // The legacy fields must be deleted after migration so they don't
    // linger in storage forever.
    const stored = await page.evaluate(() => {
      const raw = window.localStorage.getItem('cmc_prefs');
      return raw ? JSON.parse(raw) : null;
    });
    expect(stored.pinnedDistrictKey).toBeUndefined();
    expect(stored.inspectedDistrictKey).toBeUndefined();
    expect(stored.inspectedQuarterKey).toBe('court');
  });

  test('loadMissionPrefs migrates legacy inspectedDistrictKey to inspectedQuarterKey', async ({ page }) => {
    // Intermediate-generation field (v0.1.x). Some users will have
    // this set instead of pinnedDistrictKey.
    await page.addInitScript(() => {
      window.localStorage.setItem('cmc_prefs', JSON.stringify({
        inspectedDistrictKey: 'library',
        replayPaused: false,
      }));
    });
    await page.goto(GAME_URL);
    await waitForGame(page);

    const state = await getMissionState(page);
    expect(state!.inspectedQuarterKey).toBe('library');

    const stored = await page.evaluate(() => {
      const raw = window.localStorage.getItem('cmc_prefs');
      return raw ? JSON.parse(raw) : null;
    });
    expect(stored.inspectedDistrictKey).toBeUndefined();
    expect(stored.inspectedQuarterKey).toBe('library');
  });
});

test.describe('Copilot Mission Control — Focus Mode', () => {
  test('topbar panels button toggles side panels and resizes the ring', async ({ page }) => {
    await installFixture(page);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(GAME_URL);
    await waitForGame(page);

    const before = await getMissionState(page);
    expect(before!.layout!.panelW).toBeGreaterThan(0);

    await page.locator('#panels-btn').click();
    // Wait for the re-render to settle.
    await page.waitForFunction(() => {
      const scene = (window as any).__phaserGame?.scene?.getScene?.('mission-control');
      return scene?.layout?.panelW === 0;
    }, { timeout: 2000 });

    const after = await getMissionState(page);
    expect(after!.layout!.panelW).toBe(0);
    // Inspector still draws — its rect should grow to span between leftX
    // and the right edge minus margins.
    expect(after!.layout!.inspectorW).toBeGreaterThan(before!.layout!.inspectorW);

    // Clicking again restores panels.
    await page.locator('#panels-btn').click();
    await page.waitForFunction(() => {
      const scene = (window as any).__phaserGame?.scene?.getScene?.('mission-control');
      return (scene?.layout?.panelW ?? 0) > 0;
    }, { timeout: 2000 });
    const restored = await getMissionState(page);
    expect(restored!.layout!.panelW).toBe(before!.layout!.panelW);
  });

  test('focus-mode preference persists across reloads via localStorage', async ({ page }) => {
    await installFixture(page);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(GAME_URL);
    await waitForGame(page);

    await page.locator('#panels-btn').click();
    await page.waitForFunction(() => {
      const scene = (window as any).__phaserGame?.scene?.getScene?.('mission-control');
      return scene?.layout?.panelW === 0;
    }, { timeout: 2000 });

    const stored = await page.evaluate(() => localStorage.getItem('cmc_panels_hidden'));
    expect(stored).toBe('1');

    // Reload — the scene should paint in focus mode on the first frame
    // (no flash of panels-visible state).
    await page.reload();
    await waitForGame(page);
    const state = await getMissionState(page);
    expect(state!.layout!.panelW).toBe(0);
  });
});

test.describe('Copilot Mission Control — Ops Rules', () => {
  test('reports idle when no sessions are active', async ({ page }) => {
    const fixture = {
      ...MISSION_FIXTURE,
      active_sessions: 0,
      sessions: MISSION_FIXTURE.sessions.map(session => ({ ...session, is_active: false, error_count: 0, status: 'idle' })),
      alerts: [],
    };
    await installFixture(page, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    const state = await getMissionState(page);
    expect(state!.opsMode).toBe('Idle');
    expect(state!.opsAttention).toBe('ok');
    expect(state!.opsRecommendation).toContain('Safe to context-switch');
  });

  test('reports editing when active work is edit-heavy', async ({ page }) => {
    const fixture = {
      ...MISSION_FIXTURE,
      active_sessions: 1,
      sessions: [
        { ...MISSION_FIXTURE.sessions[0], is_active: true, error_count: 0, read_count: 1, write_count: 12, command_count: 1, web_count: 0, task_count: 0, status: 'working' },
      ],
      alerts: [],
    };
    await installFixture(page, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    const state = await getMissionState(page);
    expect(state!.opsMode).toBe('Editing');
    expect(state!.opsAttention).toBe('watch');
    expect(state!.opsRecommendation).toContain('review diffs');
  });
});

const VIEWPORTS = [
  { name: '4k', width: 3840, height: 2160 },
  { name: '1080p', width: 1920, height: 1080 },
  { name: 'mbp14', width: 1512, height: 982 },
  { name: 'mbp13', width: 1440, height: 900 },
  { name: '720p', width: 1280, height: 720 },
  { name: 'small', width: 1024, height: 768 },
];

for (const vp of VIEWPORTS) {
  test(`Copilot Mission Control renders at ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
    await installFixture(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(GAME_URL);
    await waitForGame(page);

    const state = await getMissionState(page);
    expect(state).not.toBeNull();
    expect(state!.screenW).toBe(vp.width);
    expect(state!.screenH).toBe(vp.height);
    expect(state!.sessionCount).toBe(3);
    expect(state!.quarterCount).toBe(8);

    // Layout regression: quarters must fit between side panels with at
    // least a small gutter, and inside the central well between the ops
    // strip and the bottom inspector. This catches the laptop overlap
    // bug where quarters crashed into Selected Session / Activity Feed.
    const layout = state!.layout!;
    expect(layout).not.toBeNull();
    const leftPanelRight = layout.leftX + layout.panelW;
    const wellRight = state!.screenW - layout.leftX;
    const wellTop = layout.opsY + layout.opsH;
    const wellBottom = layout.bottomY;
    for (const d of state!.quarterRects) {
      const r = layout.quarterR;
      expect(d.x - r, `quarter ${d.key} left edge crosses left panel`).toBeGreaterThanOrEqual(leftPanelRight);
      expect(d.x + r, `quarter ${d.key} right edge crosses viewport gutter`).toBeLessThanOrEqual(wellRight);
      expect(d.y - r, `quarter ${d.key} top edge crosses ops strip`).toBeGreaterThanOrEqual(wellTop);
      expect(d.y + r, `quarter ${d.key} bottom edge crosses bottom inspector`).toBeLessThanOrEqual(wellBottom);
    }
    expect(layout.radiusX / layout.radiusY, 'sector ring should not stretch into a flat oval').toBeLessThan(1.5);
  });
}
