//! Agent activity providers.
//!
//! Each AI agent (Copilot CLI today, Claude Code / Codex / etc. in the
//! future) plugs in by implementing [`AgentProvider`]. Each provider
//! returns a sanitized [`ProviderScan`] containing only allowlisted
//! summary fields (no prompts, no tool args, no command output, no file
//! contents, no diffs). The merger [`collect_agent_activity`] composes
//! provider scans into the [`AgentActivity`] shape consumed by the
//! Agent Mission Control scene.
//!
//! A filesystem watcher (see [`start_watcher`]) replaces the previous
//! 5-second renderer poll by emitting a JS callback whenever any
//! provider's state directory changes. The callback is debounced to
//! ~300ms so bursty writes coalesce into a single refresh.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, fs};

use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, Local, LocalResult, NaiveDate, TimeZone,
    Timelike, Utc,
};
use notify::{recommended_watcher, RecursiveMode, Watcher};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

// ── Public types serialized to the renderer ───────────────────────────

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentActivity {
    pub available: bool,
    pub source: String,
    pub scanned_sessions: usize,
    pub active_sessions: usize,
    pub total_events: usize,
    pub total_tool_calls: usize,
    pub total_output_tokens: u64,
    pub total_input_tokens: u64,
    /// Total assistant turns observed across all scanned sessions.
    /// One turn = one model round-trip.
    #[serde(default)]
    pub total_turns: usize,
    pub sessions: Vec<AgentSessionSummary>,
    pub tools: Vec<AgentToolMetric>,
    pub recent_events: Vec<AgentEventSummary>,
    pub alerts: Vec<String>,
    #[serde(default)]
    pub schema_drift: Vec<SchemaDriftReport>,
    #[serde(default)]
    pub history: AgentHistorySummary,
    #[serde(default)]
    pub activity_signal: AgentActivitySignal,
    pub generated_at_ms: u64,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentActivitySignal {
    pub generated_at_ms: u64,
    pub launches_last_5m: usize,
    pub launches_last_hour: usize,
    pub velocity_per_hour: f64,
    pub peak_velocity_per_hour: usize,
    pub peak_hour_event_count_24h: usize,
    pub busiest_hour_label_24h: String,
    pub active_hours_24h: usize,
    pub hourly_24h: Vec<AgentActivitySignalBucket>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentActivitySignalBucket {
    pub start: String,
    pub label: String,
    pub event_count: usize,
    pub launch_count: usize,
    #[serde(default)]
    pub turn_count: usize,
    pub failure_count: usize,
    pub active_sessions: usize,
    pub intensity: f64,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentHistorySummary {
    pub generated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    pub event_count: usize,
    pub tool_count: usize,
    pub failure_count: usize,
    pub activity_24h: Vec<AgentHistoryBucket>,
    pub activity_7d: Vec<AgentHistoryBucket>,
    pub model_mix: Vec<AgentHistoryMetric>,
    pub category_mix: Vec<AgentHistoryMetric>,
    pub top_tools: Vec<AgentHistoryMetric>,
    #[serde(default)]
    pub high_activity_sessions: Vec<AgentHistorySession>,
    pub recent_sessions: Vec<AgentHistorySession>,
    pub recent_failures: Vec<AgentHistoryFailure>,
    #[serde(default)]
    pub session_scopes: Vec<AgentHistorySessionScope>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentHistoryBucket {
    pub start: String,
    pub label: String,
    pub event_count: usize,
    #[serde(default)]
    pub launch_count: usize,
    pub failure_count: usize,
    pub active_sessions: usize,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentHistoryMetric {
    pub name: String,
    pub count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentHistorySession {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub session_name: String,
    pub repository: String,
    pub branch: String,
    pub updated_at: String,
    pub is_active: bool,
    pub status: String,
    pub event_count: usize,
    #[serde(default)]
    pub tool_count: usize,
    pub error_count: usize,
    #[serde(default)]
    pub turn_count: usize,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub last_model: String,
    pub last_tool: String,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentHistoryFailure {
    pub session_id: String,
    pub timestamp: String,
    pub kind: String,
    pub tool: String,
    pub category: String,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentHistorySessionScope {
    pub session_id: String,
    pub label: String,
    #[serde(flatten)]
    pub summary: AgentHistoryScopeSummary,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentHistoryScopeSummary {
    pub generated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    pub event_count: usize,
    pub tool_count: usize,
    pub failure_count: usize,
    pub activity_24h: Vec<AgentHistoryBucket>,
    pub activity_7d: Vec<AgentHistoryBucket>,
    pub model_mix: Vec<AgentHistoryMetric>,
    pub category_mix: Vec<AgentHistoryMetric>,
    pub top_tools: Vec<AgentHistoryMetric>,
    #[serde(default)]
    pub high_activity_sessions: Vec<AgentHistorySession>,
    pub recent_sessions: Vec<AgentHistorySession>,
    pub recent_failures: Vec<AgentHistoryFailure>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct SchemaDriftReport {
    pub provider: String,
    pub schema_version: String,
    pub severity: String,
    pub summary: String,
    pub checked_sessions: usize,
    pub affected_sessions: usize,
    pub total_events: usize,
    pub recognized_events: usize,
    pub tool_starts: usize,
    pub tool_completes: usize,
    pub missing_event_type: usize,
    pub unknown_event_types: Vec<SchemaDriftCount>,
    pub hints: Vec<String>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct SchemaDriftCount {
    pub name: String,
    pub count: usize,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentSessionSummary {
    #[serde(default)]
    pub provider: String,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub session_name: String,
    pub repository: String,
    pub branch: String,
    pub updated_at: String,
    pub is_active: bool,
    pub status: String,
    pub event_count: usize,
    pub tool_count: usize,
    pub write_count: usize,
    pub read_count: usize,
    pub command_count: usize,
    pub web_count: usize,
    pub task_count: usize,
    #[serde(default)]
    pub delegates_count: usize,
    #[serde(default)]
    pub skills_count: usize,
    #[serde(default)]
    pub court_count: usize,
    /// Tools served by MCP servers (github-mcp-server-*, context7-*,
    /// kit-dev-mcp-*, etc.) — separate bucket because they sit on a
    /// dedicated quarter in the renderer.
    #[serde(default)]
    pub mcp_count: usize,
    /// Copilot CLI hook callbacks (sessionStart, postToolUse, agentStop,
    /// etc.). Hook inputs/outputs are never surfaced; this is a count
    /// and sanitized transcript marker only.
    #[serde(default)]
    pub hooks_count: usize,
    pub error_count: usize,
    /// Count of assistant.turn_start events for this session. Lets the
    /// renderer surface a "turns" metric (one turn = one model round
    /// trip: user prompt → model thinks/calls tools → model replies).
    #[serde(default)]
    pub turn_count: usize,
    pub output_tokens: u64,
    pub input_tokens: u64,
    pub last_tool: String,
    pub last_event_kind: String,
    pub last_event_category: String,
    pub last_event_timestamp: String,
    pub stale_seconds: u64,
    /// Most recent model id observed on this session's
    /// `assistant.message` or `tool.execution_complete` events (e.g.
    /// `"gpt-5.5"`). Empty when the session log has no model-bearing
    /// events yet. Lets the renderer display the active model in the
    /// navbar and update it when the user switches models mid-session.
    #[serde(default)]
    pub last_model: String,
    /// Absolute path to the session's git root. Exposed so the
    /// renderer can offer "open in editor" deep links. Empty when the
    /// workspace.yaml didn't record one.
    #[serde(default)]
    pub git_root: String,
    /// Most recent tool calls for this session (newest last), capped at
    /// [`MAX_SESSION_TOOL_CALLS`]. Each entry is the privacy-safe
    /// summary the renderer needs to render a transcript drill-down
    /// (tool name, category, success, timestamp, duration ms).
    #[serde(default)]
    pub recent_tool_calls: Vec<SessionToolCall>,
    /// Recent assistant turns observed in the tail window. These are
    /// sanitized rollups only: no prompt text, assistant text, tool args,
    /// command output, file paths, or diffs.
    #[serde(default)]
    pub recent_turns: Vec<SessionTurnSummary>,
    /// Privacy-safe token totals over time. Contains only timestamp plus
    /// cumulative input/output token counts so replay can move the token
    /// display without exposing prompt, response, args, paths, or diffs.
    #[serde(default)]
    pub token_checkpoints: Vec<SessionTokenCheckpoint>,
    /// Privacy-safe selected-session 24h activity signal. Unlike
    /// `recent_tool_calls` and `recent_turns`, this is computed from the
    /// full event stream with an allowlisted aggregate only, so the
    /// selected session panel can show the whole rolling day without
    /// surfacing prompts, args, command output, paths, or diffs.
    #[serde(default)]
    pub activity_signal: AgentActivitySignal,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct SessionToolCall {
    pub tool: String,
    pub category: String,
    pub timestamp: String,
    pub success: bool,
    #[serde(default)]
    pub completed_at: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub call_id: String,
    #[serde(default)]
    pub event_ref: String,
    #[serde(default)]
    pub turn_id: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub details: Vec<SafeDetail>,
    /// Duration in ms between matching start/complete events. None when
    /// the call is still in flight or the complete event is missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct SafeDetail {
    pub label: String,
    pub value: String,
}

#[derive(serde::Serialize, Default)]
pub struct RawToolCallDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_args: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub raw_args_truncated: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub raw_output_truncated: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub raw_output_scan_limited: bool,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct SessionTurnSummary {
    pub id: String,
    pub started_at: String,
    pub ended_at: String,
    pub status: String,
    pub tool_count: usize,
    #[serde(default)]
    pub tools: Vec<String>,
    pub failure_count: usize,
    pub categories: Vec<String>,
    pub model: String,
    pub output_tokens: u64,
    /// True when the scanner saw activity for a turn but the turn_start
    /// event was outside the tail window.
    #[serde(default)]
    pub partial: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct SessionTokenCheckpoint {
    pub timestamp: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct AgentToolMetric {
    pub name: String,
    pub category: String,
    pub count: usize,
}

#[derive(serde::Serialize, Clone)]
pub struct AgentEventSummary {
    #[serde(default)]
    pub provider: String,
    pub session_id: String,
    pub timestamp: String,
    pub kind: String,
    pub tool: String,
    pub category: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
}

// ── Provider abstraction ──────────────────────────────────────────────

/// Raw, un-truncated per-provider scan. The merger handles global
/// sorting and top-N truncation so providers cannot accidentally drop
/// events that would have ranked highly across the merged result set.
pub struct ProviderScan {
    pub provider: &'static str,
    pub available: bool,
    pub sessions: Vec<AgentSessionSummary>,
    pub tool_counts: BTreeMap<(String, String), usize>,
    pub recent_events: Vec<AgentEventSummary>,
    pub alerts: Vec<String>,
    pub schema_drift: Vec<SchemaDriftReport>,
    pub total_events: usize,
    pub total_tool_calls: usize,
    pub total_output_tokens: u64,
    pub total_input_tokens: u64,
    pub total_turns: usize,
    pub active_sessions: usize,
    pub scanned_sessions: usize,
}

impl ProviderScan {
    fn unavailable(provider: &'static str) -> Self {
        Self {
            provider,
            available: false,
            sessions: Vec::new(),
            tool_counts: BTreeMap::new(),
            recent_events: Vec::new(),
            alerts: Vec::new(),
            schema_drift: Vec::new(),
            total_events: 0,
            total_tool_calls: 0,
            total_output_tokens: 0,
            total_input_tokens: 0,
            total_turns: 0,
            active_sessions: 0,
            scanned_sessions: 0,
        }
    }
}

pub trait AgentProvider: Send + Sync {
    #[allow(dead_code)]
    fn id(&self) -> &'static str;
    #[allow(dead_code)]
    fn label(&self) -> &'static str;
    #[allow(dead_code)]
    fn is_available(&self) -> bool;
    /// Directories whose changes should trigger a re-scan. Empty means
    /// the provider cannot be watched (e.g. it polls a remote endpoint).
    fn state_roots(&self) -> Vec<PathBuf>;
    fn scan(&self, include_history: bool) -> ProviderScan;
}

pub fn default_providers() -> Vec<Box<dyn AgentProvider>> {
    vec![Box::new(CopilotProvider)]
}

// ── Top-level merge ───────────────────────────────────────────────────

const MAX_SESSIONS: usize = 12;
const MAX_SCANNED_SESSIONS: usize = 64;
const MAX_TOOLS: usize = 10;
const MAX_TOOLS_PER_CATEGORY: usize = 5;
const ACTIVITY_CACHE_MAX_AGE_MS: u64 = 2_000;
/// Recent global event feed cap (after merging across providers). Bumped
/// from 18 → 80 so chatty bursts between scans don't drop events that
/// the renderer's workMixHistory needs to accumulate per category.
const MAX_RECENT_EVENTS: usize = 80;
const MAX_SESSION_TOKEN_CHECKPOINTS: usize = 120;
const HISTORY_HOUR_BUCKETS: usize = 24;
const HISTORY_DAY_BUCKETS: usize = 7;
const MAX_HISTORY_METRICS: usize = 10;
const MAX_HISTORY_RECENT_SESSIONS: usize = 16;
const MAX_HISTORY_RECENT_FAILURES: usize = 20;
const HOUR_MS: u64 = 60 * 60 * 1000;
const DAY_MS: u64 = 24 * HOUR_MS;
/// Sessions whose `events.jsonl` has not been touched within the visible
/// history window are considered stale "ghost" sessions and excluded from
/// the scan. Without this filter the user's accumulated session-state
/// directory floods the picker with old runs that are outside the archive.
const STALE_SESSION_CUTOFF_SECS: u64 = HISTORY_DAY_BUCKETS as u64 * 24 * 60 * 60;
/// Tool-call entries retained per session for the inspector transcript
/// drill-down. Bumped from 20 → 120 so low-volume categories (Intent,
/// Skills, Agents) survive bursts of high-volume categories (bash,
/// view) without getting evicted from the buffer.
const MAX_SESSION_TOOL_CALLS: usize = 120;
/// Turn summaries retained per session for the turn-by-turn story panel.
/// Matches the same "recent, bounded, tail-window" philosophy as tool
/// calls so the bridge payload stays small even during long sessions.
const MAX_SESSION_TURNS: usize = 80;
const BUNDLED_COPILOT_SCHEMA: &str = include_str!("../provider-schemas/copilot.json");
const SUPPORTED_SCHEMA_MAJOR: &str = "1";
const REMOTE_COPILOT_SCHEMA_INDEX_URL: &str =
    "https://danwahlin.github.io/agent-mission-control/provider-schemas/copilot/index.json";
const SCHEMA_FETCH_TIMEOUT_SECS: u64 = 2;
const MISSION_CONTROL_ANALYTICS_MARKER: &str = "COPILOT_MISSION_CONTROL_ANALYTICS_CHAT_IGNORE";
static COPILOT_SCHEMA: OnceLock<(ProviderSchema, Vec<String>)> = OnceLock::new();
static ACTIVITY_CACHE: OnceLock<RwLock<AgentActivity>> = OnceLock::new();
static ACTIVITY_REFRESH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static COPILOT_SESSION_SCAN_CACHE: OnceLock<
    RwLock<HashMap<CopilotSessionCacheKey, CachedCopilotSessionScan>>,
> = OnceLock::new();
static COPILOT_TOKEN_PREFIX_CACHE: OnceLock<
    RwLock<HashMap<CopilotTokenPrefixCacheKey, CachedTokenPrefix>>,
> = OnceLock::new();
const MAX_COPILOT_SESSION_SCAN_CACHE_ENTRIES: usize = 256;
const MAX_COPILOT_TOKEN_PREFIX_CACHE_ENTRIES: usize = 256;
const MAX_EVENT_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_RAW_DETAIL_SCAN_BYTES: u64 = 8 * 1024 * 1024;
const MAX_RAW_DETAIL_VALUE_BYTES: usize = 512 * 1024;
const TOKEN_PREFIX_HEAD_SIGNATURE_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct FileFingerprint {
    len: u64,
    modified_secs: u64,
    modified_nanos: u32,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CopilotSessionCacheKey {
    session_path: PathBuf,
    events: FileFingerprint,
    workspace: Option<FileFingerprint>,
    schema_context: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CopilotTokenPrefixCacheKey {
    events_path: PathBuf,
    schema_context: String,
}

#[derive(Clone)]
struct CachedCopilotSessionScan {
    summary: AgentSessionSummary,
    tool_counts: BTreeMap<(String, String), usize>,
    recent_events: Vec<AgentEventSummary>,
    schema_stats: SessionSchemaStats,
}

#[derive(Clone, Copy, Default)]
struct TokenTotals {
    input_tokens: u64,
    output_tokens: u64,
}

#[derive(Clone)]
struct CachedTokenPrefix {
    processed_len: u64,
    totals: TokenTotals,
    head_signature: Vec<u8>,
}

#[derive(serde::Deserialize, Clone)]
struct ProviderSchema {
    schema_version: String,
    provider: String,
    state_root: Vec<String>,
    session: SessionSchema,
    workspace: WorkspaceSchema,
    events: EventsSchema,
    #[serde(default)]
    hooks: HookConfigSchema,
    #[serde(default)]
    token_events: Vec<TokenEventSchema>,
    #[serde(default)]
    tool_identity_rules: Vec<ToolIdentityRule>,
    mcp: McpSchema,
    #[serde(default)]
    tool_category_rules: Vec<ToolCategoryRule>,
    fallback_category: String,
}

#[derive(serde::Deserialize, Clone)]
struct SessionSchema {
    events_files: Vec<String>,
    workspace_files: Vec<String>,
    relevant_files: Vec<String>,
}

#[derive(serde::Deserialize, Clone)]
struct WorkspaceSchema {
    allowed_keys: Vec<String>,
}

#[derive(serde::Deserialize, Clone)]
struct EventsSchema {
    event_type_paths: Vec<String>,
    tool_start: String,
    tool_complete: String,
    assistant_message: String,
    assistant_turn_start: String,
    assistant_turn_end: String,
    user_message: String,
    session_start: String,
    #[serde(default)]
    hook_start: String,
    #[serde(default)]
    hook_complete: String,
    #[serde(default)]
    ignore_as_last_event: Vec<String>,
    timestamp_paths: Vec<String>,
    model_paths: Vec<String>,
    tool_name_paths: Vec<String>,
    arguments_paths: Vec<String>,
    #[serde(default)]
    output_paths: Vec<String>,
    success_paths: Vec<String>,
    output_token_paths: Vec<String>,
    turn_id_paths: Vec<String>,
    tool_call_id_paths: Vec<String>,
    #[serde(default)]
    hook_name_paths: Vec<String>,
    #[serde(default)]
    hook_invocation_id_paths: Vec<String>,
    #[serde(default)]
    hook_input_paths: Vec<String>,
    #[serde(default)]
    hook_output_paths: Vec<String>,
}

#[derive(serde::Deserialize, Clone, Default)]
struct HookConfigSchema {
    #[serde(default)]
    config_path: Vec<String>,
    #[serde(default)]
    hook_types_path: String,
}

#[derive(serde::Deserialize, Clone)]
struct TokenEventSchema {
    event_type: String,
    mode: String,
    #[serde(default)]
    input_components: Vec<String>,
    #[serde(default)]
    output_components: Vec<String>,
    #[serde(default)]
    model_metrics: Option<ModelMetricsTokenSchema>,
}

#[derive(serde::Deserialize, Clone)]
struct ModelMetricsTokenSchema {
    metrics_path: String,
    input_path: String,
    cache_read_path: String,
    output_path: String,
}

#[derive(serde::Deserialize, Clone)]
struct ToolIdentityRule {
    tool: String,
    category: String,
    #[serde(default)]
    target_paths: Vec<String>,
    fallback: String,
    #[serde(default)]
    safe_details: Vec<SafeDetailRule>,
}

#[derive(serde::Deserialize, Clone)]
struct SafeDetailRule {
    label: String,
    paths: Vec<String>,
    fallback: String,
}

#[derive(serde::Deserialize, Clone)]
struct McpSchema {
    allowlist_path: Vec<String>,
    servers_path: String,
    tools_key: String,
}

#[derive(serde::Deserialize, Clone)]
struct ToolCategoryRule {
    category: String,
    #[serde(default)]
    exact: Vec<String>,
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    mcp_allowlist: bool,
}

#[derive(serde::Deserialize)]
struct ProviderSchemaIndex {
    schema_index_version: u64,
    provider: String,
    schemas: Vec<RemoteSchemaEntry>,
}

#[derive(serde::Deserialize, Clone)]
struct RemoteSchemaEntry {
    version: String,
    url: String,
    sha256: String,
}

fn load_copilot_schema() -> (ProviderSchema, Vec<String>) {
    COPILOT_SCHEMA.get_or_init(resolve_copilot_schema).clone()
}

fn resolve_copilot_schema() -> (ProviderSchema, Vec<String>) {
    let bundled = parse_provider_schema(BUNDLED_COPILOT_SCHEMA)
        .expect("bundled Copilot provider schema must be valid");
    let mut alerts = Vec::new();

    // Runtime schema overrides are deliberately opt-in. A provider
    // schema controls which local JSON paths get inspected, so release
    // builds must not accept arbitrary environment-provided schemas by
    // accident. The interpreter still sanitizes every surfaced value,
    // but the safest default is the signed, bundled schema.
    let override_enabled = env::var("CMC_ALLOW_SCHEMA_OVERRIDE")
        .map(|value| value == "1")
        .unwrap_or(false);
    if override_enabled {
        if let Some(path) = env::var_os("CMC_COPILOT_SCHEMA").map(PathBuf::from) {
            match fs::read_to_string(&path)
                .map_err(|err| err.to_string())
                .and_then(|raw| parse_provider_schema(&raw))
            {
                Ok(schema) => return (schema, alerts),
                Err(err) => {
                    alerts.push(format!(
                        "Unable to load Copilot provider schema override {}; using bundled schema: {}",
                        path.display(),
                        err
                    ));
                    return (bundled, alerts);
                }
            }
        }
    }

    if env::var("CMC_DISABLE_REMOTE_SCHEMA")
        .map(|value| value == "1")
        .unwrap_or(false)
    {
        return (bundled, alerts);
    }

    match load_remote_copilot_schema(&bundled) {
        Ok(Some(schema)) => return (schema, alerts),
        Ok(None) => {}
        Err(err) => log::debug!("Unable to load remote Copilot provider schema: {}", err),
    }

    match load_cached_copilot_schema(&bundled) {
        Ok(Some(schema)) => (schema, alerts),
        Ok(None) => (bundled, alerts),
        Err(err) => {
            log::debug!("Unable to load cached Copilot provider schema: {}", err);
            (bundled, alerts)
        }
    }
}

fn load_remote_copilot_schema(bundled: &ProviderSchema) -> Result<Option<ProviderSchema>, String> {
    let index_raw = fetch_schema_url(REMOTE_COPILOT_SCHEMA_INDEX_URL)?;
    let index: ProviderSchemaIndex =
        serde_json::from_str(&index_raw).map_err(|err| err.to_string())?;
    validate_schema_index(&index)?;
    let Some(entry) = newest_compatible_schema_entry(&index.schemas, &bundled.schema_version)
    else {
        return Ok(None);
    };
    let schema_url = resolve_schema_url(REMOTE_COPILOT_SCHEMA_INDEX_URL, &entry.url)?;
    let schema_raw = fetch_schema_url(&schema_url)?;
    validate_schema_checksum(&schema_raw, &entry.sha256)?;
    let schema = parse_provider_schema(&schema_raw)?;
    if schema.schema_version != entry.version {
        return Err(format!(
            "remote schema version '{}' did not match index entry '{}'",
            schema.schema_version, entry.version
        ));
    }
    cache_copilot_schema(&schema.schema_version, &schema_raw);
    Ok(Some(schema))
}

fn load_cached_copilot_schema(bundled: &ProviderSchema) -> Result<Option<ProviderSchema>, String> {
    let Some(cache_dir) = copilot_schema_cache_dir() else {
        return Ok(None);
    };
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return Ok(None);
    };
    let mut schemas = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(schema) = parse_provider_schema(&raw) else {
            continue;
        };
        if is_compatible_schema_version(&schema.schema_version)
            && is_newer_schema_version(&schema.schema_version, &bundled.schema_version)
            && cached_schema_checksum_valid(&path, &raw)
        {
            schemas.push(schema);
        }
    }
    schemas.sort_by(|a, b| {
        compare_versions(&b.schema_version, &a.schema_version).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(schemas.into_iter().next())
}

fn validate_schema_index(index: &ProviderSchemaIndex) -> Result<(), String> {
    if index.schema_index_version != 1 {
        return Err(format!(
            "unsupported schema index version '{}'",
            index.schema_index_version
        ));
    }
    if index.provider != "copilot" {
        return Err(format!(
            "unsupported schema index provider '{}'",
            index.provider
        ));
    }
    Ok(())
}

fn newest_compatible_schema_entry(
    entries: &[RemoteSchemaEntry],
    bundled_version: &str,
) -> Option<RemoteSchemaEntry> {
    let mut compatible = entries
        .iter()
        .filter(|entry| is_compatible_schema_version(&entry.version))
        .filter(|entry| is_newer_schema_version(&entry.version, bundled_version))
        .cloned()
        .collect::<Vec<_>>();
    compatible.sort_by(|a, b| {
        compare_versions(&b.version, &a.version).unwrap_or(std::cmp::Ordering::Equal)
    });
    compatible.into_iter().next()
}

fn fetch_schema_url(url: &str) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err(format!("refusing non-HTTPS schema URL '{}'", url));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(SCHEMA_FETCH_TIMEOUT_SECS))
        .user_agent(format!(
            "copilot-mission-control/{}",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|err| err.to_string())?;
    client
        .get(url)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|err| err.to_string())?
        .text()
        .map_err(|err| err.to_string())
}

fn resolve_schema_url(index_url: &str, schema_url: &str) -> Result<String, String> {
    let Some((base, _)) = index_url.rsplit_once('/') else {
        return Err("schema index URL has no parent path".to_string());
    };
    if schema_url.starts_with("https://") {
        let Some(relative) = schema_url.strip_prefix(&format!("{}/", base)) else {
            return Err(format!(
                "refusing schema URL outside index path '{}'",
                schema_url
            ));
        };
        if !is_safe_relative_schema_url(relative) {
            return Err(format!("refusing unsafe schema URL '{}'", schema_url));
        }
        return Ok(schema_url.to_string());
    }
    if !is_safe_relative_schema_url(schema_url) {
        return Err(format!("refusing unsafe schema URL '{}'", schema_url));
    }
    Ok(format!("{}/{}", base, schema_url))
}

fn is_safe_relative_schema_url(schema_url: &str) -> bool {
    !schema_url.is_empty()
        && schema_url.ends_with(".json")
        && !schema_url.starts_with('/')
        && !schema_url.starts_with('.')
        && !schema_url.contains("://")
        && !schema_url.contains("..")
        && !schema_url.contains('%')
        && !schema_url.contains('\\')
        && !schema_url.contains('?')
        && !schema_url.contains('#')
        && !schema_url.contains('\0')
        && schema_url.split('/').all(|segment| {
            !segment.is_empty()
                && !segment.starts_with('.')
                && segment
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        })
}

fn validate_schema_checksum(raw: &str, expected: &str) -> Result<(), String> {
    let actual = sha256_hex(raw);
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "schema checksum mismatch: expected {}, got {}",
            expected, actual
        ))
    }
}

fn sha256_hex(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

fn cache_copilot_schema(version: &str, raw: &str) {
    let Some(cache_dir) = copilot_schema_cache_dir() else {
        return;
    };
    if fs::create_dir_all(&cache_dir).is_err() {
        return;
    }
    let _ = fs::write(cache_dir.join(format!("{}.json", version)), raw);
    let _ = fs::write(
        cache_dir.join(format!("{}.sha256", version)),
        sha256_hex(raw),
    );
}

fn cached_schema_checksum_valid(path: &Path, raw: &str) -> bool {
    let checksum_path = path.with_extension("sha256");
    let Ok(expected) = fs::read_to_string(checksum_path) else {
        return false;
    };
    sha256_hex(raw).eq_ignore_ascii_case(expected.trim())
}

fn copilot_schema_cache_dir() -> Option<PathBuf> {
    home_dir().map(|home| {
        home.join(".copilot-mission-control")
            .join("provider-schemas")
            .join("copilot")
    })
}

fn is_compatible_schema_version(version: &str) -> bool {
    version.split('.').next() == Some(SUPPORTED_SCHEMA_MAJOR)
}

fn compare_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    Some(parse_schema_version(left)?.cmp(&parse_schema_version(right)?))
}

fn is_newer_schema_version(candidate: &str, baseline: &str) -> bool {
    compare_versions(candidate, baseline) == Some(std::cmp::Ordering::Greater)
}

fn parse_schema_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn parse_provider_schema(raw: &str) -> Result<ProviderSchema, String> {
    let schema: ProviderSchema = serde_json::from_str(raw).map_err(|err| err.to_string())?;
    validate_provider_schema(&schema)?;
    Ok(schema)
}

fn validate_provider_schema(schema: &ProviderSchema) -> Result<(), String> {
    if schema.provider != "copilot" {
        return Err(format!("unsupported provider '{}'", schema.provider));
    }
    let major = schema.schema_version.split('.').next().unwrap_or_default();
    if major != SUPPORTED_SCHEMA_MAJOR {
        return Err(format!(
            "unsupported schema version '{}' (expected major {})",
            schema.schema_version, SUPPORTED_SCHEMA_MAJOR
        ));
    }
    if schema.state_root.is_empty() {
        return Err("state_root must contain at least one path segment".to_string());
    }
    if schema.session.events_files.is_empty() {
        return Err("session.events_files must not be empty".to_string());
    }
    if schema.session.workspace_files.is_empty() {
        return Err("session.workspace_files must not be empty".to_string());
    }
    if schema.events.event_type_paths.is_empty()
        || schema.events.tool_start.is_empty()
        || schema.events.tool_complete.is_empty()
        || schema.events.assistant_message.is_empty()
    {
        return Err("core event type names must not be empty".to_string());
    }
    validate_path_suffixes(&schema.events.event_type_paths, &["type"], "event type")?;
    validate_path_suffixes(
        &schema.events.timestamp_paths,
        &["timestamp", "created_at"],
        "timestamp",
    )?;
    validate_path_suffixes(&schema.events.model_paths, &["model"], "model")?;
    validate_path_suffixes(
        &schema.events.tool_name_paths,
        &["toolName", "tool_name"],
        "tool name",
    )?;
    validate_path_suffixes(
        &schema.events.arguments_paths,
        &["arguments", "args"],
        "arguments",
    )?;
    validate_arguments_paths(&schema.events.arguments_paths)?;
    validate_path_suffixes(
        &schema.events.output_paths,
        &["output", "result", "error"],
        "output",
    )?;
    validate_path_suffixes(&schema.events.success_paths, &["success"], "success")?;
    validate_path_suffixes(
        &schema.events.output_token_paths,
        &["outputTokens", "output_tokens"],
        "output token",
    )?;
    validate_path_suffixes(
        &schema.events.turn_id_paths,
        &["turnId", "turn_id"],
        "turn id",
    )?;
    validate_path_suffixes(
        &schema.events.tool_call_id_paths,
        &["toolCallId", "tool_call_id"],
        "tool call id",
    )?;
    validate_path_suffixes(
        &schema.events.hook_name_paths,
        &["hookType", "hook_type"],
        "hook type",
    )?;
    validate_path_suffixes(
        &schema.events.hook_invocation_id_paths,
        &["hookInvocationId", "hook_invocation_id"],
        "hook invocation id",
    )?;
    validate_path_suffixes(&schema.events.hook_input_paths, &["input"], "hook input")?;
    validate_path_suffixes(
        &schema.events.hook_output_paths,
        &["output", "result", "error"],
        "hook output",
    )?;
    if !schema.hooks.hook_types_path.is_empty()
        && !is_safe_surface_path(&schema.hooks.hook_types_path)
    {
        return Err(format!(
            "unsafe hook types path '{}'",
            schema.hooks.hook_types_path
        ));
    }
    for token in &schema.token_events {
        if !matches!(token.mode.as_str(), "additive" | "cumulative_max") {
            return Err(format!("unsupported token mode '{}'", token.mode));
        }
    }
    for category in schema
        .tool_category_rules
        .iter()
        .map(|rule| rule.category.as_str())
        .chain(
            schema
                .tool_identity_rules
                .iter()
                .map(|rule| rule.category.as_str()),
        )
        .chain(std::iter::once(schema.fallback_category.as_str()))
    {
        if !is_known_tool_category(category) {
            return Err(format!("unknown tool category '{}'", category));
        }
    }
    for rule in &schema.tool_identity_rules {
        for path in &rule.target_paths {
            if !is_safe_surface_path(path) {
                return Err(format!(
                    "unsafe surfaced identity path '{}' for tool '{}'",
                    path, rule.tool
                ));
            }
        }
        for detail in &rule.safe_details {
            for path in &detail.paths {
                if !is_safe_surface_path(path) {
                    return Err(format!(
                        "unsafe surfaced detail path '{}' for tool '{}'",
                        path, rule.tool
                    ));
                }
            }
        }
    }
    Ok(())
}

fn is_known_tool_category(category: &str) -> bool {
    matches!(
        category,
        "edits"
            | "library"
            | "terminal"
            | "signal"
            | "hooks"
            | "delegates"
            | "skills"
            | "court"
            | "mcp"
    )
}

fn validate_path_suffixes(paths: &[String], allowed: &[&str], label: &str) -> Result<(), String> {
    for path in paths {
        let Some(last) = path.split('.').next_back() else {
            return Err(format!("invalid {} path '{}'", label, path));
        };
        if !allowed
            .iter()
            .any(|allowed| last.eq_ignore_ascii_case(allowed))
        {
            return Err(format!("unsafe {} path '{}'", label, path));
        }
    }
    Ok(())
}

fn validate_arguments_paths(paths: &[String]) -> Result<(), String> {
    for path in paths {
        if path.split('.').any(|segment| {
            matches!(
                segment.to_ascii_lowercase().as_str(),
                "prompt"
                    | "command"
                    | "content"
                    | "result"
                    | "output"
                    | "path"
                    | "file"
                    | "file_path"
                    | "diff"
            )
        }) {
            return Err(format!("unsafe arguments path '{}'", path));
        }
    }
    Ok(())
}

fn is_safe_surface_path(path: &str) -> bool {
    !path.split('.').any(|segment| {
        matches!(
            segment.to_ascii_lowercase().as_str(),
            "prompt"
                | "command"
                | "content"
                | "result"
                | "output"
                | "path"
                | "file"
                | "file_path"
                | "diff"
                | "arguments"
        )
    })
}

fn path_from_home(home: &Path, segments: &[String]) -> PathBuf {
    segments
        .iter()
        .fold(home.to_path_buf(), |path, segment| path.join(segment))
}

#[derive(Clone)]
struct CopilotStateRoot {
    path: PathBuf,
    label: String,
}

#[derive(Default)]
struct CopilotRootDiscovery {
    roots: Vec<CopilotStateRoot>,
    alerts: Vec<String>,
}

fn copilot_state_root_for_home(home: &Path, schema: &ProviderSchema) -> PathBuf {
    path_from_home(home, &schema.state_root)
}

fn no_session_state_alerts(executable_available: bool) -> Vec<String> {
    let setup_hint = if executable_available {
        "Run Copilot CLI in your terminal to create it."
    } else {
        "Copilot CLI was not found. Install GitHub Copilot CLI or add the `copilot` command to PATH, then run it once to create session state."
    };
    vec![
        format!("No Copilot session state found yet. {}", setup_hint),
        session_state_lookup_message().to_string(),
        copilot_executable_lookup_message().to_string(),
    ]
}

#[cfg(target_os = "windows")]
fn session_state_lookup_message() -> &'static str {
    r"Session-state locations checked: %USERPROFILE%\.copilot\session-state, \\wsl.localhost\<distro>\home\<user>\.copilot\session-state, and \\wsl$\<distro>\home\<user>\.copilot\session-state."
}

#[cfg(not(target_os = "windows"))]
fn session_state_lookup_message() -> &'static str {
    "Session-state location checked: ~/.copilot/session-state."
}

#[cfg(target_os = "windows")]
fn copilot_executable_lookup_message() -> &'static str {
    r"Copilot executable locations checked: PATH, %APPDATA%\npm, %LOCALAPPDATA%\Programs, and %LOCALAPPDATA%\Microsoft\WinGet\Packages."
}

#[cfg(target_os = "macos")]
fn copilot_executable_lookup_message() -> &'static str {
    "Copilot executable locations checked: PATH, ~/.local/bin, ~/bin, ~/.npm-global/bin, ~/.volta/bin, ~/.yarn/bin, /opt/homebrew/bin, and /usr/local/bin."
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn copilot_executable_lookup_message() -> &'static str {
    "Copilot executable locations checked: PATH, ~/.local/bin, ~/bin, ~/.npm-global/bin, ~/.volta/bin, and ~/.yarn/bin."
}

fn io_error_kind_label(err: &std::io::Error) -> &'static str {
    match err.kind() {
        std::io::ErrorKind::PermissionDenied => "permission denied",
        std::io::ErrorKind::TimedOut => "timed out",
        std::io::ErrorKind::NotConnected => "not connected",
        std::io::ErrorKind::Interrupted => "interrupted",
        std::io::ErrorKind::UnexpectedEof => "incomplete read",
        _ => "I/O error",
    }
}

fn session_state_recovery_hint(label: &str) -> &'static str {
    if label.starts_with("WSL distro ") {
        "Check WSL distro status or file permissions."
    } else {
        "Check file permissions."
    }
}

fn discover_copilot_state_roots(schema: &ProviderSchema) -> CopilotRootDiscovery {
    let mut discovery = CopilotRootDiscovery::default();
    if let Some(home) = home_dir() {
        discovery.roots.push(CopilotStateRoot {
            path: copilot_state_root_for_home(&home, schema),
            label: "local".to_string(),
        });
    } else {
        discovery.alerts.push(
            "Your home folder could not be found, so Copilot session state cannot be scanned."
                .to_string(),
        );
    }

    add_wsl_copilot_state_roots(schema, &mut discovery);
    dedupe_copilot_state_roots(&mut discovery.roots);
    discovery
}

fn dedupe_copilot_state_roots(roots: &mut Vec<CopilotStateRoot>) {
    let mut seen = HashSet::new();
    roots.retain(|root| {
        let key = root.path.to_string_lossy().to_ascii_lowercase();
        seen.insert(key)
    });
}

#[cfg(not(target_os = "windows"))]
fn add_wsl_copilot_state_roots(_schema: &ProviderSchema, _discovery: &mut CopilotRootDiscovery) {}

#[cfg(target_os = "windows")]
fn add_wsl_copilot_state_roots(schema: &ProviderSchema, discovery: &mut CopilotRootDiscovery) {
    let mut seen_distros = HashSet::new();
    for host in [r"\\wsl.localhost", r"\\wsl$"] {
        let Ok(distros) = fs::read_dir(host) else {
            continue;
        };
        for distro in distros.filter_map(Result::ok) {
            let distro_name = distro.file_name().to_string_lossy().to_string();
            let safe_distro = sanitize_wsl_label(&distro_name);
            if safe_distro.is_empty() || !seen_distros.insert(safe_distro.to_ascii_lowercase()) {
                continue;
            }

            let home_dir = distro.path().join("home");
            let users = match fs::read_dir(&home_dir) {
                Ok(users) => users,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    discovery.alerts.push(format!(
                        "Could not read home folders in '{}'. Start the WSL distro to enable scanning.",
                        safe_distro
                    ));
                    continue;
                }
            };

            for user_home in users.filter_map(Result::ok).map(|entry| entry.path()) {
                if !user_home.is_dir() {
                    continue;
                }
                let state_root = copilot_state_root_for_home(&user_home, schema);
                match fs::metadata(&state_root) {
                    Ok(metadata) if metadata.is_dir() => {
                        discovery.roots.push(CopilotStateRoot {
                            path: state_root,
                            label: format!("WSL distro '{}'", safe_distro),
                        });
                    }
                    Ok(_) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => discovery.alerts.push(format!(
                        "Found Copilot state in '{}' but could not access it. The WSL distro may have stopped.",
                        safe_distro
                    )),
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn sanitize_wsl_label(label: &str) -> String {
    label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(*c, '.' | '_' | '-'))
        .take(64)
        .collect()
}

fn first_existing_child(parent: &Path, names: &[String]) -> PathBuf {
    names
        .iter()
        .map(|name| parent.join(name))
        .find(|path| path.exists())
        .unwrap_or_else(|| parent.join(&names[0]))
}

fn is_mission_control_analytics_session(events_path: &Path) -> bool {
    let Ok(file) = fs::File::open(events_path) else {
        return false;
    };
    let reader = BufReader::new(file);
    reader
        .lines()
        .map_while(Result::ok)
        .any(|line| line_marks_mission_control_analytics_session(&line))
}

fn line_marks_mission_control_analytics_session(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    let event_type = value
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if event_type == "system.message" {
        // Anchor to the start of the system prompt. The analytics chat always
        // prepends the marker as the first line of its system message, so a
        // strict starts_with check avoids false positives when the marker merely
        // appears elsewhere in the content (e.g. quoted in injected memories or
        // custom instructions). The session.start clientName check below is the
        // robust secondary signal.
        return value
            .pointer("/data/content")
            .and_then(|value| value.as_str())
            .is_some_and(|content| {
                content
                    .trim_start()
                    .starts_with(MISSION_CONTROL_ANALYTICS_MARKER)
            });
    }
    if event_type == "session.start" {
        return value
            .pointer("/data/clientName")
            .or_else(|| value.pointer("/data/client_name"))
            .and_then(|value| value.as_str())
            .is_some_and(|client| client == "copilot-mission-control-analytics");
    }
    false
}

fn activity_cache() -> &'static RwLock<AgentActivity> {
    ACTIVITY_CACHE.get_or_init(|| RwLock::new(AgentActivity::default()))
}

fn activity_refresh_lock() -> &'static Mutex<()> {
    ACTIVITY_REFRESH_LOCK.get_or_init(|| Mutex::new(()))
}

fn scan_agent_activity(include_history: bool) -> AgentActivity {
    let providers = default_providers();
    let scans: Vec<ProviderScan> = providers.iter().map(|p| p.scan(include_history)).collect();
    merge_scans(scans, include_history)
}

fn without_history(mut activity: AgentActivity) -> AgentActivity {
    activity.history = AgentHistorySummary::default();
    activity
}

fn activity_includes_history(activity: &AgentActivity) -> bool {
    activity.history.generated_at_ms > 0
}

fn cached_agent_activity_snapshot(include_history: bool) -> Option<AgentActivity> {
    match activity_cache().read() {
        Ok(cached)
            if cached.generated_at_ms > 0
                && (!include_history || activity_includes_history(&cached)) =>
        {
            let activity = cached.clone();
            Some(if include_history {
                activity
            } else {
                without_history(activity)
            })
        }
        Ok(_) => None,
        Err(err) => {
            log::warn!("Agent activity cache lock poisoned during read: {}", err);
            None
        }
    }
}

fn scan_and_store_agent_activity(include_history: bool) -> AgentActivity {
    let activity = scan_agent_activity(include_history);
    match activity_cache().write() {
        Ok(mut cached) => {
            *cached = activity.clone();
        }
        Err(err) => {
            log::warn!("Agent activity cache lock poisoned during refresh: {}", err);
        }
    }
    if include_history {
        activity
    } else {
        without_history(activity)
    }
}

pub fn refresh_agent_activity_cache() -> AgentActivity {
    match activity_refresh_lock().lock() {
        Ok(_guard) => scan_and_store_agent_activity(false),
        Err(err) => {
            log::warn!("Agent activity refresh lock poisoned: {}", err);
            cached_agent_activity_snapshot(false).unwrap_or_else(|| scan_agent_activity(false))
        }
    }
}

pub fn collect_agent_activity() -> AgentActivity {
    collect_agent_activity_for_route(false)
}

pub fn collect_agent_activity_with_history() -> AgentActivity {
    collect_agent_activity_for_route(true)
}

fn collect_agent_activity_for_route(include_history: bool) -> AgentActivity {
    let now = unix_ms(SystemTime::now());
    match activity_cache().read() {
        Ok(cached)
            if cached.generated_at_ms > 0
                && now.saturating_sub(cached.generated_at_ms) < ACTIVITY_CACHE_MAX_AGE_MS
                && (!include_history || activity_includes_history(&cached)) =>
        {
            let activity = cached.clone();
            return if include_history {
                activity
            } else {
                without_history(activity)
            };
        }
        Ok(_) => {}
        Err(err) => {
            log::warn!("Agent activity cache lock poisoned during read: {}", err);
        }
    }
    match activity_refresh_lock().try_lock() {
        Ok(_guard) => scan_and_store_agent_activity(include_history),
        Err(_) => cached_agent_activity_snapshot(include_history).unwrap_or_default(),
    }
}

fn truncate_recent_events(events: &mut Vec<AgentEventSummary>, max: usize) {
    events.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    events.truncate(max);
}

fn merge_scans(scans: Vec<ProviderScan>, include_history: bool) -> AgentActivity {
    let mut activity = AgentActivity {
        available: scans.iter().any(|s| s.available),
        source: if scans.len() == 1 {
            format!("{}-session-state", scans[0].provider)
        } else {
            "agent-providers".to_string()
        },
        generated_at_ms: unix_ms(SystemTime::now()),
        ..Default::default()
    };

    let mut all_sessions: Vec<AgentSessionSummary> = Vec::new();
    let mut all_events: Vec<AgentEventSummary> = Vec::new();
    let mut tool_counts: BTreeMap<(String, String), usize> = BTreeMap::new();

    for scan in scans {
        activity.scanned_sessions += scan.scanned_sessions;
        activity.active_sessions += scan.active_sessions;
        activity.total_events += scan.total_events;
        activity.total_tool_calls += scan.total_tool_calls;
        activity.total_output_tokens += scan.total_output_tokens;
        activity.total_input_tokens += scan.total_input_tokens;
        activity.total_turns += scan.total_turns;
        activity.alerts.extend(scan.alerts);
        activity.schema_drift.extend(scan.schema_drift);
        all_sessions.extend(scan.sessions);
        all_events.extend(scan.recent_events);
        for ((name, category), count) in scan.tool_counts {
            *tool_counts.entry((name, category)).or_insert(0) += count;
        }
    }

    // Sessions: prefer active, then most recently touched (smallest stale_seconds).
    all_sessions.sort_by(|a, b| {
        b.is_active
            .cmp(&a.is_active)
            .then_with(|| a.stale_seconds.cmp(&b.stale_seconds))
    });
    let mut tools: Vec<AgentToolMetric> = tool_counts
        .into_iter()
        .map(|((name, category), count)| AgentToolMetric {
            name,
            category,
            count,
        })
        .collect();
    tools.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));

    // Two-pass truncation:
    //   1. Global cap (MAX_TOOLS) keeps the renderer's overall payload
    //      small.
    //   2. Per-category cap (MAX_TOOLS_PER_CATEGORY) guarantees each
    //      quarter inspector gets at least its top-N tools — without
    //      this, chatty categories (bash, view) crowd out the long-tail
    //      categories (MCP, web, agents) entirely so their inspector
    //      panel shows "no tools" even when calls were observed.
    let mut per_category: HashMap<String, usize> = HashMap::new();
    let mut survivors: Vec<AgentToolMetric> = Vec::with_capacity(tools.len());
    for tool in tools.iter() {
        let bucket = per_category.entry(tool.category.clone()).or_insert(0);
        if *bucket >= MAX_TOOLS_PER_CATEGORY {
            continue;
        }
        *bucket += 1;
        survivors.push(tool.clone());
    }
    // Top up to MAX_TOOLS with any leftovers (already sorted by count
    // desc) so the global cap is filled when we have slack.
    if survivors.len() < MAX_TOOLS {
        let kept: std::collections::HashSet<(String, String)> = survivors
            .iter()
            .map(|t| (t.name.clone(), t.category.clone()))
            .collect();
        for tool in tools.iter() {
            if survivors.len() >= MAX_TOOLS {
                break;
            }
            if kept.contains(&(tool.name.clone(), tool.category.clone())) {
                continue;
            }
            survivors.push(tool.clone());
        }
    }
    // Enforce the global cap but never shrink below the per-category
    // guarantees. Derived from the number of distinct categories seen
    // in this scan so adding a new quarter later doesn't silently
    // truncate its top-N entries. Worst case: every category has
    // MAX_TOOLS_PER_CATEGORY entries → ceiling = categories * 5.
    let category_floor = per_category.len() * MAX_TOOLS_PER_CATEGORY;
    survivors.truncate(MAX_TOOLS.max(category_floor));
    activity.tools = survivors;

    all_events.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    activity.activity_signal =
        build_activity_signal(&all_events, &all_sessions, activity.generated_at_ms);
    if include_history {
        activity.history = build_history_summary(
            &all_sessions,
            &all_events,
            &activity.tools,
            activity.generated_at_ms,
        );
    }
    activity.sessions = all_sessions.into_iter().take(MAX_SESSIONS).collect();
    all_events.truncate(MAX_RECENT_EVENTS);
    activity.recent_events = all_events;

    let failed_tools = activity
        .recent_events
        .iter()
        .filter(|event| event.kind == "tool.execution_complete" && !event.success)
        .count();
    if failed_tools > 0 {
        activity.alerts.push(format!(
            "{} recent tool failure{} need review.",
            failed_tools,
            if failed_tools == 1 { "" } else { "s" }
        ));
    }
    if activity.active_sessions == 0 {
        activity
            .alerts
            .push("No agent sessions active in the last 10 minutes.".to_string());
    }
    if !activity.available {
        activity
            .alerts
            .push("No supported agent activity sources are currently available.".to_string());
    }

    activity
}

fn build_activity_signal(
    events: &[AgentEventSummary],
    sessions: &[AgentSessionSummary],
    generated_at_ms: u64,
) -> AgentActivitySignal {
    let mut signal_events = events.to_vec();
    append_recent_tool_call_launch_events(&mut signal_events, sessions);
    signal_events.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    let mut hourly = build_activity_signal_buckets(&signal_events, generated_at_ms);
    let peak_hour_event_count_24h = hourly
        .iter()
        .map(|bucket| bucket.event_count)
        .max()
        .unwrap_or(0);
    let peak_velocity_per_hour = hourly
        .iter()
        .map(|bucket| bucket.launch_count)
        .max()
        .unwrap_or(0);
    let active_hours_24h = hourly
        .iter()
        .filter(|bucket| bucket.launch_count > 0)
        .count();
    for bucket in &mut hourly {
        bucket.intensity = activity_signal_intensity(bucket.launch_count, peak_velocity_per_hour);
    }

    let busiest_hour_label_24h = hourly
        .iter()
        .max_by(|a, b| {
            a.launch_count
                .cmp(&b.launch_count)
                .then_with(|| a.start.cmp(&b.start))
        })
        .filter(|bucket| bucket.launch_count > 0)
        .map(|bucket| bucket.label.clone())
        .unwrap_or_else(|| "No activity".to_string());

    let five_min_start = generated_at_ms.saturating_sub(5 * 60 * 1000);
    let hour_start = generated_at_ms.saturating_sub(HOUR_MS);
    let launches_last_5m = count_launches_since(&signal_events, five_min_start, generated_at_ms);
    let launches_last_hour = count_launches_since(&signal_events, hour_start, generated_at_ms);

    AgentActivitySignal {
        generated_at_ms,
        launches_last_5m,
        launches_last_hour,
        velocity_per_hour: launches_last_hour as f64,
        peak_velocity_per_hour,
        peak_hour_event_count_24h,
        busiest_hour_label_24h,
        active_hours_24h,
        hourly_24h: hourly,
    }
}

fn append_recent_tool_call_launch_events(
    signal_events: &mut Vec<AgentEventSummary>,
    sessions: &[AgentSessionSummary],
) {
    let mut seen = signal_events
        .iter()
        .map(activity_signal_event_key)
        .collect::<HashSet<_>>();

    for session in sessions {
        for call in &session.recent_tool_calls {
            if call.timestamp.is_empty() {
                continue;
            }
            let event = AgentEventSummary {
                provider: session.provider.clone(),
                session_id: session.id.chars().take(8).collect(),
                timestamp: call.timestamp.clone(),
                kind: if call.category == "hooks" {
                    "hook.start".to_string()
                } else {
                    "tool.execution_start".to_string()
                },
                tool: call.tool.clone(),
                category: call.category.clone(),
                success: true,
                input_tokens: None,
                output_tokens: None,
            };
            let key = activity_signal_event_key(&event);
            if seen.insert(key) {
                signal_events.push(event);
            }
        }
    }
}

fn activity_signal_event_key(event: &AgentEventSummary) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        event.session_id, event.timestamp, event.kind, event.tool
    )
}

fn build_activity_signal_buckets(
    events: &[AgentEventSummary],
    generated_at_ms: u64,
) -> Vec<AgentActivitySignalBucket> {
    let history_buckets =
        build_history_buckets(events, generated_at_ms, HOUR_MS, HISTORY_HOUR_BUCKETS);
    let mut buckets: Vec<AgentActivitySignalBucket> = history_buckets
        .into_iter()
        .map(|bucket| AgentActivitySignalBucket {
            start: bucket.start,
            label: bucket.label,
            event_count: bucket.event_count,
            failure_count: bucket.failure_count,
            active_sessions: bucket.active_sessions,
            ..Default::default()
        })
        .collect();
    let index_by_start = buckets
        .iter()
        .enumerate()
        .map(|(index, bucket)| (bucket.start.clone(), index))
        .collect::<HashMap<_, _>>();

    for event in events {
        if !is_launch_signal(event) {
            continue;
        }
        let Some(event_ms) = parse_iso_ms(&event.timestamp) else {
            continue;
        };
        let bucket_start = (event_ms / HOUR_MS) * HOUR_MS;
        let start = format_bucket_start(bucket_start, HOUR_MS);
        if let Some(index) = index_by_start.get(&start) {
            buckets[*index].launch_count += 1;
        }
    }

    buckets
}

fn activity_signal_intensity(event_count: usize, peak: usize) -> f64 {
    if event_count == 0 || peak == 0 {
        return 0.0;
    }
    (event_count as f64 / peak as f64).clamp(0.0, 1.0)
}

fn count_launches_since(events: &[AgentEventSummary], start_ms: u64, end_ms: u64) -> usize {
    events
        .iter()
        .filter(|event| is_launch_signal(event))
        .filter_map(|event| parse_iso_ms(&event.timestamp))
        .filter(|timestamp| *timestamp >= start_ms && *timestamp <= end_ms)
        .count()
}

fn is_launch_signal(event: &AgentEventSummary) -> bool {
    event.kind == "tool.execution_start" && event.category == "delegates"
}

fn build_session_activity_signal_from_path(
    path: &Path,
    schema: &ProviderSchema,
    generated_at_ms: u64,
) -> AgentActivitySignal {
    let mut buckets = empty_activity_signal_buckets(generated_at_ms);
    let index_by_start = buckets
        .iter()
        .enumerate()
        .map(|(index, bucket)| (bucket.start.clone(), index))
        .collect::<HashMap<_, _>>();
    let five_min_start = generated_at_ms.saturating_sub(5 * 60 * 1000);
    let hour_start = generated_at_ms.saturating_sub(HOUR_MS);
    let mut activity_last_5m = 0usize;
    let mut activity_last_hour = 0usize;

    let Ok(file) = fs::File::open(path) else {
        return AgentActivitySignal {
            generated_at_ms,
            hourly_24h: buckets,
            ..Default::default()
        };
    };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("tool.execution_")
            && !line.contains("assistant.turn_start")
            && !line.contains("hook.end")
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let event_type =
            string_from_paths(&value, &schema.events.event_type_paths).unwrap_or_default();
        let timestamp =
            string_from_paths(&value, &schema.events.timestamp_paths).unwrap_or_default();
        let Some(event_ms) = parse_iso_ms(&timestamp) else {
            continue;
        };
        let bucket_start = (event_ms / HOUR_MS) * HOUR_MS;
        let start = format_bucket_start(bucket_start, HOUR_MS);
        let Some(index) = index_by_start.get(&start).copied() else {
            continue;
        };
        let bucket = &mut buckets[index];
        match event_type.as_str() {
            event if event == schema.events.tool_start => {
                bucket.event_count += 1;
                bucket.launch_count += 1;
            }
            event if event == schema.events.assistant_turn_start => {
                bucket.event_count += 1;
                bucket.turn_count += 1;
            }
            event if event == schema.events.tool_complete => {
                let success = bool_from_paths(&value, &schema.events.success_paths).unwrap_or(true);
                if !success {
                    bucket.failure_count += 1;
                }
                continue;
            }
            event if event == schema.events.hook_complete => {
                let success = bool_from_paths(&value, &schema.events.success_paths).unwrap_or(true);
                if !success {
                    bucket.failure_count += 1;
                }
                continue;
            }
            _ => continue,
        }
        bucket.active_sessions = 1;
        if event_ms >= five_min_start && event_ms <= generated_at_ms {
            activity_last_5m += 1;
        }
        if event_ms >= hour_start && event_ms <= generated_at_ms {
            activity_last_hour += 1;
        }
    }

    let peak_activity = buckets
        .iter()
        .map(|bucket| bucket.event_count)
        .max()
        .unwrap_or(0);
    for bucket in &mut buckets {
        bucket.intensity = activity_signal_intensity(bucket.event_count, peak_activity);
    }

    AgentActivitySignal {
        generated_at_ms,
        launches_last_5m: activity_last_5m,
        launches_last_hour: activity_last_hour,
        velocity_per_hour: activity_last_hour as f64,
        peak_velocity_per_hour: peak_activity,
        peak_hour_event_count_24h: peak_activity,
        busiest_hour_label_24h: buckets
            .iter()
            .max_by(|a, b| {
                a.event_count
                    .cmp(&b.event_count)
                    .then_with(|| a.start.cmp(&b.start))
            })
            .filter(|bucket| bucket.event_count > 0)
            .map(|bucket| bucket.label.clone())
            .unwrap_or_else(|| "No activity".to_string()),
        active_hours_24h: buckets
            .iter()
            .filter(|bucket| bucket.event_count > 0)
            .count(),
        hourly_24h: buckets,
    }
}

fn empty_activity_signal_buckets(generated_at_ms: u64) -> Vec<AgentActivitySignalBucket> {
    let end_bucket_start = (generated_at_ms / HOUR_MS) * HOUR_MS;
    let first_bucket_start =
        end_bucket_start.saturating_sub((HISTORY_HOUR_BUCKETS as u64 - 1) * HOUR_MS);
    (0..HISTORY_HOUR_BUCKETS)
        .map(|index| {
            let start_ms = first_bucket_start + index as u64 * HOUR_MS;
            AgentActivitySignalBucket {
                start: format_bucket_start(start_ms, HOUR_MS),
                label: format_bucket_label(start_ms, HOUR_MS),
                ..Default::default()
            }
        })
        .collect()
}

struct HistoryBucketAccumulator {
    bucket: AgentHistoryBucket,
    session_ids: BTreeSet<String>,
}

fn build_history_summary(
    sessions: &[AgentSessionSummary],
    events: &[AgentEventSummary],
    tools: &[AgentToolMetric],
    generated_at_ms: u64,
) -> AgentHistorySummary {
    let global = build_history_scope_summary(sessions, events, tools, generated_at_ms);
    let session_scopes = sessions
        .iter()
        .take(MAX_HISTORY_RECENT_SESSIONS)
        .map(|session| {
            let scoped_events: Vec<AgentEventSummary> = events
                .iter()
                .filter(|event| event.session_id == session.id)
                .cloned()
                .collect();
            let scoped_tools = history_tools_for_session(session);
            AgentHistorySessionScope {
                session_id: session.id.clone(),
                label: history_session_label(session),
                summary: build_history_scope_summary(
                    std::slice::from_ref(session),
                    &scoped_events,
                    &scoped_tools,
                    generated_at_ms,
                ),
            }
        })
        .collect();

    AgentHistorySummary {
        generated_at_ms: global.generated_at_ms,
        last_activity_at: global.last_activity_at,
        event_count: global.event_count,
        tool_count: global.tool_count,
        failure_count: global.failure_count,
        activity_24h: global.activity_24h,
        activity_7d: global.activity_7d,
        model_mix: global.model_mix,
        category_mix: global.category_mix,
        top_tools: global.top_tools,
        high_activity_sessions: global.high_activity_sessions,
        recent_sessions: global.recent_sessions,
        recent_failures: global.recent_failures,
        session_scopes,
    }
}

fn build_history_scope_summary(
    sessions: &[AgentSessionSummary],
    events: &[AgentEventSummary],
    tools: &[AgentToolMetric],
    generated_at_ms: u64,
) -> AgentHistoryScopeSummary {
    let mut sorted_events = events.to_vec();
    sorted_events.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    let failure_events: Vec<&AgentEventSummary> = sorted_events
        .iter()
        .filter(|event| is_failure_event(event) && parse_iso_ms(&event.timestamp).is_some())
        .collect();

    AgentHistoryScopeSummary {
        generated_at_ms,
        last_activity_at: history_last_activity_at(sessions, &sorted_events),
        event_count: sessions.iter().map(|session| session.event_count).sum(),
        tool_count: sessions.iter().map(|session| session.tool_count).sum(),
        failure_count: failure_events.len(),
        activity_24h: build_history_buckets(
            &sorted_events,
            generated_at_ms,
            HOUR_MS,
            HISTORY_HOUR_BUCKETS,
        ),
        activity_7d: build_history_buckets(
            &sorted_events,
            generated_at_ms,
            DAY_MS,
            HISTORY_DAY_BUCKETS,
        ),
        model_mix: build_model_mix(sessions),
        category_mix: build_category_mix(sessions, &sorted_events),
        top_tools: tools
            .iter()
            .take(MAX_HISTORY_METRICS)
            .map(|tool| AgentHistoryMetric {
                name: tool.name.clone(),
                count: tool.count,
                ..Default::default()
            })
            .collect(),
        high_activity_sessions: history_high_activity_sessions(sessions),
        recent_sessions: sessions
            .iter()
            .take(MAX_HISTORY_RECENT_SESSIONS)
            .map(history_session_from_summary)
            .collect(),
        recent_failures: failure_events
            .into_iter()
            .take(MAX_HISTORY_RECENT_FAILURES)
            .map(|event| AgentHistoryFailure {
                session_id: event.session_id.clone(),
                timestamp: event.timestamp.clone(),
                kind: event.kind.clone(),
                tool: event.tool.clone(),
                category: event.category.clone(),
            })
            .collect(),
    }
}

fn history_high_activity_sessions(sessions: &[AgentSessionSummary]) -> Vec<AgentHistorySession> {
    let mut ranked = sessions.to_vec();
    ranked.sort_by(|a, b| {
        b.turn_count
            .cmp(&a.turn_count)
            .then_with(|| b.tool_count.cmp(&a.tool_count))
            .then_with(|| b.event_count.cmp(&a.event_count))
            .then_with(|| b.output_tokens.cmp(&a.output_tokens))
            .then_with(|| b.last_event_timestamp.cmp(&a.last_event_timestamp))
    });
    ranked
        .iter()
        .take(MAX_HISTORY_RECENT_SESSIONS)
        .map(history_session_from_summary)
        .collect()
}

fn history_tools_for_session(session: &AgentSessionSummary) -> Vec<AgentToolMetric> {
    let mut counts: BTreeMap<(String, String), usize> = BTreeMap::new();
    for call in &session.recent_tool_calls {
        let name = normalize_history_label(&call.tool, "tool");
        let category = normalize_history_label(&call.category, "activity");
        *counts.entry((name, category)).or_insert(0) += 1;
    }

    if counts.is_empty() && !session.last_tool.trim().is_empty() && session.tool_count > 0 {
        counts.insert(
            (
                session.last_tool.trim().to_string(),
                normalize_history_label(&session.last_event_category, "activity"),
            ),
            session.tool_count,
        );
    }

    let mut tools: Vec<AgentToolMetric> = counts
        .into_iter()
        .map(|((name, category), count)| AgentToolMetric {
            name,
            category,
            count,
        })
        .collect();
    tools.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    tools
}

fn build_history_buckets(
    events: &[AgentEventSummary],
    generated_at_ms: u64,
    bucket_ms: u64,
    bucket_count: usize,
) -> Vec<AgentHistoryBucket> {
    if bucket_count == 0 || bucket_ms == 0 {
        return Vec::new();
    }
    if bucket_ms >= DAY_MS {
        return build_daily_history_buckets(events, generated_at_ms, bucket_count, &Local);
    }

    let end_bucket_start = (generated_at_ms / bucket_ms) * bucket_ms;
    let first_bucket_start = end_bucket_start.saturating_sub((bucket_count as u64 - 1) * bucket_ms);
    let mut buckets: Vec<HistoryBucketAccumulator> = (0..bucket_count)
        .map(|i| {
            let start_ms = first_bucket_start + i as u64 * bucket_ms;
            HistoryBucketAccumulator {
                bucket: AgentHistoryBucket {
                    start: format_bucket_start(start_ms, bucket_ms),
                    label: format_bucket_label(start_ms, bucket_ms),
                    ..Default::default()
                },
                session_ids: BTreeSet::new(),
            }
        })
        .collect();

    for event in events {
        let Some(event_ms) = parse_iso_ms(&event.timestamp) else {
            continue;
        };
        if event_ms < first_bucket_start {
            continue;
        }
        let index = ((event_ms - first_bucket_start) / bucket_ms) as usize;
        if index >= buckets.len() {
            continue;
        }
        buckets[index].bucket.event_count += 1;
        if is_launch_signal(event) {
            buckets[index].bucket.launch_count += 1;
        }
        if is_failure_event(event) {
            buckets[index].bucket.failure_count += 1;
        }
        if !event.session_id.is_empty() {
            buckets[index].session_ids.insert(event.session_id.clone());
        }
    }

    buckets
        .into_iter()
        .map(|mut acc| {
            acc.bucket.active_sessions = acc.session_ids.len();
            acc.bucket
        })
        .collect()
}

struct DailyHistoryBucketBounds {
    start_ms: u64,
    end_ms: u64,
    accumulator: HistoryBucketAccumulator,
}

fn build_daily_history_buckets<Tz: TimeZone>(
    events: &[AgentEventSummary],
    generated_at_ms: u64,
    bucket_count: usize,
    timezone: &Tz,
) -> Vec<AgentHistoryBucket> {
    let generated_utc = utc_datetime_from_ms(generated_at_ms).unwrap_or_else(Utc::now);
    let end_date = generated_utc.with_timezone(timezone).date_naive();
    let mut buckets: Vec<DailyHistoryBucketBounds> = (0..bucket_count)
        .map(|i| {
            let days_before_end = (bucket_count - 1 - i) as i64;
            let bucket_date = end_date
                .checked_sub_signed(ChronoDuration::days(days_before_end))
                .unwrap_or(end_date);
            let next_date = bucket_date
                .checked_add_signed(ChronoDuration::days(1))
                .unwrap_or(bucket_date);
            let start = start_of_local_date(timezone, bucket_date);
            let end = start_of_local_date(timezone, next_date);
            DailyHistoryBucketBounds {
                start_ms: datetime_to_unix_ms(&start),
                end_ms: datetime_to_unix_ms(&end),
                accumulator: HistoryBucketAccumulator {
                    bucket: AgentHistoryBucket {
                        start: format_local_bucket_start(&start),
                        label: format_local_day_label(&start),
                        ..Default::default()
                    },
                    session_ids: BTreeSet::new(),
                },
            }
        })
        .collect();

    for event in events {
        let Some(event_ms) = parse_iso_ms(&event.timestamp) else {
            continue;
        };
        let Some(bucket) = buckets
            .iter_mut()
            .find(|bucket| event_ms >= bucket.start_ms && event_ms < bucket.end_ms)
        else {
            continue;
        };
        bucket.accumulator.bucket.event_count += 1;
        if is_failure_event(event) {
            bucket.accumulator.bucket.failure_count += 1;
        }
        if !event.session_id.is_empty() {
            bucket
                .accumulator
                .session_ids
                .insert(event.session_id.clone());
        }
    }

    buckets
        .into_iter()
        .map(|mut bounded| {
            bounded.accumulator.bucket.active_sessions = bounded.accumulator.session_ids.len();
            bounded.accumulator.bucket
        })
        .collect()
}

fn build_model_mix(sessions: &[AgentSessionSummary]) -> Vec<AgentHistoryMetric> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut last_seen: BTreeMap<String, String> = BTreeMap::new();

    for session in sessions {
        let mut counted_turn_model = false;
        for turn in &session.recent_turns {
            let model = normalize_history_label(&turn.model, "Unknown");
            if model == "Unknown" {
                continue;
            }
            counted_turn_model = true;
            *counts.entry(model.clone()).or_insert(0) += 1;
            let seen = if turn.ended_at.is_empty() {
                turn.started_at.as_str()
            } else {
                turn.ended_at.as_str()
            };
            update_latest_label(&mut last_seen, &model, seen);
        }

        if counted_turn_model {
            continue;
        }

        let model = normalize_history_label(&session.last_model, "Unknown");
        *counts.entry(model.clone()).or_insert(0) += 1;
        update_latest_label(&mut last_seen, &model, &session.last_event_timestamp);
    }

    metrics_from_counts(counts, Some(last_seen))
}

fn build_category_mix(
    sessions: &[AgentSessionSummary],
    events: &[AgentEventSummary],
) -> Vec<AgentHistoryMetric> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut last_seen: BTreeMap<String, String> = BTreeMap::new();

    if !events.is_empty() {
        for event in events {
            let category = normalize_history_label(&event.category, "activity");
            *counts.entry(category.clone()).or_insert(0) += 1;
            update_latest_label(&mut last_seen, &category, &event.timestamp);
        }
        return metrics_from_counts(counts, Some(last_seen));
    }

    for session in sessions {
        add_category_count(&mut counts, "edits", session.write_count);
        add_category_count(&mut counts, "library", session.read_count);
        add_category_count(&mut counts, "terminal", session.command_count);
        add_category_count(&mut counts, "signal", session.web_count);
        add_category_count(&mut counts, "delegates", session.delegates_count);
        add_category_count(&mut counts, "skills", session.skills_count);
        add_category_count(&mut counts, "court", session.court_count);
        add_category_count(&mut counts, "mcp", session.mcp_count);
        add_category_count(&mut counts, "hooks", session.hooks_count);
        add_category_count(&mut counts, "alert", session.error_count);
    }

    metrics_from_counts(counts, None)
}

fn add_category_count(counts: &mut BTreeMap<String, usize>, category: &str, count: usize) {
    if count > 0 {
        *counts.entry(category.to_string()).or_insert(0) += count;
    }
}

fn metrics_from_counts(
    counts: BTreeMap<String, usize>,
    last_seen: Option<BTreeMap<String, String>>,
) -> Vec<AgentHistoryMetric> {
    let total: usize = counts.values().sum();
    let last_seen = last_seen.unwrap_or_default();
    let mut metrics: Vec<AgentHistoryMetric> = counts
        .into_iter()
        .map(|(name, count)| AgentHistoryMetric {
            last_seen: last_seen.get(&name).cloned(),
            name,
            count,
            percent: if total > 0 {
                Some(((count as f64 / total as f64) * 1000.0).round() / 10.0)
            } else {
                None
            },
            ..Default::default()
        })
        .collect();
    metrics.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    metrics.truncate(MAX_HISTORY_METRICS);
    metrics
}

fn history_last_activity_at(
    sessions: &[AgentSessionSummary],
    events: &[AgentEventSummary],
) -> Option<String> {
    let mut latest: Option<String> = None;
    for timestamp in
        events
            .iter()
            .map(|event| event.timestamp.as_str())
            .chain(sessions.iter().flat_map(|session| {
                [
                    session.last_event_timestamp.as_str(),
                    session.updated_at.as_str(),
                ]
            }))
    {
        update_latest_option(&mut latest, timestamp);
    }
    latest
}

fn history_session_from_summary(session: &AgentSessionSummary) -> AgentHistorySession {
    AgentHistorySession {
        id: session.id.clone(),
        title: session.title.clone(),
        session_name: session.session_name.clone(),
        repository: session.repository.clone(),
        branch: session.branch.clone(),
        updated_at: session.updated_at.clone(),
        is_active: session.is_active,
        status: session.status.clone(),
        event_count: session.event_count,
        tool_count: session.tool_count,
        error_count: session.error_count,
        turn_count: session.turn_count,
        input_tokens: session.input_tokens,
        output_tokens: session.output_tokens,
        last_model: session.last_model.clone(),
        last_tool: session.last_tool.clone(),
    }
}

fn history_session_label(session: &AgentSessionSummary) -> String {
    let title = session.title.trim();
    let session_name = session.session_name.trim();
    let repository = session.repository.trim();
    if !title.is_empty() {
        title.to_string()
    } else if !session_name.is_empty() {
        session_name.to_string()
    } else if !repository.is_empty() {
        repository.to_string()
    } else {
        short_history_session_id(&session.id)
    }
}

fn short_history_session_id(id: &str) -> String {
    id.chars().take(8).collect()
}

fn is_failure_event(event: &AgentEventSummary) -> bool {
    !event.success
}

fn normalize_history_label(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn update_latest_label(latest: &mut BTreeMap<String, String>, key: &str, timestamp: &str) {
    if timestamp.is_empty() {
        return;
    }
    let entry = latest.entry(key.to_string()).or_default();
    if entry.is_empty() || timestamp > entry.as_str() {
        *entry = timestamp.to_string();
    }
}

fn update_latest_option(latest: &mut Option<String>, timestamp: &str) {
    if parse_iso_ms(timestamp).is_none() {
        return;
    }
    if latest.as_deref().is_none_or(|current| timestamp > current) {
        *latest = Some(timestamp.to_string());
    }
}

fn format_bucket_start(start_ms: u64, bucket_ms: u64) -> String {
    let (year, month, day, hour) = utc_parts_from_ms(start_ms);
    if bucket_ms >= DAY_MS {
        format!("{year:04}-{month:02}-{day:02}T00:00:00Z")
    } else {
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:00:00Z")
    }
}

fn format_bucket_label(start_ms: u64, bucket_ms: u64) -> String {
    let (_year, month, day, hour) = utc_parts_from_ms(start_ms);
    if bucket_ms >= DAY_MS {
        format!("{month:02}-{day:02}")
    } else {
        format!("{hour:02}:00Z")
    }
}

fn utc_datetime_from_ms(ms: u64) -> Option<DateTime<Utc>> {
    if ms > i64::MAX as u64 {
        return None;
    }
    Utc.timestamp_millis_opt(ms as i64).single()
}

fn start_of_local_date<Tz: TimeZone>(timezone: &Tz, date: NaiveDate) -> DateTime<Tz> {
    let midnight = date
        .and_hms_opt(0, 0, 0)
        .expect("midnight is valid for a NaiveDate");
    match timezone.from_local_datetime(&midnight) {
        LocalResult::Single(dt) => dt,
        LocalResult::Ambiguous(earliest, _) => earliest,
        LocalResult::None => timezone.from_utc_datetime(&midnight),
    }
}

fn datetime_to_unix_ms<Tz: TimeZone>(dt: &DateTime<Tz>) -> u64 {
    dt.with_timezone(&Utc).timestamp_millis().max(0) as u64
}

fn format_local_bucket_start<Tz: TimeZone>(start: &DateTime<Tz>) -> String {
    let utc = start.with_timezone(&Utc);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        utc.year(),
        utc.month(),
        utc.day(),
        utc.hour(),
        utc.minute(),
        utc.second()
    )
}

fn format_local_day_label<Tz: TimeZone>(start: &DateTime<Tz>) -> String {
    format!("{:02}-{:02}", start.month(), start.day())
}

fn utc_parts_from_ms(ms: u64) -> (i64, i64, i64, i64) {
    let total_seconds = (ms / 1000) as i64;
    let days = total_seconds.div_euclid(86_400);
    let seconds_of_day = total_seconds.rem_euclid(86_400);
    let hour = seconds_of_day / 3600;
    let (year, month, day) = civil_from_days(days);
    (year, month, day, hour)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

// ── Copilot CLI provider ──────────────────────────────────────────────

pub struct CopilotProvider;

impl AgentProvider for CopilotProvider {
    fn id(&self) -> &'static str {
        "copilot"
    }
    fn label(&self) -> &'static str {
        "GitHub Copilot CLI"
    }
    fn is_available(&self) -> bool {
        is_copilot_available()
    }
    fn state_roots(&self) -> Vec<PathBuf> {
        let (schema, _) = load_copilot_schema();
        discover_copilot_state_roots(&schema)
            .roots
            .into_iter()
            .map(|root| root.path)
            .collect()
    }
    fn scan(&self, include_history: bool) -> ProviderScan {
        scan_copilot(include_history)
    }
}

fn scan_copilot(include_history: bool) -> ProviderScan {
    let (schema, schema_alerts) = load_copilot_schema();
    let executable_available = is_copilot_available();
    let discovery = discover_copilot_state_roots(&schema);
    scan_copilot_from_discovery(
        include_history,
        schema,
        schema_alerts,
        executable_available,
        discovery,
    )
}

fn scan_copilot_from_discovery(
    include_history: bool,
    schema: ProviderSchema,
    schema_alerts: Vec<String>,
    executable_available: bool,
    discovery: CopilotRootDiscovery,
) -> ProviderScan {
    let provider = "copilot";
    let mut scan = ProviderScan::unavailable(provider);
    scan.available = executable_available;
    scan.alerts.extend(schema_alerts);

    scan.alerts.extend(discovery.alerts);
    if discovery.roots.is_empty() {
        scan.alerts
            .extend(no_session_state_alerts(executable_available));
        return scan;
    }
    let mut session_dirs = Vec::new();
    let mut existing_roots = 0usize;
    let mut readable_roots = 0usize;
    for root in &discovery.roots {
        match fs::metadata(&root.path) {
            Ok(metadata) if metadata.is_dir() => existing_roots += 1,
            Ok(_) => continue,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => {
                scan.alerts.push(format!(
                    "Unable to access {} Copilot session state ({}). {}",
                    root.label,
                    io_error_kind_label(&err),
                    session_state_recovery_hint(&root.label)
                ));
                continue;
            }
        }
        let entries = match fs::read_dir(&root.path) {
            Ok(entries) => {
                readable_roots += 1;
                entries
            }
            Err(err) => {
                scan.alerts.push(format!(
                    "Unable to scan {} Copilot session state ({}). {}",
                    root.label,
                    io_error_kind_label(&err),
                    session_state_recovery_hint(&root.label)
                ));
                continue;
            }
        };
        session_dirs.extend(entries.filter_map(Result::ok).filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let session_name = path.file_name().and_then(|name| name.to_str())?.to_string();
            let events_path = first_existing_child(&path, &schema.session.events_files);
            let modified = events_path
                .metadata()
                .and_then(|m| m.modified())
                .or_else(|_| entry.metadata().and_then(|m| m.modified()))
                .unwrap_or(UNIX_EPOCH);
            // Drop sessions whose event log hasn't changed in the
            // configured cutoff window. Old session folders never
            // disappear on disk, so without this filter the picker
            // ends up dominated by yesterday's work.
            if let Ok(age) = SystemTime::now().duration_since(modified) {
                if age.as_secs() > STALE_SESSION_CUTOFF_SECS {
                    return None;
                }
            }
            Some((session_name, path, modified))
        }));
    }
    if existing_roots == 0 {
        scan.alerts
            .extend(no_session_state_alerts(executable_available));
        return scan;
    }
    if readable_roots == 0 {
        scan.alerts.push(
            "Copilot session state was found but could not be read. Check WSL distro status or file permissions."
                .to_string(),
        );
        return scan;
    }
    scan.available = scan.available || readable_roots > 0;
    let mut newest_by_session: BTreeMap<String, (PathBuf, SystemTime)> = BTreeMap::new();
    for (session_name, path, modified) in session_dirs {
        let replace = newest_by_session
            .get(&session_name)
            .map(|(_, existing_modified)| modified > *existing_modified)
            .unwrap_or(true);
        if replace {
            newest_by_session.insert(session_name, (path, modified));
        }
    }
    let mut session_dirs = newest_by_session
        .into_values()
        .collect::<Vec<(PathBuf, SystemTime)>>();

    session_dirs.sort_by(|a, b| b.1.cmp(&a.1));
    session_dirs.retain(|(session_path, _)| {
        let events_path = first_existing_child(session_path, &schema.session.events_files);
        !is_mission_control_analytics_session(&events_path)
    });
    // Cap per-provider scan effort but leave visible session truncation to the merger.
    session_dirs.truncate(MAX_SCANNED_SESSIONS);
    scan.scanned_sessions = session_dirs.len();

    // Load once per scan; reused for every tool execution event below.
    let mcp_allowlist = load_mcp_tool_allowlist(&schema);
    let configured_hook_types = load_configured_hook_types(&schema);
    let session_cache_context = copilot_session_cache_context(
        &schema.schema_version,
        &mcp_allowlist,
        &configured_hook_types,
        include_history,
    );
    let token_prefix_cache_context = copilot_token_prefix_cache_context(&schema);
    let mut active_session_paths = HashSet::new();
    let mut active_events_paths = HashSet::new();
    let mut schema_drift = SchemaDriftAccumulator::new(provider, &schema.schema_version);

    let now = SystemTime::now();

    for (session_path, modified) in session_dirs {
        let session_id = session_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let workspace_path = first_existing_child(&session_path, &schema.session.workspace_files);
        let events_path = first_existing_child(&session_path, &schema.session.events_files);
        let workspace = parse_workspace(&workspace_path, &schema);
        if workspace_marks_mission_control_analytics_session(&workspace) {
            continue;
        }
        let Some(repository) = workspace_repository_label(&workspace) else {
            continue;
        };
        active_session_paths.insert(session_path.clone());
        active_events_paths.insert(events_path.clone());
        let session_name = sanitize_session_title(workspace.get("name"));
        let age_seconds = now
            .duration_since(modified)
            .map(|age| age.as_secs())
            .unwrap_or(0);
        let mut summary = AgentSessionSummary {
            provider: provider.to_string(),
            id: session_id.chars().take(8).collect(),
            session_name: session_name.clone().unwrap_or_default(),
            repository,
            branch: workspace.get("branch").cloned().unwrap_or_default(),
            updated_at: workspace.get("updated_at").cloned().unwrap_or_default(),
            is_active: age_seconds < 10 * 60,
            stale_seconds: age_seconds,
            git_root: workspace
                .get("git_root")
                .or_else(|| workspace.get("cwd"))
                .cloned()
                .unwrap_or_default(),
            ..Default::default()
        };
        summary.title =
            session_title_from_workspace(&workspace, &summary.repository, &summary.branch);

        let cache_key = copilot_session_cache_key(
            &session_path,
            &events_path,
            &workspace_path,
            &session_cache_context,
        );

        let mut session_tool_counts = BTreeMap::new();
        let mut session_recent_events = Vec::new();
        let session_schema_stats = if let Some(key) = cache_key.as_ref() {
            if let Some(cached) = cached_copilot_session_scan(key, &summary) {
                summary = cached.summary;
                session_tool_counts = cached.tool_counts;
                session_recent_events = cached.recent_events;
                cached.schema_stats
            } else {
                let stats = summarize_events_with_mode(
                    provider,
                    &events_path,
                    &session_id,
                    &mut summary,
                    &mut session_tool_counts,
                    &mut session_recent_events,
                    &mcp_allowlist,
                    &configured_hook_types,
                    &schema,
                    &token_prefix_cache_context,
                    include_history,
                );
                summary.activity_signal = build_session_activity_signal_from_path(
                    &events_path,
                    &schema,
                    unix_ms(SystemTime::now()),
                );
                store_copilot_session_scan(
                    key.clone(),
                    CachedCopilotSessionScan {
                        summary: summary.clone(),
                        tool_counts: session_tool_counts.clone(),
                        recent_events: session_recent_events.clone(),
                        schema_stats: stats.clone(),
                    },
                );
                stats
            }
        } else {
            let stats = summarize_events_with_mode(
                provider,
                &events_path,
                &session_id,
                &mut summary,
                &mut session_tool_counts,
                &mut session_recent_events,
                &mcp_allowlist,
                &configured_hook_types,
                &schema,
                &token_prefix_cache_context,
                include_history,
            );
            summary.activity_signal = build_session_activity_signal_from_path(
                &events_path,
                &schema,
                unix_ms(SystemTime::now()),
            );
            stats
        };
        for ((name, category), count) in session_tool_counts {
            *scan.tool_counts.entry((name, category)).or_insert(0) += count;
        }
        scan.recent_events.extend(session_recent_events);
        schema_drift.record_session(&summary, &session_schema_stats);

        // Active sessions report "working" or "thinking" by activity
        // level. We intentionally do NOT escalate to "needs-attention"
        // based on error_count — failed tool calls (view of a missing
        // file, edit where old_str didn't match, grep with no hits) are
        // normal LLM exploration noise, not something the dev needs to
        // act on. If we add real attention signals later (permission
        // requests, session.error events, model failures), wire those
        // here instead.
        summary.status = if summary.is_active && (summary.tool_count > 0 || summary.hooks_count > 0)
        {
            "working".to_string()
        } else if summary.is_active {
            "thinking".to_string()
        } else {
            "idle".to_string()
        };

        if summary.is_active {
            scan.active_sessions += 1;
        }
        scan.total_events += summary.event_count;
        scan.total_tool_calls += summary.tool_count;
        scan.total_output_tokens += summary.output_tokens;
        scan.total_input_tokens += summary.input_tokens;
        scan.total_turns += summary.turn_count;
        scan.sessions.push(summary);
        if !include_history && scan.recent_events.len() > MAX_RECENT_EVENTS {
            truncate_recent_events(&mut scan.recent_events, MAX_RECENT_EVENTS);
        }
    }
    if let Some(report) = schema_drift.into_report() {
        scan.alerts.push(report.summary.clone());
        scan.schema_drift.push(report);
    }
    sweep_copilot_session_scan_cache(&active_session_paths);
    sweep_copilot_token_prefix_cache(&active_events_paths);

    scan
}

#[derive(Clone, Default)]
struct SessionSchemaStats {
    total_events: usize,
    recognized_events: usize,
    tool_starts: usize,
    tool_completes: usize,
    missing_event_type: usize,
    unknown_event_types: BTreeMap<String, usize>,
}

impl SessionSchemaStats {
    fn record_event_type(&mut self, event_type: &str, schema: &ProviderSchema) {
        self.total_events += 1;
        if event_type.is_empty() {
            self.missing_event_type += 1;
            return;
        }
        if is_schema_known_event(event_type, schema) {
            self.recognized_events += 1;
        } else {
            *self
                .unknown_event_types
                .entry(event_type.to_string())
                .or_insert(0) += 1;
        }
    }
}

fn file_fingerprint(path: &Path) -> Option<FileFingerprint> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(FileFingerprint {
        len: metadata.len(),
        modified_secs: modified.as_secs(),
        modified_nanos: modified.subsec_nanos(),
    })
}

fn copilot_session_cache(
) -> &'static RwLock<HashMap<CopilotSessionCacheKey, CachedCopilotSessionScan>> {
    COPILOT_SESSION_SCAN_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn copilot_session_cache_context(
    schema_version: &str,
    mcp_allowlist: &HashSet<String>,
    configured_hook_types: &HashSet<String>,
    include_history: bool,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"session-activity-signal-v1");
    hasher.update([0]);
    hasher.update(schema_version.as_bytes());
    hasher.update([0]);
    hasher.update(if include_history {
        "full-history"
    } else {
        "tail-dashboard"
    });
    hasher.update([0]);

    let mut allowed_tools = mcp_allowlist.iter().collect::<Vec<_>>();
    allowed_tools.sort();
    for tool in allowed_tools {
        hasher.update(tool.as_bytes());
        hasher.update([0]);
    }

    let mut hook_types = configured_hook_types.iter().collect::<Vec<_>>();
    hook_types.sort();
    for hook_type in hook_types {
        hasher.update(hook_type.as_bytes());
        hasher.update([0]);
    }

    format!("{:x}", hasher.finalize())
}

fn copilot_token_prefix_cache_context(schema: &ProviderSchema) -> String {
    let mut hasher = Sha256::new();
    hasher.update(schema.schema_version.as_bytes());
    hasher.update([0]);
    for token in &schema.token_events {
        hasher.update(token.event_type.as_bytes());
        hasher.update([0]);
        hasher.update(token.mode.as_bytes());
        hasher.update([0]);
        for path in &token.input_components {
            hasher.update(path.as_bytes());
            hasher.update([0]);
        }
        hasher.update([0xff]);
        for path in &token.output_components {
            hasher.update(path.as_bytes());
            hasher.update([0]);
        }
        hasher.update([0xff]);
        if let Some(model_metrics) = &token.model_metrics {
            hasher.update(model_metrics.metrics_path.as_bytes());
            hasher.update([0]);
            hasher.update(model_metrics.input_path.as_bytes());
            hasher.update([0]);
            hasher.update(model_metrics.cache_read_path.as_bytes());
            hasher.update([0]);
            hasher.update(model_metrics.output_path.as_bytes());
            hasher.update([0]);
        }
        hasher.update([0xff]);
    }
    for path in &schema.events.event_type_paths {
        hasher.update(path.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn copilot_session_cache_key(
    session_path: &Path,
    events_path: &Path,
    workspace_path: &Path,
    schema_context: &str,
) -> Option<CopilotSessionCacheKey> {
    Some(CopilotSessionCacheKey {
        session_path: session_path.to_path_buf(),
        events: file_fingerprint(events_path)?,
        workspace: file_fingerprint(workspace_path),
        schema_context: schema_context.to_string(),
    })
}

fn restore_dynamic_session_fields(
    summary: &mut AgentSessionSummary,
    current: &AgentSessionSummary,
) {
    summary.provider.clone_from(&current.provider);
    summary.id.clone_from(&current.id);
    summary.session_name.clone_from(&current.session_name);
    summary.repository.clone_from(&current.repository);
    summary.branch.clone_from(&current.branch);
    summary.updated_at.clone_from(&current.updated_at);
    summary.is_active = current.is_active;
    summary.stale_seconds = current.stale_seconds;
    summary.git_root.clone_from(&current.git_root);
    summary.title.clone_from(&current.title);
}

fn cached_copilot_session_scan(
    key: &CopilotSessionCacheKey,
    current_summary: &AgentSessionSummary,
) -> Option<CachedCopilotSessionScan> {
    let mut cached = copilot_session_cache().read().ok()?.get(key)?.clone();
    restore_dynamic_session_fields(&mut cached.summary, current_summary);
    Some(cached)
}

fn store_copilot_session_scan(key: CopilotSessionCacheKey, scan: CachedCopilotSessionScan) {
    if let Ok(mut cache) = copilot_session_cache().write() {
        let session_path = key.session_path.clone();
        cache.retain(|cached_key, _| cached_key.session_path != session_path || cached_key == &key);
        cache.insert(key, scan);
        if cache.len() > MAX_COPILOT_SESSION_SCAN_CACHE_ENTRIES {
            let overflow = cache.len() - MAX_COPILOT_SESSION_SCAN_CACHE_ENTRIES;
            let remove_keys = cache.keys().take(overflow).cloned().collect::<Vec<_>>();
            for key in remove_keys {
                cache.remove(&key);
            }
        }
    }
}

fn sweep_copilot_session_scan_cache(active_session_paths: &HashSet<PathBuf>) {
    if let Ok(mut cache) = copilot_session_cache().write() {
        cache.retain(|key, _| active_session_paths.contains(&key.session_path));
    }
}

fn copilot_token_prefix_cache(
) -> &'static RwLock<HashMap<CopilotTokenPrefixCacheKey, CachedTokenPrefix>> {
    COPILOT_TOKEN_PREFIX_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn copilot_token_prefix_cache_key(
    events_path: &Path,
    schema_context: &str,
) -> CopilotTokenPrefixCacheKey {
    CopilotTokenPrefixCacheKey {
        events_path: events_path.to_path_buf(),
        schema_context: schema_context.to_string(),
    }
}

fn cached_token_prefix(
    key: &CopilotTokenPrefixCacheKey,
    target_len: u64,
    head_signature: &[u8],
) -> Option<CachedTokenPrefix> {
    let cached = copilot_token_prefix_cache().read().ok()?.get(key)?.clone();
    if cached.processed_len <= target_len && cached.head_signature == head_signature {
        Some(cached)
    } else {
        None
    }
}

fn store_token_prefix(key: CopilotTokenPrefixCacheKey, prefix: CachedTokenPrefix) {
    if let Ok(mut cache) = copilot_token_prefix_cache().write() {
        cache.insert(key, prefix);
        if cache.len() > MAX_COPILOT_TOKEN_PREFIX_CACHE_ENTRIES {
            let overflow = cache.len() - MAX_COPILOT_TOKEN_PREFIX_CACHE_ENTRIES;
            let remove_keys = cache.keys().take(overflow).cloned().collect::<Vec<_>>();
            for key in remove_keys {
                cache.remove(&key);
            }
        }
    }
}

fn sweep_copilot_token_prefix_cache(active_events_paths: &HashSet<PathBuf>) {
    if let Ok(mut cache) = copilot_token_prefix_cache().write() {
        cache.retain(|key, _| active_events_paths.contains(&key.events_path));
    }
}

struct SchemaDriftAccumulator {
    provider: String,
    schema_version: String,
    checked_sessions: usize,
    affected_sessions: usize,
    total_events: usize,
    recognized_events: usize,
    tool_starts: usize,
    tool_completes: usize,
    missing_event_type: usize,
    unknown_event_types: BTreeMap<String, usize>,
    hints: BTreeSet<String>,
}

impl SchemaDriftAccumulator {
    fn new(provider: &str, schema_version: &str) -> Self {
        Self {
            provider: provider.to_string(),
            schema_version: schema_version.to_string(),
            checked_sessions: 0,
            affected_sessions: 0,
            total_events: 0,
            recognized_events: 0,
            tool_starts: 0,
            tool_completes: 0,
            missing_event_type: 0,
            unknown_event_types: BTreeMap::new(),
            hints: BTreeSet::new(),
        }
    }

    fn record_session(&mut self, summary: &AgentSessionSummary, stats: &SessionSchemaStats) {
        if stats.total_events == 0 {
            return;
        }
        self.checked_sessions += 1;
        self.total_events += stats.total_events;
        self.recognized_events += stats.recognized_events;
        self.tool_starts += stats.tool_starts;
        self.tool_completes += stats.tool_completes;
        self.missing_event_type += stats.missing_event_type;
        for (name, count) in &stats.unknown_event_types {
            *self.unknown_event_types.entry(name.clone()).or_insert(0) += count;
        }

        let missing_event_type_ratio = stats.missing_event_type as f64 / stats.total_events as f64;
        let unknown_ratio =
            stats.unknown_event_types.values().sum::<usize>() as f64 / stats.total_events as f64;
        let tool_counts_missing =
            summary.event_count >= 25 && summary.tool_count == 0 && summary.hooks_count == 0;
        let event_type_missing = stats.total_events >= 25 && missing_event_type_ratio >= 0.75;
        let many_unknown_events = stats.total_events >= 25 && unknown_ratio >= 0.5;

        if tool_counts_missing || event_type_missing || many_unknown_events {
            self.affected_sessions += 1;
        }
        if tool_counts_missing {
            self.hints.insert(
                "No tool starts were recognized in an active event window; check tool_start, tool_name_paths, and tool_call_id_paths.".to_string(),
            );
        }
        if event_type_missing {
            self.hints.insert(
                "Most event records did not match event_type_paths; check the configured event type JSON paths.".to_string(),
            );
        }
        if many_unknown_events {
            self.hints.insert(
                "Many event type names are not represented in the schema; review new Copilot event names and ignore_as_last_event.".to_string(),
            );
        }
        if stats.tool_starts > 0 && summary.token_checkpoints.is_empty() {
            self.hints.insert(
                "Tools were recognized but no token checkpoints were produced; check assistant_message output_token_paths and token_events.".to_string(),
            );
        }
    }

    fn into_report(self) -> Option<SchemaDriftReport> {
        if self.affected_sessions == 0 {
            return None;
        }
        let mut unknown_event_types = self
            .unknown_event_types
            .into_iter()
            .map(|(name, count)| SchemaDriftCount { name, count })
            .collect::<Vec<_>>();
        unknown_event_types.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
        unknown_event_types.truncate(12);
        Some(SchemaDriftReport {
            provider: self.provider,
            schema_version: self.schema_version,
            severity: "warning".to_string(),
            summary: format!(
                "Possible Copilot schema drift detected in {} of {} scanned session{}.",
                self.affected_sessions,
                self.checked_sessions,
                if self.checked_sessions == 1 { "" } else { "s" }
            ),
            checked_sessions: self.checked_sessions,
            affected_sessions: self.affected_sessions,
            total_events: self.total_events,
            recognized_events: self.recognized_events,
            tool_starts: self.tool_starts,
            tool_completes: self.tool_completes,
            missing_event_type: self.missing_event_type,
            unknown_event_types,
            hints: self.hints.into_iter().collect(),
        })
    }
}

fn is_schema_known_event(event_type: &str, schema: &ProviderSchema) -> bool {
    event_type == schema.events.tool_start
        || event_type == schema.events.tool_complete
        || event_type == schema.events.assistant_message
        || event_type == schema.events.assistant_turn_start
        || event_type == schema.events.assistant_turn_end
        || event_type == schema.events.user_message
        || event_type == schema.events.session_start
        || (!schema.events.hook_start.is_empty() && event_type == schema.events.hook_start)
        || (!schema.events.hook_complete.is_empty() && event_type == schema.events.hook_complete)
        || schema
            .events
            .ignore_as_last_event
            .iter()
            .any(|ignored| ignored == event_type)
        || schema
            .token_events
            .iter()
            .any(|token| token.event_type == event_type)
}

// ── Copilot-specific helpers (kept private to this module) ────────────

fn is_copilot_available() -> bool {
    candidate_copilot_paths().iter().any(|path| path.is_file())
}

fn candidate_copilot_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let names = copilot_executable_names();

    if let Some(path_value) = env::var_os("PATH") {
        for dir in env::split_paths(&path_value) {
            for name in &names {
                candidates.push(dir.join(name));
            }
        }
    }

    if let Some(home) = home_dir() {
        for dir in [
            home.join(".local").join("bin"),
            home.join("bin"),
            home.join(".npm-global").join("bin"),
            home.join(".volta").join("bin"),
            home.join(".yarn").join("bin"),
        ] {
            for name in &names {
                candidates.push(dir.join(name));
            }
        }
    }

    #[cfg(target_os = "macos")]
    for dir in [
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ] {
        for name in &names {
            candidates.push(dir.join(name));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = env::var_os("APPDATA").map(PathBuf::from) {
            for name in &names {
                candidates.push(appdata.join("npm").join(name));
            }
        }
        if let Some(localappdata) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            for dir in [
                localappdata.join("Programs"),
                localappdata
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Packages"),
            ] {
                for name in &names {
                    candidates.push(dir.join(name));
                }
            }
        }
    }

    candidates
}

fn copilot_executable_names() -> Vec<&'static str> {
    #[cfg(target_os = "windows")]
    {
        vec![
            "copilot.exe",
            "copilot.cmd",
            "copilot.bat",
            "copilot.ps1",
            "copilot",
        ]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec!["copilot"]
    }
}

pub fn home_dir() -> Option<PathBuf> {
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        return Some(home);
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
            return Some(profile);
        }
        if let (Some(drive), Some(path)) = (env::var_os("HOMEDRIVE"), env::var_os("HOMEPATH")) {
            return Some(PathBuf::from(format!(
                "{}{}",
                drive.to_string_lossy(),
                path.to_string_lossy()
            )));
        }
    }

    None
}

fn unix_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_workspace(path: &Path, schema: &ProviderSchema) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    let Ok(content) = fs::read_to_string(path) else {
        return values;
    };

    let lines = content.lines().collect::<Vec<_>>();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let Some((key, value)) = line.split_once(':') else {
            index += 1;
            continue;
        };
        let key = key.trim();
        if schema
            .workspace
            .allowed_keys
            .iter()
            .any(|allowed| allowed == key)
        {
            let trimmed = value.trim().trim_matches('"');
            if is_yaml_block_scalar_indicator(trimmed) {
                let mut block_lines = Vec::new();
                index += 1;
                while index < lines.len() {
                    let next_line = lines[index];
                    let is_indented = next_line.starts_with(' ') || next_line.starts_with('\t');
                    if !is_indented && next_line.split_once(':').is_some() {
                        break;
                    }
                    let block_value = next_line.trim();
                    if !block_value.is_empty() {
                        block_lines.push(block_value);
                    }
                    index += 1;
                }
                values.insert(key.to_string(), block_lines.join(" "));
                continue;
            }
            values.insert(key.to_string(), trimmed.to_string());
        }
        index += 1;
    }

    values
}

fn is_yaml_block_scalar_indicator(value: &str) -> bool {
    matches!(value, "|" | "|-" | "|+" | ">" | ">-" | ">+")
}

fn workspace_repository_label(workspace: &BTreeMap<String, String>) -> Option<String> {
    workspace
        .get("repository")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| workspace_folder_name(workspace.get("git_root")))
        .or_else(|| workspace_folder_name(workspace.get("cwd")))
}

fn workspace_folder_name(path: Option<&String>) -> Option<String> {
    path.and_then(|p| Path::new(p).file_name()?.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn workspace_marks_mission_control_analytics_session(workspace: &BTreeMap<String, String>) -> bool {
    ["name", "summary"].iter().any(|key| {
        workspace
            .get(*key)
            .is_some_and(|value| value.contains(MISSION_CONTROL_ANALYTICS_MARKER))
    })
}

fn sanitize_session_title(summary: Option<&String>) -> Option<String> {
    let raw = summary?.trim();
    if raw.is_empty() || is_yaml_block_scalar_indicator(raw) {
        return None;
    }

    let mut unquoted = String::with_capacity(raw.len());
    let mut quote: Option<char> = None;
    for ch in raw.chars() {
        if matches!(ch, '"' | '\'' | '`') {
            quote = if quote == Some(ch) { None } else { Some(ch) };
            unquoted.push(' ');
        } else if quote.is_none() {
            unquoted.push(ch);
        }
    }

    let mut collapsed = unquoted.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX_TITLE_CHARS: usize = 48;
    if collapsed.chars().count() > MAX_TITLE_CHARS {
        collapsed = collapsed
            .chars()
            .take(MAX_TITLE_CHARS - 1)
            .collect::<String>();
        collapsed.push('…');
    }

    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed)
    }
}

fn session_title_from_workspace(
    workspace: &BTreeMap<String, String>,
    repository: &str,
    branch: &str,
) -> String {
    sanitize_session_title(workspace.get("name"))
        .or_else(|| sanitize_session_title(workspace.get("summary")))
        .unwrap_or_else(|| {
            let repository = repository.trim();
            let branch = branch.trim();
            match (repository.is_empty(), branch.is_empty()) {
                (false, false) => format!("{} {}", repository, branch),
                (false, true) => repository.to_string(),
                (true, false) => branch.to_string(),
                (true, true) => "Session".to_string(),
            }
        })
}

struct PendingToolStart {
    timestamp: String,
    category: String,
    tool: String,
    call_id: String,
    event_ref: String,
    turn_id: String,
}

#[derive(Default)]
struct TurnBuilder {
    id: String,
    started_at: String,
    ended_at: String,
    tool_count: usize,
    tools: Vec<String>,
    failure_count: usize,
    categories: BTreeSet<String>,
    model: String,
    output_tokens: u64,
    partial: bool,
}

impl TurnBuilder {
    fn to_summary(&self) -> SessionTurnSummary {
        let duration_ms = parse_iso_ms(&self.ended_at)
            .zip(parse_iso_ms(&self.started_at))
            .and_then(|(end, start)| {
                if end >= start {
                    Some(end - start)
                } else {
                    None
                }
            });
        let status = if self.failure_count > 0 {
            "failed"
        } else if self.ended_at.is_empty() {
            "running"
        } else {
            "complete"
        };
        SessionTurnSummary {
            id: self.id.clone(),
            started_at: self.started_at.clone(),
            ended_at: self.ended_at.clone(),
            status: status.to_string(),
            tool_count: self.tool_count,
            tools: self.tools.clone(),
            failure_count: self.failure_count,
            categories: self.categories.iter().cloned().collect(),
            model: self.model.clone(),
            output_tokens: self.output_tokens,
            partial: self.partial,
            duration_ms,
        }
    }
}

fn ensure_turn<'a>(
    turns: &'a mut BTreeMap<String, TurnBuilder>,
    turn_order: &mut Vec<String>,
    turn_id: &str,
    timestamp: &str,
    partial: bool,
) -> &'a mut TurnBuilder {
    if !turns.contains_key(turn_id) {
        turn_order.push(turn_id.to_string());
        turns.insert(
            turn_id.to_string(),
            TurnBuilder {
                id: turn_id.to_string(),
                started_at: timestamp.to_string(),
                partial,
                ..Default::default()
            },
        );
    }
    let turn = turns.get_mut(turn_id).expect("turn inserted above");
    if turn.started_at.is_empty() || timestamp < turn.started_at.as_str() {
        turn.started_at = timestamp.to_string();
    }
    turn.partial |= partial;
    turn
}

#[cfg(test)]
fn summarize_events(
    provider: &'static str,
    path: &Path,
    session_id: &str,
    summary: &mut AgentSessionSummary,
    tool_counts: &mut BTreeMap<(String, String), usize>,
    recent_events: &mut Vec<AgentEventSummary>,
    mcp_allowlist: &HashSet<String>,
    configured_hook_types: &HashSet<String>,
    schema: &ProviderSchema,
    token_prefix_cache_context: &str,
) -> SessionSchemaStats {
    summarize_events_with_mode(
        provider,
        path,
        session_id,
        summary,
        tool_counts,
        recent_events,
        mcp_allowlist,
        configured_hook_types,
        schema,
        token_prefix_cache_context,
        false,
    )
}

fn summarize_events_with_mode(
    provider: &'static str,
    path: &Path,
    session_id: &str,
    summary: &mut AgentSessionSummary,
    tool_counts: &mut BTreeMap<(String, String), usize>,
    recent_events: &mut Vec<AgentEventSummary>,
    mcp_allowlist: &HashSet<String>,
    configured_hook_types: &HashSet<String>,
    schema: &ProviderSchema,
    token_prefix_cache_context: &str,
    include_full_history: bool,
) -> SessionSchemaStats {
    let mut schema_stats = SessionSchemaStats::default();
    let Ok(mut file) = fs::File::open(path) else {
        return schema_stats;
    };

    // Tail-window limit. The full-event scan (recent tools, errors,
    // last_tool, recent_events list) only reads the last MAX_EVENT_TAIL_BYTES
    // of the file: that gives ~5-15 minutes of busy-session history and
    // parses in a few ms, even for a 100 MB+ events.jsonl. Bumped from
    // 512 KiB → 8 MiB because 512 KiB only captured the most recent
    // ~30-50 tool calls, which made low-volume categories like Intent
    // (`report_intent`) invisible whenever bash bursts dominated.
    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);

    // If the file is larger than the tail window, pre-scan the SKIPPED
    // portion (0 .. file_len - MAX_READ_BYTES) for compaction/shutdown
    // token events ONLY. Without this, long-running sessions whose most
    // recent `session.compaction_complete` got pushed out of the 8 MiB
    // tail by a burst of `tool.execution_complete` events would show
    // 0 input tokens (Copilot's `assistant.message` events carry
    // outputTokens but NOT inputTokens, so input is only ever recorded
    // at compaction or shutdown). The head scan is cheap because we
    // substring-filter lines before JSON-parsing, so only the ~1 in
    // 4 MB of lines that actually contain a token event get parsed.
    let mut read_offset = 0;
    if !include_full_history && file_len > MAX_EVENT_TAIL_BYTES {
        let skipped_len = file_len - MAX_EVENT_TAIL_BYTES;
        fold_skipped_token_events_from_path(
            path,
            skipped_len,
            summary,
            schema,
            token_prefix_cache_context,
        );
        read_offset = skipped_len;
        let _ = file.seek(SeekFrom::Start(read_offset));
    }

    // Pending tool starts keyed by toolCallId when available, falling
    // back to tool name for older/incomplete events. Captures the turn at
    // start time so a later completion can't drift into a newer turn.
    let mut pending_starts: BTreeMap<String, PendingToolStart> = BTreeMap::new();
    let mut pending_hooks: BTreeMap<String, PendingToolStart> = BTreeMap::new();
    let mut turn_order: Vec<String> = Vec::new();
    let mut turns: BTreeMap<String, TurnBuilder> = BTreeMap::new();
    let mut active_turn_id: Option<String> = None;
    let mut last_completed_tool_turn_id: Option<String> = None;
    let mut current_model = summary.last_model.clone();
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        let line_start = read_offset;
        line.clear();
        let Ok(bytes_read) = reader.read_line(&mut line) else {
            break;
        };
        if bytes_read == 0 {
            break;
        }
        read_offset = read_offset.saturating_add(bytes_read as u64);
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let event_ref = event_ref_from_offset(line_start);
        let event_type =
            string_from_paths(&value, &schema.events.event_type_paths).unwrap_or_default();
        let event_type = event_type.as_str();
        schema_stats.record_event_type(event_type, schema);
        let timestamp =
            string_from_paths(&value, &schema.events.timestamp_paths).unwrap_or_default();
        if summary.token_checkpoints.is_empty()
            && (summary.input_tokens > 0 || summary.output_tokens > 0)
        {
            push_token_checkpoint(summary, &timestamp);
        }

        summary.event_count += 1;
        let is_hook_start =
            !schema.events.hook_start.is_empty() && event_type == schema.events.hook_start;
        let is_hook_complete =
            !schema.events.hook_complete.is_empty() && event_type == schema.events.hook_complete;
        let is_hook_event = is_hook_start || is_hook_complete;
        let event_category = categorize_event(event_type).to_string();
        if !is_hook_event
            && !schema
                .events
                .ignore_as_last_event
                .iter()
                .any(|ignored| ignored == event_type)
        {
            record_last_event(summary, &timestamp, event_type, &event_category);
        }

        // Many event types carry `data.model` (assistant.message,
        // tool.execution_start/complete, assistant.streaming_delta,
        // etc.). The JSONL is appended chronologically so the last
        // write wins → newer events overwrite the captured value,
        // letting the renderer surface mid-session model switches.
        if let Some(model) = string_from_paths(&value, &schema.events.model_paths) {
            if !model.is_empty() {
                current_model = model;
                summary.last_model = current_model.clone();
            }
        }

        if is_hook_start {
            let hook_name = safe_hook_name(&value, schema);
            if !is_configured_hook_type(&hook_name, configured_hook_types) {
                continue;
            }
            let raw_hook_id = raw_hook_invocation_id(&value, schema);
            let call_id = raw_hook_id
                .as_deref()
                .map(|id| safe_ref_id("hook", id))
                .unwrap_or_default();
            let hook_turn_id = raw_event_turn_id(&value, schema)
                .map(|id| safe_ref_id("turn", &id))
                .or_else(|| active_turn_id.clone())
                .or_else(|| {
                    if is_post_tool_use_hook(&hook_name) {
                        last_completed_tool_turn_id.clone()
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            record_last_event(summary, &timestamp, event_type, "hooks");

            summary.hooks_count += 1;
            summary.last_tool = hook_name.clone();
            recent_events.push(AgentEventSummary {
                provider: provider.to_string(),
                session_id: session_id.chars().take(8).collect(),
                timestamp: timestamp.clone(),
                kind: event_type.to_string(),
                tool: hook_name.clone(),
                category: "hooks".to_string(),
                success: true,
                input_tokens: Some(summary.input_tokens),
                output_tokens: Some(summary.output_tokens),
            });

            push_session_tool_call(
                &mut summary.recent_tool_calls,
                SessionToolCall {
                    tool: hook_name.clone(),
                    category: "hooks".to_string(),
                    timestamp: timestamp.clone(),
                    success: true,
                    completed_at: String::new(),
                    model: current_model.clone(),
                    call_id: call_id.clone(),
                    event_ref: event_ref.clone(),
                    turn_id: hook_turn_id.clone(),
                    target: hook_name.clone(),
                    details: build_safe_hook_details(provider, &hook_name),
                    duration_ms: None,
                },
            );
            let pending_key = raw_hook_id.unwrap_or_else(|| hook_name.clone());
            pending_hooks.insert(
                pending_key,
                PendingToolStart {
                    timestamp,
                    category: "hooks".to_string(),
                    tool: hook_name,
                    call_id,
                    event_ref,
                    turn_id: hook_turn_id,
                },
            );
        } else if is_hook_complete {
            let hook_name = safe_hook_name(&value, schema);
            if !is_configured_hook_type(&hook_name, configured_hook_types) {
                continue;
            }
            let success = bool_from_paths(&value, &schema.events.success_paths).unwrap_or(true);
            let completion_category = if success { "hooks" } else { "alert" };
            record_last_event(summary, &timestamp, event_type, completion_category);
            recent_events.push(AgentEventSummary {
                provider: provider.to_string(),
                session_id: session_id.chars().take(8).collect(),
                timestamp: timestamp.clone(),
                kind: event_type.to_string(),
                tool: hook_name.clone(),
                category: completion_category.to_string(),
                success,
                input_tokens: Some(summary.input_tokens),
                output_tokens: Some(summary.output_tokens),
            });

            let complete_key =
                raw_hook_invocation_id(&value, schema).unwrap_or_else(|| hook_name.clone());
            if let Some(start) = pending_hooks.remove(&complete_key) {
                let duration_ms = parse_iso_ms(&timestamp)
                    .zip(parse_iso_ms(&start.timestamp))
                    .and_then(|(end, start)| {
                        if end >= start {
                            Some(end - start)
                        } else {
                            None
                        }
                    });
                if let Some(entry) = summary.recent_tool_calls.iter_mut().rev().find(|entry| {
                    if !start.event_ref.is_empty() {
                        entry.event_ref == start.event_ref
                    } else if !start.call_id.is_empty() {
                        entry.call_id == start.call_id
                    } else {
                        entry.category == "hooks"
                            && entry.tool == start.tool
                            && entry.duration_ms.is_none()
                    }
                }) {
                    entry.success = success;
                    entry.duration_ms = duration_ms;
                    entry.completed_at = timestamp.clone();
                }
            }
            if !success {
                summary.error_count += 1;
            }
        } else if event_type == schema.events.tool_start {
            schema_stats.tool_starts += 1;
            let raw_tool_name = string_from_paths(&value, &schema.events.tool_name_paths)
                .unwrap_or_else(|| "tool".to_string());
            let args = value_from_paths(&value, &schema.events.arguments_paths);
            let raw_call_id = raw_tool_call_id(&value, schema);
            let call_id = raw_call_id
                .as_deref()
                .map(|id| safe_ref_id("call", id))
                .unwrap_or_default();
            let turn_id = raw_event_turn_id(&value, schema)
                .map(|id| safe_ref_id("turn", &id))
                .or_else(|| active_turn_id.clone())
                .unwrap_or_default();
            let (tool_name, category) = classify_tool(&raw_tool_name, args, mcp_allowlist, schema);
            record_last_event(summary, &timestamp, event_type, &category);
            if !turn_id.is_empty() {
                let partial = !turns.contains_key(&turn_id);
                let turn = ensure_turn(&mut turns, &mut turn_order, &turn_id, &timestamp, partial);
                turn.tool_count += 1;
                if turn.tools.len() < 12 {
                    turn.tools.push(tool_name.clone());
                }
                turn.categories.insert(category.clone());
                if turn.model.is_empty() {
                    turn.model = current_model.clone();
                }
            }

            summary.tool_count += 1;
            summary.last_tool = tool_name.clone();
            match category.as_str() {
                "edits" => summary.write_count += 1,
                "library" => summary.read_count += 1,
                "terminal" => summary.command_count += 1,
                "signal" => summary.web_count += 1,
                "delegates" => {
                    summary.task_count += 1;
                    summary.delegates_count += 1;
                }
                "skills" => {
                    summary.task_count += 1;
                    summary.skills_count += 1;
                }
                "court" => summary.court_count += 1,
                "mcp" => summary.mcp_count += 1,
                _ => {}
            }

            *tool_counts
                .entry((tool_name.clone(), category.clone()))
                .or_insert(0) += 1;
            recent_events.push(AgentEventSummary {
                provider: provider.to_string(),
                session_id: session_id.chars().take(8).collect(),
                timestamp: timestamp.clone(),
                kind: event_type.to_string(),
                tool: tool_name.clone(),
                category: category.clone(),
                success: true,
                input_tokens: Some(summary.input_tokens),
                output_tokens: Some(summary.output_tokens),
            });

            // Record an in-flight entry in the per-session transcript;
            // duration is filled in when the matching complete event
            // lands. Bounded so a chatty session doesn't blow memory.
            push_session_tool_call(
                &mut summary.recent_tool_calls,
                SessionToolCall {
                    tool: tool_name.clone(),
                    category: category.clone(),
                    timestamp: timestamp.clone(),
                    success: true,
                    completed_at: String::new(),
                    model: current_model.clone(),
                    call_id: call_id.clone(),
                    event_ref: event_ref.clone(),
                    turn_id: turn_id.clone(),
                    target: tool_name.clone(),
                    details: build_safe_tool_details(
                        provider,
                        &raw_tool_name,
                        &category,
                        args,
                        schema,
                    ),
                    duration_ms: None,
                },
            );
            let pending_key = raw_call_id.unwrap_or_else(|| tool_name.clone());
            pending_starts.insert(
                pending_key,
                PendingToolStart {
                    timestamp,
                    category,
                    tool: tool_name,
                    call_id,
                    event_ref,
                    turn_id,
                },
            );
        } else if event_type == schema.events.tool_complete {
            schema_stats.tool_completes += 1;
            let success = bool_from_paths(&value, &schema.events.success_paths).unwrap_or(true);
            let completion_category = if success { "complete" } else { "alert" };
            record_last_event(summary, &timestamp, event_type, completion_category);
            recent_events.push(AgentEventSummary {
                provider: provider.to_string(),
                session_id: session_id.chars().take(8).collect(),
                timestamp: timestamp.clone(),
                kind: event_type.to_string(),
                tool: "tool complete".to_string(),
                category: completion_category.to_string(),
                success,
                input_tokens: Some(summary.input_tokens),
                output_tokens: Some(summary.output_tokens),
            });

            // Fold the success/duration back into the most-recent tool
            // call entry whose tool name matches. Keeps the transcript
            // in chrono order. We also use the stashed category to
            // decide whether this failure escalates the session to
            // needs-attention: failed terminal calls (e.g. `grep` with
            // no matches, `test` returning non-zero) aren't actionable
            // for the dev — they're normal LLM exploration — so they
            // don't bump error_count and don't turn the session red.
            let complete_key =
                raw_tool_call_id(&value, schema).unwrap_or_else(|| summary.last_tool.clone());
            if let Some(start) = pending_starts.remove(&complete_key) {
                let duration_ms = parse_iso_ms(&timestamp)
                    .zip(parse_iso_ms(&start.timestamp))
                    .and_then(|(end, start)| {
                        if end >= start {
                            Some(end - start)
                        } else {
                            None
                        }
                    });
                if let Some(entry) = summary.recent_tool_calls.iter_mut().rev().find(|entry| {
                    if !start.event_ref.is_empty() {
                        entry.event_ref == start.event_ref
                    } else if !start.call_id.is_empty() {
                        entry.call_id == start.call_id
                    } else {
                        entry.tool == start.tool && entry.duration_ms.is_none()
                    }
                }) {
                    entry.success = success;
                    entry.duration_ms = duration_ms;
                    entry.completed_at = timestamp.clone();
                }
                if !start.turn_id.is_empty() {
                    last_completed_tool_turn_id = Some(start.turn_id.clone());
                    if let Some(turn) = turns.get_mut(&start.turn_id) {
                        if !success {
                            turn.failure_count += 1;
                        }
                        if turn.model.is_empty() {
                            turn.model = current_model.clone();
                        }
                    }
                }
                if !success && start.category != "terminal" {
                    summary.error_count += 1;
                }
            }
            // Note: we deliberately do NOT count "orphan" complete events
            // (no matching start in this scan). Because we only read the
            // last MAX_EVENT_TAIL_BYTES of events.jsonl, the tail often begins
            // mid-pair — the first few completes routinely have no start
            // in the window. Counting those would re-flag every long-
            // running session as needs-attention purely from tail
            // truncation, even when the live work is fine.
        } else if event_type == schema.events.assistant_message {
            // Copilot's `assistant.message` carries `outputTokens` per
            // message but not `inputTokens` in practice — input token
            // counts are reported at session.shutdown via tokenDetails
            // (see below), so trying to accumulate them here would
            // silently stay at zero anyway.
            if let Some(tokens) = u64_from_paths(&value, &schema.events.output_token_paths) {
                summary.output_tokens += tokens;
                push_token_checkpoint(summary, &timestamp);
                let turn_id = raw_event_turn_id(&value, schema)
                    .map(|id| safe_ref_id("turn", &id))
                    .or_else(|| active_turn_id.clone());
                if let Some(turn_id) = turn_id {
                    let partial = !turns.contains_key(&turn_id);
                    let turn =
                        ensure_turn(&mut turns, &mut turn_order, &turn_id, &timestamp, partial);
                    turn.output_tokens += tokens;
                    if turn.model.is_empty() {
                        turn.model = current_model.clone();
                    }
                }
            }
        } else if schema
            .token_events
            .iter()
            .any(|token| token.event_type == event_type)
        {
            // Token aggregation is shared with the head-pass helper
            // (`fold_skipped_token_events`) so the same accounting rules
            // apply whether the event lands in the 8 MiB tail or in the
            // earlier portion of a long-running file. See the helper's
            // doc for the cache_read / cache_write semantics.
            apply_token_event(&value, event_type, summary, schema);
            push_token_checkpoint(summary, &timestamp);
        } else if event_type == schema.events.assistant_turn_start
            || event_type == schema.events.assistant_turn_end
            || event_type == schema.events.user_message
            || event_type == schema.events.session_start
        {
            if event_type == schema.events.assistant_turn_start {
                summary.turn_count += 1;
                let raw_turn =
                    raw_event_turn_id(&value, schema).unwrap_or_else(|| timestamp.clone());
                let turn_id = safe_ref_id("turn", &raw_turn);
                active_turn_id = Some(turn_id.clone());
                let turn = ensure_turn(&mut turns, &mut turn_order, &turn_id, &timestamp, false);
                turn.partial = false;
                if turn.model.is_empty() {
                    turn.model = current_model.clone();
                }
            } else if event_type == schema.events.assistant_turn_end {
                let turn_id = raw_event_turn_id(&value, schema)
                    .map(|id| safe_ref_id("turn", &id))
                    .or_else(|| active_turn_id.clone());
                if let Some(turn_id) = turn_id {
                    let partial = !turns.contains_key(&turn_id);
                    let turn =
                        ensure_turn(&mut turns, &mut turn_order, &turn_id, &timestamp, partial);
                    turn.ended_at = timestamp.clone();
                    if turn.model.is_empty() {
                        turn.model = current_model.clone();
                    }
                    if active_turn_id.as_deref() == Some(turn_id.as_str()) {
                        active_turn_id = None;
                    }
                }
            }
            recent_events.push(AgentEventSummary {
                provider: provider.to_string(),
                session_id: session_id.chars().take(8).collect(),
                timestamp,
                kind: event_type.to_string(),
                tool: String::new(),
                category: categorize_event(event_type).to_string(),
                success: true,
                input_tokens: Some(summary.input_tokens),
                output_tokens: Some(summary.output_tokens),
            });
        }
    }
    let start = turn_order.len().saturating_sub(MAX_SESSION_TURNS);
    summary.recent_turns = turn_order[start..]
        .iter()
        .filter_map(|id| turns.get(id))
        .map(TurnBuilder::to_summary)
        .collect();
    schema_stats
}

pub fn get_raw_tool_call_details(
    provider: Option<String>,
    session_id: String,
    event_ref: String,
) -> Result<RawToolCallDetails, String> {
    let provider = provider.unwrap_or_else(|| "copilot".to_string());
    if provider != "copilot" {
        return Err(format!(
            "Raw inspection is not supported for provider '{}'",
            provider
        ));
    }
    if !is_safe_public_ref(&session_id) {
        return Err("Invalid session id".to_string());
    }

    let (schema, _) = load_copilot_schema();
    let session_dir = resolve_copilot_session_dir(&schema, &session_id)?;
    let events_path = first_existing_child(&session_dir, &schema.session.events_files);
    raw_tool_call_details_from_events_path(&events_path, &schema, &event_ref)
}

fn resolve_copilot_session_dir(
    schema: &ProviderSchema,
    session_id: &str,
) -> Result<PathBuf, String> {
    let discovery = discover_copilot_state_roots(schema);
    let mut matches = Vec::new();
    let mut scanned_roots = 0usize;
    for root in discovery.roots {
        if !root.path.exists() {
            continue;
        }
        let canonical_root = match root.path.canonicalize() {
            Ok(path) => path,
            Err(err) => {
                log::warn!("Unable to access Copilot session state: {}", err);
                continue;
            }
        };
        let entries = match fs::read_dir(&canonical_root) {
            Ok(entries) => {
                scanned_roots += 1;
                entries
            }
            Err(err) => {
                log::warn!("Unable to scan Copilot session state: {}", err);
                continue;
            }
        };
        matches.extend(entries.filter_map(Result::ok).filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(session_id) {
                return None;
            }
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let canonical = path.canonicalize().ok()?;
            if canonical.starts_with(&canonical_root) {
                Some(canonical)
            } else {
                None
            }
        }));
    }
    if scanned_roots == 0 {
        return Err("Unable to scan local Copilot session state".to_string());
    }

    match matches.len() {
        0 => Err("No matching local session was found".to_string()),
        1 => Ok(matches.remove(0)),
        _ => Err(
            "Session id is ambiguous; refresh activity before revealing raw details".to_string(),
        ),
    }
}

fn raw_tool_call_details_from_events_path(
    path: &Path,
    schema: &ProviderSchema,
    event_ref: &str,
) -> Result<RawToolCallDetails, String> {
    let offset =
        parse_event_ref(event_ref).ok_or_else(|| "Invalid tool event reference".to_string())?;
    let mut file =
        fs::File::open(path).map_err(|err| format!("Unable to open session events: {}", err))?;
    let len = file
        .metadata()
        .map_err(|err| format!("Unable to inspect session events: {}", err))?
        .len();
    if offset >= len {
        return Err("Tool event reference is no longer available".to_string());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|err| format!("Unable to read session events: {}", err))?;

    let mut reader = BufReader::new(file);
    let mut line = String::new();
    if reader
        .read_line(&mut line)
        .map_err(|err| format!("Unable to read session event: {}", err))?
        == 0
    {
        return Err("Tool event reference is no longer available".to_string());
    }
    let value = serde_json::from_str::<serde_json::Value>(&line)
        .map_err(|_| "Tool event reference no longer points to a readable event".to_string())?;
    let event_type = string_from_paths(&value, &schema.events.event_type_paths).unwrap_or_default();
    let (raw_args, raw_args_truncated, raw_output) = if event_type == schema.events.tool_start {
        let (raw_args, raw_args_truncated) =
            value_from_paths(&value, &schema.events.arguments_paths)
                .map(|value| raw_value_to_string(value, MAX_RAW_DETAIL_VALUE_BYTES))
                .unwrap_or_default();
        let raw_call_id = raw_tool_call_id(&value, schema);
        let raw_output = find_raw_event_output(
            &mut reader,
            schema,
            &schema.events.tool_complete,
            raw_call_id.as_deref(),
            &schema.events.output_paths,
            raw_tool_call_id,
        );
        (raw_args, raw_args_truncated, raw_output)
    } else if event_type == schema.events.hook_start {
        let (raw_args, raw_args_truncated) =
            value_from_paths(&value, &schema.events.hook_input_paths)
                .map(|value| raw_value_to_string(value, MAX_RAW_DETAIL_VALUE_BYTES))
                .unwrap_or_default();
        let raw_hook_id = raw_hook_invocation_id(&value, schema);
        let raw_output = find_raw_event_output(
            &mut reader,
            schema,
            &schema.events.hook_complete,
            raw_hook_id.as_deref(),
            &schema.events.hook_output_paths,
            raw_hook_invocation_id,
        );
        (raw_args, raw_args_truncated, raw_output)
    } else {
        return Err("Raw details are only available for tool or hook calls".to_string());
    };
    Ok(RawToolCallDetails {
        raw_args,
        raw_output: raw_output.value,
        raw_args_truncated,
        raw_output_truncated: raw_output.truncated,
        raw_output_scan_limited: raw_output.scan_limited,
    })
}

#[derive(Default)]
struct RawOutputSearch {
    value: Option<String>,
    truncated: bool,
    scan_limited: bool,
}

fn find_raw_event_output<R: BufRead, F>(
    reader: &mut R,
    schema: &ProviderSchema,
    complete_event_type: &str,
    raw_call_id: Option<&str>,
    output_paths: &[String],
    event_id: F,
) -> RawOutputSearch
where
    F: Fn(&serde_json::Value, &ProviderSchema) -> Option<String>,
{
    let Some(raw_call_id) = raw_call_id else {
        return RawOutputSearch::default();
    };
    if output_paths.is_empty() || complete_event_type.is_empty() {
        return RawOutputSearch::default();
    }
    let mut line = String::new();
    let mut scanned_bytes = 0u64;
    loop {
        line.clear();
        let Ok(bytes_read) = reader.read_line(&mut line) else {
            return RawOutputSearch::default();
        };
        if bytes_read == 0 {
            return RawOutputSearch::default();
        }
        scanned_bytes = scanned_bytes.saturating_add(bytes_read as u64);
        if scanned_bytes > MAX_RAW_DETAIL_SCAN_BYTES {
            return RawOutputSearch {
                scan_limited: true,
                ..Default::default()
            };
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let event_type =
            string_from_paths(&value, &schema.events.event_type_paths).unwrap_or_default();
        if event_type != complete_event_type {
            continue;
        }
        if event_id(&value, schema).as_deref() == Some(raw_call_id) {
            let (value, truncated) = value_from_paths(&value, output_paths)
                .map(|value| raw_value_to_string(value, MAX_RAW_DETAIL_VALUE_BYTES))
                .unwrap_or_default();
            return RawOutputSearch {
                value,
                truncated,
                scan_limited: false,
            };
        }
    }
}

fn raw_value_to_string(value: &serde_json::Value, max_bytes: usize) -> (Option<String>, bool) {
    let rendered = if let Some(value) = value.as_str() {
        value.to_string()
    } else {
        serde_json::to_string_pretty(value)
            .or_else(|_| serde_json::to_string(value))
            .unwrap_or_default()
    };
    let (rendered, truncated) = truncate_utf8(rendered, max_bytes);
    (Some(rendered), truncated)
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value, false);
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    (value, true)
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_safe_public_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn event_ref_from_offset(offset: u64) -> String {
    format!("evt-{offset:x}")
}

fn parse_event_ref(event_ref: &str) -> Option<u64> {
    let suffix = event_ref.strip_prefix("evt-")?;
    if suffix.is_empty() || !suffix.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(suffix, 16).ok()
}

fn value_at_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for segment in path.split('.') {
        if segment.is_empty() {
            return None;
        }
        current = current.get(segment)?;
    }
    Some(current)
}

fn value_from_paths<'a>(
    value: &'a serde_json::Value,
    paths: &[String],
) -> Option<&'a serde_json::Value> {
    paths.iter().find_map(|path| value_at_path(value, path))
}

fn string_from_paths(value: &serde_json::Value, paths: &[String]) -> Option<String> {
    value_from_paths(value, paths)
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn bool_from_paths(value: &serde_json::Value, paths: &[String]) -> Option<bool> {
    value_from_paths(value, paths).and_then(|value| value.as_bool())
}

fn u64_from_paths(value: &serde_json::Value, paths: &[String]) -> Option<u64> {
    value_from_paths(value, paths).and_then(|value| value.as_u64())
}

fn sum_token_components(value: &serde_json::Value, paths: &[String]) -> u64 {
    paths
        .iter()
        .filter_map(|path| value_at_path(value, path).and_then(|value| value.as_u64()))
        .sum()
}

fn model_metrics_totals(value: &serde_json::Value, rule: &ModelMetricsTokenSchema) -> (u64, u64) {
    let Some(metrics) =
        value_at_path(value, &rule.metrics_path).and_then(|value| value.as_object())
    else {
        return (0, 0);
    };

    metrics
        .values()
        .fold((0_u64, 0_u64), |(input_total, output_total), metric| {
            let input = value_at_path(metric, &rule.input_path)
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let cache_read = value_at_path(metric, &rule.cache_read_path)
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let output = value_at_path(metric, &rule.output_path)
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            (
                input_total.saturating_add(input.saturating_sub(cache_read)),
                output_total.saturating_add(output),
            )
        })
}

/// Apply the token deltas from a single `session.compaction_complete`
/// or `session.shutdown` event to `summary`.
///
/// **Compaction**: `compactionTokensUsed.inputTokens` / `outputTokens`
/// are the tokens consumed BY each compaction operation (~200 KTok per
/// call), not a running total of the conversation. Summing across all
/// compactions in the session legitimately accounts for "tokens the
/// agent spent on self-compaction this session" — they're additive.
///
/// **Shutdown**: Copilot emits cumulative session totals in a four-
/// bucket `tokenDetails` block (input / cache_read / cache_write /
/// output). Newer shutdown events may instead expose only per-model
/// `modelMetrics.*.usage` totals; we treat those as the same cumulative
/// source. We deliberately EXCLUDE cache reads from the input total:
/// cache reads are the cached prefix the model re-fetches on every turn,
/// which can balloon into the hundreds of millions for a long session
/// (one observed session reported 321M cache reads vs 125K fresh input
/// and 10M cache writes). Including cache reads made the "Tokens · 24h"
/// card report ~333M for a normal day of coding, which both overflowed
/// the card and misrepresented actual model work. Cache reads are billed
/// at a tiny fraction of fresh-input rates and the model doesn't process
/// them from scratch.
///
/// We DO include `cache_write` because cache writes are the model
/// committing new content to cache and are billed at the same (or
/// higher) rate as fresh input — they represent real work.
///
/// Shutdown REPLACES the totals if its number is larger than the
/// running sum (using `max`), so a shutdown checkpoint that includes
/// pre-shutdown compactions doesn't double-count those compactions,
/// while any post-shutdown compactions still add on top.
fn apply_token_event(
    value: &serde_json::Value,
    event_type: &str,
    summary: &mut AgentSessionSummary,
    schema: &ProviderSchema,
) {
    let Some(rule) = schema
        .token_events
        .iter()
        .find(|rule| rule.event_type == event_type)
    else {
        return;
    };

    let mut input = sum_token_components(value, &rule.input_components);
    let mut output = sum_token_components(value, &rule.output_components);
    if rule.mode == "cumulative_max" {
        let (model_input, model_output) = rule
            .model_metrics
            .as_ref()
            .map(|model_rule| model_metrics_totals(value, model_rule))
            .unwrap_or((0, 0));
        input = input.max(model_input);
        output = output.max(model_output);
    }
    match rule.mode.as_str() {
        "additive" => {
            summary.input_tokens += input;
            summary.output_tokens += output;
        }
        "cumulative_max" => {
            if input > summary.input_tokens {
                summary.input_tokens = input;
            }
            if output > summary.output_tokens {
                summary.output_tokens = output;
            }
        }
        _ => {}
    }
}

/// Streaming scan of the portion of events.jsonl that the tail-window
/// scan in `summarize_events` skipped. Aggregates input/output tokens
/// from `session.compaction_complete` and `session.shutdown` events
/// ONLY — everything else (recent events, tool counts, error counts,
/// last_tool, etc.) is intentionally NOT updated here, so the tail
/// scan remains the single source of truth for "what's happening
/// right now".
///
/// Lines are substring-filtered before JSON parsing so the per-line
/// cost is essentially free for the 99%+ of events that aren't token
/// events. On a 163 MB file with 42 compactions this completes in
/// well under a second.
fn fold_skipped_token_events_from_path(
    path: &Path,
    target_len: u64,
    summary: &mut AgentSessionSummary,
    schema: &ProviderSchema,
    cache_context: &str,
) {
    if target_len == 0 {
        return;
    }

    let Ok(mut file) = fs::File::open(path) else {
        return;
    };
    let head_signature = file_head_signature(&mut file);
    let key = copilot_token_prefix_cache_key(path, cache_context);
    let mut start_offset = 0;
    if let Some(cached) = cached_token_prefix(&key, target_len, &head_signature) {
        apply_token_totals(summary, cached.totals);
        start_offset = cached.processed_len;
    }
    if start_offset >= target_len {
        return;
    }

    if file.seek(SeekFrom::Start(start_offset)).is_err() {
        return;
    }

    let reader = BufReader::new(file.take(target_len - start_offset));
    let processed_delta = fold_skipped_token_events(reader, summary, schema);
    let processed_len = start_offset.saturating_add(processed_delta);
    store_token_prefix(
        key,
        CachedTokenPrefix {
            processed_len,
            totals: token_totals(summary),
            head_signature,
        },
    );
}

fn file_head_signature(file: &mut fs::File) -> Vec<u8> {
    let mut signature = vec![0; TOKEN_PREFIX_HEAD_SIGNATURE_BYTES];
    let read_len = match file.read(&mut signature) {
        Ok(len) => len,
        Err(_) => 0,
    };
    signature.truncate(read_len);
    signature
}

fn token_totals(summary: &AgentSessionSummary) -> TokenTotals {
    TokenTotals {
        input_tokens: summary.input_tokens,
        output_tokens: summary.output_tokens,
    }
}

fn apply_token_totals(summary: &mut AgentSessionSummary, totals: TokenTotals) {
    summary.input_tokens = totals.input_tokens;
    summary.output_tokens = totals.output_tokens;
}

fn fold_skipped_token_events<R: BufRead>(
    mut reader: R,
    summary: &mut AgentSessionSummary,
    schema: &ProviderSchema,
) -> u64 {
    let token_needles = schema
        .token_events
        .iter()
        .map(|token| format!("\"{}\"", token.event_type))
        .collect::<Vec<_>>();
    let mut processed_len = 0u64;
    let mut line = Vec::new();
    loop {
        line.clear();
        let Ok(bytes_read) = reader.read_until(b'\n', &mut line) else {
            break;
        };
        if bytes_read == 0 {
            break;
        }
        if !line.ends_with(b"\n") {
            break;
        }
        processed_len = processed_len.saturating_add(bytes_read as u64);
        let Ok(line) = std::str::from_utf8(&line) else {
            continue;
        };
        if !schema
            .token_events
            .iter()
            .zip(token_needles.iter())
            .any(|(_, needle)| line.contains(needle))
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let event_type =
            string_from_paths(&value, &schema.events.event_type_paths).unwrap_or_default();
        let event_type = event_type.as_str();
        if schema
            .token_events
            .iter()
            .any(|token| token.event_type == event_type)
        {
            apply_token_event(&value, event_type, summary, schema);
        }
    }
    processed_len
}

fn push_session_tool_call(buf: &mut Vec<SessionToolCall>, call: SessionToolCall) {
    buf.push(call);
    if buf.len() > MAX_SESSION_TOOL_CALLS {
        let overflow = buf.len() - MAX_SESSION_TOOL_CALLS;
        buf.drain(0..overflow);
    }
}

fn push_token_checkpoint(summary: &mut AgentSessionSummary, timestamp: &str) {
    let checkpoint = SessionTokenCheckpoint {
        timestamp: timestamp.to_string(),
        input_tokens: summary.input_tokens,
        output_tokens: summary.output_tokens,
    };
    if summary.token_checkpoints.last().is_some_and(|last| {
        last.input_tokens == checkpoint.input_tokens
            && last.output_tokens == checkpoint.output_tokens
            && last.timestamp == checkpoint.timestamp
    }) {
        return;
    }
    summary.token_checkpoints.push(checkpoint);
    if summary.token_checkpoints.len() > MAX_SESSION_TOKEN_CHECKPOINTS {
        let overflow = summary.token_checkpoints.len() - MAX_SESSION_TOKEN_CHECKPOINTS;
        summary.token_checkpoints.drain(0..overflow);
    }
}

/// Parse "2026-05-21T07:14:00.123Z" (or without ms) into unix epoch ms.
/// Best-effort: returns None on malformed input rather than failing the
/// whole scan. We only need the millisecond delta for durations.
fn parse_iso_ms(s: &str) -> Option<u64> {
    if s.is_empty() {
        return None;
    }
    // Split date/time on 'T'
    let (date, rest) = s.split_once('T')?;
    let time = rest.trim_end_matches('Z');
    let date_parts: Vec<&str> = date.split('-').collect();
    if date_parts.len() != 3 {
        return None;
    }
    let year: i64 = date_parts[0].parse().ok()?;
    let month: i64 = date_parts[1].parse().ok()?;
    let day: i64 = date_parts[2].parse().ok()?;

    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let time_parts: Vec<&str> = hms.split(':').collect();
    if time_parts.len() < 2 {
        return None;
    }
    let hour: i64 = time_parts[0].parse().ok()?;
    let minute: i64 = time_parts[1].parse().ok()?;
    let second: i64 = time_parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    // Pad/truncate frac to 3 digits for ms.
    let mut ms_str = String::from(frac);
    ms_str.truncate(3);
    while ms_str.len() < 3 {
        ms_str.push('0');
    }
    let ms: i64 = ms_str.parse().ok()?;

    // Convert (UTC) civil date to days since epoch using the Howard
    // Hinnant algorithm; avoids pulling in a date crate just for this.
    let y = if month <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = (y - era * 400) as i64;
    let m = month as i64;
    let d = day as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let total_secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    if total_secs < 0 {
        return None;
    }
    Some((total_secs as u64) * 1000 + ms as u64)
}

fn record_last_event(
    summary: &mut AgentSessionSummary,
    timestamp: &str,
    event_type: &str,
    category: &str,
) {
    if timestamp.is_empty() || timestamp >= summary.last_event_timestamp.as_str() {
        summary.last_event_timestamp = timestamp.to_string();
        summary.last_event_kind = event_type.to_string();
        summary.last_event_category = category.to_string();
    }
}

fn raw_event_turn_id(value: &serde_json::Value, schema: &ProviderSchema) -> Option<String> {
    string_from_paths(value, &schema.events.turn_id_paths)
}

fn raw_tool_call_id(value: &serde_json::Value, schema: &ProviderSchema) -> Option<String> {
    string_from_paths(value, &schema.events.tool_call_id_paths)
}

fn raw_hook_invocation_id(value: &serde_json::Value, schema: &ProviderSchema) -> Option<String> {
    string_from_paths(value, &schema.events.hook_invocation_id_paths)
}

fn safe_ref_id(prefix: &str, raw: &str) -> String {
    let suffix = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>();
    if suffix.is_empty() {
        String::new()
    } else {
        format!("{}-{}", prefix, suffix)
    }
}

fn sanitize_identifier(raw: &str, fallback: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 64 {
        return fallback.to_string();
    }
    if trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        trimmed.to_string()
    } else {
        fallback.to_string()
    }
}

fn classify_tool(
    raw_name: &str,
    args: Option<&serde_json::Value>,
    mcp_allowlist: &HashSet<String>,
    schema: &ProviderSchema,
) -> (String, String) {
    let lower = raw_name.to_ascii_lowercase();
    for rule in &schema.tool_identity_rules {
        if lower == rule.tool.to_ascii_lowercase() {
            let fallback = sanitize_identifier(&rule.fallback, "tool");
            let identity = args
                .and_then(|arguments| string_from_paths(arguments, &rule.target_paths))
                .map(|value| sanitize_identifier(&value, &fallback))
                .unwrap_or(fallback);
            return (identity, rule.category.clone());
        }
    }
    let category = categorize_tool(raw_name, mcp_allowlist, schema);
    (sanitize_identifier(raw_name, "tool"), category)
}

fn build_safe_tool_details(
    provider: &str,
    raw_name: &str,
    category: &str,
    args: Option<&serde_json::Value>,
    schema: &ProviderSchema,
) -> Vec<SafeDetail> {
    let mut details = vec![
        safe_detail("Type", detail_kind(category)),
        safe_detail("Provider", provider),
        safe_detail("Privacy", "arguments/output hidden"),
    ];
    let lower = raw_name.to_ascii_lowercase();
    if let Some(rule) = schema
        .tool_identity_rules
        .iter()
        .find(|rule| lower == rule.tool.to_ascii_lowercase())
    {
        for detail_rule in &rule.safe_details {
            if let Some(value) = args
                .and_then(|arguments| string_from_paths(arguments, &detail_rule.paths))
                .map(|value| sanitize_identifier(&value, &detail_rule.fallback))
                .filter(|value| !value.is_empty())
            {
                details.push(safe_detail(&detail_rule.label, &value));
            }
        }
    }
    details
}

fn safe_hook_name(value: &serde_json::Value, schema: &ProviderSchema) -> String {
    string_from_paths(value, &schema.events.hook_name_paths)
        .map(|name| sanitize_identifier(&name, "hook"))
        .unwrap_or_else(|| "hook".to_string())
}

fn is_post_tool_use_hook(hook_name: &str) -> bool {
    hook_name.eq_ignore_ascii_case("postToolUse")
}

fn build_safe_hook_details(provider: &str, hook_name: &str) -> Vec<SafeDetail> {
    vec![
        safe_detail("Type", "Hook"),
        safe_detail("Hook type", hook_name),
        safe_detail("Provider", provider),
        safe_detail("Privacy", "input/output hidden"),
    ]
}

fn detail_kind(category: &str) -> &'static str {
    match category {
        "mcp" => "MCP tool",
        "hooks" => "Hook",
        "skills" => "Skill",
        "delegates" => "Sub-agent",
        "terminal" => "Command tool",
        "signal" => "Web/docs tool",
        "edits" => "Edit tool",
        "library" => "Read/search tool",
        "court" => "Control tool",
        _ => "Tool",
    }
}

fn safe_detail(label: &str, value: &str) -> SafeDetail {
    SafeDetail {
        label: label.to_string(),
        value: value.to_string(),
    }
}

fn load_configured_hook_types(schema: &ProviderSchema) -> HashSet<String> {
    if schema.hooks.config_path.is_empty() || schema.hooks.hook_types_path.is_empty() {
        return HashSet::new();
    }
    let Some(home) = home_dir() else {
        return HashSet::new();
    };
    let path = path_from_home(&home, &schema.hooks.config_path);
    let Ok(raw) = fs::read_to_string(&path) else {
        return HashSet::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return HashSet::new();
    };

    configured_hook_types_from_value(&value, schema)
}

fn configured_hook_types_from_value(
    value: &serde_json::Value,
    schema: &ProviderSchema,
) -> HashSet<String> {
    let mut hook_types = HashSet::new();
    let Some(configured_hooks) =
        value_at_path(value, &schema.hooks.hook_types_path).and_then(|value| value.as_object())
    else {
        return hook_types;
    };

    for (hook_type, entries) in configured_hooks {
        if !has_configured_hook_entries(entries) {
            continue;
        }
        let safe_hook_type = sanitize_identifier(hook_type, "");
        if !safe_hook_type.is_empty() {
            hook_types.insert(safe_hook_type.to_ascii_lowercase());
        }
    }

    hook_types
}

fn has_configured_hook_entries(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(entries) => !entries.is_empty(),
        serde_json::Value::Object(entries) => !entries.is_empty(),
        _ => false,
    }
}

fn is_configured_hook_type(hook_name: &str, configured_hook_types: &HashSet<String>) -> bool {
    configured_hook_types.contains(&hook_name.to_ascii_lowercase())
}

/// Load all MCP-registered tool names from `~/.copilot/m-mcp-servers.json`
/// so `categorize_tool` can route them to the MCP quarter even when
/// they have underscore-only names (e.g. Playwright MCP registers
/// `browser_close`, `browser_navigate`, etc. which the heuristic-only
/// path silently falls through to "workshop"). Returns an empty set
/// if the file is missing or malformed — categorization then falls
/// back to the hyphen/`mcp` substring heuristic alone, which is the
/// pre-allowlist behavior.
fn load_mcp_tool_allowlist(schema: &ProviderSchema) -> HashSet<String> {
    let mut allowlist = HashSet::new();
    let Some(home) = home_dir() else {
        return allowlist;
    };
    let path = path_from_home(&home, &schema.mcp.allowlist_path);
    let Ok(raw) = fs::read_to_string(&path) else {
        return allowlist;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return allowlist;
    };
    let Some(servers) = value_at_path(&value, &schema.mcp.servers_path).and_then(|v| v.as_object())
    else {
        return allowlist;
    };
    for (_server, info) in servers {
        let Some(tools) = info.get(&schema.mcp.tools_key).and_then(|v| v.as_array()) else {
            continue;
        };
        for tool in tools {
            if let Some(name) = tool.as_str() {
                allowlist.insert(name.to_ascii_lowercase());
            }
        }
    }
    allowlist
}

fn categorize_tool(
    tool_name: &str,
    mcp_allowlist: &HashSet<String>,
    schema: &ProviderSchema,
) -> String {
    let name = tool_name.to_ascii_lowercase();
    for rule in &schema.tool_category_rules {
        if rule.mcp_allowlist && mcp_allowlist.contains(&name) {
            return rule.category.clone();
        }
        if rule
            .exact
            .iter()
            .any(|candidate| name == candidate.to_ascii_lowercase())
        {
            return rule.category.clone();
        }
        if rule
            .contains
            .iter()
            .any(|candidate| name.contains(&candidate.to_ascii_lowercase()))
        {
            return rule.category.clone();
        }
    }
    schema.fallback_category.clone()
}

fn categorize_event(event_type: &str) -> &'static str {
    match event_type {
        "assistant.turn_start" => "thinking",
        "assistant.turn_end" => "waiting",
        "user.message" => "prompt",
        "session.start" => "arrival",
        _ => "activity",
    }
}

// ── Filesystem watcher ────────────────────────────────────────────────

/// Spawn a background thread that watches each provider's state root
/// and, on any filesystem change, debounces to ~300 ms before invoking
/// `window.__cmcOnAgentActivityChanged()` in the renderer.
///
/// Returns nothing intentionally: the watcher lives for the entire app
/// lifetime and is dropped automatically on shutdown.
pub fn start_watcher(app: AppHandle) {
    let providers = default_providers();
    let (schema, _) = load_copilot_schema();
    let relevant_files = schema.session.relevant_files.clone();
    let mut watch_targets: Vec<(PathBuf, RecursiveMode)> = Vec::new();

    for provider in providers {
        for root in provider.state_roots() {
            // Prefer the narrow state_root; fall back to its parent for
            // creation events if the root doesn't exist yet.
            if root.exists() {
                watch_targets.push((root, RecursiveMode::Recursive));
            } else if let Some(parent) = root.parent() {
                if parent.exists() {
                    watch_targets.push((parent.to_path_buf(), RecursiveMode::NonRecursive));
                    log::info!(
                        "Watching {} non-recursively until {} exists",
                        parent.display(),
                        root.display()
                    );
                } else {
                    log::warn!(
                        "Cannot watch {}: parent does not exist either; relying on poll fallback",
                        root.display()
                    );
                }
            }
        }
    }

    if watch_targets.is_empty() {
        log::info!("No provider state directories to watch; renderer poll fallback will refresh");
        return;
    }

    thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match recommended_watcher(tx) {
            Ok(w) => w,
            Err(err) => {
                log::warn!("Failed to create filesystem watcher: {}", err);
                return;
            }
        };

        for (path, mode) in &watch_targets {
            if let Err(err) = watcher.watch(path, *mode) {
                log::warn!("Failed to watch {}: {}", path.display(), err);
            }
        }

        let pending = Arc::new(AtomicBool::new(false));

        while let Ok(event) = rx.recv() {
            // Filter: only react to files our scan actually reads.
            // Avoids needless rescans on rewind-snapshots, sqlite
            // journals, and other noise inside session dirs.
            let Ok(event) = event else { continue };
            if !event
                .paths
                .iter()
                .any(|p| is_relevant_path(p, &relevant_files))
            {
                continue;
            }

            // Coalesce: only spawn an emit-timer if one isn't already in
            // flight. Any events that arrive while the timer is pending
            // are absorbed and emitted together at the timer's end.
            if pending.swap(true, Ordering::SeqCst) {
                continue;
            }
            let pending_clone = pending.clone();
            let app_clone = app.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(300));
                refresh_agent_activity_cache();
                pending_clone.store(false, Ordering::SeqCst);
                if let Some(win) = app_clone.get_webview_window("main") {
                    let _ = win.eval(
                        "window.__cmcOnAgentActivityChanged && \
                         window.__cmcOnAgentActivityChanged()",
                    );
                }
            });
        }
    });
}

/// Paths whose changes warrant a re-scan. The scan reads
/// `events.jsonl` per session for activity and `workspace.yaml` for
/// session metadata (title, repository, branch). Everything else in a
/// session dir (sqlite journals, rewind snapshots, etc.) is ignored.
fn is_relevant_path(path: &Path, relevant_files: &[String]) -> bool {
    match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => relevant_files.iter().any(|candidate| candidate == name),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn test_schema() -> ProviderSchema {
        parse_provider_schema(BUNDLED_COPILOT_SCHEMA).expect("bundled schema")
    }

    #[test]
    fn bundled_provider_schema_parses_and_validates() {
        let schema = test_schema();
        assert_eq!(schema.provider, "copilot");
        assert_eq!(schema.schema_version, "1.2.2");
        assert!(schema
            .session
            .relevant_files
            .contains(&"events.jsonl".to_string()));
        assert!(schema.workspace.allowed_keys.contains(&"name".to_string()));
        assert!(schema.workspace.allowed_keys.contains(&"cwd".to_string()));
    }

    #[test]
    fn published_provider_schema_matches_bundled_schema() {
        let published = include_str!("../../docs/provider-schemas/copilot/1.2.2.json");
        assert_eq!(published, BUNDLED_COPILOT_SCHEMA);
        assert_eq!(
            sha256_hex(published),
            "b9f7391a340636e03293b5a2f07ff0f28ba4b3ab159e42e770914df406a1a186"
        );
    }

    #[test]
    fn workspace_name_is_preferred_over_generated_summary() {
        let schema = test_schema();
        let mut path = std::env::temp_dir();
        path.push(format!(
            "cmc_workspace_name_test_{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            concat!(
                "repository: DanWahlin/copilot-mission-control\n",
                "branch: main\n",
                "name: Custom Session Name\n",
                "summary: Repo main fallback\n",
            ),
        )
        .expect("write workspace");

        let workspace = parse_workspace(&path, &schema);
        let title =
            session_title_from_workspace(&workspace, "DanWahlin/copilot-mission-control", "main");

        assert_eq!(title, "Custom Session Name");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn workspace_block_scalar_name_becomes_session_title() {
        let schema = test_schema();
        let mut path = std::env::temp_dir();
        path.push(format!(
            "cmc_workspace_block_name_test_{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            concat!(
                "repository: DanWahlin/copilot-mission-control\n",
                "branch: main\n",
                "name: |-\n",
                "  Investigate Retained Session Titles\n",
            ),
        )
        .expect("write workspace");

        let workspace = parse_workspace(&path, &schema);
        let title =
            session_title_from_workspace(&workspace, "DanWahlin/copilot-mission-control", "main");

        assert_eq!(title, "Investigate Retained Session Titles");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn workspace_without_repository_git_root_or_cwd_has_no_session_scope() {
        let workspace = BTreeMap::from([
            ("name".to_string(), "Mission Control Chat".to_string()),
            ("branch".to_string(), "main".to_string()),
        ]);

        assert_eq!(workspace_repository_label(&workspace), None);
    }

    #[test]
    fn workspace_uses_cwd_folder_name_when_repository_and_git_root_are_missing() {
        let workspace = BTreeMap::from([
            (
                "cwd".to_string(),
                "/Users/danwahlin/Desktop/projects/github-copilot-app-for-beginners".to_string(),
            ),
            (
                "name".to_string(),
                "Planning copilot app course".to_string(),
            ),
        ]);

        assert_eq!(
            workspace_repository_label(&workspace),
            Some("github-copilot-app-for-beginners".to_string())
        );
    }

    #[test]
    fn copilot_scan_includes_workspace_with_only_cwd_scope() {
        let mut root = std::env::temp_dir();
        root.push(format!("cmc_scan_cwd_root_test_{}", std::process::id()));
        let session_dir = root.join("be225fae-fca3-42e3-9346-0150cd953a9e");
        std::fs::create_dir_all(&session_dir).expect("create temp session dir");
        std::fs::write(
            session_dir.join("workspace.yaml"),
            concat!(
                "cwd: /Users/danwahlin/Desktop/projects/github-copilot-app-for-beginners\n",
                "name: Planning copilot app course\n",
                "updated_at: 2026-06-21T01:19:36.912Z\n",
            ),
        )
        .expect("write workspace");
        std::fs::write(
            session_dir.join("events.jsonl"),
            concat!(
                "{\"type\":\"session.start\",\"timestamp\":\"2026-06-21T01:19:27Z\"}\n",
                "{\"type\":\"tool.execution_start\",\"timestamp\":\"2026-06-21T01:19:28Z\",\"data\":{\"toolName\":\"list_projects\",\"turnId\":\"turn-1\",\"toolCallId\":\"call-1\"}}\n",
                "{\"type\":\"tool.execution_complete\",\"timestamp\":\"2026-06-21T01:19:29Z\",\"data\":{\"toolName\":\"list_projects\",\"turnId\":\"turn-1\",\"toolCallId\":\"call-1\",\"success\":true}}\n",
            ),
        )
        .expect("write events");

        let scan = scan_copilot_from_discovery(
            false,
            test_schema(),
            Vec::new(),
            false,
            CopilotRootDiscovery {
                roots: vec![CopilotStateRoot {
                    path: root.clone(),
                    label: "test".to_string(),
                }],
                alerts: Vec::new(),
            },
        );
        let _ = std::fs::remove_dir_all(&root);

        let session = scan
            .sessions
            .iter()
            .find(|session| session.repository == "github-copilot-app-for-beginners")
            .expect("cwd-only session should be visible");
        assert_eq!(session.session_name, "Planning copilot app course");
        assert_eq!(session.title, "Planning copilot app course");
        assert_eq!(
            session.git_root,
            "/Users/danwahlin/Desktop/projects/github-copilot-app-for-beginners"
        );
        assert_eq!(session.tool_count, 1);
    }

    #[test]
    fn workspace_marker_marks_mission_control_analytics_session() {
        let workspace = BTreeMap::from([
            (
                "name".to_string(),
                MISSION_CONTROL_ANALYTICS_MARKER.to_string(),
            ),
            (
                "repository".to_string(),
                "DanWahlin/agent-mission-control".to_string(),
            ),
        ]);

        assert!(workspace_marks_mission_control_analytics_session(
            &workspace
        ));
    }

    #[test]
    fn watcher_relevance_is_limited_to_events_and_workspace_files() {
        let relevant = vec!["events.jsonl".to_string(), "workspace.yaml".to_string()];

        assert!(is_relevant_path(
            Path::new("/tmp/session-state/session-a/events.jsonl"),
            &relevant
        ));
        assert!(is_relevant_path(
            Path::new("/tmp/session-state/session-a/workspace.yaml"),
            &relevant
        ));
        assert!(!is_relevant_path(
            Path::new("/tmp/session-state/session-a/session.db"),
            &relevant
        ));
        assert!(!is_relevant_path(
            Path::new("/tmp/session-state/session-a/checkpoints/index.md"),
            &relevant
        ));
    }

    #[test]
    fn schema_index_selects_newest_compatible_version() {
        let entries = vec![
            RemoteSchemaEntry {
                version: "1.0.0".to_string(),
                url: "1.0.0.json".to_string(),
                sha256: "a".to_string(),
            },
            RemoteSchemaEntry {
                version: "1.2.0".to_string(),
                url: "1.2.0.json".to_string(),
                sha256: "b".to_string(),
            },
            RemoteSchemaEntry {
                version: "2.0.0".to_string(),
                url: "2.0.0.json".to_string(),
                sha256: "c".to_string(),
            },
        ];

        let entry = newest_compatible_schema_entry(&entries, "1.0.0").expect("entry");
        assert_eq!(entry.version, "1.2.0");
    }

    #[test]
    fn schema_index_ignores_versions_not_newer_than_bundled() {
        let entries = vec![RemoteSchemaEntry {
            version: "1.0.0".to_string(),
            url: "1.0.0.json".to_string(),
            sha256: "a".to_string(),
        }];

        assert!(newest_compatible_schema_entry(&entries, "1.0.0").is_none());
    }

    #[test]
    fn analytics_session_marker_only_matches_session_identity_events() {
        let system_marker = format!(
            r#"{{"type":"system.message","data":{{"content":"{}"}}}}"#,
            MISSION_CONTROL_ANALYTICS_MARKER
        );
        let client_marker =
            r#"{"type":"session.start","data":{"clientName":"copilot-mission-control-analytics"}}"#;
        let tool_output_marker = format!(
            r#"{{"type":"tool.execution_complete","data":{{"result":"{}"}}}}"#,
            MISSION_CONTROL_ANALYTICS_MARKER
        );
        let assistant_content_marker = format!(
            r#"{{"type":"assistant.message","data":{{"content":"{}"}}}}"#,
            MISSION_CONTROL_ANALYTICS_MARKER
        );
        // Realistic analytics prompt: marker is the first line of the system message.
        let system_marker_prefix = format!(
            r#"{{"type":"system.message","data":{{"content":"{}\nYou are the Agent Mission Control Analytics assistant."}}}}"#,
            MISSION_CONTROL_ANALYTICS_MARKER
        );
        // Regression: a normal coding session whose system prompt merely mentions
        // the marker mid-content (e.g. quoted in an injected memory or custom
        // instruction) must NOT be treated as an analytics chat session.
        let system_marker_mid_content = format!(
            r#"{{"type":"system.message","data":{{"content":"You are the GitHub Copilot CLI. A memory cites const MARKER = {}"}}}}"#,
            MISSION_CONTROL_ANALYTICS_MARKER
        );

        assert!(line_marks_mission_control_analytics_session(&system_marker));
        assert!(line_marks_mission_control_analytics_session(client_marker));
        assert!(line_marks_mission_control_analytics_session(
            &system_marker_prefix
        ));
        assert!(!line_marks_mission_control_analytics_session(
            &system_marker_mid_content
        ));
        assert!(!line_marks_mission_control_analytics_session(
            &tool_output_marker
        ));
        assert!(!line_marks_mission_control_analytics_session(
            &assistant_content_marker
        ));
    }

    #[test]
    fn provider_schema_rejects_unsafe_surfaced_paths() {
        let raw = BUNDLED_COPILOT_SCHEMA.replace(
            r#""target_paths": ["skill"]"#,
            r#""target_paths": ["prompt"]"#,
        );
        let err = match parse_provider_schema(&raw) {
            Ok(_) => panic!("unsafe schema must fail validation"),
            Err(err) => err,
        };
        assert!(err.contains("unsafe surfaced identity path"));
    }

    #[test]
    fn provider_schema_rejects_unsafe_event_paths() {
        let raw = BUNDLED_COPILOT_SCHEMA.replace(
            r#""timestamp_paths": ["timestamp"]"#,
            r#""timestamp_paths": ["data.prompt"]"#,
        );
        let err = match parse_provider_schema(&raw) {
            Ok(_) => panic!("unsafe schema must fail validation"),
            Err(err) => err,
        };
        assert!(err.contains("unsafe timestamp path"));
    }

    #[test]
    fn provider_schema_rejects_unsafe_arguments_paths() {
        let raw = BUNDLED_COPILOT_SCHEMA.replace(
            r#""arguments_paths": ["data.arguments"]"#,
            r#""arguments_paths": ["data.prompt.arguments"]"#,
        );
        let err = match parse_provider_schema(&raw) {
            Ok(_) => panic!("unsafe arguments path must fail validation"),
            Err(err) => err,
        };
        assert!(err.contains("unsafe arguments path"));
    }

    #[test]
    fn configured_hook_types_are_read_from_hook_config_keys_only() {
        let schema = test_schema();
        let config = serde_json::json!({
            "version": 1,
            "hooks": {
                "agentStop": [
                    {
                        "type": "bash",
                        "bash": "SECRET_COMMAND",
                        "timeoutSec": 5
                    }
                ],
                "postToolUse": [],
                "bad hook /Users/dan/private": [
                    {
                        "type": "bash",
                        "bash": "SECRET_PATH"
                    }
                ]
            }
        });

        let configured = configured_hook_types_from_value(&config, &schema);

        assert!(configured.contains("agentstop"));
        assert!(!configured.contains("posttooluse"));
        assert_eq!(configured.len(), 1);
    }

    #[test]
    fn unconfigured_hook_events_are_ignored_for_hook_activity() {
        use std::io::Write;

        let schema = test_schema();
        let mut path = std::env::temp_dir();
        path.push(format!(
            "cmc_unconfigured_hook_events_{}_{}.jsonl",
            std::process::id(),
            unix_ms(SystemTime::now())
        ));
        let mut file = std::fs::File::create(&path).expect("create hook test events");
        writeln!(
            file,
            r#"{{"type":"hook.start","timestamp":"2026-05-21T07:14:00.000Z","data":{{"hookInvocationId":"abc123456789","hookType":"postToolUse","input":{{"cwd":"/Users/dan/private","prompt":"SECRET_PROMPT","toolArgs":{{"command":"SECRET_COMMAND"}}}}}}}}"#
        )
        .expect("write hook start");
        writeln!(
            file,
            r#"{{"type":"hook.end","timestamp":"2026-05-21T07:14:01.250Z","data":{{"hookInvocationId":"abc123456789","hookType":"postToolUse","success":false,"output":"SECRET_OUTPUT","error":{{"message":"SECRET_ERROR"}}}}}}"#
        )
        .expect("write hook end");
        drop(file);

        let mut summary = AgentSessionSummary::default();
        let mut tool_counts = BTreeMap::new();
        let mut recent_events = Vec::new();
        let stats = summarize_events(
            "copilot",
            &path,
            "hook-session-123456789",
            &mut summary,
            &mut tool_counts,
            &mut recent_events,
            &HashSet::new(),
            &HashSet::new(),
            &schema,
            "test",
        );
        let rendered = serde_json::to_string(&summary).expect("serialize summary");

        assert_eq!(stats.recognized_events, 2);
        assert_eq!(summary.hooks_count, 0);
        assert_eq!(summary.tool_count, 0);
        assert_eq!(summary.error_count, 0);
        assert!(summary.last_tool.is_empty());
        assert!(summary.last_event_kind.is_empty());
        assert!(tool_counts.is_empty());
        assert!(summary.recent_tool_calls.is_empty());
        assert!(recent_events.is_empty());
        assert!(!rendered.contains("SECRET"));
        assert!(!rendered.contains("/Users/dan/private"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn configured_hook_events_are_counted_without_exposing_sensitive_payloads() {
        use std::io::Write;

        let schema = test_schema();
        let mut path = std::env::temp_dir();
        path.push(format!(
            "cmc_hook_events_{}_{}.jsonl",
            std::process::id(),
            unix_ms(SystemTime::now())
        ));
        let mut file = std::fs::File::create(&path).expect("create hook test events");
        writeln!(
            file,
            r#"{{"type":"hook.start","timestamp":"2026-05-21T07:14:00.000Z","data":{{"hookInvocationId":"abc123456789","hookType":"postToolUse","input":{{"cwd":"/Users/dan/private","prompt":"SECRET_PROMPT","toolArgs":{{"command":"SECRET_COMMAND"}}}}}}}}"#
        )
        .expect("write hook start");
        writeln!(
            file,
            r#"{{"type":"hook.end","timestamp":"2026-05-21T07:14:01.250Z","data":{{"hookInvocationId":"abc123456789","hookType":"postToolUse","success":false,"output":"SECRET_OUTPUT","error":{{"message":"SECRET_ERROR"}}}}}}"#
        )
        .expect("write hook end");
        drop(file);

        let mut summary = AgentSessionSummary::default();
        let mut tool_counts = BTreeMap::new();
        let mut recent_events = Vec::new();
        let configured_hook_types = HashSet::from(["posttooluse".to_string()]);
        let stats = summarize_events(
            "copilot",
            &path,
            "hook-session-123456789",
            &mut summary,
            &mut tool_counts,
            &mut recent_events,
            &HashSet::new(),
            &configured_hook_types,
            &schema,
            "test",
        );
        let rendered = serde_json::to_string(&summary).expect("serialize summary");

        assert_eq!(stats.recognized_events, 2);
        assert_eq!(summary.hooks_count, 1);
        assert_eq!(summary.tool_count, 0);
        assert_eq!(summary.error_count, 1);
        assert_eq!(summary.last_tool, "postToolUse");
        assert!(tool_counts.is_empty());
        assert_eq!(summary.recent_tool_calls.len(), 1);
        let hook = &summary.recent_tool_calls[0];
        assert_eq!(hook.category, "hooks");
        assert_eq!(hook.tool, "postToolUse");
        assert!(!hook.success);
        assert_eq!(hook.duration_ms, Some(1250));
        assert!(recent_events
            .iter()
            .any(|event| event.kind == "hook.start" && event.category == "hooks"));
        assert!(recent_events
            .iter()
            .any(|event| event.kind == "hook.end" && event.category == "alert" && !event.success));
        assert!(!rendered.contains("SECRET"));
        assert!(!rendered.contains("/Users/dan/private"));

        let raw = raw_tool_call_details_from_events_path(&path, &schema, &hook.event_ref)
            .expect("raw hook details");
        assert!(raw.raw_args.unwrap().contains("SECRET_PROMPT"));
        assert_eq!(raw.raw_output.as_deref(), Some("SECRET_OUTPUT"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn schema_url_resolution_rejects_encoded_or_external_paths() {
        let index_url =
            "https://danwahlin.github.io/agent-mission-control/provider-schemas/copilot/index.json";

        assert!(resolve_schema_url(index_url, "1.0.1.json").is_ok());
        assert!(resolve_schema_url(index_url, "nested/1.0.1.json").is_ok());
        assert!(resolve_schema_url(index_url, "../1.0.1.json").is_err());
        assert!(resolve_schema_url(index_url, "%2e%2e/1.0.1.json").is_err());
        assert!(resolve_schema_url(index_url, "https://example.com/1.0.1.json").is_err());
    }

    #[test]
    fn cached_schema_requires_matching_checksum_sidecar() {
        use std::io::Write;
        let mut path = std::env::temp_dir();
        path.push("cmc_cached_schema_test.json");
        let checksum_path = path.with_extension("sha256");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&checksum_path);

        let raw = BUNDLED_COPILOT_SCHEMA;
        std::fs::File::create(&path)
            .and_then(|mut file| file.write_all(raw.as_bytes()))
            .expect("write cached schema");

        assert!(!cached_schema_checksum_valid(&path, raw));
        std::fs::write(&checksum_path, sha256_hex(raw)).expect("write checksum");
        assert!(cached_schema_checksum_valid(&path, raw));
        std::fs::write(&checksum_path, "bad").expect("write bad checksum");
        assert!(!cached_schema_checksum_valid(&path, raw));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&checksum_path);
    }

    #[test]
    fn unavailable_merge_alert_reports_activity_source_not_cli_path() {
        let activity = merge_scans(vec![ProviderScan::unavailable("test")], false);

        assert!(activity
            .alerts
            .iter()
            .any(|alert| alert == "No supported agent activity sources are currently available."));
        assert!(!activity
            .alerts
            .iter()
            .any(|alert| alert.contains("CLI executables")));
        assert_eq!(activity.history.failure_count, 0);
        assert!(activity
            .history
            .activity_24h
            .iter()
            .all(|b| b.event_count == 0));
        assert!(activity.history.recent_failures.is_empty());
    }

    #[test]
    fn post_tool_use_hook_inherits_completed_tool_turn() {
        use std::io::Write;

        let schema = test_schema();
        let mut path = std::env::temp_dir();
        path.push(format!(
            "cmc_hook_turn_attribution_{}_{}.jsonl",
            std::process::id(),
            unix_ms(SystemTime::now())
        ));
        let mut file = std::fs::File::create(&path).expect("create hook turn test events");
        writeln!(
            file,
            r#"{{"type":"assistant.turn_start","timestamp":"2026-05-21T07:13:58.000Z","data":{{"turnId":"turn-alpha","model":"gpt-5.5"}}}}"#
        )
        .expect("write turn start");
        writeln!(
            file,
            r#"{{"type":"tool.execution_start","timestamp":"2026-05-21T07:14:00.000Z","data":{{"toolName":"bash","toolCallId":"call-bash","turnId":"turn-alpha","arguments":{{"command":"SECRET_COMMAND"}}}}}}"#
        )
        .expect("write tool start");
        writeln!(
            file,
            r#"{{"type":"tool.execution_complete","timestamp":"2026-05-21T07:14:01.000Z","data":{{"toolCallId":"call-bash","success":true,"output":"SECRET_OUTPUT"}}}}"#
        )
        .expect("write tool complete");
        writeln!(
            file,
            r#"{{"type":"hook.start","timestamp":"2026-05-21T07:14:01.100Z","data":{{"hookInvocationId":"hook-post-tool","hookType":"postToolUse","input":{{"cwd":"/Users/dan/private","toolName":"bash","toolArgs":"SECRET_COMMAND"}}}}}}"#
        )
        .expect("write hook start");
        writeln!(
            file,
            r#"{{"type":"hook.end","timestamp":"2026-05-21T07:14:01.300Z","data":{{"hookInvocationId":"hook-post-tool","hookType":"postToolUse","success":true,"output":"SECRET_HOOK_OUTPUT"}}}}"#
        )
        .expect("write hook end");
        drop(file);

        let mut summary = AgentSessionSummary::default();
        let mut tool_counts = BTreeMap::new();
        let mut recent_events = Vec::new();
        let configured_hook_types = HashSet::from(["posttooluse".to_string()]);
        summarize_events(
            "copilot",
            &path,
            "hook-session-123456789",
            &mut summary,
            &mut tool_counts,
            &mut recent_events,
            &HashSet::new(),
            &configured_hook_types,
            &schema,
            "test",
        );

        let tool = summary
            .recent_tool_calls
            .iter()
            .find(|call| call.tool == "bash")
            .expect("tool call");
        let hook = summary
            .recent_tool_calls
            .iter()
            .find(|call| call.tool == "postToolUse")
            .expect("hook call");

        assert!(!tool.turn_id.is_empty());
        assert_eq!(hook.turn_id, tool.turn_id);
        assert_eq!(hook.duration_ms, Some(200));
        let rendered = serde_json::to_string(&summary).expect("serialize summary");
        assert!(!rendered.contains("SECRET"));
        assert!(!rendered.contains("/Users/dan/private"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn history_hourly_buckets_count_sanitized_failures() {
        let generated_at_ms = parse_iso_ms("2026-05-28T12:34:00Z").expect("valid fixture time");
        let events = vec![
            history_event(
                "alpha123",
                "2026-05-28T11:15:00Z",
                "tool.execution_start",
                "bash",
                "terminal",
                true,
            ),
            history_event(
                "alpha123",
                "2026-05-28T12:05:00Z",
                "tool.execution_complete",
                "bash",
                "terminal",
                false,
            ),
            history_event(
                "alpha123",
                "2026-05-28T12:10:00Z",
                "assistant.message",
                "",
                "complete",
                true,
            ),
            history_event(
                "beta4567",
                "2026-05-28T12:20:00Z",
                "hook.end",
                "postToolUse",
                "alert",
                false,
            ),
            history_event(
                "alpha123",
                "not-a-date",
                "tool.execution_complete",
                "view",
                "library",
                false,
            ),
        ];

        let history = build_history_summary(
            &[history_session("alpha123")],
            &events,
            &[],
            generated_at_ms,
        );
        let current_hour = history.activity_24h.last().expect("current hour bucket");

        assert_eq!(history.activity_24h.len(), HISTORY_HOUR_BUCKETS);
        assert_eq!(
            history
                .activity_24h
                .first()
                .expect("first hour bucket")
                .start,
            "2026-05-27T13:00:00Z"
        );
        assert_eq!(current_hour.start, "2026-05-28T12:00:00Z");
        assert_eq!(current_hour.event_count, 3);
        assert_eq!(current_hour.failure_count, 2);
        assert_eq!(current_hour.active_sessions, 2);
        assert_eq!(history.failure_count, 2);
        assert_eq!(history.recent_failures.len(), 2);
        assert_eq!(history.recent_failures[0].kind, "hook.end");
        assert_eq!(history.recent_failures[0].tool, "postToolUse");
        assert_eq!(history.recent_failures[1].kind, "tool.execution_complete");
        assert_eq!(history.recent_failures[1].tool, "bash");
    }

    #[test]
    fn activity_signal_counts_launch_windows() {
        let generated_at_ms = parse_iso_ms("2026-05-28T12:00:00Z").expect("valid fixture time");
        let events = vec![
            history_event(
                "alpha123",
                "2026-05-28T11:56:00Z",
                "tool.execution_start",
                "task",
                "delegates",
                true,
            ),
            history_event(
                "alpha123",
                "2026-05-28T11:30:00Z",
                "tool.execution_start",
                "task",
                "delegates",
                true,
            ),
            history_event(
                "alpha123",
                "2026-05-28T11:57:00Z",
                "tool.execution_complete",
                "bash",
                "terminal",
                true,
            ),
            history_event(
                "beta4567",
                "2026-05-28T10:59:00Z",
                "tool.execution_start",
                "rg",
                "library",
                true,
            ),
        ];

        let signal = build_activity_signal(&events, &[], generated_at_ms);

        assert_eq!(signal.launches_last_5m, 1);
        assert_eq!(signal.launches_last_hour, 2);
        assert_eq!(signal.velocity_per_hour, 2.0);
        assert_eq!(signal.peak_velocity_per_hour, 2);
    }

    #[test]
    fn activity_signal_builds_24h_intensity() {
        let generated_at_ms = parse_iso_ms("2026-05-28T12:34:00Z").expect("valid fixture time");
        let events = vec![
            history_event(
                "alpha123",
                "2026-05-28T10:05:00Z",
                "tool.execution_start",
                "task",
                "delegates",
                true,
            ),
            history_event(
                "alpha123",
                "2026-05-28T11:05:00Z",
                "tool.execution_start",
                "task",
                "delegates",
                true,
            ),
            history_event(
                "beta4567",
                "2026-05-28T11:15:00Z",
                "tool.execution_start",
                "task",
                "delegates",
                true,
            ),
            history_event(
                "beta4567",
                "2026-05-28T11:25:00Z",
                "tool.execution_complete",
                "bash",
                "alert",
                false,
            ),
        ];

        let signal = build_activity_signal(&events, &[], generated_at_ms);
        let ten_hour = signal
            .hourly_24h
            .iter()
            .find(|bucket| bucket.start == "2026-05-28T10:00:00Z")
            .expect("10am bucket");
        let eleven_hour = signal
            .hourly_24h
            .iter()
            .find(|bucket| bucket.start == "2026-05-28T11:00:00Z")
            .expect("11am bucket");

        assert_eq!(signal.hourly_24h.len(), HISTORY_HOUR_BUCKETS);
        assert_eq!(signal.peak_hour_event_count_24h, 3);
        assert_eq!(signal.peak_velocity_per_hour, 2);
        assert_eq!(signal.active_hours_24h, 2);
        assert_eq!(signal.busiest_hour_label_24h, "11:00Z");
        assert_eq!(ten_hour.event_count, 1);
        assert_eq!(ten_hour.launch_count, 1);
        assert_eq!(ten_hour.intensity, 0.5);
        assert_eq!(eleven_hour.event_count, 3);
        assert_eq!(eleven_hour.launch_count, 2);
        assert_eq!(eleven_hour.failure_count, 1);
        assert_eq!(eleven_hour.active_sessions, 2);
        assert_eq!(eleven_hour.intensity, 1.0);
    }

    #[test]
    fn activity_signal_ignores_non_launch_events_for_velocity() {
        let generated_at_ms = parse_iso_ms("2026-05-28T12:00:00Z").expect("valid fixture time");
        let events = vec![
            history_event(
                "alpha123",
                "2026-05-28T11:55:00Z",
                "assistant.turn_start",
                "thinking",
                "thinking",
                true,
            ),
            history_event(
                "alpha123",
                "2026-05-28T11:56:00Z",
                "tool.execution_complete",
                "bash",
                "alert",
                false,
            ),
            history_event(
                "alpha123",
                "2026-05-28T11:57:00Z",
                "assistant.message",
                "",
                "complete",
                true,
            ),
        ];

        let signal = build_activity_signal(&events, &[], generated_at_ms);
        let previous_hour = signal
            .hourly_24h
            .iter()
            .find(|bucket| bucket.start == "2026-05-28T11:00:00Z")
            .expect("previous hour bucket");

        assert_eq!(signal.launches_last_5m, 0);
        assert_eq!(signal.launches_last_hour, 0);
        assert_eq!(signal.velocity_per_hour, 0.0);
        assert_eq!(previous_hour.event_count, 3);
        assert_eq!(previous_hour.launch_count, 0);
        assert_eq!(previous_hour.failure_count, 1);
    }

    #[test]
    fn activity_signal_handles_unparseable_timestamps() {
        let generated_at_ms = parse_iso_ms("2026-05-28T12:00:00Z").expect("valid fixture time");
        let events = vec![history_event(
            "alpha123",
            "not-a-date",
            "tool.execution_start",
            "bash",
            "terminal",
            true,
        )];

        let signal = build_activity_signal(&events, &[], generated_at_ms);

        assert_eq!(signal.hourly_24h.len(), HISTORY_HOUR_BUCKETS);
        assert_eq!(signal.launches_last_5m, 0);
        assert_eq!(signal.launches_last_hour, 0);
        assert_eq!(signal.peak_hour_event_count_24h, 0);
        assert_eq!(signal.peak_velocity_per_hour, 0);
        assert_eq!(signal.active_hours_24h, 0);
        assert_eq!(signal.busiest_hour_label_24h, "No activity");
        assert!(signal
            .hourly_24h
            .iter()
            .all(|bucket| bucket.intensity == 0.0));
    }

    #[test]
    fn session_activity_signal_counts_full_24h_file() {
        use std::io::Write;

        let schema = test_schema();
        let mut path = std::env::temp_dir();
        path.push(format!(
            "cmc_session_activity_signal_{}_{}.jsonl",
            std::process::id(),
            unix_ms(SystemTime::now())
        ));
        let mut file = std::fs::File::create(&path).expect("create activity signal test file");
        writeln!(
            file,
            r#"{{"type":"tool.execution_start","timestamp":"2026-05-28T10:05:00.000Z","data":{{"toolName":"view","toolCallId":"call-view"}}}}"#
        )
        .expect("write tool start");
        writeln!(
            file,
            r#"{{"type":"assistant.turn_start","timestamp":"2026-05-28T10:06:00.000Z","data":{{"turnId":"turn-one"}}}}"#
        )
        .expect("write turn start");
        writeln!(
            file,
            r#"{{"type":"tool.execution_complete","timestamp":"2026-05-28T10:07:00.000Z","data":{{"toolCallId":"call-view","success":false}}}}"#
        )
        .expect("write failed complete");
        writeln!(
            file,
            r#"{{"type":"tool.execution_start","timestamp":"2026-05-28T12:01:00.000Z","data":{{"toolName":"bash","toolCallId":"call-bash"}}}}"#
        )
        .expect("write current tool start");
        drop(file);

        let generated_at_ms = parse_iso_ms("2026-05-28T12:34:00Z").expect("valid fixture time");
        let signal = build_session_activity_signal_from_path(&path, &schema, generated_at_ms);
        let ten_hour = signal
            .hourly_24h
            .iter()
            .find(|bucket| bucket.start == "2026-05-28T10:00:00Z")
            .expect("10am bucket");
        let current_hour = signal.hourly_24h.last().expect("current bucket");

        assert_eq!(ten_hour.event_count, 2);
        assert_eq!(ten_hour.launch_count, 1);
        assert_eq!(ten_hour.turn_count, 1);
        assert_eq!(ten_hour.failure_count, 1);
        assert_eq!(current_hour.launch_count, 1);
        assert_eq!(signal.active_hours_24h, 2);
        assert_eq!(signal.launches_last_hour, 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn history_daily_buckets_aggregate_observed_events_by_local_day() {
        let timezone = FixedOffset::west_opt(7 * 60 * 60).expect("PDT offset");
        let generated_at_ms = parse_iso_ms("2026-05-29T05:53:00Z").expect("valid fixture time");
        let events = vec![
            history_event(
                "alpha123",
                "2026-05-26T23:59:00Z",
                "tool.execution_start",
                "view",
                "library",
                true,
            ),
            history_event(
                "beta4567",
                "2026-05-29T05:30:00Z",
                "tool.execution_complete",
                "bash",
                "terminal",
                false,
            ),
        ];

        let buckets =
            build_daily_history_buckets(&events, generated_at_ms, HISTORY_DAY_BUCKETS, &timezone);
        let may_26 = buckets
            .iter()
            .find(|bucket| bucket.label == "05-26")
            .expect("May 26 bucket");
        let may_28 = buckets.last().expect("current local day bucket");

        assert_eq!(buckets.len(), HISTORY_DAY_BUCKETS);
        assert_eq!(may_26.event_count, 1);
        assert_eq!(may_26.failure_count, 0);
        assert_eq!(may_28.label, "05-28");
        assert_eq!(may_28.start, "2026-05-28T07:00:00Z");
        assert_eq!(may_28.event_count, 1);
        assert_eq!(may_28.failure_count, 1);
    }

    #[test]
    fn history_totals_use_session_summaries_not_capped_recent_events() {
        let generated_at_ms = parse_iso_ms("2026-05-28T12:34:00Z").expect("valid fixture time");
        let mut alpha = history_session("alpha123");
        alpha.event_count = 455;
        alpha.tool_count = 114;
        let mut beta = history_session("beta4567");
        beta.event_count = 80;
        beta.tool_count = 10;

        let history = build_history_summary(&[alpha, beta], &[], &[], generated_at_ms);
        let alpha_scope = history
            .session_scopes
            .iter()
            .find(|scope| scope.session_id == "alpha123")
            .expect("alpha scope");

        assert_eq!(history.event_count, 535);
        assert_eq!(history.tool_count, 124);
        assert_eq!(alpha_scope.summary.event_count, 455);
        assert_eq!(alpha_scope.summary.tool_count, 114);
    }

    #[test]
    fn history_model_mix_uses_turn_models_before_session_fallback_and_unknown() {
        let mut turn_session = history_session("alpha123");
        turn_session.last_model = "fallback-model".to_string();
        turn_session.recent_turns = vec![SessionTurnSummary {
            id: "turn-1".to_string(),
            started_at: "2026-05-28T12:00:00Z".to_string(),
            ended_at: "2026-05-28T12:01:00Z".to_string(),
            status: "complete".to_string(),
            tool_count: 1,
            tools: vec!["bash".to_string()],
            failure_count: 0,
            categories: vec!["terminal".to_string()],
            model: "gpt-5.5".to_string(),
            output_tokens: 100,
            partial: false,
            duration_ms: None,
        }];
        let mut fallback_session = history_session("beta4567");
        fallback_session.last_model = "gpt-5.4".to_string();
        let unknown_session = history_session("gamma890");

        let metrics = build_model_mix(&[turn_session, fallback_session, unknown_session]);

        assert_eq!(metric_count(&metrics, "gpt-5.5"), 1);
        assert_eq!(metric_count(&metrics, "gpt-5.4"), 1);
        assert_eq!(metric_count(&metrics, "Unknown"), 1);
        assert_eq!(metric_count(&metrics, "fallback-model"), 0);
    }

    #[test]
    fn history_category_mix_falls_back_to_session_counters_without_events() {
        let mut session = history_session("alpha123");
        session.write_count = 2;
        session.read_count = 3;
        session.command_count = 4;
        session.error_count = 1;

        let metrics = build_category_mix(&[session], &[]);

        assert_eq!(metric_count(&metrics, "terminal"), 4);
        assert_eq!(metric_count(&metrics, "library"), 3);
        assert_eq!(metric_count(&metrics, "edits"), 2);
        assert_eq!(metric_count(&metrics, "alert"), 1);
    }

    fn history_event(
        session_id: &str,
        timestamp: &str,
        kind: &str,
        tool: &str,
        category: &str,
        success: bool,
    ) -> AgentEventSummary {
        AgentEventSummary {
            provider: "test".to_string(),
            session_id: session_id.to_string(),
            timestamp: timestamp.to_string(),
            kind: kind.to_string(),
            tool: tool.to_string(),
            category: category.to_string(),
            success,
            input_tokens: None,
            output_tokens: None,
        }
    }

    fn history_session(id: &str) -> AgentSessionSummary {
        AgentSessionSummary {
            provider: "test".to_string(),
            id: id.to_string(),
            title: format!("Session {id}"),
            repository: "copilot-mission-control".to_string(),
            branch: "main".to_string(),
            updated_at: "2026-05-28T12:00:00Z".to_string(),
            status: "working".to_string(),
            last_tool: "bash".to_string(),
            last_event_timestamp: "2026-05-28T12:00:00Z".to_string(),
            ..Default::default()
        }
    }

    fn metric_count(metrics: &[AgentHistoryMetric], name: &str) -> usize {
        metrics
            .iter()
            .find(|metric| metric.name == name)
            .map(|metric| metric.count)
            .unwrap_or(0)
    }

    /// Build a synthetic `ProviderScan` containing only the supplied
    /// tool counts. Other fields are zeroed out — these tests only
    /// exercise the tool truncation path.
    fn scan_with_tools(entries: &[(&str, &str, usize)]) -> ProviderScan {
        let mut tool_counts: BTreeMap<(String, String), usize> = BTreeMap::new();
        for (name, category, count) in entries {
            tool_counts.insert(((*name).to_string(), (*category).to_string()), *count);
        }
        ProviderScan {
            provider: "test",
            available: true,
            sessions: Vec::new(),
            tool_counts,
            recent_events: Vec::new(),
            alerts: Vec::new(),
            schema_drift: Vec::new(),
            total_events: 0,
            total_tool_calls: 0,
            total_output_tokens: 0,
            total_input_tokens: 0,
            total_turns: 0,
            active_sessions: 0,
            scanned_sessions: 0,
        }
    }

    #[test]
    fn merge_only_builds_history_when_requested() {
        let mut session = history_session("abc12345");
        session.event_count = 1;
        session.tool_count = 1;
        let mut scan = scan_with_tools(&[("bash", "terminal", 1)]);
        scan.sessions.push(session);
        scan.recent_events.push(history_event(
            "abc12345",
            "2026-05-28T12:00:00Z",
            "tool.execution_complete",
            "bash",
            "terminal",
            true,
        ));
        scan.total_events = 1;
        scan.total_tool_calls = 1;

        let lightweight = merge_scans(vec![scan], false);
        assert_eq!(lightweight.history.generated_at_ms, 0);
        assert_eq!(lightweight.history.event_count, 0);
        assert_eq!(lightweight.recent_events.len(), 1);

        let mut scan = scan_with_tools(&[("bash", "terminal", 1)]);
        let mut session = history_session("abc12345");
        session.event_count = 1;
        session.tool_count = 1;
        scan.sessions.push(session);
        scan.recent_events.push(history_event(
            "abc12345",
            "2026-05-28T12:00:00Z",
            "tool.execution_complete",
            "bash",
            "terminal",
            true,
        ));
        scan.total_events = 1;
        scan.total_tool_calls = 1;

        let with_history = merge_scans(vec![scan], true);
        assert!(with_history.history.generated_at_ms > 0);
        assert_eq!(with_history.history.event_count, 1);
        assert_eq!(with_history.recent_events.len(), 1);
    }

    /// Regression: chatty categories (bash/edit/view) used to take all
    /// MAX_TOOLS slots, dropping low-count MCP/web/agents entries from
    /// the renderer's `tools` array entirely. The two-pass truncation
    /// in `merge_scans` must keep at least one entry per active
    /// category when slots allow.
    #[test]
    fn long_tail_categories_survive_chatty_domination() {
        let scan = scan_with_tools(&[
            // Chatty: terminal + library with many high-count entries
            ("bash", "terminal", 50),
            ("zsh", "terminal", 40),
            ("fish", "terminal", 30),
            ("sh", "terminal", 20),
            ("posh", "terminal", 15),
            ("dash", "terminal", 10),
            ("view", "library", 45),
            ("grep", "library", 35),
            ("rg", "library", 25),
            ("fd", "library", 20),
            ("find", "library", 15),
            ("ls", "library", 12),
            // Long-tail: a single low-count MCP tool that the OLD merger
            // would have dropped.
            ("mcp-deepwiki-ask", "mcp", 1),
            ("github-mcp-server-list", "mcp", 2),
        ]);

        let activity = merge_scans(vec![scan], false);
        let mcp_tools: Vec<&AgentToolMetric> = activity
            .tools
            .iter()
            .filter(|t| t.category == "mcp")
            .collect();
        assert!(
            !mcp_tools.is_empty(),
            "MCP tools must survive truncation even when terminal/library dominate; \
             got tools = {:?}",
            activity
                .tools
                .iter()
                .map(|t| (&t.name, &t.category, t.count))
                .collect::<Vec<_>>()
        );
    }

    /// Within each category the per-category cap must not exceed
    /// MAX_TOOLS_PER_CATEGORY *when other categories are competing for
    /// slots*. (When only one category exists, the pass-2 top-up
    /// intentionally fills slack with leftovers regardless of category
    /// — that's not starvation, it's just no long tail to protect.)
    #[test]
    fn per_category_cap_is_enforced_under_contention() {
        let mut entries: Vec<(&str, &str, usize)> = (0..20)
            .map(|i| {
                let name: &'static str = Box::leak(format!("bash-{}", i).into_boxed_str());
                (name, "terminal", 100 - i)
            })
            .collect();
        // Add competing categories so the top-up has somewhere to go
        // besides terminal. Without these, pass 2 fills slack with
        // leftover terminal tools (which is correct — there's no long
        // tail to protect).
        entries.push(("view", "library", 5));
        entries.push(("rg", "library", 4));
        entries.push(("github-mcp-list", "mcp", 1));
        entries.push(("github-mcp-search", "mcp", 1));
        entries.push(("web-fetch", "signal", 2));

        let scan = scan_with_tools(&entries);
        let activity = merge_scans(vec![scan], false);
        let terminal_count = activity
            .tools
            .iter()
            .filter(|t| t.category == "terminal")
            .count();
        assert!(
            terminal_count <= MAX_TOOLS_PER_CATEGORY,
            "terminal got {} entries under contention, expected <= {}",
            terminal_count,
            MAX_TOOLS_PER_CATEGORY
        );
    }

    /// When slack exists after the per-category pass, the merger should
    /// top up the survivor list with the highest-count leftovers up to
    /// MAX_TOOLS so the global payload isn't unnecessarily small.
    #[test]
    fn second_pass_tops_up_to_max_tools() {
        // 6 terminal tools — only 5 pass the per-category cap. The 6th
        // would normally be dropped, but with no other categories to
        // fill MAX_TOOLS, the leftover top-up should rescue it.
        let scan = scan_with_tools(&[
            ("a", "terminal", 60),
            ("b", "terminal", 50),
            ("c", "terminal", 40),
            ("d", "terminal", 30),
            ("e", "terminal", 20),
            ("f", "terminal", 10),
            ("g", "terminal", 5),
        ]);
        let activity = merge_scans(vec![scan], false);
        // The category cap floor is `1 * 5 = 5`, so MAX_TOOLS (10) wins
        // → survivors should saturate at 7 (all the tools we provided).
        assert_eq!(activity.tools.len(), 7);
    }

    /// Sort order must remain by count desc after truncation so the
    /// renderer's "top tool" call-out is always the most-used entry.
    #[test]
    fn truncation_preserves_count_desc_order() {
        let scan = scan_with_tools(&[
            ("rare", "mcp", 1),
            ("common", "terminal", 100),
            ("medium", "library", 50),
        ]);
        let activity = merge_scans(vec![scan], false);
        let counts: Vec<usize> = activity.tools.iter().map(|t| t.count).collect();
        let mut sorted = counts.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(counts, sorted, "tools must remain sorted by count desc");
    }

    /// Tools registered by an MCP server but with underscore-only
    /// names (Playwright's `browser_close`, `browser_navigate`,
    /// presentation server's `add_slide_from_code`, etc.) used to fall
    /// through the hyphen/`mcp` heuristic and land in the fallback
    /// — invisible in every quarter. The allowlist must override
    /// that and route them to "mcp".
    #[test]
    fn mcp_allowlist_routes_underscore_only_tools() {
        let schema = test_schema();
        let mut allowlist = HashSet::new();
        allowlist.insert("browser_close".to_string());
        allowlist.insert("browser_navigate".to_string());
        allowlist.insert("add_slide_from_code".to_string());

        assert_eq!(categorize_tool("browser_close", &allowlist, &schema), "mcp");
        assert_eq!(
            categorize_tool("browser_navigate", &allowlist, &schema),
            "mcp"
        );
        assert_eq!(
            categorize_tool("add_slide_from_code", &allowlist, &schema),
            "mcp"
        );
        // Case-insensitive match.
        assert_eq!(categorize_tool("Browser_Close", &allowlist, &schema), "mcp");
    }

    /// Tools NOT in the allowlist and without hyphen/`mcp` markers
    /// should still hit the original heuristic path (native Copilot
    /// tools land in their proper quarters).
    #[test]
    fn empty_allowlist_falls_back_to_heuristics() {
        let schema = test_schema();
        let allowlist = HashSet::new();
        // Native Copilot tools — should hit the verb-based branches,
        // not "mcp".
        assert_eq!(categorize_tool("bash", &allowlist, &schema), "terminal");
        assert_eq!(categorize_tool("view", &allowlist, &schema), "library");
        assert_eq!(categorize_tool("edit", &allowlist, &schema), "edits");
        // Hyphenated tool still routes to mcp via the heuristic.
        assert_eq!(
            categorize_tool("github-mcp-server-list", &allowlist, &schema),
            "mcp"
        );
    }

    /// Wrapper tools whose name combines a verb prefix with the
    /// wrapped subsystem's name (read_bash, write_agent, web_search,
    /// ...) must route to the quarter that matches the work the tool
    /// actually performs, not the quarter implied by the verb prefix.
    /// Before the pattern reorder these all landed in edits/library
    /// purely because "read"/"write"/"search" was checked before
    /// "bash"/"agent"/"web".
    #[test]
    fn composite_names_beat_verb_prefixes() {
        let schema = test_schema();
        let allowlist = HashSet::new();
        // *_bash / *_shell / *_sql / *_test should all land in terminal,
        // not in edits (write) or library (read) just because of the
        // prefix verb.
        assert_eq!(
            categorize_tool("read_bash", &allowlist, &schema),
            "terminal"
        );
        assert_eq!(
            categorize_tool("write_bash", &allowlist, &schema),
            "terminal"
        );
        assert_eq!(
            categorize_tool("stop_bash", &allowlist, &schema),
            "terminal"
        );
        assert_eq!(
            categorize_tool("list_bash", &allowlist, &schema),
            "terminal"
        );
        // *_agent should land in delegates (Guild Hall) since the
        // tool drives a sub-agent, not in library/edits.
        assert_eq!(
            categorize_tool("read_agent", &allowlist, &schema),
            "delegates"
        );
        assert_eq!(
            categorize_tool("write_agent", &allowlist, &schema),
            "delegates"
        );
        assert_eq!(
            categorize_tool("list_agents", &allowlist, &schema),
            "delegates"
        );
        assert_eq!(
            categorize_tool("stop_agent", &allowlist, &schema),
            "delegates"
        );
        // web_search is a web tool — Signal Tower, not Library.
        assert_eq!(categorize_tool("web_search", &allowlist, &schema), "signal");
        assert_eq!(categorize_tool("web_fetch", &allowlist, &schema), "signal");
    }

    /// Built-in meta/control tools (vote_memory, store_memory,
    /// exit_plan_mode, manage_schedule, ...) previously fell through
    /// every heuristic branch and landed in the "workshop" fallback,
    /// which had no quarter — so the tool call appeared in the
    /// Activity Feed but no building's count incremented and no pulse
    /// flew to any quarter. They must route to a quarter that exists.
    #[test]
    fn meta_control_tools_land_in_a_real_quarter() {
        let schema = test_schema();
        let allowlist = HashSet::new();
        // Memory tools = persisted knowledge = Tome Hall (skills).
        assert_eq!(
            categorize_tool("store_memory", &allowlist, &schema),
            "skills"
        );
        assert_eq!(
            categorize_tool("vote_memory", &allowlist, &schema),
            "skills"
        );
        // Plan/schedule/intent = Royal Court (dev-facing control).
        assert_eq!(
            categorize_tool("exit_plan_mode", &allowlist, &schema),
            "court"
        );
        assert_eq!(
            categorize_tool("manage_schedule", &allowlist, &schema),
            "court"
        );
        assert_eq!(categorize_tool("ask_user", &allowlist, &schema), "court");
        assert_eq!(
            categorize_tool("report_intent", &allowlist, &schema),
            "court"
        );
    }

    #[test]
    fn skill_and_subagent_identifiers_are_sanitized() {
        let schema = test_schema();
        let allowlist = HashSet::new();
        let args = serde_json::json!({
            "skill": "secret prompt /Users/dan/.env",
            "agent_type": "code-reviewer",
            "name": "schema-review",
            "mode": "background",
            "prompt": "do not expose me"
        });

        assert_eq!(
            classify_tool("skill", Some(&args), &allowlist, &schema),
            ("skill".to_string(), "skills".to_string())
        );
        assert_eq!(
            classify_tool("task", Some(&args), &allowlist, &schema),
            ("code-reviewer".to_string(), "delegates".to_string())
        );
        let details = build_safe_tool_details("test", "task", "delegates", Some(&args), &schema);
        assert!(details
            .iter()
            .any(|detail| detail.label == "Agent type" && detail.value == "code-reviewer"));
        assert!(details
            .iter()
            .any(|detail| detail.label == "Agent name" && detail.value == "schema-review"));
        assert!(details
            .iter()
            .any(|detail| detail.label == "Mode" && detail.value == "background"));
    }

    #[test]
    fn summarize_events_builds_safe_tool_details_and_turns() {
        use std::io::Write;
        let mut path = std::env::temp_dir();
        path.push("cmc_test_safe_details_turns.jsonl");
        let _ = std::fs::remove_file(&path);
        {
            let mut f = std::fs::File::create(&path).expect("create temp jsonl");
            writeln!(
                f,
                r#"{{"type":"assistant.turn_start","timestamp":"2026-01-01T00:00:00.000Z","data":{{"turnId":"turn-alpha","model":"gpt-5.5"}}}}"#
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"type":"tool.execution_start","timestamp":"2026-01-01T00:00:01.000Z","data":{{"toolName":"skill","toolCallId":"call-skill","turnId":"turn-alpha","model":"gpt-5.5","arguments":{{"skill":"blog-writer","prompt":"SECRET_PROMPT"}}}}}}"#
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"type":"tool.execution_complete","timestamp":"2026-01-01T00:00:02.500Z","data":{{"toolCallId":"call-skill","turnId":"turn-alpha","success":true,"output":"SECRET_OUTPUT"}}}}"#
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"type":"tool.execution_start","timestamp":"2026-01-01T00:00:03.000Z","data":{{"toolName":"task","toolCallId":"call-task","turnId":"turn-alpha","arguments":{{"agent_type":"code-reviewer","name":"schema-review","mode":"background","prompt":"SECRET_TASK"}}}}}}"#
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"type":"tool.execution_complete","timestamp":"2026-01-01T00:00:04.000Z","data":{{"toolCallId":"call-task","turnId":"turn-alpha","success":false}}}}"#
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"type":"assistant.message","timestamp":"2026-01-01T00:00:05.000Z","data":{{"turnId":"turn-alpha","outputTokens":321}}}}"#
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"type":"assistant.turn_end","timestamp":"2026-01-01T00:00:06.000Z","data":{{"turnId":"turn-alpha"}}}}"#
            )
            .unwrap();
        }

        let mut summary = AgentSessionSummary::default();
        let mut tool_counts = BTreeMap::new();
        let mut recent_events = Vec::new();
        let allowlist = HashSet::new();
        let schema = test_schema();
        summarize_events(
            "test",
            &path,
            "test-session",
            &mut summary,
            &mut tool_counts,
            &mut recent_events,
            &allowlist,
            &HashSet::new(),
            &schema,
            "test",
        );

        assert_eq!(summary.recent_tool_calls.len(), 2);
        assert_eq!(summary.recent_tool_calls[0].tool, "blog-writer");
        assert_eq!(summary.recent_tool_calls[0].category, "skills");
        assert_eq!(summary.recent_tool_calls[0].duration_ms, Some(1500));
        assert!(!summary.recent_tool_calls[0].event_ref.is_empty());
        assert_eq!(summary.recent_tool_calls[1].tool, "code-reviewer");
        assert_eq!(summary.recent_tool_calls[1].category, "delegates");
        assert!(!summary.recent_tool_calls[1].success);
        assert!(summary.recent_tool_calls[1]
            .details
            .iter()
            .any(|detail| detail.label == "Agent name" && detail.value == "schema-review"));

        assert_eq!(summary.recent_turns.len(), 1);
        let turn = &summary.recent_turns[0];
        assert_eq!(turn.tool_count, 2);
        assert_eq!(
            turn.tools,
            vec!["blog-writer".to_string(), "code-reviewer".to_string()]
        );
        assert_eq!(turn.failure_count, 1);
        assert_eq!(turn.status, "failed");
        assert_eq!(turn.output_tokens, 321);
        assert_eq!(summary.token_checkpoints.len(), 1);
        assert_eq!(
            summary.token_checkpoints[0].timestamp,
            "2026-01-01T00:00:05.000Z"
        );
        assert_eq!(summary.token_checkpoints[0].input_tokens, 0);
        assert_eq!(summary.token_checkpoints[0].output_tokens, 321);
        assert!(!turn.partial);
        assert_eq!(turn.duration_ms, Some(6000));
        assert_eq!(summary.recent_tool_calls[0].turn_id, turn.id);
        assert!(turn.categories.contains(&"skills".to_string()));
        assert!(turn.categories.contains(&"delegates".to_string()));

        let serialized = serde_json::to_string(&summary).expect("serialize summary");
        assert!(!serialized.contains("SECRET_PROMPT"));
        assert!(!serialized.contains("SECRET_TASK"));
        assert!(!serialized.contains("SECRET_OUTPUT"));
        assert!(!serialized.contains("/Users/dan/.env"));

        let raw = raw_tool_call_details_from_events_path(
            &path,
            &schema,
            &summary.recent_tool_calls[0].event_ref,
        )
        .expect("raw tool details");
        assert!(raw.raw_args.unwrap().contains("SECRET_PROMPT"));
        assert_eq!(raw.raw_output.as_deref(), Some("SECRET_OUTPUT"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn raw_tool_call_details_truncate_large_values() {
        use std::io::Write;

        let mut path = std::env::temp_dir();
        path.push(format!(
            "cmc_test_raw_truncate_{}.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        let huge_args = "A".repeat(MAX_RAW_DETAIL_VALUE_BYTES + 128);
        let huge_output = "B".repeat(MAX_RAW_DETAIL_VALUE_BYTES + 128);
        {
            let mut f = std::fs::File::create(&path).expect("create temp jsonl");
            let start = serde_json::json!({
                "type": "tool.execution_start",
                "timestamp": "2026-01-01T00:00:03.000Z",
                "data": {
                    "toolName": "bash",
                    "toolCallId": "call-huge",
                    "arguments": { "payload": huge_args }
                }
            });
            let complete = serde_json::json!({
                "type": "tool.execution_complete",
                "timestamp": "2026-01-01T00:00:04.000Z",
                "data": {
                    "toolCallId": "call-huge",
                    "success": true,
                    "output": huge_output
                }
            });
            writeln!(f, "{}", serde_json::to_string(&start).unwrap()).unwrap();
            writeln!(f, "{}", serde_json::to_string(&complete).unwrap()).unwrap();
        }

        let schema = test_schema();
        let mut summary = AgentSessionSummary::default();
        let mut tool_counts = BTreeMap::new();
        let mut recent_events = Vec::new();
        summarize_events(
            "test",
            &path,
            "test-session",
            &mut summary,
            &mut tool_counts,
            &mut recent_events,
            &HashSet::new(),
            &HashSet::new(),
            &schema,
            "test",
        );

        let raw = raw_tool_call_details_from_events_path(
            &path,
            &schema,
            &summary.recent_tool_calls[0].event_ref,
        )
        .expect("raw tool details");
        assert!(raw.raw_args_truncated);
        assert!(raw.raw_output_truncated);
        assert_eq!(raw.raw_args.unwrap().len(), MAX_RAW_DETAIL_VALUE_BYTES);
        assert_eq!(raw.raw_output.unwrap().len(), MAX_RAW_DETAIL_VALUE_BYTES);
        assert!(!raw.raw_output_scan_limited);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn raw_tool_call_details_stop_output_scan_after_limit() {
        use std::io::Write;

        let mut path = std::env::temp_dir();
        path.push(format!(
            "cmc_test_raw_scan_limit_{}.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        {
            let f = std::fs::File::create(&path).expect("create temp jsonl");
            let mut bw = std::io::BufWriter::new(f);
            writeln!(
                bw,
                r#"{{"type":"tool.execution_start","timestamp":"2026-01-01T00:00:03.000Z","data":{{"toolName":"bash","toolCallId":"call-late","arguments":{{"command":"echo secret"}}}}}}"#
            )
            .unwrap();
            let filler = format!(
                r#"{{"type":"assistant.message","timestamp":"2026-01-01T00:00:03.500Z","data":{{"content":"{}"}}}}"#,
                "A".repeat(1024)
            );
            for _ in 0..((MAX_RAW_DETAIL_SCAN_BYTES / 1024) + 128) {
                writeln!(bw, "{}", filler).unwrap();
            }
            writeln!(
                bw,
                r#"{{"type":"tool.execution_complete","timestamp":"2026-01-01T00:00:04.000Z","data":{{"toolCallId":"call-late","success":true,"output":"SECRET_OUTPUT"}}}}"#
            )
            .unwrap();
        }

        let schema = test_schema();
        let raw = raw_tool_call_details_from_events_path(&path, &schema, "evt-0")
            .expect("raw tool details");

        assert!(raw.raw_args.unwrap().contains("echo secret"));
        assert!(raw.raw_output.is_none());
        assert!(raw.raw_output_scan_limited);
        assert!(!raw.raw_output_truncated);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tool_seen_without_turn_start_marks_turn_partial() {
        use std::io::Write;
        let mut path = std::env::temp_dir();
        path.push("cmc_test_partial_turn.jsonl");
        let _ = std::fs::remove_file(&path);
        {
            let mut f = std::fs::File::create(&path).expect("create temp jsonl");
            writeln!(
                f,
                r#"{{"type":"tool.execution_start","timestamp":"2026-01-01T00:00:03.000Z","data":{{"toolName":"bash","toolCallId":"call-bash","turnId":"turn-tail","arguments":{{"command":"SECRET_COMMAND"}}}}}}"#
            )
            .unwrap();
        }

        let mut summary = AgentSessionSummary::default();
        let mut tool_counts = BTreeMap::new();
        let mut recent_events = Vec::new();
        let allowlist = HashSet::new();
        let schema = test_schema();
        summarize_events(
            "test",
            &path,
            "test-session",
            &mut summary,
            &mut tool_counts,
            &mut recent_events,
            &allowlist,
            &HashSet::new(),
            &schema,
            "test",
        );

        assert_eq!(summary.recent_turns.len(), 1);
        assert!(summary.recent_turns[0].partial);
        assert_eq!(summary.recent_turns[0].status, "running");
        let serialized = serde_json::to_string(&summary).expect("serialize summary");
        assert!(!serialized.contains("SECRET_COMMAND"));

        let _ = std::fs::remove_file(&path);
    }

    /// Regression: `session.shutdown` reports cumulative token counts
    /// in a four-bucket `tokenDetails` block — fresh input, cache_read,
    /// cache_write, and output. Including `cache_read` in the input
    /// total ballooned the "Tokens · 24h" Summary card to ~333M for a
    /// normal session (cache reads are the cached prefix the model
    /// re-fetches every turn, billed at a tiny fraction of fresh-input
    /// rates and not real new work). The fix sums fresh + cache_write
    /// only; cache_read is intentionally dropped.
    #[test]
    fn shutdown_excludes_cache_read_from_input_tokens() {
        use std::io::Write;
        let mut path = std::env::temp_dir();
        path.push("koa_test_shutdown_cache_read.jsonl");
        {
            let mut f = std::fs::File::create(&path).expect("create temp jsonl");
            // One assistant.message (output tokens only) plus a
            // shutdown with absurd cache_read to mirror the real bug.
            writeln!(
                f,
                r#"{{"type":"assistant.message","timestamp":"2026-01-01T00:00:00Z","data":{{"outputTokens":1000}}}}"#
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"type":"session.shutdown","timestamp":"2026-01-01T00:01:00Z","data":{{"tokenDetails":{{"input":{{"tokenCount":100000}},"cache_read":{{"tokenCount":1000000000}},"cache_write":{{"tokenCount":10000000}},"output":{{"tokenCount":2000000}}}}}}}}"#
            )
            .unwrap();
        }

        let mut summary = AgentSessionSummary::default();
        let mut tool_counts = BTreeMap::new();
        let mut recent_events = Vec::new();
        let allowlist = HashSet::new();
        let schema = test_schema();
        summarize_events(
            "test",
            &path,
            "test-session",
            &mut summary,
            &mut tool_counts,
            &mut recent_events,
            &allowlist,
            &HashSet::new(),
            &schema,
            "test",
        );

        // Fresh + cache_write = 100_000 + 10_000_000 = 10_100_000.
        // cache_read (1B) is intentionally excluded.
        assert_eq!(
            summary.input_tokens, 10_100_000,
            "cache_read must be excluded from input_tokens; got {}",
            summary.input_tokens
        );
        // Output: shutdown's 2M wins over the per-message 1K (max()).
        assert_eq!(summary.output_tokens, 2_000_000);
        assert_eq!(summary.token_checkpoints.len(), 2);
        assert_eq!(summary.token_checkpoints[0].input_tokens, 0);
        assert_eq!(summary.token_checkpoints[0].output_tokens, 1000);
        assert_eq!(summary.token_checkpoints[1].input_tokens, 10_100_000);
        assert_eq!(summary.token_checkpoints[1].output_tokens, 2_000_000);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn shutdown_model_metrics_supply_tokens_when_top_level_details_missing() {
        use std::io::Write;
        let mut path = std::env::temp_dir();
        path.push("cmc_test_shutdown_model_metrics_tokens.jsonl");
        let _ = std::fs::remove_file(&path);
        {
            let mut f = std::fs::File::create(&path).expect("create temp jsonl");
            writeln!(
                f,
                r#"{{"type":"session.shutdown","timestamp":"2026-01-01T00:01:00Z","data":{{"modelMetrics":{{"claude-opus-4.6":{{"usage":{{"inputTokens":31477746,"cacheReadTokens":30035719,"cacheWriteTokens":0,"outputTokens":58213}},"requests":{{"cost":1341}}}}}}}}}}"#
            )
            .unwrap();
        }

        let mut summary = AgentSessionSummary::default();
        let mut tool_counts = BTreeMap::new();
        let mut recent_events = Vec::new();
        let allowlist = HashSet::new();
        let schema = test_schema();
        summarize_events(
            "test",
            &path,
            "test-session",
            &mut summary,
            &mut tool_counts,
            &mut recent_events,
            &allowlist,
            &HashSet::new(),
            &schema,
            "test",
        );

        assert_eq!(summary.input_tokens, 1_442_027);
        assert_eq!(summary.output_tokens, 58_213);
        assert_eq!(summary.token_checkpoints.len(), 1);
        assert_eq!(summary.token_checkpoints[0].input_tokens, 1_442_027);
        assert_eq!(summary.token_checkpoints[0].output_tokens, 58_213);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn shutdown_model_metrics_sum_multiple_models_without_cache_read() {
        let input = concat!(
            r#"{"type":"session.shutdown","data":{"modelMetrics":{"gpt-5.5":{"usage":{"inputTokens":1952371,"cacheReadTokens":1817600,"cacheWriteTokens":0,"outputTokens":12265},"requests":{"cost":7.5}},"claude-haiku-4.5":{"usage":{"inputTokens":913294,"cacheReadTokens":819040,"cacheWriteTokens":88379,"outputTokens":9429},"requests":{"cost":2}}}}}"#,
            "\n"
        );
        let mut summary = AgentSessionSummary::default();
        let schema = test_schema();

        fold_skipped_token_events(std::io::Cursor::new(input), &mut summary, &schema);

        assert_eq!(summary.input_tokens, 229_025);
        assert_eq!(summary.output_tokens, 21_694);
    }

    #[test]
    fn shutdown_does_not_replace_last_meaningful_event() {
        use std::io::Write;
        let mut path = std::env::temp_dir();
        path.push("cmc_test_shutdown_last_event.jsonl");
        let _ = std::fs::remove_file(&path);
        {
            let mut f = std::fs::File::create(&path).expect("create temp jsonl");
            writeln!(
                f,
                r#"{{"type":"tool.execution_start","timestamp":"2026-01-01T00:00:01.000Z","data":{{"toolName":"bash","toolCallId":"call-bash","turnId":"turn-current"}}}}"#
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"type":"session.shutdown","timestamp":"2026-01-01T00:00:02.000Z","data":{{"tokenDetails":{{"input":{{"tokenCount":100}},"cache_write":{{"tokenCount":50}},"output":{{"tokenCount":25}}}}}}}}"#
            )
            .unwrap();
        }

        let mut summary = AgentSessionSummary::default();
        let mut tool_counts = BTreeMap::new();
        let mut recent_events = Vec::new();
        let allowlist = HashSet::new();
        let schema = test_schema();
        summarize_events(
            "test",
            &path,
            "test-session",
            &mut summary,
            &mut tool_counts,
            &mut recent_events,
            &allowlist,
            &HashSet::new(),
            &schema,
            "test",
        );

        assert_eq!(summary.last_event_kind, "tool.execution_start");
        assert_eq!(summary.last_event_category, "terminal");
        assert_eq!(summary.last_tool, "bash");
        assert_eq!(summary.input_tokens, 150);
        assert_eq!(summary.output_tokens, 25);

        let _ = std::fs::remove_file(&path);
    }

    /// Direct unit test for `fold_skipped_token_events`. The helper
    /// must accumulate compaction tokens, accept a shutdown that
    /// reports a larger total (max), and ignore non-token lines.
    #[test]
    fn fold_skipped_token_events_aggregates_compactions_and_shutdown() {
        let input = concat!(
            // Two compactions: 100K + 200K = 300K input, 1K + 2K = 3K output.
            r#"{"type":"session.compaction_complete","data":{"compactionTokensUsed":{"inputTokens":100000,"outputTokens":1000}}}"#,
            "\n",
            r#"{"type":"assistant.message","data":{"outputTokens":50}}"#,
            "\n",
            r#"{"type":"session.compaction_complete","data":{"compactionTokensUsed":{"inputTokens":200000,"outputTokens":2000}}}"#,
            "\n",
            // Shutdown reports 500K fresh + 50K cache_write = 550K, which
            // is larger than the running 300K from compactions, so it
            // should REPLACE input_tokens (not add).
            r#"{"type":"session.shutdown","data":{"tokenDetails":{"input":{"tokenCount":500000},"cache_write":{"tokenCount":50000},"cache_read":{"tokenCount":999999999},"output":{"tokenCount":10000}}}}"#,
            "\n",
            r#"{"type":"tool.execution_complete","data":{"toolCallId":"abc"}}"#,
            "\n",
        );
        let mut summary = AgentSessionSummary::default();
        let schema = test_schema();
        fold_skipped_token_events(std::io::Cursor::new(input), &mut summary, &schema);
        assert_eq!(
            summary.input_tokens, 550_000,
            "shutdown must replace running compaction sum when larger"
        );
        // Output: 1K + 2K (compactions) = 3K, then max(3K, 10K shutdown) = 10K.
        assert_eq!(summary.output_tokens, 10_000);
    }

    #[test]
    fn skipped_token_prefix_cache_reuses_prior_prefix_without_double_counting() {
        use std::io::Write;

        let mut path = std::env::temp_dir();
        path.push(format!(
            "cmc_test_token_prefix_cache_{}.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        let schema = test_schema();
        let context = format!("test-prefix-cache-{}", std::process::id());
        let filler =
            r#"{"type":"tool.execution_complete","data":{"toolCallId":"pad","success":true}}"#;

        {
            let f = std::fs::File::create(&path).expect("create temp jsonl");
            let mut bw = std::io::BufWriter::new(f);
            writeln!(
                bw,
                r#"{{"type":"session.compaction_complete","data":{{"compactionTokensUsed":{{"inputTokens":100,"outputTokens":10}}}}}}"#
            )
            .unwrap();
            for _ in 0..64 {
                writeln!(bw, "{}", filler).unwrap();
            }
        }

        let first_len = std::fs::metadata(&path).expect("stat first file").len();
        let mut first_summary = AgentSessionSummary::default();
        fold_skipped_token_events_from_path(
            &path,
            first_len,
            &mut first_summary,
            &schema,
            &context,
        );
        assert_eq!(first_summary.input_tokens, 100);
        assert_eq!(first_summary.output_tokens, 10);

        {
            let f = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .expect("append temp jsonl");
            let mut bw = std::io::BufWriter::new(f);
            writeln!(
                bw,
                r#"{{"type":"session.compaction_complete","data":{{"compactionTokensUsed":{{"inputTokens":200,"outputTokens":20}}}}}}"#
            )
            .unwrap();
            for _ in 0..64 {
                writeln!(bw, "{}", filler).unwrap();
            }
        }

        let second_len = std::fs::metadata(&path).expect("stat second file").len();
        let mut second_summary = AgentSessionSummary::default();
        fold_skipped_token_events_from_path(
            &path,
            second_len,
            &mut second_summary,
            &schema,
            &context,
        );

        assert_eq!(
            second_summary.input_tokens, 300,
            "cached prefix must not be double counted after append"
        );
        assert_eq!(second_summary.output_tokens, 30);

        {
            let f = std::fs::File::create(&path).expect("rewrite temp jsonl");
            let mut bw = std::io::BufWriter::new(f);
            writeln!(
                bw,
                r#"{{"type":"session.compaction_complete","data":{{"compactionTokensUsed":{{"inputTokens":7,"outputTokens":3}}}}}}"#
            )
            .unwrap();
            for _ in 0..64 {
                writeln!(bw, "{}", filler).unwrap();
            }
        }

        let rewritten_len = std::fs::metadata(&path).expect("stat rewritten file").len();
        let mut rewritten_summary = AgentSessionSummary::default();
        fold_skipped_token_events_from_path(
            &path,
            rewritten_len,
            &mut rewritten_summary,
            &schema,
            &context,
        );
        assert_eq!(
            rewritten_summary.input_tokens, 7,
            "rewritten files with the same path must not reuse stale cached prefixes"
        );
        assert_eq!(rewritten_summary.output_tokens, 3);

        let _ = std::fs::remove_file(&path);
    }

    /// Regression: when events.jsonl is larger than the 8 MiB tail
    /// window AND the most recent compaction has been pushed past the
    /// window, the selected-session panel showed 0 input tokens
    /// because the tail scan never saw any token-bearing event. The
    /// head-pass added by `fold_skipped_token_events` must recover
    /// these compaction tokens from the skipped portion.
    #[test]
    fn compactions_outside_tail_window_still_counted() {
        use std::io::Write;
        let mut path = std::env::temp_dir();
        path.push("cmc_test_compaction_outside_tail.jsonl");
        // Best-effort cleanup from any prior failed run so we don't
        // accumulate stale data inside the same temp file.
        let _ = std::fs::remove_file(&path);

        {
            let f = std::fs::File::create(&path).expect("create temp jsonl");
            let mut bw = std::io::BufWriter::new(f);
            // One compaction at the very start (deep inside the head
            // region once the file grows past 8 MiB).
            writeln!(
                bw,
                r#"{{"type":"session.compaction_complete","timestamp":"2026-01-01T00:00:00Z","data":{{"compactionTokensUsed":{{"inputTokens":250000,"outputTokens":3000}}}}}}"#
            )
            .unwrap();
            // Pad with filler tool events until the file is well past
            // the 8 MiB tail window. Each line is ~300 bytes; ~32K
            // lines puts us at ~9.6 MB.
            let filler = r#"{"type":"tool.execution_complete","timestamp":"2026-01-01T00:00:00Z","data":{"toolCallId":"pad","model":"x","interactionId":"i","turnId":"1","success":true,"result":{"content":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}}"#;
            for _ in 0..32_000 {
                writeln!(bw, "{}", filler).unwrap();
            }
        }

        let metadata = std::fs::metadata(&path).expect("stat temp jsonl");
        assert!(
            metadata.len() > 8 * 1024 * 1024,
            "test file must exceed the 8 MiB tail window, got {} bytes",
            metadata.len()
        );

        let mut summary = AgentSessionSummary::default();
        let mut tool_counts = BTreeMap::new();
        let mut recent_events = Vec::new();
        let allowlist = HashSet::new();
        let schema = test_schema();
        summarize_events(
            "test",
            &path,
            "test-session",
            &mut summary,
            &mut tool_counts,
            &mut recent_events,
            &allowlist,
            &HashSet::new(),
            &schema,
            "test",
        );

        assert_eq!(
            summary.input_tokens, 250_000,
            "compaction outside the tail window must still be aggregated; got {}",
            summary.input_tokens
        );
        assert_eq!(summary.output_tokens, 3_000);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn history_mode_scans_events_before_tail_window() {
        use std::io::Write;
        let mut path = std::env::temp_dir();
        path.push("cmc_test_full_history_scan.jsonl");
        let _ = std::fs::remove_file(&path);

        {
            let f = std::fs::File::create(&path).expect("create temp jsonl");
            let mut bw = std::io::BufWriter::new(f);
            writeln!(
                bw,
                r#"{{"type":"tool.execution_start","timestamp":"2026-05-28T01:00:00.000Z","data":{{"toolName":"view","toolCallId":"old-call"}}}}"#
            )
            .unwrap();
            let filler = "not json\n";
            let filler_repeats = (MAX_EVENT_TAIL_BYTES as usize / filler.len()) + 1024;
            for _ in 0..filler_repeats {
                bw.write_all(filler.as_bytes()).unwrap();
            }
            writeln!(
                bw,
                r#"{{"type":"tool.execution_start","timestamp":"2026-05-28T02:00:00.000Z","data":{{"toolName":"bash","toolCallId":"new-call"}}}}"#
            )
            .unwrap();
        }

        let schema = test_schema();
        let allowlist = HashSet::new();
        let configured_hook_types = HashSet::new();
        let mut tail_summary = AgentSessionSummary::default();
        let mut tail_tool_counts = BTreeMap::new();
        let mut tail_events = Vec::new();
        summarize_events(
            "test",
            &path,
            "test-session",
            &mut tail_summary,
            &mut tail_tool_counts,
            &mut tail_events,
            &allowlist,
            &configured_hook_types,
            &schema,
            "test",
        );

        let mut history_summary = AgentSessionSummary::default();
        let mut history_tool_counts = BTreeMap::new();
        let mut history_events = Vec::new();
        summarize_events_with_mode(
            "test",
            &path,
            "test-session",
            &mut history_summary,
            &mut history_tool_counts,
            &mut history_events,
            &allowlist,
            &configured_hook_types,
            &schema,
            "test",
            true,
        );

        assert_eq!(tail_summary.event_count, 1);
        assert_eq!(tail_events.len(), 1);
        assert_eq!(history_summary.event_count, 2);
        assert_eq!(history_events.len(), 2);

        let _ = std::fs::remove_file(&path);
    }

    /// Sanity check: every Copilot CLI built-in tool we've observed
    /// must land in one of the eight known quarter keys. No tool
    /// should ever be invisible on the mission map.
    #[test]
    fn every_observed_builtin_routes_to_a_known_quarter() {
        let schema = test_schema();
        let allowlist = HashSet::new();
        const QUARTERS: &[&str] = &[
            "edits",
            "library",
            "terminal",
            "signal",
            "delegates",
            "skills",
            "court",
            "mcp",
        ];
        let tools = [
            "bash",
            "write_bash",
            "read_bash",
            "stop_bash",
            "list_bash",
            "view",
            "edit",
            "create",
            "apply_patch",
            "grep",
            "glob",
            "web_fetch",
            "web_search",
            "fetch_copilot_cli_documentation",
            "ask_user",
            "report_intent",
            "store_memory",
            "vote_memory",
            "exit_plan_mode",
            "manage_schedule",
            "list_agents",
            "read_agent",
            "write_agent",
            "stop_agent",
            "sql",
            "session_store_sql",
            "tool_search_tool_regex",
        ];
        for tool in tools {
            let cat = categorize_tool(tool, &allowlist, &schema);
            assert!(
                QUARTERS.contains(&cat.as_str()),
                "tool {tool} -> {cat}, which is not a real quarter"
            );
        }
    }
}
