import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { GAME_URL, waitForGame } from './helpers';

function signalBuckets() {
  const starts = [0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 2, 0, 2, 4, 7, 11];
  return starts.map((launches, index) => {
    const startMs = Date.parse('2026-05-20T08:00:00Z') + index * 60 * 60 * 1000;
    const events = launches * 8 + (index % 3);
    return {
      start: new Date(startMs).toISOString().replace('.000Z', 'Z'),
      label: `${String(new Date(startMs).getUTCHours()).padStart(2, '0')}:00Z`,
      event_count: events,
      launch_count: launches,
      failure_count: index === 21 || index === 23 ? 1 : 0,
      active_sessions: launches > 0 ? Math.min(3, Math.max(1, Math.ceil(launches / 4))) : 0,
      intensity: launches ? launches / 11 : 0,
    };
  });
}

function agentStart(timestamp: string, id: string) {
  return {
    tool: 'task',
    category: 'delegates',
    timestamp,
    success: true,
    call_id: id,
  };
}

const MISSION_FIXTURE = {
  available: true,
  source: 'playwright-fixture',
  scanned_sessions: 3,
  active_sessions: 2,
  total_events: 184,
  total_tool_calls: 47,
  total_input_tokens: 3300,
  total_output_tokens: 8120,
  sessions: [
    { id: 'alpha123', title: 'Build Mission Control', repository: 'copilot-mission-control', branch: 'main', updated_at: '', is_active: true, status: 'working', event_count: 82, tool_count: 23, write_count: 8, read_count: 9, command_count: 4, web_count: 1, task_count: 3, delegates_count: 1, skills_count: 2, court_count: 4, mcp_count: 1, hooks_count: 3, error_count: 0, input_tokens: 1600, output_tokens: 4200, last_tool: 'apply_patch', last_event_kind: 'tool.execution_start', last_event_category: 'edits', stale_seconds: 12, recent_tool_calls: [
      agentStart('2026-05-21T07:18:00Z', 'alpha-agent-1'),
    ], token_checkpoints: [
      { timestamp: '2026-05-21T07:11:00Z', input_tokens: 100, output_tokens: 200 },
      { timestamp: '2026-05-21T07:13:00Z', input_tokens: 400, output_tokens: 900 },
      { timestamp: '2026-05-21T07:15:00Z', input_tokens: 1600, output_tokens: 4200 },
    ] },
    { id: 'beta4567', title: 'Review Tests', repository: 'copilot-mission-control', branch: 'main', updated_at: '', is_active: true, status: 'needs-attention', event_count: 64, tool_count: 17, write_count: 2, read_count: 7, command_count: 6, web_count: 0, task_count: 5, delegates_count: 2, skills_count: 3, court_count: 1, mcp_count: 4, hooks_count: 2, error_count: 1, input_tokens: 1200, output_tokens: 2920, last_tool: 'bash', last_event_kind: 'tool.execution_complete', last_event_category: 'alert', stale_seconds: 25, recent_tool_calls: [
      agentStart('2026-05-21T07:16:00Z', 'beta-agent-1'),
      agentStart('2026-05-21T07:17:00Z', 'beta-agent-2'),
      agentStart('2026-05-21T07:18:00Z', 'beta-agent-3'),
      agentStart('2026-05-21T07:19:00Z', 'beta-agent-4'),
      agentStart('2026-05-21T06:45:00Z', 'beta-agent-5'),
    ], token_checkpoints: [
      { timestamp: '2026-05-21T07:14:00Z', input_tokens: 1200, output_tokens: 2920 },
    ] },
    { id: 'gamma890', title: 'Research UI', repository: 'docs', branch: 'main', updated_at: '', is_active: false, status: 'idle', event_count: 38, tool_count: 7, write_count: 0, read_count: 3, command_count: 0, web_count: 4, task_count: 0, delegates_count: 0, skills_count: 0, court_count: 0, mcp_count: 0, hooks_count: 0, error_count: 0, input_tokens: 500, output_tokens: 1000, last_tool: 'web_fetch', last_event_kind: 'tool.execution_start', last_event_category: 'signal', stale_seconds: 900, recent_turns: [
      { id: 'gamma-turn-1', started_at: '2026-05-21T07:10:00Z', ended_at: '2026-05-21T07:11:00Z', status: 'complete', tool_count: 2, tools: ['web_fetch'], failure_count: 0, categories: ['signal'], output_tokens: 600 },
      { id: 'gamma-turn-2', started_at: '2026-05-21T07:11:30Z', ended_at: '2026-05-21T07:12:00Z', status: 'complete', tool_count: 1, tools: ['view'], failure_count: 0, categories: ['library'], output_tokens: 1000 },
    ] },
  ],
  tools: [
    { name: 'view', category: 'library', count: 14 },
    { name: 'apply_patch', category: 'edits', count: 8 },
    { name: 'bash', category: 'terminal', count: 7 },
    { name: 'rg', category: 'library', count: 5 },
    { name: 'task', category: 'delegates', count: 3 },
    { name: 'web_fetch', category: 'signal', count: 4 },
  ],
  recent_events: [
    { session_id: 'alpha123', timestamp: '2026-05-21T07:14:30Z', kind: 'assistant.turn_start', tool: 'thinking', category: 'thinking', success: true },
    { session_id: 'alpha123', timestamp: '2026-05-21T07:15:00Z', kind: 'tool.execution_start', tool: 'apply_patch', category: 'edits', success: true },
    { session_id: 'beta4567', timestamp: '2026-05-21T07:13:30Z', kind: 'assistant.turn_start', tool: 'thinking', category: 'thinking', success: true },
    { session_id: 'beta4567', timestamp: '2026-05-21T07:14:00Z', kind: 'tool.execution_complete', tool: 'tool complete', category: 'alert', success: false },
    { session_id: 'alpha123', timestamp: '2026-05-21T07:12:30Z', kind: 'assistant.turn_start', tool: 'thinking', category: 'thinking', success: true },
    { session_id: 'alpha123', timestamp: '2026-05-21T07:13:00Z', kind: 'tool.execution_start', tool: 'view', category: 'library', success: true },
    { session_id: 'gamma890', timestamp: '2026-05-21T07:12:00Z', kind: 'tool.execution_start', tool: 'web_fetch', category: 'signal', success: true },
  ],
  alerts: ['1 recent tool failure needs review.'],
  history: {
    generated_at_ms: Date.parse('2026-05-21T07:20:00Z'),
    last_activity_at: '2026-05-21T07:15:00Z',
    event_count: 184,
    tool_count: 47,
    failure_count: 2,
    activity_24h: [
      { start: '2026-05-21T04:00:00Z', label: '4a', event_count: 12, launch_count: 0, failure_count: 0, active_sessions: 1 },
      { start: '2026-05-21T05:00:00Z', label: '5a', event_count: 31, launch_count: 1, failure_count: 1, active_sessions: 2 },
      { start: '2026-05-21T06:00:00Z', label: '6a', event_count: 54, launch_count: 2, failure_count: 0, active_sessions: 2 },
      { start: '2026-05-21T07:00:00Z', label: '7a', event_count: 87, launch_count: 3, failure_count: 1, active_sessions: 3 },
    ],
    activity_7d: [
      { start: '2026-05-18T00:00:00Z', label: 'Mon', event_count: 42, failure_count: 0, active_sessions: 1 },
      { start: '2026-05-19T00:00:00Z', label: 'Tue', event_count: 61, failure_count: 1, active_sessions: 2 },
      { start: '2026-05-20T00:00:00Z', label: 'Wed', event_count: 39, failure_count: 0, active_sessions: 2 },
      { start: '2026-05-21T00:00:00Z', label: 'Thu', event_count: 184, failure_count: 2, active_sessions: 3 },
    ],
    model_mix: [
      { name: 'gpt-5.5', count: 6, percent: 75 },
      { name: 'unknown', count: 2, percent: 25 },
    ],
    category_mix: [
      { name: 'library', count: 18, percent: 39.1 },
      { name: 'edits', count: 10, percent: 21.7 },
      { name: 'hooks', count: 5, percent: 10.9 },
      { name: 'alert', count: 2, percent: 4.3 },
    ],
    top_tools: [
      { name: 'view', count: 14, percent: 29.8 },
      { name: 'apply_patch', count: 8, percent: 17 },
      { name: 'bash', count: 7, percent: 14.9 },
    ],
    recent_sessions: [
      { id: 'alpha123', title: 'Build Mission Control', repository: 'copilot-mission-control', branch: 'main', updated_at: '2026-05-21T07:15:00Z', is_active: true, status: 'working', event_count: 82, tool_count: 23, error_count: 0, turn_count: 4, input_tokens: 1600, output_tokens: 4200, last_model: 'gpt-5.5', last_tool: 'apply_patch' },
      { id: 'beta4567', title: 'Review Tests', repository: 'copilot-mission-control', branch: 'main', updated_at: '2026-05-21T07:14:00Z', is_active: true, status: 'needs-attention', event_count: 64, tool_count: 17, error_count: 2, turn_count: 3, input_tokens: 1200, output_tokens: 2920, last_model: 'gpt-5.5', last_tool: 'bash' },
      { id: 'gamma890', title: 'Research UI', repository: 'docs', branch: 'main', updated_at: '2026-05-21T07:12:00Z', is_active: false, status: 'idle', event_count: 38, tool_count: 7, error_count: 0, turn_count: 1, input_tokens: 500, output_tokens: 1000, last_model: 'unknown', last_tool: 'web_fetch' },
    ],
    high_activity_sessions: [
      { id: 'alpha123', title: 'Build Mission Control', repository: 'copilot-mission-control', branch: 'main', updated_at: '2026-05-21T07:15:00Z', is_active: true, status: 'working', event_count: 82, tool_count: 23, error_count: 0, turn_count: 4, input_tokens: 1600, output_tokens: 4200, last_model: 'gpt-5.5', last_tool: 'apply_patch' },
      { id: 'beta4567', title: 'Review Tests', repository: 'copilot-mission-control', branch: 'main', updated_at: '2026-05-21T07:14:00Z', is_active: true, status: 'needs-attention', event_count: 64, tool_count: 17, error_count: 2, turn_count: 3, input_tokens: 1200, output_tokens: 2920, last_model: 'gpt-5.5', last_tool: 'bash' },
      { id: 'gamma890', title: 'Research UI', repository: 'docs', branch: 'main', updated_at: '2026-05-21T07:12:00Z', is_active: false, status: 'idle', event_count: 38, tool_count: 7, error_count: 0, turn_count: 1, input_tokens: 500, output_tokens: 1000, last_model: 'unknown', last_tool: 'web_fetch' },
    ],
    recent_failures: [
      { session_id: 'beta4567', timestamp: '2026-05-21T07:14:00Z', kind: 'tool.execution_complete', tool: 'bash', category: 'alert' },
      { session_id: 'beta4567', timestamp: '2026-05-21T07:13:30Z', kind: 'hook.end', tool: 'postToolUse', category: 'hooks' },
    ],
    session_scopes: [
      {
        session_id: 'alpha123',
        label: 'Build Mission Control',
        generated_at_ms: Date.parse('2026-05-21T07:20:00Z'),
        last_activity_at: '2026-05-21T07:15:00Z',
        event_count: 82,
        tool_count: 23,
        failure_count: 0,
        activity_24h: [
          { start: '2026-05-21T05:00:00Z', label: '5a', event_count: 12, launch_count: 0, failure_count: 0, active_sessions: 1 },
          { start: '2026-05-21T06:00:00Z', label: '6a', event_count: 24, launch_count: 1, failure_count: 0, active_sessions: 1 },
          { start: '2026-05-21T07:00:00Z', label: '7a', event_count: 46, launch_count: 1, failure_count: 0, active_sessions: 1 },
        ],
        activity_7d: [
          { start: '2026-05-19T00:00:00Z', label: 'Tue', event_count: 16, failure_count: 0, active_sessions: 1 },
          { start: '2026-05-20T00:00:00Z', label: 'Wed', event_count: 20, failure_count: 0, active_sessions: 1 },
          { start: '2026-05-21T00:00:00Z', label: 'Thu', event_count: 46, failure_count: 0, active_sessions: 1 },
        ],
        model_mix: [{ name: 'gpt-5.5', count: 4, percent: 100 }],
        category_mix: [
          { name: 'library', count: 9, percent: 45 },
          { name: 'edits', count: 7, percent: 35 },
        ],
        top_tools: [
          { name: 'view', count: 9, percent: 56.3 },
          { name: 'apply_patch', count: 7, percent: 43.8 },
        ],
        recent_sessions: [
          { id: 'alpha123', title: 'Build Mission Control', repository: 'copilot-mission-control', branch: 'main', updated_at: '2026-05-21T07:15:00Z', is_active: true, status: 'working', event_count: 82, tool_count: 23, error_count: 0, turn_count: 4, input_tokens: 1600, output_tokens: 4200, last_model: 'gpt-5.5', last_tool: 'apply_patch' },
        ],
        high_activity_sessions: [
          { id: 'alpha123', title: 'Build Mission Control', repository: 'copilot-mission-control', branch: 'main', updated_at: '2026-05-21T07:15:00Z', is_active: true, status: 'working', event_count: 82, tool_count: 23, error_count: 0, turn_count: 4, input_tokens: 1600, output_tokens: 4200, last_model: 'gpt-5.5', last_tool: 'apply_patch' },
        ],
        recent_failures: [],
      },
      {
        session_id: 'beta4567',
        label: 'Review Tests',
        generated_at_ms: Date.parse('2026-05-21T07:20:00Z'),
        last_activity_at: '2026-05-21T07:14:00Z',
        event_count: 64,
        tool_count: 17,
        failure_count: 2,
        activity_24h: [
          { start: '2026-05-21T05:00:00Z', label: '5a', event_count: 19, launch_count: 1, failure_count: 1, active_sessions: 1 },
          { start: '2026-05-21T06:00:00Z', label: '6a', event_count: 30, launch_count: 2, failure_count: 0, active_sessions: 1 },
          { start: '2026-05-21T07:00:00Z', label: '7a', event_count: 41, launch_count: 1, failure_count: 1, active_sessions: 1 },
        ],
        activity_7d: [
          { start: '2026-05-19T00:00:00Z', label: 'Tue', event_count: 45, failure_count: 1, active_sessions: 1 },
          { start: '2026-05-21T00:00:00Z', label: 'Thu', event_count: 45, failure_count: 2, active_sessions: 1 },
        ],
        model_mix: [{ name: 'gpt-5.5', count: 2, percent: 100 }],
        category_mix: [
          { name: 'terminal', count: 8, percent: 57.1 },
          { name: 'hooks', count: 4, percent: 28.6 },
          { name: 'alert', count: 2, percent: 14.3 },
        ],
        top_tools: [
          { name: 'bash', count: 7, percent: 63.6 },
          { name: 'postToolUse', count: 4, percent: 36.4 },
        ],
        recent_sessions: [
          { id: 'beta4567', title: 'Review Tests', repository: 'copilot-mission-control', branch: 'main', updated_at: '2026-05-21T07:14:00Z', is_active: true, status: 'needs-attention', event_count: 64, tool_count: 17, error_count: 2, turn_count: 3, input_tokens: 1200, output_tokens: 2920, last_model: 'gpt-5.5', last_tool: 'bash' },
        ],
        high_activity_sessions: [
          { id: 'beta4567', title: 'Review Tests', repository: 'copilot-mission-control', branch: 'main', updated_at: '2026-05-21T07:14:00Z', is_active: true, status: 'needs-attention', event_count: 64, tool_count: 17, error_count: 2, turn_count: 3, input_tokens: 1200, output_tokens: 2920, last_model: 'gpt-5.5', last_tool: 'bash' },
        ],
        recent_failures: [
          { session_id: 'beta4567', timestamp: '2026-05-21T07:14:00Z', kind: 'tool.execution_complete', tool: 'bash', category: 'alert' },
          { session_id: 'beta4567', timestamp: '2026-05-21T07:13:30Z', kind: 'hook.end', tool: 'postToolUse', category: 'hooks' },
        ],
      },
    ],
  },
  activity_signal: {
    generated_at_ms: Date.parse('2026-05-21T07:20:00Z'),
    launches_last_5m: 4,
    launches_last_hour: 11,
    velocity_per_hour: 11,
    peak_velocity_per_hour: 11,
    peak_hour_event_count_24h: 90,
    busiest_hour_label_24h: '07:00Z',
    active_hours_24h: 10,
    hourly_24h: signalBuckets(),
  },
  generated_at_ms: Date.now(),
};

const LONG_TOOL_NAME = 'bash-command-with-a-very-long-safe-label-for-turn-story-truncation';

function expectedJuneSelectedDay() {
  const day = Math.min(new Date().getDate(), 30);
  return `2026-06-${String(day).padStart(2, '0')}`;
}

async function installFixture(page: Page, fixture = MISSION_FIXTURE) {
  await page.addInitScript((fixtureArg) => {
    (window as any).__missionControlFixture = fixtureArg;
  }, fixture);
}

async function installFlightLogFixture(page: Page) {
  await page.addInitScript(() => {
    const calendarDays = [
      { local_day: '2026-05-18', day_number: 18, in_month: true, enabled: true, is_today: false, intensity: 1, sessions: 1, events: 42, turns: 2, tool_calls: 8, failures: 0, input_tokens: 800, output_tokens: 1400, estimated_active_ms: 300000, partial: false, badges: ['Active'], dominant_repo: 'docs', dominant_branch: 'main' },
      { local_day: '2026-05-19', day_number: 19, in_month: true, enabled: true, is_today: false, intensity: 2, sessions: 2, events: 61, turns: 4, tool_calls: 12, failures: 1, input_tokens: 900, output_tokens: 2000, estimated_active_ms: 600000, partial: false, badges: ['Failure', 'Active'], dominant_repo: 'copilot-mission-control', dominant_branch: 'main' },
      { local_day: '2026-05-20', day_number: 20, in_month: true, enabled: false, is_today: false, intensity: 0, sessions: 0, events: 0, turns: 0, tool_calls: 0, failures: 0, input_tokens: 0, output_tokens: 0, estimated_active_ms: 0, partial: false, badges: [] },
      { local_day: '2026-05-21', day_number: 21, in_month: true, enabled: true, is_today: false, intensity: 4, sessions: 3, events: 184, turns: 8, tool_calls: 47, failures: 2, input_tokens: 3300, output_tokens: 8120, estimated_active_ms: 900000, partial: false, badges: ['Failure', 'Token spike', 'MCP'], dominant_repo: 'copilot-mission-control', dominant_branch: 'main' },
      { local_day: '2026-05-22', day_number: 22, in_month: true, enabled: false, is_today: false, intensity: 0, sessions: 0, events: 0, turns: 0, tool_calls: 0, failures: 0, input_tokens: 0, output_tokens: 0, estimated_active_ms: 0, partial: false, badges: [] },
      { local_day: '2026-05-23', day_number: 23, in_month: true, enabled: false, is_today: false, intensity: 0, sessions: 0, events: 0, turns: 0, tool_calls: 0, failures: 0, input_tokens: 0, output_tokens: 0, estimated_active_ms: 0, partial: false, badges: [] },
      { local_day: '2026-06-01', day_number: 1, in_month: true, enabled: true, is_today: false, intensity: 2, sessions: 2, events: 101, turns: 5, tool_calls: 13, failures: 0, input_tokens: 1100, output_tokens: 2200, estimated_active_ms: 600000, partial: false, badges: ['Active'], dominant_repo: 'copilot-mission-control', dominant_branch: 'main' },
      { local_day: '2026-06-02', day_number: 2, in_month: true, enabled: true, is_today: false, intensity: 2, sessions: 2, events: 102, turns: 5, tool_calls: 13, failures: 0, input_tokens: 1100, output_tokens: 2200, estimated_active_ms: 600000, partial: false, badges: ['Active'], dominant_repo: 'copilot-mission-control', dominant_branch: 'main' },
      { local_day: '2026-06-03', day_number: 3, in_month: true, enabled: false, is_today: true, intensity: 0, sessions: 0, events: 0, turns: 0, tool_calls: 0, failures: 0, input_tokens: 0, output_tokens: 0, estimated_active_ms: 0, partial: false, badges: [] },
      { local_day: '2026-06-04', day_number: 4, in_month: true, enabled: false, is_today: false, intensity: 0, sessions: 0, events: 0, turns: 0, tool_calls: 0, failures: 0, input_tokens: 0, output_tokens: 0, estimated_active_ms: 0, partial: false, badges: [] },
      { local_day: '2026-06-05', day_number: 5, in_month: true, enabled: false, is_today: false, intensity: 0, sessions: 0, events: 0, turns: 0, tool_calls: 0, failures: 0, input_tokens: 0, output_tokens: 0, estimated_active_ms: 0, partial: false, badges: [] },
      { local_day: '2026-06-06', day_number: 6, in_month: true, enabled: false, is_today: false, intensity: 0, sessions: 0, events: 0, turns: 0, tool_calls: 0, failures: 0, input_tokens: 0, output_tokens: 0, estimated_active_ms: 0, partial: false, badges: [] },
    ];
    const activeDay = {
      local_day: '2026-05-21',
      totals: [
        { label: 'Sessions', value: 3, exact: true },
        { label: 'Events', value: 184, exact: true },
        { label: 'Turns', value: 8, exact: true },
        { label: 'Tool calls', value: 47, exact: true },
        { label: 'Failures', value: 2, exact: true },
        { label: 'Input tokens', value: 3300, exact: true },
        { label: 'Output tokens', value: 8120, exact: true },
      ],
      activity_rate: Array.from({ length: 24 }, (_, hour) => {
        const active = hour === 7 || hour === 12 || hour === 15;
        const eventCount = hour === 12 ? 88 : hour === 7 ? 64 : hour === 15 ? 32 : 0;
        return {
          start_ms: Date.parse(`2026-05-21T${String(hour).padStart(2, '0')}:00:00Z`),
          label: `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`,
          event_count: eventCount,
          tool_call_count: active ? Math.round(eventCount * 0.6) : 0,
          turn_count: active ? Math.max(1, Math.round(eventCount / 20)) : 0,
          failure_count: hour === 12 ? 1 : 0,
          session_count: active ? 2 : 0,
          intensity: eventCount / 88,
        };
      }),
      repos: [
        {
          repository: 'copilot-mission-control',
          branch: 'main',
          events: 146,
          failures: 2,
          input_tokens: 2800,
          output_tokens: 7120,
          first_seen_ms: Date.parse('2026-05-21T07:11:00Z'),
          last_seen_ms: Date.parse('2026-05-21T07:15:00Z'),
          sessions: [
            { session_hash: 'alpha123', title: 'Build Mission Control', repository: 'copilot-mission-control', branch: 'main', status: 'working', is_active: true, events: 82, failures: 0, turns: 4, tool_calls: 23, input_tokens: 1600, output_tokens: 4200, last_model: 'gpt-5.5', first_seen_ms: Date.parse('2026-05-21T07:11:00Z'), last_seen_ms: Date.parse('2026-05-21T07:15:00Z') },
            { session_hash: 'beta4567', title: 'Review Tests', repository: 'copilot-mission-control', branch: 'main', status: 'needs-attention', is_active: true, events: 64, failures: 2, turns: 3, tool_calls: 17, input_tokens: 1200, output_tokens: 2920, last_model: 'gpt-5.5', first_seen_ms: Date.parse('2026-05-21T07:12:00Z'), last_seen_ms: Date.parse('2026-05-21T07:14:00Z') },
          ],
        },
      ],
      models: [{ label: 'gpt-5.5', category: 'model', value: 7120, secondary_value: 7, tertiary_value: 2800, partial: false }],
      tools: [
        { name: 'view', category: 'library', calls: 14, successes: 14, failures: 0, total_duration_ms: 1200 },
        { name: 'bash', category: 'terminal', calls: 7, successes: 6, failures: 1, total_duration_ms: 90000 },
        { name: 'github-mcp-server-get_file_contents', category: 'mcp', calls: 4, successes: 4, failures: 0, total_duration_ms: 4000 },
      ],
      failures: [{ kind: 'tool.execution_complete', tool: 'bash', category: 'terminal', count: 2, last_seen_ms: Date.parse('2026-05-21T07:14:00Z') }],
      token_hotspots: [{ session_hash: 'alpha123', title: 'Build Mission Control', repository: 'copilot-mission-control', branch: 'main', status: 'working', is_active: true, events: 82, failures: 0, turns: 4, tool_calls: 23, input_tokens: 0, output_tokens: 4200, last_model: 'gpt-5.5', first_seen_ms: Date.parse('2026-05-21T07:11:00Z'), last_seen_ms: Date.parse('2026-05-21T07:15:00Z') }],
      useful_sessions: [{ session_hash: 'beta4567', title: 'Review Tests', repository: 'copilot-mission-control', branch: 'main', status: 'needs-attention', is_active: true, events: 64, failures: 2, turns: 3, tool_calls: 17, input_tokens: 1200, output_tokens: 2920, last_model: 'gpt-5.5', first_seen_ms: Date.parse('2026-05-21T07:12:00Z'), last_seen_ms: Date.parse('2026-05-21T07:14:00Z') }],
      narrative: 'On 2026-05-21, you worked mostly in copilot-mission-control on main, across 3 sessions. gpt-5.5 handled most observed model activity, and view was the busiest tool.',
      exports: [
        { kind: 'daily-digest', label: 'Copy Daily Digest', body: '## Daily Digest - 2026-05-21\n\nOn 2026-05-21, you worked mostly in copilot-mission-control on main, across 3 sessions. gpt-5.5 handled most observed model activity, and view was the busiest tool.\n\n### Highlights\n- copilot-mission-control (main): Build Mission Control; Review Tests\n\n### By the numbers\n3 sessions across 1 repo · 7 turns · 25 tool calls · 2800 / 7120 tokens\n\n### Models\ngpt-5.5 (2800 input tokens / 7120 output tokens)\n\n### Tools\nview (14), bash (7), github-mcp-server-get_file_contents (4)' },
      ],
    };
    const emptyDay = {
      local_day: '2026-05-20',
      totals: [],
      repos: [],
      models: [],
      tools: [],
      failures: [],
      token_hotspots: [],
      useful_sessions: [],
      narrative: 'No indexed Copilot CLI activity is available for 2026-05-20.',
      exports: [],
    };
    (window as any).__analyticsFixture = {
      digest: (request: any) => {
        (window as any).__lastFlightLogRequest = request;
        const selected = request && request.selected_day ? request.selected_day : '2026-05-21';
        return {
          generated_at_ms: Date.parse('2026-05-21T07:20:00Z'),
          selected_day: selected,
          month: '2026-05',
          available_years: [2026, 2025],
          calendar_days: calendarDays,
          day: selected === '2026-05-20' ? emptyDay : activeDay,
          caveats: ['Fixture Daily Log caveat.'],
        };
      },
    };
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        lastText: '',
        writeText(text: string) {
          this.lastText = text;
          (window as any).__copiedFlightLogText = text;
          return Promise.resolve();
        },
      },
      configurable: true,
    });
  });
}

async function getHistoryNumbers(page: Page) {
  return page.evaluate(() => {
    const text = (selector: string) => (document.querySelector(selector)?.textContent || '').replace(/\s+/g, ' ').trim();
    const kpis = Object.fromEntries(Array.from(document.querySelectorAll('.history-kpi')).map((el) => {
      const label = (el.querySelector('.history-kpi-label')?.textContent || '').trim();
      return [label, {
        value: (el.querySelector('.history-kpi-value')?.textContent || '').trim(),
        note: (el.querySelector('.history-kpi-note')?.textContent || '').trim(),
      }];
    }));
    const chartReadouts = (card: string) => Array.from(new Set(Array.from(
      document.querySelectorAll(`[data-history-card="${card}"] rect.activity[data-history-readout]`),
    ).map((el) => el.getAttribute('data-history-readout') || '')));
    const rankRows = (card: string) => Array.from(document.querySelectorAll(`[data-history-card="${card}"] .history-rank-row`)).map((row) => {
      const spans = Array.from(row.querySelectorAll('.history-rank-meta span')).map((el) => (el.textContent || '').trim());
      return `${spans[0]}=${spans[1]}`;
    });
    const rowText = (selector: string) => Array.from(document.querySelectorAll(selector)).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
    return {
      subtitle: text('#history-subtitle'),
      kpis,
      tokenValues: Array.from(document.querySelectorAll('.history-token-kpi .history-kpi-value')).map((el) => (el.textContent || '').trim()),
      hourChartDesc: text('[data-history-card="history-24h"] desc'),
      weekChartDesc: text('[data-history-card="history-7d"] desc'),
      hourReadouts: chartReadouts('history-24h'),
      weekReadouts: chartReadouts('history-7d'),
      topTools: rankRows('top-tools'),
      models: rankRows('models-used'),
      eventMix: rankRows('event-mix'),
      highActivityRows: rowText('.history-activity-session-row'),
      sessionRows: rowText('.history-session-row'),
    };
  });
}

async function expectedHistoryAge(page: Page, iso: string) {
  return page.evaluate((timestamp) => {
    const ts = Date.parse(timestamp);
    const seconds = Math.max(0, (Date.now() - ts) / 1000);
    if (seconds < 60) return `${Math.floor(seconds)}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  }, iso);
}

async function expectedHistoryClock(page: Page, iso: string) {
  return page.evaluate((timestamp) => (
    new Date(timestamp).toLocaleTimeString([], { hour: 'numeric' })
  ), iso);
}

async function selectSession(page: Page, id: string) {
  await page.locator('#dom-session [data-cmc-action="session-menu"]').click();
  await page.locator(`#dom-session [data-session-id="${id}"]`).click();
  await page.waitForTimeout(150);
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
      sessions: scene.activity?.sessions ?? [],
      quarterCount: scene.quarters?.length ?? 0,
      selectedSessionId: scene.selectedSession?.id,
      selectedInputTokens: scene.selectedSession?.input_tokens ?? 0,
      selectedOutputTokens: scene.selectedSession?.output_tokens ?? 0,
      selectedToolCount: scene.selectedSession?.tool_count ?? 0,
      eventLogLength: scene.eventLog?.length ?? 0,
      eventLogSessionIds: Array.from(new Set((scene.eventLog ?? []).map((event: any) => event.session_id))),
      eventLogTools: (scene.eventLog ?? []).map((event: any) => event.tool),
      replayTimelineLength: scene.replayTimeline?.length ?? 0,
      replayTimelineKinds: Array.from(new Set((scene.replayTimeline ?? []).map((event: any) => event.kind))),
      replayTimelineTimestamps: (scene.replayTimeline ?? []).map((event: any) => event.timestamp),
      activityResetAtMs: scene.activityResetAtMs ?? null,
      sessionPickerRows: scene.sessionPickerRows ?? [],
      activeEventPulseCount: scene.activeEventPulseCount ?? 0,
      quarterEventBadges: scene.quarterEventBadges ?? {},
      replayState: scene.replayState ?? { paused: false, cursor: 0, total: 0, atLive: true },
      opsMode: scene.opsSummary?.mode,
      opsAttention: scene.opsSummary?.attention,
      opsRecommendation: scene.opsSummary?.recommendation,
      scannedSessions: scene.activity?.scanned_sessions,
      screenW: window.innerWidth,
      screenH: window.innerHeight,
      layout: scene.layout ? {
        leftX: scene.layout.leftX,
        topY: scene.layout.topY,
        panelW: scene.layout.panelW,
        opsY: scene.layout.opsY,
        opsH: scene.layout.opsH,
        bottomY: scene.layout.bottomY,
        bottomH: scene.layout.bottomH,
        inspectorX: scene.layout.inspectorX,
        inspectorW: scene.layout.inspectorW,
        radiusX: scene.layout.radiusX,
        radiusY: scene.layout.radiusY,
        centerX: scene.layout.centerX,
        centerY: scene.layout.centerY,
        hubY: scene.layout.hubY,
        quarterR: scene.layout.quarterR,
        compact: scene.layout.compact,
      } : null,
      quarterRects: (scene.quarters ?? []).map((d: any) => {
        const quarterSize = scene.layout?.quarterSize ?? 0;
        const labelBlockH = Math.round(38 * Math.max(scene.layout?.s ?? 1, 0.85));
        const frameH = quarterSize + labelBlockH;
        return {
          key: d.key,
          x: d.x,
          y: d.y,
          left: d.x - quarterSize / 2,
          right: d.x + quarterSize / 2,
          top: d.y - quarterSize / 2,
          bottom: d.y - quarterSize / 2 + frameH,
        };
      }),
      moat: scene.moatGeometry ? {
        x: scene.moatGeometry.x,
        y: scene.moatGeometry.y,
        radius: scene.moatGeometry.radius,
      } : null,
      quarterCounts: Object.fromEntries((scene.quarters ?? []).map((d: any) => [d.key, d.count])),
      inspectedQuarterKey: scene.inspectedQuarterKey ?? null,
      hoveredQuarterIndex: scene.hoveredQuarterIndex ?? -1,
    };
  });
}

async function openQuarterDetails(page: Page, key: string) {
  const state = await getMissionState(page);
  const quarter = state!.quarterRects.find((d: any) => d.key === key);
  expect(quarter).toBeTruthy();
  const off = await canvasOffset(page);
  await page.mouse.move(off.x + quarter.x, off.y + quarter.y);
  await expect.poll(async () => (await getMissionState(page))!.inspectedQuarterKey).toBe(key);
  const button = page.locator('#dom-quarter [data-cmc-action="quarter-details"]');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('#inspector-overlay')).toHaveClass(/visible/);
}

function expectNoQuarterFrameOverlaps(rects: Array<{ key: string; left: number; right: number; top: number; bottom: number }>) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const xOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const yOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(
        xOverlap <= 0 || yOverlap <= 0,
        `quarter frames ${a.key} and ${b.key} should not overlap (${Math.round(xOverlap)}x${Math.round(yOverlap)})`,
      ).toBe(true);
    }
  }
}

function inspectorFixture() {
  const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
  const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
  beta.session_name = 'Review Tests';
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
      event_ref: 'evt-1',
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
      event_ref: 'evt-2',
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
      event_ref: 'evt-3',
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
      event_ref: 'evt-4',
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

test.describe('Agent Mission Control — Startup', () => {
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
    expect(state!.quarterCount).toBe(9);
    expect(state!.scannedSessions).toBe(3);
    expect(state!.opsAttention).toBe('ok');
    expect(state!.opsRecommendation).toContain('Reading source');
    expect(state!.selectedSessionId).toBe('beta4567');
    expect(state!.quarterCounts).toEqual({
      edits: 2,
      library: 7,
      terminal: 6,
      signal: 0,
      hooks: 2,
      delegates: 2,
      skills: 3,
      court: 1,
      mcp: 4,
    });
  });

  test('top bar HUD elements are present', async ({ page }) => {
    await expect(page.locator('#topbar .brand')).toBeVisible();
    await expect(page.locator('#topbar-metrics')).toHaveCount(0);
    await expect(page.locator('#topbar')).not.toContainText('Active');
    await expect(page.locator('#topbar')).not.toContainText('Tools/min');
    await expect(page.locator('#ops-chip')).toHaveCount(0);
    await expect(page.locator('#ops-rec')).toHaveCount(0);
    await expect(page.locator('#topbar-controls')).toBeVisible();
    await expect(page.locator('#theme-btn')).toBeVisible();
    await expect(page.locator('#theme-btn')).toHaveAttribute('aria-label', /Switch to light theme|Switch to dark theme/);
  });
});

test.describe('Agent Mission Control — Replay startup', () => {
  test('defaults the time travel slider to live even if pause was persisted', async ({ page }) => {
    await page.addInitScript((fixtureArg) => {
      window.localStorage.setItem('cmc_prefs', JSON.stringify({ replayPaused: true }));
      (window as any).__missionControlFixture = fixtureArg;
    }, MISSION_FIXTURE);
    await page.goto(GAME_URL);
    await waitForGame(page);

    const state = await getMissionState(page);
    expect(state!.replayState.total).toBe(1);
    expect(state!.replayState.cursor).toBe(1);
    expect(state!.replayState.atLive).toBe(true);
    expect(state!.replayState.paused).toBe(false);
    await expect(page.locator('#dom-replay [data-cmc-action="replay-live"]')).toHaveText('LIVE');
    await expect(page.locator('#dom-feed .cmc-panel-title')).toHaveText('Recent Activity Feed');
  });
});

test.describe('Agent Mission Control — History', () => {
  test.beforeEach(async ({ page }) => {
    await installFixture(page);
    await page.goto(GAME_URL);
    await waitForGame(page);
  });

  test('topbar route opens global History analytics and returns to Mission Control', async ({ page }) => {
    await expect(page.locator('#history-screen')).not.toBeVisible();
    await page.locator('#history-route-btn').click();

    await expect(page.locator('body')).toHaveClass(/history-route/);
    await expect(page).toHaveURL(/#history$/);
    await expect(page.locator('#history-screen')).toBeVisible();
    await expect(page.locator('#game')).not.toBeVisible();
    await expect(page.locator('#dashboard-overlay')).not.toBeVisible();
    await expect(page.locator('#history-route-btn')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#history-title')).toHaveText('Copilot Mission Archive');
    await expect(page.locator('.history-header')).toContainText('Sessions Scanned');
    await expect(page.locator('#history-content')).toContainText('184');
    await expect(page.locator('.history-kpi').filter({ hasText: 'Events' })).toContainText('184');
    await expect(page.locator('.history-kpi').filter({ hasText: 'Tool Calls' })).toContainText('47');
    await expect(page.locator('.history-token-kpi').filter({ hasText: 'Input Tokens' })).toContainText('3,300');
    await expect(page.locator('.history-token-kpi').filter({ hasText: 'Output Tokens' })).toContainText('8,120');
    await expect(page.locator('#history-token-summary')).toHaveCount(0);
    await expect(page.locator('#history-session-filter')).toContainText('Build Mission Control · alpha123');
    await expect(page.locator('[data-history-card="history-24h"] svg.history-chart')).toBeVisible();
    await expect(page.locator('[data-history-card="history-7d"] svg.history-chart')).toBeVisible();
    await expect(page.locator('#history-content')).toContainText('Models Used');
    await expect(page.locator('#history-content')).toContainText('Activity Breakdown');
    await expect(page.locator('#history-content')).toContainText('Top Tools');
    await expect(page.locator('[data-history-card="session-distribution"]')).toHaveCount(0);
    await expect(page.locator('[data-history-card="high-activity-sessions"]')).toContainText('High Activity Sessions');
    await expect(page.locator('[data-history-card="high-activity-sessions"] .history-activity-session-row')).toHaveCount(3);
    await expect(page.locator('[data-history-card="high-activity-sessions"] .history-activity-session-row').first()).toContainText('copilot-mission-control / main · 82 events · 4 turns · 23 tool calls · 1,600 input tokens · 4,200 output tokens · 0 failures');
    await expect(page.locator('[data-history-card="high-activity-sessions"] .history-chart-readout')).toHaveCount(0);
    await expect(page.locator('#history-session-filter')).toHaveCSS('font-size', '14px');
    const historyLayout = await page.evaluate(() => {
      const grid = document.querySelector('.history-grid') as HTMLElement;
      const chartRegion = document.querySelector('.history-chart-region') as HTMLElement;
      const chartCards = Array.from(chartRegion.querySelectorAll<HTMLElement>('.history-card')).map((card) => card.getBoundingClientRect());
      const breakdown = document.querySelector('.history-breakdown-region') as HTMLElement;
      const models = document.querySelector('[data-history-card="models-used"]') as HTMLElement;
      const topTools = document.querySelector('[data-history-card="top-tools"]') as HTMLElement;
      const sessions = document.querySelector('.history-sessions-region') as HTMLElement;
      const gridStyle = window.getComputedStyle(grid);
      const gridRect = grid.getBoundingClientRect();
      const chartRect = chartRegion.getBoundingClientRect();
      const breakdownRect = breakdown.getBoundingClientRect();
      const modelsRect = models.getBoundingClientRect();
      const topToolsRect = topTools.getBoundingClientRect();
      return {
        columns: gridStyle.gridTemplateColumns.split(' ').filter(Boolean).length,
        chartLeft: Math.round(chartRect.left - gridRect.left),
        chartWidth: Math.round(chartRect.width),
        firstChartLeft: Math.round(chartCards[0].left),
        secondChartLeft: Math.round(chartCards[1].left),
        firstChartTop: Math.round(chartCards[0].top),
        secondChartTop: Math.round(chartCards[1].top),
        firstChartWidth: Math.round(chartCards[0].width),
        breakdownLeft: Math.round(breakdownRect.left - gridRect.left),
        breakdownWidth: Math.round(breakdownRect.width),
        modelsLeft: Math.round(modelsRect.left - gridRect.left),
        topToolsLeft: Math.round(topToolsRect.left - gridRect.left),
        modelsTop: Math.round(modelsRect.top),
        topToolsTop: Math.round(topToolsRect.top),
        sessionsLeft: Math.round(sessions.getBoundingClientRect().left - gridRect.left),
        sessionsWidth: Math.round(sessions.getBoundingClientRect().width),
      };
    });
    expect(historyLayout.columns).toBe(3);
    expect(historyLayout.chartLeft).toBeGreaterThan(0);
    expect(historyLayout.firstChartWidth).toBeGreaterThan(historyLayout.chartWidth * 0.95);
    expect(historyLayout.secondChartLeft).toBe(historyLayout.firstChartLeft);
    expect(historyLayout.secondChartTop).toBeGreaterThan(historyLayout.firstChartTop);
    expect(historyLayout.breakdownLeft).toBe(historyLayout.chartLeft);
    expect(historyLayout.breakdownWidth).toBe(historyLayout.chartWidth);
    expect(historyLayout.modelsLeft).toBe(0);
    expect(historyLayout.topToolsLeft).toBe(0);
    expect(historyLayout.modelsTop).toBeLessThan(historyLayout.topToolsTop);
    expect(historyLayout.sessionsLeft).toBe(historyLayout.chartLeft);
    expect(historyLayout.sessionsWidth).toBe(historyLayout.chartWidth);
    const scrollbarStyles = await page.evaluate(() => {
      const selectors = [
        '#history-screen',
        '.history-session-list',
        '#inspector-list',
        '#schema-drift-dialog',
        '#attention-body',
        '#dom-feed .cmc-panel-body',
        '#dom-quarter .cmc-panel-body',
      ];
      return selectors.map((selector) => {
        const el = document.querySelector(selector) as HTMLElement;
        const style = window.getComputedStyle(el);
        return {
          selector,
          gutter: style.scrollbarGutter,
          color: style.scrollbarColor,
        };
      });
    });
    expect(scrollbarStyles.every(({ color }) => color !== 'auto')).toBe(true);
    expect(new Set(scrollbarStyles.map(({ color }) => color)).size).toBe(1);
    expect(scrollbarStyles.find(({ selector }) => selector === '#history-screen')?.gutter).toContain('stable');
    const columnTops = await page.evaluate(() => {
      const left = document.querySelector('.history-tools-region .history-card');
      const right = document.querySelector('.history-chart-region .history-card');
      return {
        left: left?.getBoundingClientRect().top ?? 0,
        right: right?.getBoundingClientRect().top ?? 0,
      };
    });
    expect(Math.abs(columnTops.left - columnTops.right)).toBeLessThanOrEqual(1);

    await page.evaluate(() => {
      const sessionPanel = document.querySelector('#dom-session') as HTMLElement | null;
      if (sessionPanel) sessionPanel.style.height = '900px';
    });
    await page.locator('#mission-route-btn').click();
    await expect(page.locator('body')).not.toHaveClass(/history-route/);
    await expect(page).toHaveURL(/#mission$/);
    await expect(page.locator('#mission-route-btn')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#game')).toBeVisible();
    await expect(page.locator('#dashboard-overlay')).toBeVisible();
    await page.waitForFunction(() => {
      const sessionPanel = document.querySelector('#dom-session') as HTMLElement | null;
      return !!sessionPanel && sessionPanel.style.height !== '900px';
    });
    const dashboardLayout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) throw new Error(`missing ${selector}`);
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height };
      };
      return {
        session: rect('#dom-session'),
        actions: rect('#dom-session .cmc-actions'),
        summary: rect('#dom-session .cmc-session-summary'),
        pulse: rect('#dom-session .cmc-ops-tempo'),
        feed: rect('#dom-feed'),
        constrained: document.querySelector('#dom-session')?.classList.contains('constrained') ?? true,
      };
    });
    expect(dashboardLayout.constrained).toBe(false);
    expect(dashboardLayout.pulse.top).toBeGreaterThanOrEqual(dashboardLayout.summary.bottom);
    expect(dashboardLayout.actions.top).toBeGreaterThanOrEqual(dashboardLayout.pulse.bottom);
    expect(dashboardLayout.session.bottom).toBeGreaterThanOrEqual(dashboardLayout.actions.bottom);
    expect(dashboardLayout.feed.top).toBeGreaterThanOrEqual(dashboardLayout.session.bottom + 8);
  });

  test('Daily Log tab renders calendar heatmap and Daily Debrief details', async ({ page }) => {
    await installFlightLogFixture(page);
    await page.reload();
    await waitForGame(page);

    await page.locator('#history-route-btn').click();
    await page.locator('#history-flight-log-tab').click();

    await expect(page.locator('#history-flight-log-tab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.history-filter')).toBeHidden();
    await expect(page.locator('[data-history-card="flight-log-calendar"]')).toBeVisible();
    await expect(page.locator('[data-flight-log-month-select]')).toBeVisible();
    await expect(page.locator('[data-flight-log-year-select]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next month' })).toBeEnabled();
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect.poll(async () => page.evaluate(() => (window as any).__lastFlightLogRequest)).toMatchObject({
      month: '2026-06',
      selected_day: expectedJuneSelectedDay(),
    });
    await page.locator('[data-flight-log-day="2026-05-21"]').click();
    await expect(page.locator('[data-flight-log-day="2026-05-21"] .flight-log-day-number')).toBeVisible();
    await expect(page.locator('[data-flight-log-day="2026-05-21"] .flight-log-event-dot')).toHaveCount(0);
    await expect(page.locator('[data-flight-log-day="2026-05-21"]')).toHaveAttribute('aria-label', /184 events/);
    await expect(page.locator('[data-flight-log-day="2026-05-21"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#mission-route-btn').click();
    await page.locator('#history-route-btn').click();
    await expect(page.locator('#history-flight-log-tab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-history-card="flight-log-calendar"]')).toBeVisible();
    await expect(page.locator('[data-history-card="flight-log-calendar"]')).not.toContainText('0 events');
    await expect(page.locator('[data-flight-log-day="2026-05-22"]')).toBeDisabled();
    await expect(page.locator('[data-history-card="flight-log-debrief"]')).toContainText('Daily Debrief');
    await expect(page.locator('[data-history-card="flight-log-debrief"] .flight-log-stat').filter({ hasText: 'Input tokens' })).toContainText('3,300');
    await expect(page.locator('[data-history-card="flight-log-debrief"]')).toContainText('copilot-mission-control / main');
    await expect(page.locator('[data-history-card="flight-log-debrief"]')).toContainText('gpt-5.5');
    await expect(page.locator('[data-history-card="flight-log-debrief"]')).toContainText('github-mcp-server-get_file_contents');
    const activityRate = page.locator('.flight-log-activity-rate');
    await expect(activityRate).toContainText('Activity Rate');
    await expect(activityRate.locator('.flight-log-activity-cell')).toHaveCount(24);
    await expect(activityRate).toContainText('Peak hour');
    await expect(activityRate).toContainText('88 activity items');
    await activityRate.locator('.flight-log-activity-cell').nth(12).hover();
    await expect(activityRate.locator('.history-chart-readout')).toContainText('88 activity items');
    await expect(activityRate.locator('.history-chart-readout')).toContainText('tool calls');
    await expect(activityRate.locator('.history-chart-readout')).toContainText('-');
    await expect(activityRate.locator('.history-chart-readout')).not.toContainText('Z');
    const toolsPanel = page.locator('.flight-log-section').filter({ hasText: 'Tools / MCP' });
    await expect(toolsPanel).toContainText('bash');
    await expect(toolsPanel).toContainText('Commands · 7 calls · 1 failure');
    await expect(page.locator('[data-history-card="flight-log-debrief"]')).toContainText('Mission Summary');
    await expect(page.getByRole('heading', { name: 'Transmit' })).toHaveCount(0);
    const workedOn = page.locator('.flight-log-section').filter({ hasText: 'What I Worked On' });
    const dailyDigestPanel = workedOn.locator('[data-flight-log-export-panel="daily-digest"]');
    const dailyDigestPreview = dailyDigestPanel.locator('textarea');
    await expect(workedOn.locator('[data-flight-log-export]')).toHaveCount(1);
    await expect(workedOn).toContainText('Expand a section to preview it before copying.');
    await expect(workedOn).toContainText('Daily Digest');
    await expect(workedOn).not.toContainText('Resume Prompt');
    await expect(workedOn).not.toContainText('standup update');
    await expect(workedOn).not.toContainText('Markdown digest');
    await expect(workedOn).not.toContainText('PR summary');
    await expect(workedOn).not.toContainText('Copy Daily Digest');
    await expect(dailyDigestPanel).not.toHaveAttribute('open', '');
    await expect(dailyDigestPreview).not.toBeVisible();
    await dailyDigestPanel.locator('summary').click();
    await expect(dailyDigestPreview).toBeVisible();
    await expect(dailyDigestPreview).toHaveValue(/On 2026-05-21, you worked mostly in copilot-mission-control/);
    await expect(dailyDigestPreview).toHaveValue(/### Highlights/);
    await expect(dailyDigestPreview).toHaveJSProperty('readOnly', true);
    const dailyDigestHeight = await dailyDigestPreview.evaluate((textarea) => Math.round((textarea as HTMLTextAreaElement).getBoundingClientRect().height));
    expect(dailyDigestHeight).toBeGreaterThanOrEqual(80);
    expect(dailyDigestHeight).toBeLessThanOrEqual(170);
    await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Token Hotspots' })).toBeVisible();
    const models = page.locator('.flight-log-section').filter({ has: page.getByRole('heading', { name: 'Models' }) });
    const tokenHotspots = page.locator('.flight-log-section').filter({ has: page.getByRole('heading', { name: 'Token Hotspots' }) });
    await expect(models).toContainText('gpt-5.5');
    await expect(models).not.toContainText('Token hotspot');
    await expect(tokenHotspots).toContainText('Build Mission Control');
    await expect(tokenHotspots).toContainText('pending input tokens · 4,200 output tokens');
    await expect(tokenHotspots).not.toContainText('Token hotspot ·');
    await expect(page.locator('[data-history-card="flight-log-debrief"]')).toContainText('7 calls · 1 failure');
    await expect(page.locator('[data-history-card="flight-log-debrief"]')).not.toContainText('1 failures');
    await expect(page.locator('[data-history-card="flight-log-debrief"]')).toContainText('High Activity Sessions');
    await expect(page.locator('[data-history-card="flight-log-debrief"]')).toContainText('64 events · 3 turns · 17 tool calls · 1,200 input tokens · 2,920 output tokens · 2 failures');
    await expect(page.locator('[data-history-card="flight-log-debrief"]')).not.toContainText('Unresolved Work');
    await expect(page.locator('[data-flight-log-failure]')).toHaveCount(0);
    const dayHeights = await page.locator('[data-flight-log-day]').evaluateAll((days) =>
      Array.from(new Set(days.map((day) => Math.round((day as HTMLElement).getBoundingClientRect().height)))),
    );
    expect(dayHeights).toHaveLength(1);
    const numberOffsets = await page.locator('[data-flight-log-day]').evaluateAll((days) =>
      Array.from(new Set(days.map((day) => {
        const cell = (day as HTMLElement).getBoundingClientRect();
        const number = (day as HTMLElement).querySelector('.flight-log-day-number')!.getBoundingClientRect();
        return Math.round(number.top - cell.top);
      }))),
    );
    expect(numberOffsets).toHaveLength(1);
  });

  test('Daily Log disabled no-data days stay visible without a green badge', async ({ page }) => {
    await installFlightLogFixture(page);
    await page.reload();
    await waitForGame(page);

    await page.locator('#history-route-btn').click();
    await page.locator('#history-flight-log-tab').click();

    await expect(page.locator('[data-flight-log-day="2026-05-20"]')).toBeDisabled();
    await expect(page.locator('[data-flight-log-day="2026-05-20"]')).not.toHaveClass(/has-events/);
    await expect(page.locator('[data-flight-log-day="2026-05-20"] .flight-log-day-number')).toBeVisible();
  });

  test('Daily Log keeps remaining selected-week days visible and disabled', async ({ page }) => {
    await installFlightLogFixture(page);
    await page.reload();
    await waitForGame(page);

    await page.locator('#history-route-btn').click();
    await page.locator('#history-flight-log-tab').click();
    await page.locator('[data-flight-log-month-select]').selectOption('06');

    await expect.poll(async () => page.evaluate(() => (window as any).__lastFlightLogRequest)).toMatchObject({
      month: '2026-06',
      selected_day: expectedJuneSelectedDay(),
    });
    await page.locator('[data-flight-log-day="2026-06-02"]').click();
    await expect.poll(async () => page.evaluate(() => (window as any).__lastFlightLogRequest)).toMatchObject({
      month: '2026-06',
      selected_day: '2026-06-02',
    });
    await expect(page.locator('[data-flight-log-day="2026-06-03"]')).toBeVisible();
    await expect(page.locator('[data-flight-log-day="2026-06-03"]')).toBeDisabled();
    await expect(page.locator('[data-flight-log-day="2026-06-03"]')).not.toHaveClass(/has-events/);
  });

  test('Daily Log month and year dropdowns request a historical period', async ({ page }) => {
    await installFlightLogFixture(page);
    await page.reload();
    await waitForGame(page);

    await page.locator('#history-route-btn').click();
    await page.locator('#history-flight-log-tab').click();
    await page.locator('[data-flight-log-month-select]').selectOption('04');
    await expect.poll(async () => page.evaluate(() => (window as any).__lastFlightLogRequest)).toMatchObject({
      month: '2026-04',
      selected_day: '2026-04-30',
    });

    await page.locator('[data-flight-log-year-select]').selectOption('2025');
    await expect.poll(async () => page.evaluate(() => (window as any).__lastFlightLogRequest)).toMatchObject({
      month: '2025-05',
      selected_day: '2025-05-31',
    });
  });

  test('Daily Log renders a static year label when only one data year exists', async ({ page }) => {
    await installFlightLogFixture(page);
    await page.addInitScript(() => {
      const fixture = (window as any).__analyticsFixture;
      const originalDigest = fixture.digest;
      fixture.digest = (request: any) => ({
        ...originalDigest(request),
        available_years: [2026],
      });
    });
    await page.reload();
    await waitForGame(page);

    await page.locator('#history-route-btn').click();
    await page.locator('#history-flight-log-tab').click();

    await expect(page.locator('[data-flight-log-year-select]')).toHaveCount(0);
    await expect(page.locator('[data-flight-log-year-label]')).toHaveText('2026');
  });

  test('Daily Log export preview copy icon copies generated text', async ({ page }) => {
    await installFlightLogFixture(page);
    await page.reload();
    await waitForGame(page);

    await page.locator('#history-route-btn').click();
    await page.locator('#history-flight-log-tab').click();
    const dailyDigestPanel = page.locator('[data-flight-log-export-panel="daily-digest"]');
    await dailyDigestPanel.locator('summary').click();
    await dailyDigestPanel.locator('[data-flight-log-export="daily-digest"]').click();

    await expect(page.locator('.flight-log-copy-status')).toContainText('Daily Digest copied');
    await expect(dailyDigestPanel).toHaveAttribute('open', '');
    await expect(page.locator('.flight-log-copy-status')).not.toContainText('copied.');
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedFlightLogText)).toContain('On 2026-05-21, you worked mostly in copilot-mission-control');
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedFlightLogText)).toContain('## Daily Digest - 2026-05-21');
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedFlightLogText)).toContain('### Highlights');
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedFlightLogText)).toContain('### By the numbers');
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedFlightLogText)).toContain('gpt-5.5 (2800 input tokens / 7120 output tokens)');
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedFlightLogText)).not.toContain('### Follow-up');
    await expect.poll(async () => page.evaluate(() => (window as any).__copiedFlightLogText)).not.toContain('Yesterday/Today:');
  });

  test('History session filter scopes charts, lists, and token summary', async ({ page }) => {
    await page.locator('#history-route-btn').click();
    await page.locator('#history-session-filter').selectOption('beta4567');

    await expect(page.locator('.history-token-kpi').filter({ hasText: 'Input Tokens' })).toContainText('1,200');
    await expect(page.locator('.history-token-kpi').filter({ hasText: 'Output Tokens' })).toContainText('2,920');
    await expect(page.locator('.history-kpi').filter({ hasText: 'Events' })).toContainText('64');
    await expect(page.locator('.history-kpi').filter({ hasText: 'Tool Calls' })).toContainText('17');
    await expect(page.locator('#history-content')).toContainText('Review Tests');
    await expect(page.locator('#history-content')).toContainText('64 events');
    await expect(page.locator('#history-content')).toContainText('postToolUse');
    await expect(page.locator('#history-content')).not.toContainText('Research UI');
    await expect(page.locator('[data-history-card="history-24h"] svg.history-chart')).toBeVisible();
  });

  test('History all sessions uses aggregate history totals instead of capped recent activity totals', async ({ page }) => {
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    fixture.total_events = 80;
    fixture.total_tool_calls = 10;
    await page.addInitScript((fixtureArg) => {
      (window as any).__missionControlFixture = fixtureArg;
    }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    await page.locator('#history-route-btn').click();

    await expect(page.locator('.history-kpi').filter({ hasText: 'Events' })).toContainText('184');
    await expect(page.locator('.history-kpi').filter({ hasText: 'Tool Calls' })).toContainText('47');
  });

  test('History visible numbers match the underlying history payload', async ({ page }) => {
    await page.locator('#history-route-btn').click();

    const all = await getHistoryNumbers(page);
    expect(all.subtitle).toBe('KPI totals cover all currently scanned local sessions (3 sessions). Charts below show rolling 24h and last 7 days.');
    expect(all.kpis).toMatchObject({
      'Sessions Scanned': { value: '3', note: '' },
      'Events': { value: '184', note: '' },
      'Tool Calls': { value: '47', note: '' },
      'Models Used': { value: '2', note: '' },
      'Input Tokens': { value: '3,300', note: '' },
      'Output Tokens': { value: '8,120', note: '' },
    });
    expect(all.kpis['Last Activity']).toBeUndefined();
    expect(all.tokenValues).toEqual(['3,300', '8,120']);
    expect(all.hourChartDesc).toBe('184 events across observed buckets.');
    expect(all.weekChartDesc).toBe('326 events across observed buckets.');
    const allHourClocks = await Promise.all(MISSION_FIXTURE.history.activity_24h.map((bucket) => expectedHistoryClock(page, bucket.start)));
    expect(all.hourReadouts).toEqual([
      `${allHourClocks[0]} · 24h ago: 12 events, 1 sessions, 0 agent starts`,
      `${allHourClocks[1]} · 16h ago: 31 events, 2 sessions, 1 agent start`,
      `${allHourClocks[2]} · 8h ago: 54 events, 2 sessions, 2 agent starts`,
      `${allHourClocks[3]} · Current hour: 87 events, 3 sessions, 3 agent starts`,
    ]);
    expect(all.weekReadouts).toEqual([
      'Mon: 42 events, 1 sessions',
      'Tue: 61 events, 2 sessions',
      'Wed: 39 events, 2 sessions',
      'Thu: 184 events, 3 sessions',
    ]);
    expect(all.topTools).toEqual(['view=14 · 29.8%', 'apply_patch=8 · 17%', 'bash=7 · 14.9%']);
    expect(all.models).toEqual(['gpt-5.5=6 · 75%', 'unknown=2 · 25%']);
    expect(all.eventMix).toEqual(['Reads=18 · 39.1%', 'Edits=10 · 21.7%', 'Hooks=5 · 10.9%', 'Failures=2 · 4.3%']);
    expect(all.highActivityRows).toEqual([
      expect.stringContaining('Build Mission Controlcopilot-mission-control / main · 82 events · 4 turns · 23 tool calls · 1,600 input tokens · 4,200 output tokens · 0 failures'),
      expect.stringContaining('Review Testscopilot-mission-control / main · 64 events · 3 turns · 17 tool calls · 1,200 input tokens · 2,920 output tokens · 2 failures'),
      expect.stringContaining('Research UIdocs / main · 38 events · 1 turn · 7 tool calls · 500 input tokens · 1,000 output tokens · 0 failures'),
    ]);
    expect(all.sessionRows).toEqual([
      expect.stringContaining('82 events'),
      expect.stringContaining('64 events'),
      expect.stringContaining('38 events'),
    ]);
    for (const sessionRow of all.sessionRows) {
      expect(sessionRow).not.toContain('failures');
    }

    await page.locator('#history-session-filter').selectOption('beta4567');
    const beta = await getHistoryNumbers(page);
    expect(beta.subtitle).toBe('KPI totals cover the selected session (Review Tests · beta4567). Charts below show rolling 24h and last 7 days.');
    expect(beta.kpis).toMatchObject({
      'Sessions Scanned': { value: '1', note: '' },
      'Events': { value: '64', note: '' },
      'Tool Calls': { value: '17', note: '' },
      'Models Used': { value: '1', note: '' },
      'Input Tokens': { value: '1,200', note: '' },
      'Output Tokens': { value: '2,920', note: '' },
    });
    expect(beta.kpis['Last Activity']).toBeUndefined();
    expect(beta.tokenValues).toEqual(['1,200', '2,920']);
    expect(beta.hourChartDesc).toBe('90 events across observed buckets.');
    expect(beta.weekChartDesc).toBe('90 events across observed buckets.');
    const betaHourClocks = await Promise.all(MISSION_FIXTURE.history.session_scopes[1].activity_24h.map((bucket) => expectedHistoryClock(page, bucket.start)));
    expect(beta.hourReadouts).toEqual([
      `${betaHourClocks[0]} · 24h ago: 19 events, 1 sessions, 1 agent start`,
      `${betaHourClocks[1]} · 12h ago: 30 events, 1 sessions, 2 agent starts`,
      `${betaHourClocks[2]} · Current hour: 41 events, 1 sessions, 1 agent start`,
    ]);
    expect(beta.weekReadouts).toEqual([
      'Tue: 45 events, 1 sessions',
      'Thu: 45 events, 1 sessions',
    ]);
    expect(beta.topTools).toEqual(['bash=7 · 63.6%', 'postToolUse=4 · 36.4%']);
    expect(beta.models).toEqual(['gpt-5.5=2 · 100%']);
    expect(beta.eventMix).toEqual(['Commands=8 · 57.1%', 'Hooks=4 · 28.6%', 'Failures=2 · 14.3%']);
    expect(beta.highActivityRows).toEqual([
      expect.stringContaining('Review Testscopilot-mission-control / main · 64 events · 3 turns · 17 tool calls · 1,200 input tokens · 2,920 output tokens · 2 failures'),
    ]);
    expect(beta.sessionRows).toEqual([expect.stringContaining('64 events')]);
    expect(beta.sessionRows[0]).not.toContain('failures');
  });

  test('History session list panel scrolls and truncates long titles', async ({ page }) => {
    await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      const baseSession = fixture.history.recent_sessions[0];
      fixture.history.recent_sessions = Array.from({ length: 14 }, (_, index) => ({
        ...baseSession,
        id: `session-${index}`,
        title: index === 0 ? 'Investigate Extremely Long Recent Session Title That Must Truncate Consistently' : `Session ${index + 1}`,
        event_count: 40 + index,
        updated_at: `2026-05-21T07:${String(index).padStart(2, '0')}:00Z`,
      }));
      window.__cmcOnAgentActivityChanged?.();
    });

    await page.locator('#history-route-btn').click();
    const listSizing = await page.evaluate(() => {
      const sessions = document.querySelector('.history-session-list') as HTMLElement;
      return {
        sessionsScrolls: sessions.scrollHeight > sessions.clientHeight,
        sessionsMaxHeight: getComputedStyle(sessions).maxHeight,
        sessionRows: Array.from(document.querySelectorAll('.history-session-row')).slice(0, 4).map((row) => {
          const rowEl = row as HTMLElement;
          const badge = row.querySelector('.history-dossier-id') as HTMLElement;
          const status = row.querySelector('.history-status') as HTMLElement;
          const title = row.querySelector('.history-row-title') as HTMLElement;
          const subtitle = row.querySelector('.history-row-sub') as HTMLElement;
          const stats = row.querySelector('.history-session-stats') as HTMLElement;
          const age = row.querySelector('.history-session-age') as HTMLElement;
          const badgeRect = badge.getBoundingClientRect();
          const statusRect = status.getBoundingClientRect();
          const titleRect = title.getBoundingClientRect();
          const statsRect = stats.getBoundingClientRect();
          const ageRect = age.getBoundingClientRect();
          const titleStyle = getComputedStyle(title);
          return {
            rowHeight: Math.round(rowEl.getBoundingClientRect().height),
            badgeWidth: Math.round(badgeRect.width),
            badgeHeight: Math.round(badgeRect.height),
            badgeLeft: Math.round(badgeRect.left),
            ageLeft: Math.round(ageRect.left),
            statsLeft: Math.round(statsRect.left),
            statusWidth: Math.round(statusRect.width),
            titleLeft: Math.round(titleRect.left),
            titleWidth: Math.round(titleRect.width),
            subtitleText: subtitle.textContent || '',
            ageText: age.textContent || '',
            statsText: stats.textContent || '',
            titleOverflow: titleStyle.textOverflow,
            titleWhiteSpace: titleStyle.whiteSpace,
            titleTooltip: title.getAttribute('title'),
          };
        }),
      };
    });
    expect(listSizing.sessionsScrolls).toBe(true);
    expect(listSizing.sessionsMaxHeight).toBe('560px');
    expect(new Set(listSizing.sessionRows.map((row) => row.rowHeight)).size).toBe(1);
    expect(new Set(listSizing.sessionRows.map((row) => row.badgeWidth)).size).toBe(1);
    expect(new Set(listSizing.sessionRows.map((row) => row.badgeHeight)).size).toBe(1);
    expect(new Set(listSizing.sessionRows.map((row) => row.statusWidth)).size).toBe(1);
    expect(new Set(listSizing.sessionRows.map((row) => row.titleLeft)).size).toBe(1);
    expect(listSizing.sessionRows[0].rowHeight).toBeLessThan(82);
    expect(listSizing.sessionRows[0].badgeWidth).toBeLessThan(90);
    expect(listSizing.sessionRows[0].ageLeft).toBe(listSizing.sessionRows[0].titleLeft);
    expect(listSizing.sessionRows[0].statsLeft).toBeGreaterThan(listSizing.sessionRows[0].ageLeft);
    expect(listSizing.sessionRows[0].titleWidth).toBeGreaterThan(220);
    expect(listSizing.sessionRows[0].subtitleText).not.toContain('session-0');
    expect(listSizing.sessionRows[0].ageText).toContain(' · 40 events');
    expect(listSizing.sessionRows[0].statsText).toBe('40 events');
    expect(listSizing.sessionRows[0]).toMatchObject({
      titleOverflow: 'ellipsis',
      titleWhiteSpace: 'nowrap',
      titleTooltip: 'Investigate Extremely Long Recent Session Title That Must Truncate Consistently',
    });
  });

  test('hash route opens History directly on load', async ({ page }) => {
    await page.goto(`${GAME_URL}#history`);
    await waitForGame(page);

    await expect(page.locator('body')).toHaveClass(/history-route/);
    await expect(page.locator('#history-screen')).toBeVisible();
    await expect(page.locator('#history-route-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#history-content')).toContainText('Activity, Rolling 24 Hours');
  });

  test('History empty state stays useful when the backend has no observed events', async ({ page }) => {
    await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      fixture.history = {
        generated_at_ms: Date.parse('2026-05-21T07:20:00Z'),
        failure_count: 0,
        activity_24h: [],
        activity_7d: [],
        model_mix: [],
        category_mix: [],
        top_tools: [],
        recent_sessions: [],
        recent_failures: [],
      };
      window.__cmcOnAgentActivityChanged?.();
    });

    await page.locator('#history-route-btn').click();
    await expect(page.locator('#history-content')).toContainText('No observed Copilot events are available yet');
    await expect(page.locator('.history-header')).toContainText('Sessions Scanned');
  });

  test('History loading state does not flash empty copy before full scan arrives', async ({ page }) => {
    await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      fixture.history = {
        generated_at_ms: 0,
        failure_count: 0,
        activity_24h: [],
        activity_7d: [],
        model_mix: [],
        category_mix: [],
        top_tools: [],
        recent_sessions: [],
        recent_failures: [],
      };
      window.__cmcOnAgentActivityChanged?.();
    });

    await page.locator('#history-route-btn').click();
    await expect(page.locator('#history-content')).toContainText('Scanning Copilot CLI history');
    await expect(page.locator('#history-content .history-loading-dialog')).toBeVisible();
    await expect(page.locator('#history-content .history-loading-bar')).toBeVisible();
    await expect(page.locator('#history-content')).not.toContainText('No observed Copilot events are available yet');
  });

  test('History chart colors resolve in light theme', async ({ page }) => {
    await page.locator('#history-route-btn').click();
    await page.locator('#theme-btn').click();

    await expect(page.locator('body')).toHaveClass(/theme-light/);
    await page.locator('[data-history-card="history-24h"] rect.activity[data-history-readout]').nth(1).hover();
    const secondHourClock = await expectedHistoryClock(page, MISSION_FIXTURE.history.activity_24h[1].start);
    await expect(page.locator('[data-history-card="history-24h"] .history-chart-readout')).toContainText(`${secondHourClock} · 16h ago: 31 events, 2 sessions, 1 agent start`);
    await expect(page.locator('[data-history-card="history-24h"] .history-chart-readout')).toHaveClass(/visible/);
    const hourAxisLabels = await page.locator('[data-history-card="history-24h"] .history-chart-axis span').allTextContents();
    expect(hourAxisLabels.length).toBeGreaterThanOrEqual(4);
    expect(hourAxisLabels.length).toBeLessThanOrEqual(5);
    expect(hourAxisLabels[0]).toContain('24h ago');
    expect(hourAxisLabels.at(-1)).toContain('now');
    expect(hourAxisLabels.join(' ')).not.toContain('Z');
    const readout = await page.evaluate(() => {
      const card = document.querySelector('[data-history-card="history-24h"]') as HTMLElement;
      const label = card.querySelector('.history-chart-readout') as HTMLElement;
      const cardRect = card.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      return {
        visible: getComputedStyle(label).opacity,
        withinCard: labelRect.left >= cardRect.left && labelRect.top >= cardRect.top && labelRect.right <= cardRect.right,
      };
    });
    expect(readout).toEqual({ visible: '1', withinCard: true });
    const colors = await page.evaluate(() => {
      const screen = document.querySelector('#history-screen') as HTMLElement;
      const activity = document.querySelector('[data-history-card="history-24h"] rect.activity') as SVGElement;
      const activityFills = new Set(Array.from(document.querySelectorAll('[data-history-card="history-24h"] rect.activity')).map((el) => getComputedStyle(el).fill));
      const topToolFill = document.querySelector('[data-history-card="top-tools"] .history-bar-svg-fill') as SVGElement;
      const modelFill = document.querySelector('[data-history-card="models-used"] .history-bar-svg-fill') as SVGElement;
      const eventMixFill = document.querySelector('[data-history-card="event-mix"] .history-bar-svg-fill') as SVGElement;
      const eventMixSvg = document.querySelector('[data-history-card="event-mix"] .history-bar-svg') as SVGElement;
      const eventMixBar = document.querySelector('[data-history-card="event-mix"] .history-bar') as HTMLElement;
      const panelTitle = document.querySelector('.cmc-panel-title') as HTMLElement;
      const historyTitle = document.querySelector('[data-history-card="models-used"] .history-card-title') as HTMLElement;
      const legendItems = Array.from(document.querySelectorAll('[data-history-card="history-24h"] .history-legend span')).map((el) => (el.textContent || '').trim());
      const panelTitleStyle = getComputedStyle(panelTitle);
      const historyTitleStyle = getComputedStyle(historyTitle);
      const kpis = document.querySelector('.history-kpis') as HTMLElement;
      const historyHeader = document.querySelector('.history-header') as HTMLElement;
      const historyFilter = document.querySelector('.history-filter') as HTMLElement;
      const leftCapShape = (el: SVGElement) => {
        const path = el.getAttribute('d') || '';
        const match = path.match(/^M 5 0 H ([\d.]+) V 10 H 5 C 2\.238576251 10 0 7\.761423749 0 5 C 0 2\.238576251 2\.238576251 0 5 0 Z$/);
        return {
          flatRight: Boolean(match),
          fillWidth: match ? Number(match[1]) : 0,
          viewBoxWidth: Number(((el.closest('svg') as SVGElement).getAttribute('viewBox') || '').split(' ')[2] || 0),
        };
      };
      const rowBgProbe = document.createElement('span');
      rowBgProbe.style.color = 'var(--history-row-bg)';
      screen.appendChild(rowBgProbe);
      const rowBgColor = getComputedStyle(rowBgProbe).color;
      rowBgProbe.remove();
      return {
        activityVar: getComputedStyle(screen).getPropertyValue('--history-activity').trim(),
        activityFill: getComputedStyle(activity).fill,
        activityFillCount: activityFills.size,
        failureRects: document.querySelectorAll('[data-history-card="history-24h"] rect.failure').length,
        nonTimeChartFills: {
          topToolShape: leftCapShape(topToolFill),
          topToolFill: getComputedStyle(topToolFill).fill,
          topToolInlineStyle: topToolFill.getAttribute('style'),
          modelShape: leftCapShape(modelFill),
          modelFill: getComputedStyle(modelFill).fill,
          modelInlineStyle: modelFill.getAttribute('style'),
          eventMixHeight: eventMixFill.getAttribute('height'),
          eventMixFill: getComputedStyle(eventMixFill).fill,
          eventMixSvgDisplay: getComputedStyle(eventMixSvg).display,
          eventMixSvgHeight: Math.round(eventMixSvg.getBoundingClientRect().height),
          eventMixSvgBottomDelta: Math.round(eventMixBar.getBoundingClientRect().bottom - eventMixSvg.getBoundingClientRect().bottom),
        },
        legendItems,
        titleStylesMatch: {
          backgroundImage: historyTitleStyle.backgroundImage === panelTitleStyle.backgroundImage,
          color: historyTitleStyle.color === panelTitleStyle.color,
          fontSize: historyTitleStyle.fontSize === panelTitleStyle.fontSize,
          height: historyTitleStyle.height === panelTitleStyle.height,
        },
        kpiStripInHeader: historyHeader.contains(kpis),
        kpiWidthRatio: kpis.getBoundingClientRect().width / historyHeader.getBoundingClientRect().width,
        kpiSurfaceUsesRowBackground: getComputedStyle(kpis).backgroundColor === rowBgColor,
        filterBorderWidth: getComputedStyle(historyFilter).borderTopWidth,
        filterBackground: getComputedStyle(historyFilter).backgroundColor,
      };
    });
    expect(colors).toEqual({
      activityVar: '#0f63ce',
      activityFill: 'rgb(15, 99, 206)',
      activityFillCount: 1,
      failureRects: 0,
      nonTimeChartFills: {
        topToolShape: {
          flatRight: true,
          fillWidth: expect.any(Number),
          viewBoxWidth: expect.any(Number),
        },
        topToolFill: 'rgb(15, 99, 206)',
        topToolInlineStyle: null,
        modelShape: {
          flatRight: true,
          fillWidth: expect.any(Number),
          viewBoxWidth: expect.any(Number),
        },
        modelFill: 'rgb(15, 99, 206)',
        modelInlineStyle: null,
        eventMixHeight: '39.1',
        eventMixFill: 'rgb(225, 174, 69)',
        eventMixSvgDisplay: 'block',
        eventMixSvgHeight: 120,
        eventMixSvgBottomDelta: 0,
      },
      legendItems: ['Events'],
      titleStylesMatch: {
        backgroundImage: true,
        color: true,
        fontSize: true,
        height: true,
      },
      kpiStripInHeader: true,
      kpiWidthRatio: expect.any(Number),
      kpiSurfaceUsesRowBackground: true,
      filterBorderWidth: '0px',
      filterBackground: 'rgba(0, 0, 0, 0)',
    });
    expect(colors.nonTimeChartFills.topToolShape.fillWidth).toBeGreaterThan(5);
    expect(colors.nonTimeChartFills.topToolShape.viewBoxWidth).toBeGreaterThan(100);
    expect(colors.nonTimeChartFills.modelShape.fillWidth).toBeGreaterThan(5);
    expect(colors.nonTimeChartFills.modelShape.viewBoxWidth).toBeGreaterThan(100);
    expect(colors.kpiWidthRatio).toBeGreaterThan(0.92);
    expect(colors.kpiWidthRatio).toBeLessThanOrEqual(1);
  });

  test('History remains usable on narrow viewports', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await page.locator('#history-route-btn').click();

    await expect(page.locator('#history-screen')).toBeVisible();
    await expect(page.locator('#history-session-filter')).toBeVisible();
    const layout = await page.evaluate(() => {
      const screen = document.querySelector('#history-screen') as HTMLElement;
      const kpis = Array.from(document.querySelectorAll('.history-kpi')).map((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      return {
        screenLeft: screen.getBoundingClientRect().left,
        screenRight: screen.getBoundingClientRect().right,
        scrollHeight: screen.scrollHeight,
        clientHeight: screen.clientHeight,
        kpis,
      };
    });
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
    for (const kpi of layout.kpis) {
      expect(kpi.left).toBeGreaterThanOrEqual(layout.screenLeft);
      expect(kpi.right).toBeLessThanOrEqual(layout.screenRight);
    }
  });
});

test.describe('Agent Mission Control — Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await installFixture(page);
    await page.goto(GAME_URL);
    await waitForGame(page);
  });

  test('aggregate replay fires pulses across older turns by reconstructing from recent_tool_calls', async ({ page }) => {
    // Mirror the real mismatch: recent_turns span MORE history than the
    // global recent_events slice, and the older tool activity only survives
    // in recent_tool_calls. The aggregate replay must reconstruct from
    // recent_tool_calls so the early (older) turn windows still fire pulses,
    // instead of looking empty until the cursor reaches the recent slice.
    await page.evaluate(() => {
      const f = (window as any).__missionControlFixture;
      const alpha = f.sessions.find((s: any) => s.id === 'alpha123');
      // Older turns whose tools are NOT in recent_events.
      alpha.recent_turns = [
        { id: 'a-old1', started_at: '2026-05-21T06:00:00Z', ended_at: '2026-05-21T06:20:00Z', status: 'complete', tool_count: 1, tools: ['view'], failure_count: 0, categories: ['library'], output_tokens: 100 },
        { id: 'a-old2', started_at: '2026-05-21T06:30:00Z', ended_at: '2026-05-21T06:50:00Z', status: 'complete', tool_count: 1, tools: ['rg'], failure_count: 0, categories: ['library'], output_tokens: 100 },
      ];
      // Older tool calls retained per-session (cover the older turn windows).
      alpha.recent_tool_calls = [
        { tool: 'view', category: 'library', timestamp: '2026-05-21T06:15:00Z', success: true },
        { tool: 'rg', category: 'library', timestamp: '2026-05-21T06:45:00Z', success: true },
      ];
      // Make alpha the ONLY active session.
      const beta = f.sessions.find((s: any) => s.id === 'beta4567');
      beta.is_active = false;
      f.sessions = f.sessions.filter((s: any) => s.id !== 'gamma890');
      window.__cmcOnAgentActivityChanged?.();
    });
    await page.evaluate(() => (window as any).__cmcSelectSession('__all_sessions__'));

    const result = await page.evaluate(() => {
      const scene = (window as any).__phaserGame.scene.getScene('mission-control') as any;
      scene.replayPaused = false;
      scene.seekReplay(0);
      // Clear any leftover live pulses so we count ONLY pulses fired by
      // crossing the older turn windows below.
      scene.eventPulses = [];
      // Advance two playback steps (2 x 700ms) to cross only the two OLDER
      // turn windows — these have no events in the recent_events slice, so
      // pulses here prove reconstruction from recent_tool_calls.
      scene.advanceReplay(1500);
      return {
        cursor: scene.replayCursor,
        // tools that exist as real start events (these drive pulses), not
        // the tool labels carried by turn-summary positions.
        startEventTools: Array.from(new Set(
          scene.eventLog.filter((e: any) => e.kind === 'tool.execution_start').map((e: any) => e.tool)
        )),
        replayPulses: scene.eventPulses.filter((p: any) => p.source === 'replay').length,
      };
    });
    expect(result.cursor).toBe(2);
    // 'rg' only exists as a real tool.execution_start via recent_tool_calls
    // (older window); without reconstruction it would only be a turn label.
    expect(result.startEventTools).toContain('rg');
    expect(result.replayPulses).toBeGreaterThan(0);
  });

  test('dashboard renders fixture activity without manual refresh', async ({ page }) => {
    const state = await getMissionState(page);
    expect(state!.toolCalls).toBe(47);
    expect(state!.sessionCount).toBe(3);
    await expect(page.locator('#dom-workmix')).toHaveCount(0);
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      };
      return {
        session: rect('#dom-session'),
        actions: rect('#dom-session .cmc-actions'),
        summary: rect('#dom-session .cmc-session-summary'),
        pulse: rect('#dom-session .cmc-ops-tempo'),
        feed: rect('#dom-feed'),
        replay: rect('#dom-replay'),
        constrained: document.querySelector('#dom-session')?.classList.contains('constrained') ?? true,
      };
    });
    expect(layout.session).toBeTruthy();
    expect(layout.actions).toBeTruthy();
    expect(layout.summary).toBeTruthy();
    expect(layout.pulse).toBeTruthy();
    expect(layout.feed).toBeTruthy();
    expect(layout.replay).toBeTruthy();
    expect(layout.constrained).toBe(false);
    expect(layout.pulse!.top).toBeGreaterThanOrEqual(layout.summary!.bottom);
    expect(layout.actions!.top).toBeGreaterThanOrEqual(layout.pulse!.bottom);
    expect(layout.session!.bottom).toBeGreaterThanOrEqual(layout.actions!.bottom);
    expect(layout.feed!.top).toBeGreaterThanOrEqual(layout.session!.bottom + 8);
    expect(layout.feed!.bottom).toBeLessThanOrEqual(layout.replay!.top - 8);

    const sectorText = await page.locator('#dom-quarter').innerText();
    expect(sectorText).not.toContain('failed');
    expect(sectorText).not.toContain('!');
    expect(sectorText).not.toContain('Selected:');
  });

  test('dashboard Activity Rate renders selected-session activity density', async ({ page }) => {
    const tempo = page.locator('#dom-session .cmc-ops-tempo');
    await expect(tempo).toBeVisible();
    await expect(tempo).toContainText('Activity Rate');
    await expect(tempo).toContainText('Past hour');
    await expect(tempo).toContainText('5 activities/hr');
    await expect(tempo).toContainText('Past 5 min');
    await expect(tempo).toContainText('4 activities');
    await expect(tempo.locator('.cmc-tempo-heat-cell')).toHaveCount(24);
    await expect(tempo.locator('.cmc-tempo-heat-cell.has-failure')).toHaveCount(0);
    await tempo.locator('.cmc-tempo-heat-cell').last().hover();
    await expect(tempo.locator('.cmc-tempo-readout')).toContainText('4 activity items');
    await expect(tempo.locator('.cmc-tempo-readout')).toContainText('4 tool calls');
    await expect(tempo.locator('.cmc-tempo-readout')).toContainText('-');
    await expect(tempo.locator('.cmc-tempo-readout')).not.toContainText('failure');
    await expect(tempo.locator('.cmc-tempo-readout')).not.toContainText('Z');
  });

  test('dashboard Activity Rate is scoped to the selected session', async ({ page }) => {
    const tempo = page.locator('#dom-session .cmc-ops-tempo');
    await expect(tempo).toContainText('5 activities/hr');
    await expect(tempo).toContainText('4 activities');

    await selectSession(page, 'alpha123');

    await expect(tempo).toContainText('1 activity/hr');
    await expect(tempo).toContainText('1 activity');
  });

  test('dashboard Activity Rate omits duplicate status label', async ({ page }) => {
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    const selected = fixture.sessions.find((session: any) => session.id === 'beta4567');
    selected.activity_signal = {
      generated_at_ms: Date.parse('2026-05-21T07:20:00Z'),
      launches_last_5m: 14,
      launches_last_hour: 18,
      velocity_per_hour: 18,
      peak_velocity_per_hour: 18,
      peak_hour_event_count_24h: 18,
      busiest_hour_label_24h: '07:00Z',
      active_hours_24h: 4,
      hourly_24h: signalBuckets(),
    };
    await page.addInitScript((fixtureArg) => {
      (window as any).__missionControlFixture = fixtureArg;
    }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    const tempo = page.locator('#dom-session .cmc-ops-tempo');
    await expect(tempo).toContainText('Past hour');
    await expect(tempo).toContainText('18 activities/hr');
    await expect(tempo).toContainText('Past 5 min');
    await expect(tempo).toContainText('14 activities');
    await expect(tempo.locator('.cmc-ops-tempo-head strong')).toHaveCount(0);
    await expect(tempo).not.toContainText('High activity');
  });

  test('dashboard Activity Rate handles activity without a signal payload', async ({ page }) => {
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    delete fixture.activity_signal;
    await page.addInitScript((fixtureArg) => {
      (window as any).__missionControlFixture = fixtureArg;
    }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    const tempo = page.locator('#dom-session .cmc-ops-tempo');
    await expect(tempo).toBeVisible();
    await expect(tempo).toContainText('Past hour');
    await expect(tempo).toContainText('idle');
    await expect(tempo.locator('.cmc-tempo-heat-cell')).toHaveCount(24);
  });

  test('Recent Activity Feed fills remaining vertical space and scrolls overflow', async ({ page }) => {
    await selectSession(page, 'alpha123');
    await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      fixture.recent_events = Array.from({ length: 12 }, (_, index) => ({
        session_id: 'alpha123',
        timestamp: new Date(Date.parse('2026-05-21T07:00:00Z') + index * 1000).toISOString(),
        kind: 'tool.execution_start',
        tool: `view-${index}`,
        category: 'library',
        success: true,
      })).reverse();
      window.__cmcOnAgentActivityChanged?.();
    });

    await expect.poll(async () => page.locator('#dom-feed .cmc-feed-row').count()).toBeGreaterThanOrEqual(12);
    const feedMetrics = await page.evaluate(() => {
      const panel = document.querySelector('#dom-feed') as HTMLElement;
      const body = document.querySelector('#dom-feed .cmc-panel-body') as HTMLElement;
      const replay = document.querySelector('#dom-replay') as HTMLElement;
      const panelRect = panel.getBoundingClientRect();
      const replayRect = replay.getBoundingClientRect();
      return {
        panelHeight: Math.round(panelRect.height),
        panelBottom: Math.round(panelRect.bottom),
        replayTop: Math.round(replayRect.top),
        clientHeight: Math.round(body.clientHeight),
        scrollHeight: Math.round(body.scrollHeight),
      };
    });
    expect(feedMetrics.panelHeight).toBeGreaterThan(260);
    expect(feedMetrics.panelBottom).toBeLessThanOrEqual(feedMetrics.replayTop - 8);
    expect(feedMetrics.scrollHeight).toBeGreaterThan(feedMetrics.clientHeight);
  });

  test('sector details omit secondary tool summary text', async ({ page }) => {
    await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
      beta.recent_tool_calls = [
        { tool: 'postToolUse', category: 'hooks', timestamp: '2026-05-21T07:13:30Z', success: true, call_id: 'hook-post' },
        { tool: 'preToolUse', category: 'hooks', timestamp: '2026-05-21T07:13:00Z', success: true, call_id: 'hook-pre' },
      ];
      window.__cmcOnAgentActivityChanged?.();
    });

    const state = await getMissionState(page);
    const hooks = state!.quarterRects.find((d: any) => d.key === 'hooks');
    expect(hooks).toBeTruthy();
    const off = await canvasOffset(page);
    await page.mouse.move(off.x + hooks!.x, off.y + hooks!.y);
    await expect.poll(async () => (await getMissionState(page))!.inspectedQuarterKey).toBe('hooks');

    const sector = page.locator('#dom-quarter');
    await expect(sector).toContainText('2 selected-session hooks signals');
    await expect(sector).not.toContainText('Also:');
    await expect(sector.locator('.cmc-quarter-tools')).toHaveCount(0);
    await expect(sector.locator('[data-cmc-action="quarter-details"]')).toBeVisible();
  });

  test('session dropdown prefers friendly session names and hides unknown repository placeholders', async ({ page }) => {
    await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
      beta.title = 'Fix Missing Input Tokens Display';
      beta.session_name = 'Fix Missing Input Tokens Display';
      const gamma = fixture.sessions.find((session: any) => session.id === 'gamma890');
      gamma.title = 'Investigate Retained Session';
      gamma.repository = 'unknown repo';
      gamma.branch = '|-';
      window.__cmcOnAgentActivityChanged?.();
    });

    await expect(page.locator('#dom-session .cmc-session-title')).toHaveText('Fix Missing Input Tokens Display');
    await expect(page.locator('#dom-session .cmc-session-subtitle')).toHaveText('copilot-mission-control / main');

    await page.locator('#dom-session [data-cmc-action="session-menu"]').click();
    const selectedOption = page.locator('#dom-session .cmc-session-option.selected');
    await expect(selectedOption.locator('.cmc-session-option-main')).toContainText('Fix Missing Input Tokens Display');
    await expect(selectedOption.locator('.cmc-session-status-label')).toHaveText('active');
    await expect(selectedOption.locator('.cmc-session-option-sub')).toContainText('copilot-mission-control main · beta4567');
    await expect(page.locator('#dom-session .cmc-session-option').filter({ hasText: 'Build Mission Control' }).filter({ hasText: 'copilot-mission-control main · alpha123' })).toHaveCount(1);
    const idleOption = page.locator('#dom-session .cmc-session-option').filter({ hasText: 'Investigate Retained Session' });
    await expect(idleOption).toHaveCount(1);
    await expect(idleOption).not.toContainText('unknown repo');
    await expect(idleOption).not.toContainText('|-');
    await expect(idleOption.locator('.cmc-session-option-sub')).toHaveText('gamma890');
    await expect(idleOption.locator('.cmc-session-status-label')).toHaveText('idle');
  });

  test('idle sessions remain selectable under an Idle heading when All Active Sessions is selected', async ({ page }) => {
    // Select the aggregate "All Active Sessions" — the dashboard default in
    // the real app. This previously hid idle/previous sessions from the
    // dropdown, making them unreachable from the dashboard (you cannot
    // select what is not listed).
    await page.locator('#dom-session [data-cmc-action="session-menu"]').click();
    await page.locator('#dom-session [data-session-id="__all_sessions__"]').click();
    await expect.poll(async () => (await getMissionState(page))!.selectedSessionId).toBe('__all_sessions__');

    // Reopen the picker: the idle session is still listed, under an "Idle"
    // heading, and can be selected.
    await page.locator('#dom-session [data-cmc-action="session-menu"]').click();
    const menu = page.locator('#dom-session .cmc-session-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.cmc-session-group-heading')).toHaveText('Idle');

    const idleOption = page.locator('#dom-session .cmc-session-option').filter({ hasText: 'Research UI' });
    await expect(idleOption).toHaveCount(1);
    await expect(idleOption.locator('.cmc-session-status-label')).toHaveText('idle');

    await idleOption.click();
    await expect.poll(async () => (await getMissionState(page))!.selectedSessionId).toBe('gamma890');
  });

  test('idle session replay reconstructs pulse-able tool events from recent_tool_calls when raw events have aged out', async ({ page }) => {
    // Simulate a real idle/older session: its raw events have scrolled out
    // of the global recent_events window, but its per-session
    // recent_tool_calls + recent_turns snapshots are still retained. The
    // replay must rebuild a pulse-able timeline from those snapshots rather
    // than degrade to turn summaries that fire no pulses.
    await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      const gamma = fixture.sessions.find((session: any) => session.id === 'gamma890');
      gamma.recent_tool_calls = [
        { tool: 'rg', category: 'library', timestamp: '2026-05-21T07:10:30Z', success: true },
        { tool: 'apply_patch', category: 'edits', timestamp: '2026-05-21T07:11:40Z', success: true },
      ];
      // Drop gamma890 from the global recent_events window so the replay is
      // forced down the reconstruction path.
      fixture.recent_events = fixture.recent_events.filter((event: any) => event.session_id !== 'gamma890');
      window.__cmcOnAgentActivityChanged?.();
    });

    await page.evaluate(() => (window as any).__cmcSelectSession('gamma890'));
    await expect.poll(async () => (await getMissionState(page))!.selectedSessionId).toBe('gamma890');

    const state = await getMissionState(page);
    // The activity log now carries the retained tool calls as pulse-able
    // events (this is what drives the Phaser sector pulses).
    expect(state!.eventLogTools).toContain('rg');
    expect(state!.eventLogTools).toContain('apply_patch');
    expect(state!.eventLogSessionIds).toEqual(['gamma890']);
    // The scrubber positions still come from the session's turn boundaries.
    expect(state!.replayTimelineKinds).toEqual(['assistant.turn_start']);
    expect(state!.replayTimelineLength).toBe(2);
  });

  test('session dropdown stays open when live activity refreshes', async ({ page }) => {
    await page.locator('#dom-session [data-cmc-action="session-menu"]').click();
    await expect(page.locator('#dom-session .cmc-session-picker')).toHaveClass(/open/);

    await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
      beta.stale_seconds = Number(beta.stale_seconds || 0) + 1;
      window.__cmcOnAgentActivityChanged?.();
    });

    await expect(page.locator('#dom-session .cmc-session-picker')).toHaveClass(/open/);
    await expect(page.locator('#dom-session .cmc-session-menu')).toBeVisible();
  });

  test('reset button clears visible counters and keeps old file data hidden after refresh', async ({ page }) => {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#reset-btn')).toBeVisible();
    await page.locator('#reset-btn').click();

    await expect.poll(async () => {
      const state = await getMissionState(page);
      return {
        reset: state!.activityResetAtMs !== null,
        tokens: [state!.selectedInputTokens, state!.selectedOutputTokens],
        total: state!.replayState.total,
        edits: state!.quarterCounts.edits,
        library: state!.quarterCounts.library,
      };
    }).toEqual({
      reset: true,
      tokens: [0, 0],
      total: 0,
      edits: 0,
      library: 0,
    });
    await expect(page.locator('#dom-session .cmc-ops-tempo')).toContainText('idle');
    await expect(page.locator('#dom-session .cmc-ops-tempo')).toContainText('0 activities');

    await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
      const oldTimestamp = '2026-05-21T07:16:00Z';
      const newTimestamp = new Date(Date.now() + 1000).toISOString();
      beta.input_tokens = 1450;
      beta.output_tokens = 3220;
      beta.recent_tool_calls = [
        { tool: 'view', category: 'library', timestamp: oldTimestamp, success: true, call_id: 'old-view' },
        { tool: 'apply_patch', category: 'edits', timestamp: newTimestamp, success: true, call_id: 'new-patch' },
      ];
      beta.token_checkpoints = [
        { timestamp: oldTimestamp, input_tokens: 1300, output_tokens: 3000 },
        { timestamp: newTimestamp, input_tokens: 1450, output_tokens: 3220 },
      ];
      fixture.recent_events = [
        { session_id: 'beta4567', timestamp: newTimestamp, kind: 'tool.execution_start', tool: 'apply_patch', category: 'edits', success: true },
        { session_id: 'beta4567', timestamp: oldTimestamp, kind: 'tool.execution_start', tool: 'view', category: 'library', success: true },
        ...fixture.recent_events,
      ];
      window.__cmcOnAgentActivityChanged?.();
    });

    await expect.poll(async () => {
      const state = await getMissionState(page);
      return {
        tokens: [state!.selectedInputTokens, state!.selectedOutputTokens],
        total: state!.replayState.total,
        edits: state!.quarterCounts.edits,
        library: state!.quarterCounts.library,
      };
    }).toEqual({
      tokens: [250, 300],
      total: 1,
      edits: 1,
      library: 0,
    });
    await expect(page.locator('#dom-session .cmc-ops-tempo')).toContainText('1 activity/hr');
    await expect(page.locator('#dom-session .cmc-ops-tempo')).toContainText('1 activity');
  });

  test('selected session summary uses recent meaningful tool activity', async ({ page }) => {
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
    const now = Date.now();
    beta.last_event_kind = 'session.shutdown';
    beta.last_event_category = 'complete';
    beta.last_event_timestamp = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    beta.stale_seconds = 7200;
    beta.last_tool = 'report_intent';
    beta.recent_tool_calls = [
      {
        tool: 'bash',
        category: 'terminal',
        timestamp: new Date(now - 2000).toISOString(),
        completed_at: new Date(now - 1000).toISOString(),
        success: true,
        duration_ms: 1000,
        call_id: 'call-bash-current',
        turn_id: 'turn-current',
        target: 'bash',
        details: [],
      },
      {
        tool: 'report_intent',
        category: 'court',
        timestamp: new Date(now).toISOString(),
        completed_at: new Date(now).toISOString(),
        success: true,
        duration_ms: 0,
        call_id: 'call-intent-current',
        turn_id: 'turn-current',
        target: 'report_intent',
        details: [],
      },
    ];

    await page.addInitScript((f) => { (window as any).__missionControlFixture = f; }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    const text = await page.locator('#dom-session').innerText();
    expect(text).toContain('Last: bash completed');
    expect(text).toContain('Tool: bash');
    expect(text).toContain('Tokens in/out: 1,200 / 2,920');
    expect(text).toMatch(/Age: \d+s/);
    expect(text).not.toContain('session.shutdown');
    expect(text).not.toContain('report_intent');
    expect(text).not.toContain('Age: 2h');

    const labelTops = await page.locator('#dom-session .cmc-meta-label').evaluateAll((labels) =>
      labels.map((label) => Math.round((label as HTMLElement).getBoundingClientRect().top)),
    );
    expect(labelTops).toHaveLength(5);
    expect(new Set(labelTops).size).toBe(5);
    expect(labelTops).toEqual([...labelTops].sort((a, b) => a - b));
  });

  test('selected session shows pending input tokens until usage summary is emitted', async ({ page }) => {
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    fixture.sessions.forEach((session: any) => {
      session.is_active = false;
      session.status = 'idle';
    });
    const alpha = fixture.sessions.find((session: any) => session.id === 'alpha123');
    alpha.input_tokens = 0;
    alpha.output_tokens = 4200;
    alpha.token_checkpoints = [
      { timestamp: '2026-05-21T07:13:00Z', input_tokens: 0, output_tokens: 900 },
    ];

    await page.addInitScript((f) => {
      (window as any).__missionControlFixture = f;
    }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    await expect(page.locator('#dom-session .cmc-session-meta')).toContainText('Tokens in/out: pending / 4,200');
  });

  test('History selected session shows pending input tokens until usage summary is emitted', async ({ page }) => {
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    const alpha = fixture.history.recent_sessions.find((session: any) => session.id === 'alpha123');
    alpha.input_tokens = 0;
    alpha.output_tokens = 4200;
    const alphaScope = fixture.history.session_scopes.find((scope: any) => scope.session_id === 'alpha123');
    alphaScope.recent_sessions[0].input_tokens = 0;
    alphaScope.recent_sessions[0].output_tokens = 4200;

    await page.addInitScript((f) => {
      (window as any).__missionControlFixture = f;
    }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    await page.locator('#history-route-btn').click();
    await page.locator('#history-session-filter').selectOption('alpha123');

    await expect(page.locator('.history-token-kpi').filter({ hasText: 'Input Tokens' })).toContainText('pending');
    await expect(page.locator('.history-token-kpi').filter({ hasText: 'Output Tokens' })).toContainText('4,200');
  });

  test('provider scan warnings appear in the selected session panel', async ({ page }) => {
    const fixture = {
      ...MISSION_FIXTURE,
      alerts: [
        'Could not read home folders in \'Ubuntu\'. Start the WSL distro to enable scanning.',
      ],
    };
    await installFixture(page, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);
    await expect(page.locator('#dom-session .cmc-provider-alert')).toContainText('home folders in \'Ubuntu\'');
    await expect(page.locator('#provider-alert-overlay')).toHaveCount(0);
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
    expect(state!.replayState.total).toBe(1);
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
        session_id: 'beta4567',
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

  test('hook events route to the Hooks sector flow', async ({ page }) => {
    await page.waitForTimeout(800);
    const queued = await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      const newEvent = {
        session_id: 'beta4567',
        timestamp: new Date().toISOString(),
        kind: 'hook.start',
        tool: 'postToolUse',
        category: 'hooks',
        success: true,
      };
      fixture.recent_events = [newEvent, ...fixture.recent_events];
      (window as any).__cmcOnAgentActivityChanged?.();
      return true;
    });
    expect(queued).toBe(true);
    await page.waitForTimeout(250);
    const state = await getMissionState(page);
    expect(state!.activeEventPulseCount).toBeGreaterThan(0);
    await expect(page.locator('#dom-feed')).toContainText('postToolUse hook started');
  });

  test('live pushes update sector details while pulse animation is active', async ({ page }) => {
    await page.waitForTimeout(800);
    const state = await getMissionState(page);
    const hooks = state!.quarterRects.find((d: any) => d.key === 'hooks');
    expect(hooks).toBeTruthy();
    const off = await canvasOffset(page);
    await page.mouse.move(off.x + hooks!.x, off.y + hooks!.y);
    await expect.poll(async () => (await getMissionState(page))!.inspectedQuarterKey).toBe('hooks');
    await expect(page.locator('#dom-quarter')).toContainText('2 selected-session hooks signals');

    await page.evaluate(() => {
      const scene = (window as any).__phaserGame.scene.getScene('mission-control') as any;
      const original = scene.renderActivity.bind(scene);
      scene.__testRenderActivityCount = 0;
      scene.renderActivity = function (...args: any[]) {
        scene.__testRenderActivityCount++;
        return original(...args);
      };
    });
    await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
      const hookEvents = Array.from({ length: 4 }, (_, i) => ({
        session_id: 'beta4567',
        timestamp: new Date(Date.now() + i).toISOString(),
        kind: 'hook.start',
        tool: 'postToolUse',
        category: 'hooks',
        success: true,
      }));
      beta.hooks_count += hookEvents.length;
      beta.tool_count += hookEvents.length;
      beta.event_count += hookEvents.length;
      fixture.total_tool_calls += hookEvents.length;
      fixture.total_events += hookEvents.length;
      fixture.recent_events = [...hookEvents, ...fixture.recent_events];
      (window as any).__cmcOnAgentActivityChanged?.();
    });

    await expect.poll(async () => {
      const mid = await getMissionState(page);
      return {
        active: mid!.activeEventPulseCount > 0,
        hooks: mid!.quarterCounts.hooks,
      };
    }).toEqual({ active: true, hooks: 6 });
    await expect(page.locator('#dom-quarter')).toContainText('6 selected-session hooks signals');

    await page.waitForTimeout(1000);
    const renderStats = await page.evaluate(() => {
      const scene = (window as any).__phaserGame.scene.getScene('mission-control') as any;
      return {
        active: scene.activeEventPulseCount > 0,
        fullRenders: scene.__testRenderActivityCount,
      };
    });
    expect(renderStats.active).toBe(true);
    expect(renderStats.fullRenders).toBe(0);
  });

  test('replay timeline is scoped to the selected session and stays live by default', async ({ page }) => {
    const state = await getMissionState(page);
    expect(state!.selectedSessionId).toBe('beta4567');
    expect(state!.eventLogSessionIds).toEqual(['beta4567']);
    expect(state!.replayTimelineKinds).toEqual(['assistant.turn_start']);
    expect(state!.replayState.total).toBe(1);
    expect(state!.replayState.cursor).toBe(1);
    expect(state!.replayState.atLive).toBe(true);
    expect(state!.replayState.paused).toBe(false);
    await expect(page.locator('#dom-replay [data-cmc-action="replay-toggle"]')).toBeVisible();
    await expect(page.locator('#dom-replay [data-cmc-action="replay-seek"]')).toBeVisible();
    await expect(page.locator('#dom-feed .cmc-panel-title')).toHaveText('Recent Activity Feed');
    await expect(page.locator('#dom-replay .cmc-replay-status')).toContainText('Selected session turn replay');

    await selectSession(page, 'alpha123');
    const alpha = await getMissionState(page);
    expect(alpha!.eventLogSessionIds).toEqual(['alpha123']);
    expect(alpha!.replayTimelineKinds).toEqual(['assistant.turn_start']);
    expect(alpha!.replayState.total).toBe(2);
    expect(alpha!.replayState.cursor).toBe(2);
  });

  test('replay controls align with the timeline rail', async ({ page }) => {
    const metrics = await page.evaluate(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) throw new Error(`missing ${selector}`);
        const r = el.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          height: r.height,
          center: (r.top + r.bottom) / 2,
        };
      };
      return {
        panel: rect('#dom-replay'),
        toggle: rect('#dom-replay [data-cmc-action="replay-toggle"]'),
        live: rect('#dom-replay [data-cmc-action="replay-live"]'),
        rail: rect('#dom-replay .cmc-replay-rail'),
        status: rect('#dom-replay .cmc-replay-status'),
      };
    });

    expect(Math.abs(metrics.toggle.height - metrics.live.height)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(metrics.toggle.center - metrics.rail.center)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(metrics.live.center - metrics.rail.center)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(metrics.panel.center - metrics.rail.center)).toBeLessThanOrEqual(0.5);
    expect(metrics.status.top).toBeGreaterThanOrEqual(metrics.rail.bottom + 8);
    expect(metrics.status.bottom).toBeLessThanOrEqual(metrics.panel.bottom);
  });

  test('idle sessions use recent turns as replay checkpoints when recent events are absent', async ({ page }) => {
    await selectSession(page, 'gamma890');
    const state = await getMissionState(page);
    expect(state!.selectedSessionId).toBe('gamma890');
    expect(state!.eventLogSessionIds).toEqual(['gamma890']);
    expect(state!.eventLogTools).toContain('web_fetch');
    expect(state!.replayTimelineKinds).toEqual(['assistant.turn_start']);
    expect(state!.replayState.total).toBe(2);
    expect(state!.replayState.cursor).toBe(2);
    await expect(page.locator('#dom-replay .cmc-replay-status')).toContainText('2 / 2');
  });

  test('selected session replay sorts raw events newest-first before ingesting', async ({ page }) => {
    await selectSession(page, 'alpha123');
    const state = await getMissionState(page);
    expect(state!.eventLogTools).toEqual(['thinking', 'view', 'thinking', 'apply_patch']);
    expect(state!.replayTimelineTimestamps).toEqual([
      '2026-05-21T07:12:30Z',
      '2026-05-21T07:14:30Z',
    ]);
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
    await selectSession(page, 'alpha123');
    const selected = await getMissionState(page);
    expect(selected!.replayState.total).toBe(2);
    const track = page.locator('#dom-replay [data-cmc-action="replay-seek"]');
    const box = await track.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.click(box!.x + box!.width * 0.25, box!.y + box!.height / 2);
    await page.waitForTimeout(120);
    const after = await getMissionState(page);
    expect(after!.replayState.cursor).toBeLessThan(selected!.replayState.cursor);
    expect(after!.replayState.atLive).toBe(false);
    await expect(page.locator('#dom-feed .cmc-panel-title')).toHaveText('Recent Activity Feed · replay cursor');
    await expect(page.locator('#dom-feed')).toContainText('view');
    await expect(page.locator('#dom-feed .cmc-feed-row').first()).toContainText('at cursor');
  });

  test('turn replay emits Phaser pulses for raw events inside each turn', async ({ page }) => {
    await selectSession(page, 'alpha123');
    const track = page.locator('#dom-replay [data-cmc-action="replay-seek"]');
    await track.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(120);
    expect((await getMissionState(page))!.replayState.cursor).toBe(0);

    await expect.poll(async () => (await getMissionState(page))!.activeEventPulseCount, { timeout: 1600 })
      .toBeGreaterThan(0);
  });

  test('selected session stats reflect replay cursor activity', async ({ page }) => {
    await selectSession(page, 'alpha123');
    const track = page.locator('#dom-replay [data-cmc-action="replay-seek"]');
    const box = await track.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height / 2);
    await page.waitForTimeout(120);

    const meta = page.locator('#dom-session .cmc-session-meta');
    await expect(meta).toContainText('Last: view started');
    await expect(meta).toContainText('Tool: view');
    await expect(meta).toContainText('Age: at cursor');
    await expect(meta).toContainText('Tokens in/out: 100 / 200');

    await page.mouse.click(box!.x + box!.width * 0.95, box!.y + box!.height / 2);
    await page.waitForTimeout(120);
    await expect(meta).toContainText('Tokens in/out: 1,600 / 4,200');
  });

  test('replay shows pending input tokens until an input checkpoint exists', async ({ page }) => {
    await page.evaluate(() => {
      const fixture = (window as any).__missionControlFixture;
      const alpha = fixture.sessions.find((session: any) => session.id === 'alpha123');
      alpha.input_tokens = 0;
      alpha.output_tokens = 4200;
      alpha.token_checkpoints = [];
      fixture.recent_events = fixture.recent_events.map((event: any) =>
        event.session_id === 'alpha123' && event.kind === 'tool.execution_start'
          ? { ...event, output_tokens: event.tool === 'view' ? 900 : 4200 }
          : event
      );
      (window as any).__cmcOnAgentActivityChanged?.();
    });
    await selectSession(page, 'alpha123');
    const track = page.locator('#dom-replay [data-cmc-action="replay-seek"]');
    const box = await track.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height / 2);
    await page.waitForTimeout(120);

    await expect(page.locator('#dom-session .cmc-session-meta')).toContainText('Tokens in/out: pending / 900');
    await expect(page.locator('#dom-session .cmc-token-pending')).toHaveAttribute('title', /input tokens usually arrive later/i);
  });

  test('replay timeline exposes keyboard slider controls', async ({ page }) => {
    const track = page.locator('#dom-replay [data-cmc-action="replay-seek"]');
    await expect(track).toHaveAttribute('role', 'slider');
    await track.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(120);
    let state = await getMissionState(page);
    expect(state!.replayState.cursor).toBe(0);

    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(120);
    state = await getMissionState(page);
    expect(state!.replayState.cursor).toBe(1);
  });

  test('clicking a running session selects it for inspection', async ({ page }) => {
    const before = await getMissionState(page);
    expect(before!.selectedSessionId).toBe('beta4567');
    await selectSession(page, 'alpha123');

    const after = await getMissionState(page);
    expect(after!.selectedSessionId).toBe('alpha123');
    expect(after!.quarterCounts).toMatchObject({
      edits: 8,
      library: 9,
      terminal: 4,
      signal: 1,
      hooks: 3,
      delegates: 1,
      skills: 2,
      court: 4,
      mcp: 1,
    });
  });

  test('persisted idle session selection is kept when another session is running', async ({ page }) => {
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    fixture.sessions.push({
      id: 'stale999',
      title: 'Stale Same Repo',
      repository: 'copilot-mission-control',
      branch: 'main',
      updated_at: '',
      is_active: false,
      status: 'idle',
      event_count: 10,
      tool_count: 3,
      write_count: 0,
      read_count: 1,
      command_count: 2,
      web_count: 0,
      task_count: 0,
      error_count: 0,
      output_tokens: 60000,
      input_tokens: 669000,
      last_tool: 'bash',
      last_event_kind: 'session.shutdown',
      last_event_category: 'complete',
      stale_seconds: 7200,
      recent_tool_calls: [],
    });

    await page.addInitScript((f) => {
      localStorage.setItem('cmc_prefs', JSON.stringify({ lastSelectedSessionId: 'stale999' }));
      (window as any).__missionControlFixture = f;
    }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    const state = await getMissionState(page);
    expect(state!.selectedSessionId).toBe('stale999');
    const text = await page.locator('#dom-session').innerText();
    expect(text).toContain('Stale Same Repo');
    expect(text).toContain('Tokens in/out: 669,000 / 60,000');
    expect(text).toContain('Age: 2h');
  });

  test('inspector filters MCP, skills, and sub-agent calls with details', async ({ page }) => {
    await page.addInitScript((fixture) => { (window as any).__missionControlFixture = fixture; }, inspectorFixture());
    await page.goto(GAME_URL);
    await waitForGame(page);

    const state = await getMissionState(page);
    expect(state!.selectedSessionId).toBe('beta4567');
    await page.locator('#dom-session [data-cmc-action="inspector"]').click();
    await expect(page.locator('#inspector-overlay')).toHaveClass(/visible/);
    await expect(page.locator('#inspector-title')).toContainText('Review Tests');

    let text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('Details');
    expect(text).toContain('code-reviewer');
    expect(text).toContain('Sub-agent');
    expect(text).toContain('arguments/output hidden');
    expect(text).toContain('Reveal raw local details');
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
    await expect(page.locator('#dom-session [data-cmc-action="inspector"]')).toBeFocused();
  });

  test('dashboard renders Copilot App sessions that only have a cwd-derived scope', async ({ page }) => {
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    fixture.sessions.unshift({
      id: 'appcwd12',
      session_name: 'Planning copilot app course',
      title: 'Planning copilot app course',
      repository: 'github-copilot-app-for-beginners',
      branch: '',
      git_root: '/Users/danwahlin/Desktop/projects/github-copilot-app-for-beginners',
      updated_at: '2026-06-21T01:19:36.912Z',
      is_active: true,
      status: 'working',
      event_count: 12,
      tool_count: 4,
      write_count: 0,
      read_count: 2,
      command_count: 2,
      web_count: 0,
      task_count: 0,
      delegates_count: 0,
      skills_count: 0,
      court_count: 0,
      mcp_count: 0,
      hooks_count: 0,
      error_count: 0,
      input_tokens: 0,
      output_tokens: 120,
      last_tool: 'list_projects',
      last_event_kind: 'tool.execution_complete',
      last_event_category: 'intent',
      stale_seconds: 30,
      recent_tool_calls: [],
      token_checkpoints: [{ timestamp: '2026-06-21T01:19:36Z', output_tokens: 120 }],
    });
    fixture.recent_events.unshift({
      session_id: 'appcwd12',
      timestamp: '2026-06-21T01:19:36Z',
      kind: 'tool.execution_complete',
      tool: 'list_projects',
      category: 'intent',
      success: true,
    });

    await page.addInitScript((activity) => { (window as any).__missionControlFixture = activity; }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    await page.locator('[data-cmc-action="session-menu"]').click();
    await expect(page.locator('.cmc-session-menu')).toContainText('Planning copilot app course');
    await expect(page.locator('.cmc-session-menu')).toContainText('github-copilot-app-for-beginners');
    await page.locator('[data-session-id="appcwd12"]').click();

    const state = await getMissionState(page);
    expect(state!.selectedSessionId).toBe('appcwd12');
    const sessionText = await page.locator('#dom-session').innerText();
    expect(sessionText).toContain('Planning copilot app course');
    expect(sessionText).toContain('github-copilot-app-for-beginners');
    expect(sessionText).not.toContain('Unknown');
    expect(sessionText).not.toContain('github-copilot-app-for-beginners / unknown');
    await expect(page.locator('#dom-session [data-cmc-action="editor"]')).toBeEnabled();
  });

  test('All Sessions aggregates active metrics, feed rows, replay, and sector counts', async ({ page }) => {
    await page.addInitScript((activity) => { (window as any).__missionControlFixture = activity; }, MISSION_FIXTURE);
    await page.goto(GAME_URL);
    await waitForGame(page);

    await page.locator('#dom-session [data-cmc-action="session-menu"]').click();
    const options = page.locator('#dom-session .cmc-session-option');
    await expect(options.first()).toContainText('All Active Sessions');
    await expect(options.first()).toContainText('2 active');
    await expect(options.first()).not.toContainText('inactive');
    await expect(options.first().locator('.cmc-session-status-label')).toHaveCount(0);
    await expect(options.first()).not.toContainText('all');
    await page.locator('#dom-session [data-session-id="__all_sessions__"]').click();

    await expect.poll(async () => (await getMissionState(page))!.selectedSessionId).toBe('__all_sessions__');
    const state = await getMissionState(page);
    expect(state!.selectedInputTokens).toBe(2800);
    expect(state!.selectedOutputTokens).toBe(7120);
    expect(state!.selectedToolCount).toBe(40);
    expect(state!.eventLogSessionIds.sort()).toEqual(['alpha123', 'beta4567']);
    expect(state!.replayTimelineLength).toBeGreaterThanOrEqual(3);
    expect(state!.quarterCounts).toMatchObject({
      edits: 10,
      library: 16,
      terminal: 10,
      signal: 1,
      hooks: 5,
      delegates: 3,
      skills: 5,
      court: 5,
      mcp: 5,
    });

    const sessionText = await page.locator('#dom-session').innerText();
    expect(sessionText).toContain('All Active Sessions');
    expect(sessionText).toContain('2 active');
    expect(sessionText).not.toContain('inactive');
    await expect(page.locator('#dom-session .cmc-session-summary .cmc-actions')).toHaveCount(0);
    await expect(page.locator('#dom-session [data-cmc-action="editor"]')).toHaveCount(0);
    await expect(page.locator('#dom-session [data-cmc-action="inspector"]')).toHaveCount(0);
    await page.locator('#dom-session [data-cmc-action="session-menu"]').click();
    await expect(page.locator('#dom-session .cmc-session-menu')).toContainText('Build Mission Control');
    await expect(page.locator('#dom-session .cmc-session-menu')).toContainText('Review Tests');
    // Idle/previous sessions stay listed (and selectable) in the dropdown
    // even when the aggregate is selected, grouped under an "Idle" heading.
    // The aggregate's map/feed still aggregate only ACTIVE sessions — see
    // the feed assertions below — so this is purely a picker affordance.
    await expect(page.locator('#dom-session .cmc-session-menu')).toContainText('Research UI');
    await expect(page.locator('#dom-session .cmc-session-menu .cmc-session-group-heading')).toHaveText('Idle');
    await page.keyboard.press('Escape');
    await expect(page.locator('#dom-quarter .cmc-quarter-actions')).toHaveCount(1);
    await expect(page.locator('#dom-quarter [data-cmc-action="quarter-details"]')).toBeVisible();
    await expect(page.locator('#dom-quarter')).not.toContainText('all-sessions');
    await expect(page.locator('#dom-feed')).toContainText('Build Mission Control · apply_patch');
    await expect(page.locator('#dom-feed')).toContainText('Review Tests · tool failed');
    await expect(page.locator('#dom-feed')).not.toContainText('Research UI · web_fetch');
    await expect(page.locator('#dom-replay')).toContainText('All sessions turn replay');
  });

  test('All Sessions animates live events from multiple active sessions', async ({ page }) => {
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    await page.addInitScript((activity) => { (window as any).__missionControlFixture = activity; }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);
    await selectSession(page, '__all_sessions__');

    const nextFixture = JSON.parse(JSON.stringify(fixture));
    nextFixture.recent_events.unshift(
      { session_id: 'alpha123', timestamp: '2026-05-21T07:16:00Z', kind: 'tool.execution_start', tool: 'apply_patch', category: 'edits', success: true },
      { session_id: 'beta4567', timestamp: '2026-05-21T07:16:05Z', kind: 'tool.execution_start', tool: 'browser_navigate', category: 'mcp', success: true },
    );
    nextFixture.sessions[0].write_count += 1;
    nextFixture.sessions[0].tool_count += 1;
    nextFixture.sessions[0].event_count += 1;
    nextFixture.sessions[1].mcp_count += 1;
    nextFixture.sessions[1].tool_count += 1;
    nextFixture.sessions[1].event_count += 1;
    await page.evaluate((activity) => {
      (window as any).__missionControlFixture = activity;
      (window as any).__cmcOnAgentActivityChanged();
    }, nextFixture);

    await expect.poll(async () => {
      const state = await getMissionState(page);
      return {
        selected: state!.selectedSessionId,
        activePulses: state!.activeEventPulseCount > 0,
        sessions: state!.eventLogSessionIds.sort(),
      };
    }).toEqual({
      selected: '__all_sessions__',
      activePulses: true,
      sessions: ['alpha123', 'beta4567'],
    });
  });

  test('inspector reveals raw local details only after explicit opt-in', async ({ page }) => {
    await page.addInitScript((fixture) => {
      (window as any).__missionControlFixture = fixture;
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (command: string, args: any) => {
          if (command !== 'get_raw_tool_call_details') throw new Error(`unexpected command ${command}`);
          if (args.eventRef === 'evt-4') {
            return {
              raw_args: '{"agent_type":"code-reviewer","prompt":"SECRET_AGENT"}',
              raw_output: 'SECRET_AGENT_OUTPUT',
            };
          }
          return {};
        },
      };
    }, inspectorFixture());
    await page.goto(GAME_URL);
    await waitForGame(page);

    await page.locator('#dom-session [data-cmc-action="inspector"]').click();
    await expect(page.locator('#inspector-overlay')).toHaveClass(/visible/);
    await expect(page.locator('#inspector-dialog')).not.toContainText('SECRET_AGENT');

    await page.locator('[data-inspector-reveal]').click();
    await expect(page.locator('#inspector-dialog')).toContainText('SECRET_AGENT');
    await expect(page.locator('#inspector-dialog')).toContainText('SECRET_AGENT_OUTPUT');
  });

  test('inspector reveals raw local details for hook rows after explicit opt-in', async ({ page }) => {
    const fixture = inspectorFixture();
    const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
    beta.recent_tool_calls.push({
      tool: 'agentStop',
      category: 'hooks',
      timestamp: '2026-05-21T07:14:00Z',
      completed_at: '2026-05-21T07:14:02Z',
      success: true,
      duration_ms: 2000,
      model: 'gpt-5.5',
      call_id: 'hook-agentstop1',
      event_ref: 'evt-hook',
      turn_id: '',
      target: 'agentStop',
      details: [
        { label: 'Type', value: 'Hook' },
        { label: 'Hook type', value: 'agentStop' },
        { label: 'Provider', value: 'copilot' },
        { label: 'Privacy', value: 'input/output hidden' },
      ],
    });

    await page.addInitScript((fixtureArg) => {
      (window as any).__missionControlFixture = fixtureArg;
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (command: string, args: any) => {
          if (command !== 'get_raw_tool_call_details') throw new Error(`unexpected command ${command}`);
          if (args.eventRef !== 'evt-hook') throw new Error(`unexpected event ref ${args.eventRef}`);
          return {
            raw_args: '{"prompt":"SECRET_HOOK_PROMPT"}',
            raw_output: 'SECRET_HOOK_OUTPUT',
          };
        },
      };
    }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    await page.locator('#dom-session [data-cmc-action="inspector"]').click();
    await page.locator('[data-inspector-tab="hooks"]').click();
    await expect(page.locator('#inspector-dialog')).toContainText('agentStop');
    await expect(page.locator('#inspector-dialog')).not.toContainText('SECRET_HOOK_PROMPT');

    await page.locator('[data-inspector-reveal]').click();

    await expect(page.locator('#inspector-dialog')).toContainText('SECRET_HOOK_PROMPT');
    await expect(page.locator('#inspector-dialog')).toContainText('SECRET_HOOK_OUTPUT');
  });

  test('inspector hides raw local details action when no local details are retained', async ({ page }) => {
    await page.addInitScript((fixture) => {
      (window as any).__missionControlFixture = fixture;
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (command: string) => {
          if (command !== 'get_raw_tool_call_details') throw new Error(`unexpected command ${command}`);
          return {};
        },
      };
    }, inspectorFixture());
    await page.goto(GAME_URL);
    await waitForGame(page);

    await page.locator('#dom-session [data-cmc-action="inspector"]').click();
    await expect(page.locator('#inspector-overlay')).toHaveClass(/visible/);
    await page.locator('[data-inspector-tab="mcp"]').click();
    await expect(page.locator('[data-inspector-reveal]')).toBeVisible();

    await page.locator('[data-inspector-reveal]').click();

    await expect(page.locator('#inspector-dialog')).toContainText('No raw local details were retained for this call.');
    await expect(page.locator('[data-inspector-reveal]')).toHaveCount(0);
    await expect(page.locator('#inspector-dialog')).not.toContainText('Refresh raw local details');
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
    expect(text).toContain('Retained tool rows (3 of 3)');
    expect(text).toContain('code-reviewer');

    await page.locator('[data-turn-id="turn-tail"]').click();
    text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('partial tail window');
    expect(text).toContain('running');
    expect(text).toContain('bash-command-with-a-very-long-safe-label-for-...');
    expect(text).not.toContain(LONG_TOOL_NAME);
  });

  test('inspector turn mode explains when detailed tool rows are outside the retained window', async ({ page }) => {
    const fixture = inspectorFixture();
    const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
    beta.recent_tool_calls = beta.recent_tool_calls.filter((call: any) => call.turn_id !== 'turn-a1');
    await page.addInitScript((fixtureArg) => { (window as any).__missionControlFixture = fixtureArg; }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    await page.locator('#dom-session [data-cmc-action="inspector"]').click();
    await expect(page.locator('#inspector-overlay')).toHaveClass(/visible/);
    await page.locator('[data-inspector-mode="turns"]').click();
    await page.locator('[data-turn-id="turn-a1"]').click();

    const text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('Tools\n3');
    expect(text).toContain('Ran\nbrowser_navigate, blog-writer, code-reviewer');
    expect(text).toContain('Retained tool rows (0 of 3)');
    expect(text).toContain('This turn recorded 3 tools (browser_navigate, blog-writer, code-reviewer), but no detailed rows are in the retained call window.');
    expect(text).not.toContain('Tools in this turn (0)');
  });

  test('quarter Details opens a sector-scoped inspector filtered to that category', async ({ page }) => {
    await page.addInitScript((fixture) => { (window as any).__missionControlFixture = fixture; }, inspectorFixture());
    await page.goto(GAME_URL);
    await waitForGame(page);

    await openQuarterDetails(page, 'mcp');

    const text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('MCP details');
    expect(text).toContain('1 retained rows');
    expect(text).toContain('4 selected-session signals');
    expect(text).toContain('browser_navigate');
    expect(text).toContain('MCP tool');
    expect(text).not.toContain('blog-writer');
    expect(text).not.toContain('code-reviewer');
    await expect(page.locator('.inspector-toolbar')).toBeHidden();
    await expect(page.locator('#inspector-tabs')).toBeHidden();
  });

  test('All Active Sessions quarter Details groups sector rows by source session', async ({ page }) => {
    const fixture = inspectorFixture();
    const alpha = fixture.sessions.find((session: any) => session.id === 'alpha123');
    const gamma = fixture.sessions.find((session: any) => session.id === 'gamma890');
    alpha.recent_tool_calls = [
      {
        tool: 'search_docs',
        category: 'mcp',
        timestamp: '2026-05-21T07:09:00Z',
        completed_at: '2026-05-21T07:09:01Z',
        success: true,
        duration_ms: 1000,
        model: 'gpt-5.5',
        call_id: 'call-alpha-mcp',
        event_ref: 'evt-alpha-mcp',
        turn_id: 'turn-alpha',
        target: 'search_docs',
        details: [
          { label: 'Type', value: 'MCP tool' },
          { label: 'Provider', value: 'copilot' },
          { label: 'Privacy', value: 'arguments/output hidden' },
        ],
      },
    ];
    gamma.mcp_count = 1;
    gamma.recent_tool_calls = [
      {
        tool: 'stale_automation_tool',
        category: 'mcp',
        timestamp: '2026-05-21T07:12:00Z',
        completed_at: '2026-05-21T07:12:01Z',
        success: true,
        duration_ms: 1000,
        model: 'gpt-5.5',
        call_id: 'call-stale-mcp',
        event_ref: 'evt-stale-mcp',
        turn_id: 'turn-stale',
        target: 'stale_automation_tool',
        details: [
          { label: 'Type', value: 'MCP tool' },
          { label: 'Provider', value: 'copilot' },
          { label: 'Privacy', value: 'arguments/output hidden' },
        ],
      },
    ];
    await page.addInitScript((fixtureArg) => {
      (window as any).__missionControlFixture = fixtureArg;
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (command: string, args: any) => {
          if (command !== 'get_raw_tool_call_details') throw new Error(`unexpected command ${command}`);
          if (args.sessionId !== 'beta4567') throw new Error(`unexpected session ${args.sessionId}`);
          if (args.eventRef !== 'evt-1') throw new Error(`unexpected event ref ${args.eventRef}`);
          return {
            raw_args: '{"url":"SECRET_AGGREGATE_MCP"}',
            raw_output: 'SECRET_AGGREGATE_OUTPUT',
          };
        },
      };
    }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    await selectSession(page, '__all_sessions__');
    await openQuarterDetails(page, 'mcp');

    const text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('MCP details · All Active Sessions');
    expect(text).not.toContain('inactive');
    expect(text).toContain('2 retained rows');
    expect(text).toContain('5 signals');
    expect(text).toContain('Build Mission Control');
    expect(text).toContain('Review Tests');
    expect(text.indexOf('Build Mission Control')).toBeLessThan(text.indexOf('Review Tests'));
    expect(text).not.toContain('search_docs');
    expect(text).not.toContain('browser_navigate');
    expect(text).not.toContain('Research UI');
    expect(text).not.toContain('stale_automation_tool');
    await expect(page.locator('[data-inspector-group-key]')).toHaveCount(2);
    await expect(page.locator('[data-inspector-group-key]').first()).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.inspector-row')).toHaveCount(0);

    await page.locator('[data-inspector-group-key]').filter({ hasText: 'Build Mission Control' }).click();
    await expect(page.locator('[data-inspector-group-key]').filter({ hasText: 'Build Mission Control' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.inspector-row')).toHaveCount(1);
    await expect(page.locator('.inspector-row')).toContainText('search_docs');
    await expect(page.locator('.inspector-row')).not.toContainText('browser_navigate');

    await page.locator('[data-inspector-group-key]').filter({ hasText: 'Review Tests' }).click();
    await expect(page.locator('[data-inspector-group-key]').filter({ hasText: 'Review Tests' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.inspector-row')).toHaveCount(2);

    await page.locator('.inspector-row').filter({ hasText: 'browser_navigate' }).click();
    await expect(page.locator('.inspector-detail')).toContainText('Session');
    await expect(page.locator('.inspector-detail')).toContainText('Review Tests');
    await expect(page.locator('.inspector-detail')).toContainText('browser_navigate');
    await expect(page.locator('.inspector-detail')).not.toContainText('SECRET_AGGREGATE_MCP');
    await expect(page.locator('.inspector-detail')).not.toContainText('SECRET_AGGREGATE_OUTPUT');
    await page.locator('[data-inspector-reveal]').click();
    await expect(page.locator('.inspector-detail')).toContainText('SECRET_AGGREGATE_MCP');
    await expect(page.locator('.inspector-detail')).toContainText('SECRET_AGGREGATE_OUTPUT');
  });

  test('quarter Details explains when sector signals outlive retained rows', async ({ page }) => {
    const fixture = inspectorFixture();
    const beta = fixture.sessions.find((session: any) => session.id === 'beta4567');
    beta.recent_tool_calls = beta.recent_tool_calls.filter((call: any) => call.category !== 'mcp');
    await page.addInitScript((fixtureArg) => { (window as any).__missionControlFixture = fixtureArg; }, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    await openQuarterDetails(page, 'mcp');

    const text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('MCP details');
    expect(text).toContain('0 retained rows');
    expect(text).toContain('4 selected-session signals');
    expect(text).toContain('This sector recorded 4 selected-session signals, but no detailed rows are in the retained call window.');
    expect(text).not.toContain('browser_navigate');
  });

  test('normal Inspector resets after closing a sector-scoped dialog', async ({ page }) => {
    await page.addInitScript((fixture) => { (window as any).__missionControlFixture = fixture; }, inspectorFixture());
    await page.goto(GAME_URL);
    await waitForGame(page);

    await openQuarterDetails(page, 'mcp');
    await page.locator('#inspector-close').click();
    await expect(page.locator('#inspector-overlay')).not.toHaveClass(/visible/);

    await page.locator('#dom-session [data-cmc-action="inspector"]').click();
    await expect(page.locator('#inspector-overlay')).toHaveClass(/visible/);
    await expect(page.locator('.inspector-toolbar')).toBeVisible();
    await expect(page.locator('#inspector-tabs')).toBeVisible();
    await expect(page.locator('[data-inspector-tab="all"]')).toHaveClass(/active/);

    const text = await page.locator('#inspector-dialog').innerText();
    expect(text).toContain('Inspector · Review Tests');
    expect(text).toContain('blog-writer');
    expect(text).toContain('code-reviewer');
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

  test('selected session model chip mirrors the session and updates on switch', async ({ page }) => {
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
    await expect(page.locator('#topbar #model-chip')).toHaveCount(0);
    await expect(page.locator('#dom-session #model-chip')).toHaveText('claude-sonnet-4.6');
    await expect(page.locator('#dom-session #model-chip')).not.toHaveClass(/empty/);

    // Select alpha123 → chip should switch to its model.
    await selectSession(page, 'alpha123');

    await expect(page.locator('#dom-session #model-chip')).toHaveText('gpt-5.5');

    await selectSession(page, '__all_sessions__');

    await expect(page.locator('#dom-session .cmc-model-meta')).toContainText('Models:');
    await expect(page.locator('#dom-session #model-chip')).toHaveText('gpt-5.5, claude-sonnet-4.6');
  });

  test('selected session model chip stays hidden when no session reports a model', async ({ page }) => {
    // Default fixture has no `last_model` on any session. The chip
    // should render with the `empty` class (display: none) so we
    // never flash a blank pill.
    await expect(page.locator('#topbar #model-chip')).toHaveCount(0);
    await expect(page.locator('#dom-session #model-chip')).toHaveClass(/empty/);
    await expect(page.locator('#dom-session #model-chip')).toHaveText('');
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

test.describe('Agent Mission Control — Attention Center', () => {
  test('keeps attention summary out of the selected session panel', async ({ page }) => {
    const fixture = {
      ...MISSION_FIXTURE,
      active_sessions: 1,
      sessions: [
        { ...MISSION_FIXTURE.sessions[0], is_active: true, error_count: 0, status: 'working' },
        { ...MISSION_FIXTURE.sessions[1], is_active: false, error_count: 0, status: 'idle' },
      ],
      recent_events: MISSION_FIXTURE.recent_events.filter(event => event.success),
      alerts: [],
      schema_drift: [],
    };
    await installFixture(page, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    await expect(page.locator('#dom-session .cmc-attention-entry')).toHaveCount(0);
    await expect(page.locator('#dom-session')).not.toContainText('Attention');
    await expect(page.locator('#dom-session')).not.toContainText('No action needed');
    await expect(page.locator('#dom-session .cmc-attention-count')).toHaveCount(0);
    await expect(page.locator('#dom-session [data-cmc-action="attention-center"]')).toHaveCount(0);
    await expect(page.locator('#dom-feed')).not.toContainText('Attention');
  });

  test('surfaces provider and schema issues with safe details only', async ({ page }) => {
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    fixture.alerts = [
      'Could not read home folders in \'Ubuntu\'. Start the WSL distro to enable scanning.',
    ];
    fixture.schema_drift = [
      {
        provider: 'copilot',
        schema_version: '1.1.0',
        severity: 'warning',
        summary: 'Possible Copilot schema drift detected in 1 of 3 scanned sessions.',
        checked_sessions: 3,
        affected_sessions: 1,
        total_events: 128,
        recognized_events: 22,
        tool_starts: 0,
        tool_completes: 0,
        missing_event_type: 0,
        unknown_event_types: [{ name: 'assistant.new_shape', count: 42 }],
        hints: [],
        raw_prompt: 'SECRET_PROMPT',
        file_path: '/Users/dan/project/private.ts',
      },
    ];
    await installFixture(page, fixture);
    await page.goto(GAME_URL);
    await waitForGame(page);

    await expect(page.locator('#schema-drift-overlay')).toHaveClass(/visible/);
    await page.locator('#schema-drift-close').click();
    await expect(page.locator('#dom-session [data-cmc-action="attention-center"]')).toHaveCount(0);
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.cmcAction = 'attention-center';
      button.style.display = 'none';
      document.body.appendChild(button);
      button.click();
      button.remove();
    });
    await expect(page.locator('#attention-body')).toContainText('Provider scan needs review');
    await expect(page.locator('#attention-body')).toContainText('Possible provider schema drift');
    await expect(page.locator('#attention-dialog')).toContainText('No prompts, tool arguments, command output, file paths, or diffs');
    await expect(page.locator('#attention-body')).not.toContainText('SECRET_PROMPT');
    await expect(page.locator('#attention-body')).not.toContainText('/Users/dan');

    await page.locator('#attention-body [data-attention-action="open-schema-drift"]').click();
    await expect(page.locator('#schema-drift-overlay')).toHaveClass(/visible/);
  });

  test('keeps generic active failures out of the attention center', async ({ page }) => {
    await page.addInitScript((fixture) => { (window as any).__missionControlFixture = fixture; }, inspectorFixture());
    await page.goto(GAME_URL);
    await waitForGame(page);

    await expect(page.locator('#dom-session .cmc-attention-entry')).toHaveCount(0);
    await expect(page.locator('#dom-session .cmc-attention-count')).toHaveCount(0);
    await expect(page.locator('#dom-session [data-cmc-action="attention-center"]')).toHaveCount(0);
    await expect(page.locator('#dom-session')).not.toContainText('No action needed');
    await expect(page.locator('#dom-session')).not.toContainText('failures to review');
  });
});

test.describe('Agent Mission Control — Focus Mode', () => {
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

  test('compact focus mode keeps all sectors evenly spaced around the center', async ({ page }) => {
    await installFixture(page);
    await page.setViewportSize({ width: 832, height: 644 });
    await page.addInitScript(() => {
      localStorage.setItem('cmc_panels_hidden', '1');
    });
    await page.goto(GAME_URL);
    await waitForGame(page);

    const state = await getMissionState(page);
    const layout = state!.layout!;
    expect(layout.panelW).toBe(0);
    expect(state!.moat!.x).toBeCloseTo(layout.centerX, 1);
    expect(state!.moat!.y).toBeCloseTo(layout.hubY, 1);
    expectNoQuarterFrameOverlaps(state!.quarterRects);
    expect(layout.radiusX).toBeCloseTo(layout.radiusY, 1);
    const wellTop = layout.opsY + layout.opsH;
    const wellBottom = layout.bottomY;
    const topGap = Math.min(...state!.quarterRects.map((d) => d.top - wellTop));
    const bottomGap = Math.min(...state!.quarterRects.map((d) => wellBottom - d.bottom));
    expect(topGap, 'focus-mode ring should not leave a larger top gutter than bottom gutter').toBeLessThanOrEqual(bottomGap + 8);
    for (const d of state!.quarterRects) {
      const nx = (d.x - layout.centerX) / layout.radiusX;
      const ny = (d.y - layout.centerY) / layout.radiusY;
      expect(Math.hypot(nx, ny), `quarter ${d.key} should stay on the center ring`).toBeCloseTo(1, 1);
      const centerDistance = Math.hypot(d.x - state!.moat!.x, d.y - state!.moat!.y);
      expect(centerDistance, `quarter ${d.key} should not crowd the central item`).toBeGreaterThan(state!.moat!.radius + layout.quarterR + 8);
    }
    const visualSectorCenterY = state!.quarterRects.reduce((sum, rect) => sum + (rect.top + rect.bottom) / 2, 0) / state!.quarterRects.length;
    expect(state!.moat!.y, 'central hub should align to the visual center of the full sector cards').toBeCloseTo(visualSectorCenterY, 1);
  });
});

test.describe('Agent Mission Control — Schema Drift', () => {
  test('schema drift dialog opens a privacy-safe issue report', async ({ page }) => {
    const fixture = JSON.parse(JSON.stringify(MISSION_FIXTURE));
    fixture.schema_drift = [
      {
        provider: 'copilot',
        schema_version: '1.1.0',
        severity: 'warning',
        summary: 'Possible Copilot schema drift detected in 1 of 3 scanned sessions.',
        checked_sessions: 3,
        affected_sessions: 1,
        total_events: 128,
        recognized_events: 22,
        tool_starts: 0,
        tool_completes: 0,
        missing_event_type: 0,
        unknown_event_types: [
          { name: 'assistant.new_shape', count: 42 },
        ],
        hints: [
          'No tool starts were recognized in an active event window; check tool_start, tool_name_paths, and tool_call_id_paths.',
        ],
        raw_prompt: 'SECRET_PROMPT',
        file_path: '/Users/dan/project/private.ts',
      },
    ];
    await installFixture(page, fixture);
    await page.addInitScript(() => {
      (window as any).__openedUrls = [];
      window.open = ((url: string | URL | undefined) => {
        (window as any).__openedUrls.push(String(url || ''));
        return null;
      }) as typeof window.open;
    });
    await page.goto(GAME_URL);
    await waitForGame(page);

    await expect(page.locator('#schema-drift-overlay')).toHaveClass(/visible/);
    await expect(page.locator('#schema-drift-body')).toContainText('No prompts, tool arguments, command output, file paths, or diffs');

    await page.locator('#schema-drift-report').click();
    const openedUrl = await page.waitForFunction(() => (window as any).__openedUrls?.[0] || '', null, { timeout: 2000 });
    const url = String(await openedUrl.jsonValue());
    expect(url).toContain('https://github.com/DanWahlin/agent-mission-control/issues/new?');
    const issueUrl = new URL(url);
    const body = issueUrl.searchParams.get('body') || '';
    expect(issueUrl.searchParams.get('title')).toBe('Schema drift detected: Copilot provider');
    expect(issueUrl.searchParams.get('labels')).toBe('schema-drift,provider:copilot');
    expect(body).toContain('assistant.new_shape');
    expect(body).toContain('structural only');
    expect(body).not.toContain('SECRET_PROMPT');
    expect(body).not.toContain('/Users/dan');
  });
});

test.describe('Agent Mission Control — Ops Rules', () => {
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
  test(`Agent Mission Control renders at ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
    await installFixture(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(GAME_URL);
    await waitForGame(page);

    const state = await getMissionState(page);
    expect(state).not.toBeNull();
    expect(state!.screenW).toBe(vp.width);
    expect(state!.screenH).toBe(vp.height);
    expect(state!.sessionCount).toBe(3);
    expect(state!.quarterCount).toBe(9);

    // Layout regression: quarters must fit between side panels with at
    // least a small gutter, and inside the central well between the ops
    // strip and the bottom inspector. This catches the laptop overlap
    // bug where quarters crashed into Selected Session / Activity Feed.
    const layout = state!.layout!;
    expect(layout).not.toBeNull();
    expect(
      layout.topY,
      'left dashboard panels should sit near the top of the canvas without a large empty gutter',
    ).toBeLessThanOrEqual(layout.compact ? 24 : Math.max(28, state!.screenH * 0.02));
    const leftPanelRight = layout.leftX + layout.panelW;
    const wellRight = state!.screenW - layout.leftX;
    const wellTop = layout.opsY + layout.opsH;
    const wellBottom = layout.bottomY;
    const verticalWellGap = Math.min(
      ...state!.quarterRects.map((d) => Math.min(d.top - wellTop, wellBottom - d.bottom)),
    );
    for (const d of state!.quarterRects) {
      const r = layout.quarterR;
      expect(d.x - r, `quarter ${d.key} left edge crosses left panel`).toBeGreaterThanOrEqual(leftPanelRight);
      expect(d.x + r, `quarter ${d.key} right edge crosses viewport gutter`).toBeLessThanOrEqual(wellRight);
      expect(d.y - r, `quarter ${d.key} top edge crosses ops strip`).toBeGreaterThanOrEqual(wellTop);
      expect(d.y + r, `quarter ${d.key} bottom edge crosses bottom inspector`).toBeLessThanOrEqual(wellBottom);
    }
    expect(
      verticalWellGap,
      'sector ring should expand into available vertical space without crossing the well',
    ).toBeLessThanOrEqual(Math.max(18, layout.quarterR * 0.75));
    expectNoQuarterFrameOverlaps(state!.quarterRects);
    expect(layout.radiusX, 'sector ring should use equal horizontal and vertical radii').toBeCloseTo(layout.radiusY, 1);
    const visualSectorCenterY = state!.quarterRects.reduce((sum, rect) => sum + (rect.top + rect.bottom) / 2, 0) / state!.quarterRects.length;
    expect(state!.moat!.y, 'central hub should align to the visual center of the full sector cards').toBeCloseTo(visualSectorCenterY, 1);
    for (const d of state!.quarterRects) {
      const nx = (d.x - layout.centerX) / layout.radiusX;
      const ny = (d.y - layout.centerY) / layout.radiusY;
      expect(Math.hypot(nx, ny), `quarter ${d.key} should stay on the sector ring`).toBeCloseTo(1, 1);
    }
  });
}
