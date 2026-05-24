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
      replayPlayButton: scene.replayPlayButtonRect ?? null,
      replayLiveButton: scene.replayLiveButtonRect ?? null,
      replayTrack: scene.replayTrackRect ?? null,
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
        rightX: scene.layout.rightX,
        rightW: scene.layout.rightW,
        opsY: scene.layout.opsY,
        opsH: scene.layout.opsH,
        bottomY: scene.layout.bottomY,
        bottomH: scene.layout.bottomH,
        inspectorX: scene.layout.inspectorX,
        inspectorW: scene.layout.inspectorW,
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
    expect(state!.replayPlayButton).toBeTruthy();
    expect(state!.replayTrack).toBeTruthy();
  });

  test('clicking pause freezes replay; clicking live resumes', async ({ page }) => {
    const before = await getMissionState(page);
    const playBtn = before!.replayPlayButton;
    expect(playBtn).toBeTruthy();
    const off = await canvasOffset(page);
    await page.mouse.click(off.x + playBtn.x + playBtn.w / 2, off.y + playBtn.y + playBtn.h / 2);
    await page.waitForTimeout(120);
    let state = await getMissionState(page);
    expect(state!.replayState.paused).toBe(true);

    const liveBtn = state!.replayLiveButton;
    expect(liveBtn).toBeTruthy();
    await page.mouse.click(off.x + liveBtn.x + liveBtn.w / 2, off.y + liveBtn.y + liveBtn.h / 2);
    await page.waitForTimeout(120);
    state = await getMissionState(page);
    expect(state!.replayState.paused).toBe(false);
    expect(state!.replayState.atLive).toBe(true);
  });

  test('clicking the timeline scrubs the cursor backward', async ({ page }) => {
    const before = await getMissionState(page);
    expect(before!.replayState.total).toBe(4);
    const track = before!.replayTrack;
    expect(track).toBeTruthy();
    const off = await canvasOffset(page);
    await page.mouse.click(off.x + track.x + track.w * 0.25, off.y + track.y + track.h / 2);
    await page.waitForTimeout(120);
    const after = await getMissionState(page);
    expect(after!.replayState.cursor).toBeLessThan(before!.replayState.cursor);
    expect(after!.replayState.atLive).toBe(false);
  });

  test('clicking a running session selects it for inspection', async ({ page }) => {
    const before = await getMissionState(page);
    expect(before!.selectedSessionId).toBe('beta4567');
    const alphaRow = before!.sessionPickerRows.find((row: any) => row.id === 'alpha123');
    expect(alphaRow).toBeTruthy();

    const off = await canvasOffset(page);
    await page.mouse.click(off.x + alphaRow.x + alphaRow.w / 2, off.y + alphaRow.y + alphaRow.h / 2);
    await page.waitForTimeout(150);

    const after = await getMissionState(page);
    expect(after!.selectedSessionId).toBe('alpha123');
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

    // Click into alpha123 → chip should switch to its model.
    const before = await getMissionState(page);
    const alphaRow = before!.sessionPickerRows.find((row: any) => row.id === 'alpha123');
    expect(alphaRow).toBeTruthy();
    const off = await canvasOffset(page);
    await page.mouse.click(off.x + alphaRow.x + alphaRow.w / 2, off.y + alphaRow.y + alphaRow.h / 2);
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
    expect(before!.layout!.rightW).toBeGreaterThan(0);

    await page.locator('#panels-btn').click();
    // Wait for the re-render to settle.
    await page.waitForFunction(() => {
      const scene = (window as any).__phaserGame?.scene?.getScene?.('mission-control');
      return scene?.layout?.panelW === 0 && scene?.layout?.rightW === 0;
    }, { timeout: 2000 });

    const after = await getMissionState(page);
    expect(after!.layout!.panelW).toBe(0);
    expect(after!.layout!.rightW).toBe(0);
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
    expect(restored!.layout!.rightW).toBe(before!.layout!.rightW);
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
    expect(state!.layout!.rightW).toBe(0);
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
    const rightPanelLeft = layout.rightX;
    const wellTop = layout.opsY + layout.opsH;
    const wellBottom = layout.bottomY;
    for (const d of state!.quarterRects) {
      const r = layout.quarterR;
      expect(d.x - r, `quarter ${d.key} left edge crosses left panel`).toBeGreaterThanOrEqual(leftPanelRight);
      expect(d.x + r, `quarter ${d.key} right edge crosses right panel`).toBeLessThanOrEqual(rightPanelLeft);
      expect(d.y - r, `quarter ${d.key} top edge crosses ops strip`).toBeGreaterThanOrEqual(wellTop);
      expect(d.y + r, `quarter ${d.key} bottom edge crosses bottom inspector`).toBeLessThanOrEqual(wellBottom);
    }
  });
}
