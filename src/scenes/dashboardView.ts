import { buildAttentionItems, providerAttentionAlerts } from './opsSignals.js';
import type { MissionLayout } from './missionLayout.js';
import type { SessionPickerOption } from './sessionSelection.js';
import type { CopilotActivity, CopilotEventSummary, CopilotSessionSummary, MissionCategory, SessionTokenCheckpoint, SessionToolCall } from './missionTypes.js';

export interface SessionPickerRow {
  id: string;
  index: number;
  title: string;
  sessionName: string;
  repository: string;
  branch: string;
  status: string;
  isActive: boolean;
  selected: boolean;
  shortId: string;
  statusLabel: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface QuarterViewInput {
  key: MissionCategory;
  short: string;
  colorCss: string;
  count: number;
  stats: {
    line: string;
  };
}

export interface DashboardViewInput {
  initialActivityLoaded: boolean;
  panelsHidden: boolean;
  layout: MissionLayout;
  viewportWidth: number;
  activity: CopilotActivity;
  sessionOptions: SessionPickerOption[];
  selectedSessionIndex: number;
  selectedSession: CopilotSessionSummary | null;
  eventLog: CopilotEventSummary[];
  replayPaused: boolean;
  replayCursor: number;
  atLive: boolean;
  quarter: QuarterViewInput | null;
  nowMs: number;
}

export interface DashboardViewBuildResult {
  view: unknown;
  sessionPickerRows: SessionPickerRow[];
}

export function buildQuarterView(input: QuarterViewInput | null) {
  if (!input) return null;
  return {
    category: input.key,
    color: input.colorCss,
    title: input.short,
    count: input.count,
    countLine: `${input.count} selected-session ${input.short.toLowerCase()} signals`,
    line: input.stats.line,
  };
}

export function buildDashboardView(input: DashboardViewInput): DashboardViewBuildResult {
  const { layout, activity, sessionOptions, selectedSessionIndex, eventLog, replayCursor, atLive } = input;
  const compact = layout.compact;
  const activeOptions = sessionOptions.filter(({ session }) => session.is_active);
  const pickerOptions = sessionOptions.slice(0, 5);
  if (!pickerOptions.some(({ index }) => index === selectedSessionIndex)) {
    const selectedOption = sessionOptions.find(({ index }) => index === selectedSessionIndex);
    if (selectedOption) {
      if (pickerOptions.length >= 5) pickerOptions[pickerOptions.length - 1] = selectedOption;
      else pickerOptions.push(selectedOption);
    }
  }
  const sessionPickerRows = pickerOptions.map(({ session, index }, i) => sessionPickerRow(
    session,
    index,
    i,
    selectedSessionIndex,
    layout,
  ));
  const feedY = layout.topY + layout.sessionH + (compact ? 14 : 22);
  const feedH = Math.max(140, layout.bottomY - feedY - 16);
  const replayLog = eventLog.length > 0 ? eventLog : [...(activity.recent_events ?? [])].reverse();
  const total = replayLog.length;
  const cursor = eventLog.length > 0 ? replayCursor : total;
  const visibleLog = replayLog.slice(0, cursor);
  const cursorEvent = visibleLog[visibleLog.length - 1];
  const cursorTimeMs = eventTimestampMs(cursorEvent?.timestamp);
  const feedAnchorMs = atLive ? input.nowMs : (cursorTimeMs ?? input.nowMs);
  const feed = visibleLog
    .slice(-30)
    .reverse()
    .map(event => ({ event, ageS: eventAgeSeconds(event.timestamp, feedAnchorMs) }))
    .map(({ event, ageS }) => ({
      label: feedLabel(event),
      age: atLive
        ? `${formatAge(ageS)} ago`
        : ageS === 0 ? 'at cursor' : `${formatAge(ageS)} before`,
      category: event.category,
      success: event.success,
    }));
  const quarter = buildQuarterView(input.quarter);
  const cursorLabel = cursorEvent ? ` · ${formatEventClock(cursorEvent.timestamp)}` : '';
  const replayStatus = replayStatusText(total, cursor, atLive, input.replayPaused, cursorLabel);
  const selectedSessionView = buildSelectedSessionView(
    input.selectedSession,
    visibleLog,
    atLive,
    cursorTimeMs,
  );
  const providerAlerts = providerAttentionAlerts(activity);
  return {
    sessionPickerRows,
    view: {
      initialActivityLoaded: input.initialActivityLoaded,
      panelsHidden: input.panelsHidden,
      layout: {
        leftX: layout.leftX,
        topY: layout.topY,
        panelW: layout.panelW,
        compact: layout.compact,
        sessionH: layout.sessionH,
        feedY,
        feedH,
        bottomX: layout.inspectorX,
        bottomY: layout.bottomY,
        bottomW: layout.inspectorW,
        bottomH: layout.bottomH,
        replayX: layout.leftX,
        replayY: layout.replayY,
        replayW: input.viewportWidth - layout.leftX * 2,
        replayH: layout.replayH,
      },
      schemaDrift: activity.schema_drift ?? [],
      history: activity.history,
      activity: {
        available: activity.available,
        scannedSessions: activity.scanned_sessions,
        activeSessions: activity.active_sessions,
        totalEvents: activity.total_events,
        totalToolCalls: activity.total_tool_calls,
        totalInputTokens: activity.total_input_tokens ?? 0,
        totalOutputTokens: activity.total_output_tokens,
        totalTurns: activity.total_turns ?? 0,
      },
      providerAlerts: providerAlerts.slice(0, 3),
      activitySignal: activity.activity_signal,
      attention: buildAttentionItems(activity),
      sessions: {
        header: activeOptions.length > 0 ? `Running sessions (${activeOptions.length})` : 'Recent sessions (none active)',
        rows: sessionPickerRows,
        idleCount: Math.max(0, sessionOptions.length - pickerOptions.length),
        options: sessionOptions.map(({ session, index }) => sessionOptionRow(session, index)),
        selected: selectedSessionView,
      },
      feed: {
        title: atLive ? 'Recent Activity Feed' : 'Recent Activity Feed · replay cursor',
        rows: feed,
        empty: activity.available
          ? total === 0
            ? 'No recent agent events found. Start a session with the selected provider and this mission control will wake up.'
            : 'No agent events are visible at this replay position.'
          : 'No selected agent activity source was detected. Install, authenticate, or switch providers to populate this mission.',
      },
      quarter,
      replay: {
        paused: input.replayPaused,
        atLive,
        cursor,
        total,
        status: replayStatus,
      },
    },
  };
}

function sessionPickerRow(
  session: CopilotSessionSummary,
  index: number,
  optionIndex: number,
  selectedSessionIndex: number,
  layout: MissionLayout,
): SessionPickerRow {
  return {
    ...sessionOptionRow(session, index),
    selected: index === selectedSessionIndex,
    x: layout.leftX + 18,
    y: layout.topY + 80 + optionIndex * 30 - 4,
    w: layout.panelW - 36,
    h: 26,
  };
}

function sessionOptionRow(session: CopilotSessionSummary, index: number) {
  return {
    id: session.id,
    index,
    title: session.title || session.id,
    sessionName: session.session_name || '',
    repository: session.repository || '',
    branch: session.branch || '',
    shortId: session.id.length > 8 ? session.id.slice(0, 8) : session.id,
    status: session.status,
    isActive: session.is_active,
    statusLabel: session.is_active ? 'active' : 'idle',
  };
}

function buildSelectedSessionView(
  selected: CopilotSessionSummary | null,
  visibleLog: CopilotEventSummary[],
  atLive: boolean,
  cursorTimeMs: number | null,
): CopilotSessionSummary | null {
  if (!selected) return null;
  if (atLive) return selected;

  const selectedEvents = visibleLog.filter(event => eventBelongsToSession(event, selected.id));
  const latestEvent = selectedEvents[selectedEvents.length - 1];
  const latestCall = latestToolCallAtCursor(selected.recent_tool_calls, cursorTimeMs);
  const tokenEvent = [...selectedEvents]
    .reverse()
    .find(event => event.input_tokens !== undefined || event.output_tokens !== undefined);
  const tokenCheckpoint = latestTokenCheckpoint(selected.token_checkpoints, cursorTimeMs);
  const inputTokens = tokenCheckpoint?.input_tokens ?? tokenEvent?.input_tokens ?? (latestCall ? selected.input_tokens ?? 0 : 0);
  const outputTokens = tokenCheckpoint?.output_tokens ?? tokenEvent?.output_tokens ?? (latestCall ? selected.output_tokens ?? 0 : 0);
  const replayActivity = latestCall
    ? {
        last: `${latestCall.tool || 'tool'} ${latestCall.success === false ? 'failed' : latestCall.completed_at ? 'completed' : 'running'}`,
        tool: latestCall.tool || latestEvent?.tool || 'none',
        age: replayAgeLabel(latestCall.completed_at || latestCall.timestamp, cursorTimeMs),
      }
    : latestEvent
    ? {
        last: replaySessionLastLabel(latestEvent),
        tool: latestEvent.tool || 'none',
        age: replayAgeLabel(latestEvent.timestamp, cursorTimeMs),
      }
    : {
        last: 'No visible activity at cursor',
        tool: 'none',
        age: 'not reached',
      };

  return {
    ...selected,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    last_tool: replayActivity.tool,
    last_event_kind: latestEvent?.kind ?? (latestCall ? 'tool.execution_start' : ''),
    last_event_category: latestEvent?.category ?? latestCall?.category,
    last_event_timestamp: latestEvent?.timestamp ?? latestCall?.timestamp ?? '',
    replay_activity: replayActivity,
  };
}

function latestToolCallAtCursor(calls: SessionToolCall[] | undefined, cursorTimeMs: number | null) {
  if (!calls?.length || cursorTimeMs === null) return null;
  let latest: SessionToolCall | null = null;
  let latestMs = -1;
  for (const call of calls) {
    const startMs = eventTimestampMs(call.timestamp);
    const completeMs = eventTimestampMs(call.completed_at);
    const callMs = completeMs !== null && completeMs <= cursorTimeMs ? completeMs : startMs;
    if (callMs === null || callMs > cursorTimeMs) continue;
    if (callMs >= latestMs) {
      latest = call;
      latestMs = callMs;
    }
  }
  return latest;
}

function replayStatusText(total: number, cursor: number, atLive: boolean, paused: boolean, cursorLabel: string) {
  if (total === 0) return 'Recent activity replay · waiting for events';
  if (atLive) return `Recent activity replay · ${cursor} / ${total} · live${cursorLabel}`;
  return paused
    ? `Recent activity replay · ${cursor} / ${total} · paused${cursorLabel}`
    : `Recent activity replay · ${cursor} / ${total} · playing${cursorLabel}`;
}

function eventAgeSeconds(timestamp: string, nowMs = Date.now()): number {
  const t = eventTimestampMs(timestamp);
  if (t === null) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

function eventTimestampMs(timestamp?: string): number | null {
  const t = Date.parse(timestamp ?? '');
  return Number.isNaN(t) ? null : t;
}

function latestTokenCheckpoint(checkpoints: SessionTokenCheckpoint[] | undefined, cursorTimeMs: number | null) {
  if (!checkpoints?.length || cursorTimeMs === null) return null;
  let latest: SessionTokenCheckpoint | null = null;
  for (const checkpoint of checkpoints) {
    const t = eventTimestampMs(checkpoint.timestamp);
    if (t === null || t > cursorTimeMs) continue;
    if (!latest || t >= (eventTimestampMs(latest.timestamp) ?? 0)) {
      latest = checkpoint;
    }
  }
  return latest;
}

function formatEventClock(timestamp: string) {
  const t = eventTimestampMs(timestamp);
  if (t === null) return 'unknown time';
  return new Date(t).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function feedLabel(event: CopilotEventSummary) {
  if (event.kind === 'tool.execution_start') return event.tool || 'tool started';
  if (event.kind === 'tool.execution_complete') return event.success ? 'tool completed' : 'tool failed';
  if (event.kind === 'hook.start') return `${event.tool || 'hook'} hook started`;
  if (event.kind === 'hook.end') return event.success ? `${event.tool || 'hook'} hook completed` : `${event.tool || 'hook'} hook failed`;
  if (event.kind === 'assistant.turn_start') return `${providerDisplayName(event.provider)} started thinking`;
  if (event.kind === 'assistant.turn_end') return `${providerDisplayName(event.provider)} is waiting`;
  if (event.kind === 'assistant.message') return 'token update';
  if (event.kind === 'session.compaction_complete') return 'compaction token checkpoint';
  if (event.kind === 'session.shutdown') return 'session token checkpoint';
  if (event.kind === 'user.message') return 'prompt received';
  if (event.kind === 'session.start') return 'session opened';
  return event.kind;
}

function providerDisplayName(provider?: string) {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  if (provider === 'copilot') return 'Copilot';
  return 'Agent';
}

function replaySessionLastLabel(event: CopilotEventSummary) {
  if (event.kind === 'tool.execution_start') return `${event.tool || 'tool'} started`;
  if (event.kind === 'tool.execution_complete') return event.success ? 'tool completed' : 'tool failed';
  if (event.kind === 'hook.start') return `${event.tool || 'hook'} hook started`;
  if (event.kind === 'hook.end') return event.success ? `${event.tool || 'hook'} hook completed` : `${event.tool || 'hook'} hook failed`;
  return feedLabel(event);
}

function replayAgeLabel(timestamp: string, cursorTimeMs: number | null) {
  if (cursorTimeMs === null) return 'at cursor';
  const ageS = eventAgeSeconds(timestamp, cursorTimeMs);
  return ageS === 0 ? 'at cursor' : `${formatAge(ageS)} before cursor`;
}

function eventBelongsToSession(event: CopilotEventSummary, sessionId: string) {
  return event.session_id === sessionId
    || sessionId.startsWith(event.session_id)
    || event.session_id.startsWith(sessionId);
}

function formatAge(seconds?: number) {
  if (seconds === undefined || Number.isNaN(seconds)) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
