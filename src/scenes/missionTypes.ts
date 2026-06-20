export type MissionCategory = 'edits' | 'library' | 'terminal' | 'signal' | 'hooks' | 'delegates' | 'skills' | 'court' | 'mcp' | 'workshop' | 'complete' | 'alert' | 'thinking' | 'waiting' | 'prompt' | 'arrival' | 'activity';

export interface CopilotToolMetric {
  name: string;
  category: MissionCategory | string;
  count: number;
}

export interface CopilotEventSummary {
  session_id: string;
  timestamp: string;
  kind: string;
  tool: string;
  category: MissionCategory | string;
  success: boolean;
  input_tokens?: number;
  output_tokens?: number;
}

export interface CopilotSessionSummary {
  id: string;
  title: string;
  session_name?: string;
  repository: string;
  branch: string;
  updated_at: string;
  is_active: boolean;
  status: 'working' | 'thinking' | 'waiting' | 'needs-attention' | 'idle' | string;
  event_count: number;
  tool_count: number;
  write_count: number;
  read_count: number;
  command_count: number;
  web_count: number;
  task_count: number;
  delegates_count?: number;
  skills_count?: number;
  court_count?: number;
  mcp_count?: number;
  hooks_count?: number;
  error_count: number;
  turn_count?: number;
  output_tokens: number;
  input_tokens?: number;
  input_tokens_pending?: boolean;
  last_tool: string;
  last_event_kind?: string;
  last_event_category?: string;
  last_event_timestamp?: string;
  stale_seconds?: number;
  last_model?: string;
  git_root?: string;
  recent_tool_calls?: SessionToolCall[];
  recent_turns?: SessionTurnSummary[];
  token_checkpoints?: SessionTokenCheckpoint[];
  activity_signal?: CopilotActivitySignal;
  replay_activity?: {
    last: string;
    tool: string;
    age: string;
  };
}

export interface SessionTokenCheckpoint {
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
}

export interface SessionToolCall {
  tool: string;
  category: string;
  timestamp: string;
  success: boolean;
  completed_at?: string;
  model?: string;
  call_id?: string;
  event_ref?: string;
  turn_id?: string;
  target?: string;
  details?: SafeDetail[];
  duration_ms?: number;
}

export interface SafeDetail {
  label: string;
  value: string;
}

export interface SessionTurnSummary {
  id: string;
  started_at: string;
  ended_at: string;
  status: 'running' | 'complete' | 'failed' | string;
  tool_count: number;
  tools?: string[];
  failure_count: number;
  categories: string[];
  model?: string;
  output_tokens?: number;
  partial?: boolean;
  duration_ms?: number;
}

export interface CopilotHistoryBucket {
  start: string;
  label: string;
  event_count: number;
  launch_count?: number;
  failure_count: number;
  active_sessions: number;
}

export interface CopilotActivitySignalBucket extends CopilotHistoryBucket {
  launch_count: number;
  turn_count?: number;
  intensity: number;
}

export interface CopilotActivitySignal {
  generated_at_ms: number;
  launches_last_5m: number;
  launches_last_hour: number;
  velocity_per_hour: number;
  peak_velocity_per_hour: number;
  peak_hour_event_count_24h: number;
  busiest_hour_label_24h: string;
  active_hours_24h: number;
  hourly_24h: CopilotActivitySignalBucket[];
}

export interface CopilotHistoryMetric {
  name: string;
  count: number;
  percent?: number;
  secondary_count?: number;
  last_seen?: string;
}

export interface CopilotHistorySession {
  id: string;
  title: string;
  session_name?: string;
  repository: string;
  branch: string;
  updated_at: string;
  is_active: boolean;
  status: string;
  event_count: number;
  tool_count?: number;
  error_count: number;
  turn_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  last_model?: string;
  last_tool: string;
}

export interface CopilotHistoryFailure {
  session_id: string;
  timestamp: string;
  kind: string;
  tool: string;
  category: MissionCategory | string;
}

export interface CopilotHistorySummary {
  generated_at_ms: number;
  last_activity_at?: string;
  event_count?: number;
  tool_count?: number;
  failure_count: number;
  activity_24h: CopilotHistoryBucket[];
  activity_7d: CopilotHistoryBucket[];
  model_mix: CopilotHistoryMetric[];
  category_mix: CopilotHistoryMetric[];
  top_tools: CopilotHistoryMetric[];
  high_activity_sessions?: CopilotHistorySession[];
  recent_sessions: CopilotHistorySession[];
  recent_failures: CopilotHistoryFailure[];
  session_scopes?: CopilotHistorySessionScope[];
}

export interface CopilotHistorySessionScope extends CopilotHistorySummary {
  session_id: string;
  label: string;
  session_scopes?: never;
}

export interface CopilotActivity {
  available: boolean;
  source: string;
  scanned_sessions: number;
  active_sessions: number;
  total_events: number;
  total_tool_calls: number;
  total_output_tokens: number;
  total_input_tokens?: number;
  total_turns?: number;
  sessions: CopilotSessionSummary[];
  tools: CopilotToolMetric[];
  recent_events: CopilotEventSummary[];
  alerts: string[];
  schema_drift?: SchemaDriftReport[];
  history?: CopilotHistorySummary;
  activity_signal?: CopilotActivitySignal;
  generated_at_ms: number;
}

export interface EngineeringDigest {
  generated_at_ms: number;
  selected_day: string;
  month: string;
  available_years: number[];
  calendar_days: EngineeringDigestCalendarDay[];
  day: EngineeringDigestDay;
  caveats: string[];
}

export interface EngineeringDigestCalendarDay {
  local_day: string;
  day_number: number;
  in_month: boolean;
  enabled: boolean;
  is_today: boolean;
  intensity: number;
  sessions: number;
  events: number;
  turns: number;
  tool_calls: number;
  failures: number;
  input_tokens: number;
  output_tokens: number;
  estimated_active_ms: number;
  partial: boolean;
  badges: string[];
  dominant_repo?: string;
  dominant_branch?: string;
}

export interface EngineeringDigestDay {
  local_day: string;
  totals: Array<{
    label: string;
    value: number;
    exact?: boolean;
    estimated?: boolean;
    partial?: boolean;
  }>;
  activity_rate?: EngineeringDigestActivityBucket[];
  repos: EngineeringDigestRepoGroup[];
  models: Array<{
    label: string;
    category: string;
    value: number;
    secondary_value?: number;
    tertiary_value?: number;
    partial?: boolean;
  }>;
  tools: EngineeringDigestTool[];
  failures: EngineeringDigestFailure[];
  token_hotspots: EngineeringDigestSession[];
  useful_sessions: EngineeringDigestSession[];
  narrative: string;
  exports: EngineeringDigestExport[];
}

export interface EngineeringDigestActivityBucket {
  start_ms: number;
  label: string;
  event_count: number;
  tool_call_count: number;
  turn_count: number;
  failure_count: number;
  session_count: number;
  intensity: number;
}

export interface EngineeringDigestRepoGroup {
  repository: string;
  branch: string;
  sessions: EngineeringDigestSession[];
  events: number;
  failures: number;
  input_tokens: number;
  output_tokens: number;
  first_seen_ms: number;
  last_seen_ms: number;
}

export interface EngineeringDigestSession {
  session_hash: string;
  title: string;
  repository: string;
  branch: string;
  status: string;
  is_active: boolean;
  events: number;
  failures: number;
  turns: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  last_model: string;
  first_seen_ms: number;
  last_seen_ms: number;
}

export interface EngineeringDigestTool {
  name: string;
  category: string;
  calls: number;
  successes: number;
  failures: number;
  total_duration_ms: number;
}

export interface EngineeringDigestFailure {
  kind: string;
  tool: string;
  category: string;
  count: number;
  last_seen_ms: number;
}

export interface EngineeringDigestExport {
  kind: string;
  label: string;
  body: string;
}

export interface SchemaDriftReport {
  provider: string;
  schema_version: string;
  severity: string;
  summary: string;
  checked_sessions: number;
  affected_sessions: number;
  total_events: number;
  recognized_events: number;
  tool_starts: number;
  tool_completes: number;
  missing_event_type: number;
  unknown_event_types: Array<{ name: string; count: number }>;
  hints: string[];
}
