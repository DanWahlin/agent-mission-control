import { test, expect } from '@playwright/test';
import { GAME_URL, waitForGame } from './helpers';

test.describe('Agent Mission Control app shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(GAME_URL);
    await waitForGame(page);
  });

  test('top bar shows brand and theme toggle', async ({ page }) => {
    await expect(page.locator('#topbar .brand')).toContainText('Agent Mission Control');
    await expect(page.locator('#settings-btn')).toBeVisible();
    await expect(page.locator('#theme-btn')).toBeVisible();
    await expect(page.locator('#mission-route-btn')).toHaveAttribute('aria-label', 'Show Home');
    await expect(page.locator('#history-route-btn')).toHaveAttribute('aria-label', 'Show global History analytics');
    await expect(page.locator('#analytics-route-btn')).toHaveAttribute('aria-label', 'Ask Analytics Chat');
    await expect(page.locator('#mission-route-btn svg')).toBeVisible();
    await expect(page.locator('#history-route-btn svg')).toBeVisible();
    await expect(page.locator('#analytics-route-btn svg')).toBeVisible();
    await expect(page.locator('#topbar-controls')).not.toContainText(/Home|History|Reset/);
    const topbarIconStyles = await page.evaluate(() => {
      const routeGroup = document.querySelector('.topbar-route-group') as HTMLElement;
      const missionRoute = document.querySelector('#mission-route-btn') as HTMLElement;
      const routeGroupStyle = getComputedStyle(routeGroup);
      const missionRouteStyle = getComputedStyle(missionRoute);
      return {
        routeGroupBorderWidth: routeGroupStyle.borderTopWidth,
        routeBorderColor: missionRouteStyle.borderTopColor,
        routeBackgroundImage: missionRouteStyle.backgroundImage,
        routeBoxShadow: missionRouteStyle.boxShadow,
      };
    });
    expect(topbarIconStyles.routeGroupBorderWidth).toBe('0px');
    expect(topbarIconStyles.routeBorderColor).toBe('rgba(0, 0, 0, 0)');
    expect(topbarIconStyles.routeBackgroundImage).not.toBe('none');
    expect(topbarIconStyles.routeBoxShadow).not.toBe('none');
  });

  test('top bar route buttons visually mark the active route in both themes', async ({ page }) => {
    const darkActiveColor = 'rgb(184, 255, 207)';
    const lightActiveColor = 'rgb(22, 101, 52)';
    const routeStyles = async () => page.evaluate(() => {
      const mission = document.querySelector('#mission-route-btn') as HTMLElement;
      const history = document.querySelector('#history-route-btn') as HTMLElement;
      const analytics = document.querySelector('#analytics-route-btn') as HTMLElement;
      const panels = document.querySelector('#panels-btn') as HTMLButtonElement;
      const missionStyle = getComputedStyle(mission);
      const historyStyle = getComputedStyle(history);
      const analyticsStyle = getComputedStyle(analytics);
      return {
        missionCurrent: mission.getAttribute('aria-current'),
        historyCurrent: history.getAttribute('aria-current'),
        analyticsCurrent: analytics.getAttribute('aria-current'),
        missionBackgroundImage: missionStyle.backgroundImage,
        historyBackgroundImage: historyStyle.backgroundImage,
        analyticsBackgroundImage: analyticsStyle.backgroundImage,
        missionColor: missionStyle.color,
        historyColor: historyStyle.color,
        analyticsColor: analyticsStyle.color,
        panelsDisabled: panels.disabled,
      };
    });

    const initial = await routeStyles();
    expect(initial.missionCurrent).toBe('page');
    expect(initial.panelsDisabled).toBe(false);
    expect(initial.historyCurrent).toBeNull();
    expect(initial.analyticsCurrent).toBeNull();
    expect(initial.missionBackgroundImage).not.toBe('none');
    expect(initial.historyBackgroundImage).toBe('none');
    expect(initial.analyticsBackgroundImage).toBe('none');
    expect(initial.missionColor).toBe(darkActiveColor);

    await page.locator('#history-route-btn').click();
    await expect.poll(async () => (await routeStyles()).historyColor).toBe(darkActiveColor);
    const darkHistory = await routeStyles();
    expect(darkHistory.missionCurrent).toBeNull();
    expect(darkHistory.historyCurrent).toBe('page');
    expect(darkHistory.analyticsCurrent).toBeNull();
    expect(darkHistory.panelsDisabled).toBe(true);
    expect(darkHistory.missionBackgroundImage).toBe('none');
    expect(darkHistory.historyBackgroundImage).not.toBe('none');
    expect(darkHistory.analyticsBackgroundImage).toBe('none');
    expect(darkHistory.historyBackgroundImage).toBe(initial.missionBackgroundImage);
    expect(darkHistory.historyColor).toBe(initial.missionColor);

    await page.locator('#theme-btn').click();
    await expect.poll(async () => (await routeStyles()).historyColor).toBe(lightActiveColor);
    const lightHistory = await routeStyles();
    expect(lightHistory.historyCurrent).toBe('page');
    expect(lightHistory.historyBackgroundImage).not.toBe('none');
    expect(lightHistory.historyColor).toBe(lightActiveColor);
    expect(lightHistory.panelsDisabled).toBe(true);

    await page.locator('#analytics-route-btn').click();
    await expect.poll(async () => (await routeStyles()).analyticsColor).toBe(lightActiveColor);
    if (await page.locator('#analytics-token-notice.visible').count()) {
      await page.locator('#analytics-token-ack').click();
    }
    const lightAnalytics = await routeStyles();
    expect(lightAnalytics.analyticsCurrent).toBe('page');
    expect(lightAnalytics.missionCurrent).toBeNull();
    expect(lightAnalytics.historyCurrent).toBeNull();
    expect(lightAnalytics.panelsDisabled).toBe(true);
    expect(lightAnalytics.analyticsBackgroundImage).not.toBe('none');
    expect(lightAnalytics.analyticsBackgroundImage).toBe(lightHistory.historyBackgroundImage);

    await page.locator('#mission-route-btn').click();
    await expect.poll(async () => (await routeStyles()).missionColor).toBe(lightActiveColor);
    const lightMission = await routeStyles();
    expect(lightMission.missionCurrent).toBe('page');
    expect(lightMission.historyCurrent).toBeNull();
    expect(lightMission.analyticsCurrent).toBeNull();
    expect(lightMission.panelsDisabled).toBe(false);
    expect(lightMission.missionBackgroundImage).not.toBe('none');
    expect(lightMission.historyBackgroundImage).toBe('none');
    expect(lightMission.missionBackgroundImage).toBe(lightHistory.historyBackgroundImage);
    expect(lightMission.missionColor).toBe(lightHistory.historyColor);
  });

  test('history route defaults to Overview and exposes Daily Log tab', async ({ page }) => {
    await page.locator('#history-route-btn').click();
    await expect(page.locator('#history-overview-tab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#history-flight-log-tab')).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#history-overview-panel')).toBeVisible();
    await expect(page.locator('#history-flight-log-panel')).toBeHidden();

    await page.locator('#history-flight-log-tab').click();
    await expect(page.locator('#history-overview-tab')).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#history-flight-log-tab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#history-overview-panel')).toBeHidden();
    await expect(page.locator('#history-flight-log-panel')).toBeVisible();
  });

  test('analytics chat route renders grounded fixture artifacts', async ({ page }) => {
    await page.evaluate(() => localStorage.removeItem('cmc_analytics_prompt_panel_collapsed'));
    await page.evaluate(() => {
      (window as any).__analyticsChatFixture = {
        status: {
          available: true,
          session_count: 3,
          event_count: 12,
          privacy_summary: 'Fixture analytics excludes prompts, args, output, paths, and diffs.',
          warnings: [],
        },
        chat: {
          answer: 'I found a token hotspot in Commands and a repeated failure pattern.',
          artifacts: [
            {
              kind: 'table',
              title: 'Tool Failures',
              columns: ['Tool', 'Category', 'Failures'],
              rows: [['github-mcp-server-get_file_contents', 'mcp', '20']],
            },
            {
              kind: 'chart',
              title: 'Token Trend',
              points: [
                { local_day: '2026-05-29', output_tokens: 1200, tool_calls: 4 },
                { local_day: '2026-05-30', output_tokens: 2400, tool_calls: 6 },
              ],
            },
            {
              kind: 'table',
              title: 'Model Shifts',
              columns: ['Model', 'Current Turns', 'Previous Turns', 'Delta Turns'],
              rows: [['gpt-5.5', '5573', '4126507', '+36012649']],
            },
            {
              kind: 'table',
              title: 'Tool and Failure Changes',
              columns: ['Tool', 'Current Calls/Failures', 'Previous Calls/Failures', 'Delta Calls/Failures'],
              rows: [['github-mcp-server-get_file_contents', '247', '298', '-51']],
            },
            {
              kind: 'cards',
              title: 'Recommendations',
              cards: [
                { title: 'Review Repeated Tool Failures', body: 'Commands failed twice.', severity: 'review', metric: 'tool_failures' },
                { title: 'Investigate Token Hotspot', body: 'Build Mission Control produced 2400 output tokens.', severity: 'review', metric: 'output_tokens' },
                { title: 'Model Mix Context', body: 'gpt-5.5 appears most often in this range.', severity: 'info', metric: 'model_mix' },
              ],
            },
            {
              kind: 'mcp_server_usage',
              title: 'MCP Server Usage',
              description: 'Fixture MCP usage details.',
              columns: ['Server', 'Enabled', 'Registered tools', 'Used tools', 'Calls', 'Failures', 'Avg duration', 'Top tools'],
              rows: [
                ['github-mcp-server', 'on', '4', '2', '9', '1', '120 ms', 'search_code (6), get_file_contents (3)', '1'],
                ['playwright', 'off', '8', '0', '0', '0', 'n/a', 'No calls in range', '1'],
              ],
            },
          ],
          caveats: ['Active window is estimated.'],
        },
      };
    });

    await page.locator('#analytics-route-btn').click();
    if (await page.locator('#analytics-token-notice.visible').count()) {
      await page.locator('#analytics-token-ack').click();
    }
    await expect(page.locator('body')).toHaveClass(/analytics-route/);
    await expect(page.locator('#analytics-chat-title')).toHaveText('Mission Analytics Chat');
    await expect(page.locator('#analytics-chat-status')).toContainText('Ready');
    await expect(page.locator('.analytics-chat-subtitle')).toHaveCount(0);
    await expect(page.locator('#analytics-chat-privacy')).toHaveCount(0);
    await expect(page.locator('#game')).toBeHidden();
    await expect(page.locator('#analytics-chat-transcript .analytics-message-label')).toHaveCount(0);
    await expect(page.locator('#analytics-chat-suggestions')).toContainText('Ask a question and I\'ll answer from local derived metrics');
    await expect(page.locator('#analytics-chat-suggestions')).toContainText('What\'s my MCP server usage?');
    await expect(page.locator('#analytics-chat-transcript')).not.toContainText('Ask a question and I\'ll answer from local derived metrics');
    const layout = await page.evaluate(() => {
      const input = document.querySelector('#analytics-chat-input') as HTMLElement;
      const submit = document.querySelector('#analytics-chat-submit') as HTMLElement;
      const newChat = document.querySelector('#analytics-chat-new') as HTMLElement;
      const form = document.querySelector('#analytics-chat-form') as HTMLElement;
      const transcript = document.querySelector('#analytics-chat-transcript') as HTMLElement;
      const screen = document.querySelector('#analytics-chat-screen') as HTMLElement;
      return {
        input: input.getBoundingClientRect().toJSON(),
        submit: submit.getBoundingClientRect().toJSON(),
        newChat: newChat.getBoundingClientRect().toJSON(),
        form: form.getBoundingClientRect().toJSON(),
        newChatText: newChat.textContent?.trim(),
        newChatInsideForm: Boolean(newChat.closest('form')),
        transcript: transcript.getBoundingClientRect().toJSON(),
        screenOverflow: getComputedStyle(screen).overflow,
        transcriptOverflowY: getComputedStyle(transcript).overflowY,
      };
    });
    expect(layout.input.height).toBeLessThanOrEqual(56);
    expect(layout.submit.height).toBeLessThanOrEqual(56);
    expect(layout.input.width).toBeGreaterThan(300);
    expect(layout.newChatText).toBe('New Chat');
    expect(layout.newChatInsideForm).toBe(false);
    expect(layout.newChat.height).toBeLessThanOrEqual(56);
    expect(layout.newChat.x).toBeGreaterThan(layout.form.x + layout.form.width);
    expect(layout.transcript.height).toBeGreaterThan(200);
    expect(layout.screenOverflow).toBe('hidden');
    expect(layout.transcriptOverflowY).toBe('auto');
    await expect(page.locator('.analytics-chat-mic')).toBeHidden();

    await page.locator('[data-analytics-prompt]').first().click();
    await expect(page.locator('#analytics-chat-input')).toHaveValue('');
    await expect(page.locator('#analytics-chat-transcript')).toContainText('I found a token hotspot');
    await expect(page.locator('#analytics-chat-transcript')).toContainText('Token Trend');
    await expect(page.locator('#analytics-chat-transcript')).toContainText('Model Shifts');
    await expect(page.locator('.analytics-artifact').filter({ hasText: 'Model Shifts' }).locator('th')).toContainText(['Model', 'CurrentTurns', 'PreviousTurns', 'DeltaTurns']);
    await expect(page.locator('#analytics-chat-transcript')).toContainText('5,573');
    await expect(page.locator('#analytics-chat-transcript')).toContainText('4,126,507');
    await expect(page.locator('#analytics-chat-transcript')).toContainText('+36,012,649');
    await expect(page.locator('#analytics-chat-transcript')).toContainText('Review Repeated Tool Failures');
    await expect(page.locator('#analytics-chat-transcript')).toContainText('MCP Server Usage');
    await expect(page.locator('.analytics-table-mcp')).toContainText('github-mcp-server');
    await expect(page.locator('.analytics-table-mcp thead')).toContainText('Registered Tools');
    await expect(page.locator('.analytics-table-mcp thead')).toContainText('Avg Duration');
    await expect(page.locator('.analytics-table-mcp')).not.toContainText('Context impact');
    await expect(page.locator('.analytics-mcp-switch.on')).toContainText('On');
    await expect(page.locator('.analytics-mcp-switch.off')).toContainText('Off');
    await expect(page.locator('.analytics-table-tool-failures')).toContainText('github-mcp-server-get_file_contents');
    const toolChangeHeaders = page.locator('.analytics-artifact').filter({ hasText: 'Tool and Failure Changes' }).locator('.analytics-table-comparison th .analytics-heading-stack');
    await expect(toolChangeHeaders).toHaveCount(3);
    await expect(toolChangeHeaders).toContainText(['CurrentCalls /Failures', 'PreviousCalls /Failures', 'DeltaCalls /Failures']);
    const artifactTitles = await page.locator('.analytics-artifact h3').allTextContents();
    expect(artifactTitles.slice(-2)).toEqual(['Tool Failures', 'Tool and Failure Changes']);
    await expect(page.locator('#analytics-chat-transcript')).toContainText('Active window is estimated.');
    await expect(page.locator('#analytics-chat-suggestions')).toBeVisible();
    await expect(page.locator('.analytics-card')).toHaveCount(3);
    await expect.poll(() => page.locator('#analytics-chat-transcript').evaluate((el) => {
      const transcript = el as HTMLElement;
      return Math.round(transcript.scrollTop + transcript.clientHeight - transcript.scrollHeight);
    })).toBeGreaterThanOrEqual(-80);

    await page.locator('#analytics-chat-input').fill('second prompt');
    await page.locator('#analytics-chat-form').evaluate((form) => (form as HTMLFormElement).requestSubmit());
    await expect(page.locator('#analytics-chat-transcript .analytics-message-label')).toHaveCount(4);
    await expect.poll(() => page.locator('#analytics-chat-transcript').evaluate((el) => {
      const transcript = el as HTMLElement;
      return Math.round(transcript.scrollTop + transcript.clientHeight - transcript.scrollHeight);
    })).toBeGreaterThanOrEqual(-80);

    await page.locator('#analytics-chat-input').fill('draft question');
    await page.locator('#analytics-chat-new').click();
    await expect(page.locator('#analytics-chat-input')).toHaveValue('');
    await expect(page.locator('#analytics-chat-transcript')).not.toContainText('I found a token hotspot');

    await page.locator('[data-analytics-prompt-toggle]').click();
    await expect(page.locator('#analytics-chat-suggestions')).toBeVisible();
    await expect(page.locator('#analytics-chat-suggestions')).toContainText('Ask a question');
    await expect(page.locator('.analytics-chat-prompt-list')).toBeHidden();
    await page.locator('[data-analytics-prompt-toggle]').click();
    await expect(page.locator('.analytics-chat-prompt-list')).toBeVisible();
    await page.locator('[data-analytics-prompt-toggle]').click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cmc_analytics_prompt_panel_collapsed'))).toBe('1');
    await page.locator('#mission-route-btn').click();
    await page.locator('#analytics-route-btn').click();
    await expect(page.locator('#analytics-chat-suggestions')).toBeVisible();
    await expect(page.locator('.analytics-chat-prompt-list')).toBeHidden();
    await page.reload();
    await waitForGame(page);
    await expect(page.locator('#analytics-chat-suggestions')).toBeVisible();
    await expect(page.locator('.analytics-chat-prompt-list')).toBeHidden();
  });

  test('analytics chat shows background indexing status', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__analyticsChatFixture = {
        status: {
          available: false,
          ingestion_running: true,
          session_count: 0,
          event_count: 0,
          privacy_summary: 'Indexing local Copilot CLI history.',
          warnings: ['Analyzing Copilot history in the background.'],
        },
      };
    });

    await page.locator('#analytics-route-btn').click();
    await expect(page.locator('#analytics-chat-status')).toContainText('Analyzing Copilot history');
  });

  test('analytics chat lists MCP tool calls while waiting', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__analyticsChatFixture = {
        status: {
          available: true,
          session_count: 1,
          event_count: 1,
          privacy_summary: 'Fixture analytics.',
          warnings: [],
        },
        chat: new Promise((resolve) => {
          setTimeout(() => resolve({ answer: 'Prompt analysis complete.', artifacts: [], caveats: [] }), 1500);
        }),
      };
    });

    await page.locator('#analytics-route-btn').click();
    if (await page.locator('#analytics-token-notice.visible').count()) {
      await page.locator('#analytics-token-ack').click();
    }
    await page.locator('#analytics-chat-input').fill('Analyze my recent prompts.');
    await page.locator('#analytics-chat-form').evaluate((form) => (form as HTMLFormElement).requestSubmit());
    await page.evaluate(() => {
      (window as any).__cmcAnalyticsChatToolStarted('list_prompt_samples');
      (window as any).__cmcAnalyticsChatToolStarted('summarize_prompt_patterns');
    });
    await expect(page.locator('.analytics-message.assistant .analytics-label-spinner')).toBeVisible();
    await expect(page.locator('#analytics-chat-transcript')).toContainText('Calling MCP tool list_prompt_samples');
    await expect(page.locator('#analytics-chat-transcript')).toContainText('Calling MCP tool summarize_prompt_patterns');
    await expect(page.locator('#analytics-chat-transcript')).toContainText('Prompt analysis complete.');
    await expect(page.locator('.analytics-message.assistant .analytics-label-spinner')).toHaveCount(0);
  });

  test('analytics chat renders lightweight markdown bullets', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__analyticsChatFixture = {
        status: {
          available: true,
          session_count: 1,
          event_count: 1,
          privacy_summary: 'Fixture analytics.',
          warnings: [],
        },
        chat: {
          answer: 'Try this pattern:\n- state the goal\n- add constraints\n\nThen ask for validation.',
          artifacts: [],
          caveats: [],
        },
      };
    });

    await page.locator('#analytics-route-btn').click();
    if (await page.locator('#analytics-token-notice.visible').count()) {
      await page.locator('#analytics-token-ack').click();
    }
    await page.locator('#analytics-chat-input').fill('How can I improve my prompts?');
    await page.locator('#analytics-chat-form').evaluate((form) => (form as HTMLFormElement).requestSubmit());
    await expect(page.locator('#analytics-chat-transcript')).toContainText('Try this pattern:');
    await expect(page.locator('.analytics-message-body ul li')).toHaveText(['state the goal', 'add constraints']);
    await expect(page.locator('.analytics-message-body p')).toContainText(['Try this pattern:', 'Then ask for validation.']);
  });

  test('analytics chat shows one-time Copilot token notice and help reopens it', async ({ page }) => {
    await page.evaluate(() => localStorage.removeItem('cmc_analytics_token_notice_seen'));

    await page.locator('#analytics-route-btn').click();
    await expect(page.locator('#analytics-token-notice')).toHaveClass(/visible/);
    await expect(page.locator('#analytics-token-title')).toHaveText('Welcome to Mission Analytics Chat');
    await expect(page.locator('#analytics-token-notice')).toContainText('will consume Copilot requests and tokens');
    await expect(page.locator('#analytics-token-notice')).toContainText('Mission Control Insights tools');

    await page.locator('#analytics-token-ack').click();
    await expect(page.locator('#analytics-token-notice')).not.toHaveClass(/visible/);
    await page.locator('#analytics-token-help').click();
    await expect(page.locator('#analytics-token-notice')).toHaveClass(/visible/);
    await page.locator('#analytics-token-ack').click();
    await expect(page.locator('#analytics-token-notice')).not.toHaveClass(/visible/);
    await page.locator('#mission-route-btn').click();
    await page.locator('#analytics-route-btn').click();
    await expect(page.locator('#analytics-token-notice')).not.toHaveClass(/visible/);
    await page.locator('#analytics-token-help').click();
    await expect(page.locator('#analytics-token-notice')).toHaveClass(/visible/);
  });

  test('history dashboard stays cached when returning to home', async ({ page }) => {
    await page.locator('#history-route-btn').click();
    await expect.poll(() => page.locator('#history-content').evaluate((el) => el.innerHTML.length)).toBeGreaterThan(0);
    await expect(page.locator('body')).toHaveClass(/history-route/);
    const renderedHistory = await page.locator('#history-content').evaluate((el) => el.innerHTML);
    const renderedKpis = await page.locator('#history-kpi-summary').evaluate((el) => el.innerHTML);

    await page.locator('#mission-route-btn').click();
    await expect(page.locator('body')).not.toHaveClass(/history-route/);
    await expect.poll(() => page.locator('#history-content').evaluate((el) => el.innerHTML)).toBe(renderedHistory);
    await expect.poll(() => page.locator('#history-kpi-summary').evaluate((el) => el.innerHTML)).toBe(renderedKpis);

    await page.locator('#history-route-btn').click();
    await expect(page.locator('#history-content')).not.toContainText('Scanning Copilot CLI history');
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

  test('update banner can be shown and dismissed', async ({ page }) => {
    await expect(page.locator('#update-banner')).not.toBeVisible();
    await page.evaluate(() => (window as any).__cmcUpdateAvailable('99.0.0'));
    await expect(page.locator('#update-banner')).toBeVisible();
    await expect(page.locator('#update-version')).toHaveText('v99.0.0');
    await page.locator('#update-dismiss').click();
    await expect(page.locator('#update-banner')).not.toBeVisible();
  });

  test('settings dialog shows app theme selection', async ({ page }) => {
    await expect(page.locator('#settings-overlay')).not.toBeVisible();
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await expect(page.locator('#settings-title')).toHaveText('Settings');
    await expect(page.locator('#app-theme-select option')).toHaveText(['Space', 'Medieval Kingdom']);
    await expect(page.locator('#reset-btn')).toBeVisible();
    await expect(page.locator('#reset-btn')).toHaveAttribute('aria-label', 'Reset visible activity counters');
    await expect(page.locator('#reset-btn svg')).toBeVisible();
    await expect(page.locator('#app-theme-select')).toHaveValue('space');
    await expect(page.locator('#app-theme-select option:checked')).toHaveText('Space');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cmc_app_theme'))).toBe('space');
    await page.locator('#app-theme-select').selectOption('medieval');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cmc_app_theme'))).toBe('medieval');
    await expect.poll(() => page.evaluate(() => {
      const scene = (window as any).__phaserGame?.scene?.getScene?.('mission-control') as any;
      const frames = (scene?.textObjects ?? [])
        .filter((obj: any) => obj?.texture?.key)
        .map((obj: any) => ({ texture: obj.texture.key, frame: obj.frame?.name }));
      return {
        appTheme: scene?.appTheme,
        hasMedievalCastle: frames.some((frame: any) => frame.texture === 'medieval' && frame.frame === 'large_castle_3'),
        hasMedievalEditsHouse: frames.some((frame: any) => frame.texture === 'medieval' && frame.frame === 'timber_house_large'),
        hasMedievalCommandsWizard: frames.some((frame: any) => frame.texture === 'medieval' && frame.frame === 'blue_mage'),
        hasMedievalHooksDagger: frames.some((frame: any) => frame.texture === 'medieval' && frame.frame === 'dagger_blue'),
        hasMedievalHooksCrate: frames.some((frame: any) => frame.texture === 'medieval' && frame.frame === 'rune_crate'),
        hasMedievalSubagentsWarrior: frames.some((frame: any) => frame.texture === 'medieval' && frame.frame === 'dark_knight'),
        hasMedievalDragon: frames.some((frame: any) => frame.texture === 'medieval' && frame.frame === 'dragon'),
        hasMedievalCatapult: frames.some((frame: any) => frame.texture === 'medieval' && frame.frame === 'catapult'),
        hasMedievalSword: frames.some((frame: any) => frame.texture === 'medieval' && frame.frame === 'sword_silver'),
        hasRetiredPeopleSectorArt: frames.some((frame: any) => frame.texture === 'medieval' && ['queen', 'wizard_man'].includes(frame.frame)),
      };
    })).toEqual({
      appTheme: 'medieval',
      hasMedievalCastle: true,
      hasMedievalEditsHouse: true,
      hasMedievalCommandsWizard: true,
      hasMedievalHooksDagger: true,
      hasMedievalHooksCrate: false,
      hasMedievalSubagentsWarrior: true,
      hasMedievalDragon: false,
      hasMedievalCatapult: false,
      hasMedievalSword: false,
      hasRetiredPeopleSectorArt: false,
    });
    await page.locator('#app-theme-select').selectOption('space');
    await expect.poll(() => page.evaluate(() => {
      const scene = (window as any).__phaserGame?.scene?.getScene?.('mission-control') as any;
      const frames = (scene?.textObjects ?? [])
        .filter((obj: any) => obj?.texture?.key)
        .map((obj: any) => ({ texture: obj.texture.key, frame: obj.frame?.name }));
      return {
        appTheme: scene?.appTheme,
        hasSpaceOutpost: frames.some((frame: any) => frame.texture === 'mc' && frame.frame === 'outpost_domed_island'),
      };
    })).toEqual({ appTheme: 'space', hasSpaceOutpost: true });
    await page.locator('#settings-done').click();
    await expect(page.locator('#settings-overlay')).not.toBeVisible();
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

test.describe('Agent Mission Control loading splash', () => {
  test('keeps the splash visible until the initial activity scan finishes', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__cmcSplashMinMs = 0;
      let resolveActivity: (activity: unknown) => void = () => {};
      const activityPromise = new Promise((resolve) => { resolveActivity = resolve; });
      (window as any).__resolveInitialActivity = () => resolveActivity({
        available: false,
        source: 'copilot',
        scanned_sessions: 0,
        active_sessions: 0,
        total_events: 0,
        total_tool_calls: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        sessions: [],
        tools: [],
        recent_events: [],
        alerts: [],
        generated_at_ms: Date.now(),
      });
      (window as any).__TAURI_INTERNALS__ = { invoke: () => activityPromise };
    });
    await page.goto(GAME_URL);
    await waitForGame(page);

    await expect(page.locator('body')).not.toHaveClass(/dashboard-ready/);
    await expect(page.locator('body')).not.toHaveClass(/dashboard-splash-hidden/);
    await expect(page.locator('#dashboard-loading')).toBeVisible();

    await page.evaluate(() => (window as any).__resolveInitialActivity());

    await expect(page.locator('body')).toHaveClass(/dashboard-ready/);
    await expect(page.locator('body')).toHaveClass(/dashboard-splash-hidden/);
  });

  test('keeps the splash visible after the dashboard is ready', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__cmcSplashMinMs = 60_000; });
    await page.goto(GAME_URL);
    await waitForGame(page);

    await expect(page.locator('body')).toHaveClass(/dashboard-ready/);
    await expect(page.locator('body')).not.toHaveClass(/dashboard-splash-hidden/);
    await expect(page.locator('#dashboard-loading')).toBeVisible();
  });
});
