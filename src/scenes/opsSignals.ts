import type { CopilotActivity, CopilotSessionSummary } from './missionTypes.js';

export type AttentionSeverity = 'critical' | 'review' | 'watch' | 'info';
export type AttentionConfidence = 'direct' | 'derived' | 'informational';
export type AttentionSource = 'provider' | 'schema' | 'session' | 'hook' | 'tool';
export type AttentionAction = 'select-session' | 'open-inspector' | 'open-schema-drift' | 'none';

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  confidence: AttentionConfidence;
  source: AttentionSource;
  sessionId?: string;
  title: string;
  detail: string;
  timestamp?: string;
  action: AttentionAction;
}

export interface AttentionSummary {
  count: number;
  highestSeverity: AttentionSeverity;
  summary: string;
  empty: string;
  items: AttentionItem[];
}

export type AttentionLevel = 'ok' | 'watch' | 'review';

export interface OpsSummary {
  mode: string;
  attention: AttentionLevel;
  recommendation: string;
  reason: string;
}

type WorkMixCounts = { read: number; write: number; command: number; web: number; task: number; mcp: number; hooks: number };

export function createOpsSummary(mode: string, attention: AttentionLevel, recommendation: string, reason: string): OpsSummary {
  return { mode, attention, recommendation, reason };
}

export function buildOpsSummary(activity: CopilotActivity): OpsSummary {
  if (!activity.available) {
    return createOpsSummary(
      'Disconnected',
      'watch',
      'Install, authenticate, or select an agent provider to populate live activity.',
      'No selected agent activity source is currently available.',
    );
  }

  const concrete = detectConcreteOpsSignal(activity);
  if (concrete) return concrete;

  const activeSessions = activity.sessions.filter(session => session.is_active);

  if (activeSessions.length === 0) {
    return createOpsSummary(
      'Idle',
      'ok',
      'Safe to context-switch · nothing active in the last 10 min.',
      'No sessions changed in the active window.',
    );
  }

  const mix = workMix({ ...activity, sessions: activeSessions });
  const dominant = dominantWork(mix);
  const recent = activity.recent_events[0];
  const sessionList = activeSessions.map(s => s.id).join(', ');
  if (recent?.category === 'waiting' || recent?.category === 'prompt' || recent?.category === 'arrival') {
    return createOpsSummary(
      'Waiting',
      'watch',
      `Copilot is waiting on you · ${sessionList}`,
      `Latest signal is ${recent.category}.`,
    );
  }

  if (dominant === 'command') {
    return createOpsSummary('Validating', 'ok', `Running commands/tests · ${sessionList}`, 'Command/test tools dominate active work.');
  }
  if (dominant === 'write') {
    return createOpsSummary('Editing', 'watch', `Changing files · review diffs · ${sessionList}`, 'Edit tools dominate active work.');
  }
  if (dominant === 'read') {
    return createOpsSummary('Gathering context', 'ok', `Reading source · ${sessionList}`, 'Read/search tools dominate active work.');
  }
  if (dominant === 'web') {
    return createOpsSummary('Researching', 'ok', `Fetching docs/web · ${sessionList}`, 'Web/docs tools dominate active work.');
  }
  if (dominant === 'task') {
    return createOpsSummary('Delegating', 'watch', `Sub-agent active · ${sessionList}`, 'Delegation tools dominate active work.');
  }

  return createOpsSummary('Working', 'ok', `Active · ${sessionList}`, 'Active session has recent signals.');
}

export function errorOrReview(session: CopilotSessionSummary) {
  return session.status === 'needs-attention';
}

export function providerAttentionAlerts(activity: CopilotActivity): string[] {
  return (activity.alerts ?? []).filter(alert =>
    /provider|session[- ]state|state root|home folders?|CLI|executable|not found|not ready|not authenticated|Codex|Claude|Copilot/i.test(alert),
  );
}

export function buildAttentionItems(activity: CopilotActivity): AttentionSummary {
  const items: AttentionItem[] = [];

  if (!activity.available) {
    items.push({
      id: 'provider-unavailable',
      severity: 'watch',
      confidence: 'direct',
      source: 'provider',
      title:       'Agent activity source unavailable',
      detail: 'The scanner did not find a usable selected agent provider or local session source.',
      action: 'none',
    });
  }

  providerAttentionAlerts(activity).forEach((alert, index) => {
    items.push({
      id: `provider-alert-${index}-${stableAttentionIdPart(alert)}`,
      severity: 'watch',
      confidence: 'direct',
      source: 'provider',
      title: 'Provider scan needs review',
      detail: alert,
      action: 'none',
    });
  });

  (activity.schema_drift ?? []).forEach((report, index) => {
    items.push({
      id: `schema-drift-${report.provider || 'provider'}-${report.schema_version || index}`,
      severity: 'watch',
      confidence: 'direct',
      source: 'schema',
      title: 'Possible provider schema drift',
      detail: report.summary || 'The provider saw unexpected event shapes, so monitoring may be incomplete.',
      action: 'open-schema-drift',
    });
  });

  const sorted = dedupeAttentionItems(items).sort(compareAttentionItems);
  const highestSeverity = sorted[0]?.severity ?? 'info';
  return {
    count: sorted.length,
    highestSeverity,
    summary: sorted.length === 0
      ? 'No action needed'
      : sorted.length === 1
        ? '1 attention item'
        : `${sorted.length} attention items`,
    empty: 'No action needed. Monitored provider and schema signals are healthy.',
    items: sorted,
  };
}

function detectConcreteOpsSignal(activity: CopilotActivity): OpsSummary | null {
  const events = activity.recent_events;
  const sessions = activity.sessions.filter(s => s.is_active);
  const activeIds = new Set(sessions.map(s => s.id));

  const trailing = events
    .filter(e => !e.synthetic)
    .slice(0, 10)
    .filter(e => activeIds.has(e.session_id));
  const counts = new Map<string, number>();
  for (const e of trailing) {
    if (e.kind === 'tool.execution_start') {
      counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
    }
  }
  const looped = [...counts.entries()].find(([, c]) => c >= 5);
  if (looped) {
    return createOpsSummary(
      'Possible loop',
      'watch',
      `${looped[0]} called ${looped[1]}× recently · consider interrupting`,
      'A single tool name dominates the recent event window.',
    );
  }

  return null;
}

function createEmptyWorkMix(): WorkMixCounts {
  return { read: 0, write: 0, command: 0, web: 0, task: 0, mcp: 0, hooks: 0 };
}

function workMix(activity: CopilotActivity): WorkMixCounts {
  return activity.sessions.reduce(
    (mix, session) => ({
      read: mix.read + session.read_count,
      write: mix.write + session.write_count,
      command: mix.command + session.command_count,
      web: mix.web + session.web_count,
      task: mix.task + session.task_count,
      mcp: mix.mcp + (session.mcp_count ?? 0),
      hooks: mix.hooks + (session.hooks_count ?? 0),
    }),
    createEmptyWorkMix(),
  );
}

function dominantWork(mix: WorkMixCounts) {
  const entries = Object.entries(mix) as [keyof WorkMixCounts, number][];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0]?.[1] > 0 ? entries[0][0] : 'activity';
}

function stableAttentionIdPart(value: string): string {
  return (value || 'none').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'none';
}

function dedupeAttentionItems(items: AttentionItem[]): AttentionItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  const severityRank: Record<AttentionSeverity, number> = { critical: 0, review: 1, watch: 2, info: 3 };
  const severityDelta = severityRank[a.severity] - severityRank[b.severity];
  if (severityDelta !== 0) return severityDelta;
  const bTime = eventTimestampMs(b.timestamp) ?? 0;
  const aTime = eventTimestampMs(a.timestamp) ?? 0;
  return bTime - aTime || a.title.localeCompare(b.title);
}

function eventTimestampMs(timestamp?: string): number | null {
  const t = Date.parse(timestamp ?? '');
  return Number.isNaN(t) ? null : t;
}
