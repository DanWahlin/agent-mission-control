//! Agent activity providers.
//!
//! Each AI agent (Copilot CLI today, Claude Code / Codex / etc. in the
//! future) plugs in by implementing [`AgentProvider`]. Each provider
//! returns a sanitized [`ProviderScan`] containing only allowlisted
//! summary fields (no prompts, no tool args, no command output, no file
//! contents, no diffs). The merger [`collect_agent_activity`] composes
//! provider scans into the [`AgentActivity`] shape consumed by the
//! Copilot Mission Control scene.
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
    pub generated_at_ms: u64,
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
    fn scan(&self) -> ProviderScan;
}

pub fn default_providers() -> Vec<Box<dyn AgentProvider>> {
    vec![Box::new(CopilotProvider)]
}

// ── Top-level merge ───────────────────────────────────────────────────

const MAX_SESSIONS: usize = 12;
const MAX_TOOLS: usize = 10;
const MAX_TOOLS_PER_CATEGORY: usize = 5;
const ACTIVITY_CACHE_MAX_AGE_MS: u64 = 2_000;
/// Recent global event feed cap (after merging across providers). Bumped
/// from 18 → 80 so chatty bursts between scans don't drop events that
/// the renderer's workMixHistory needs to accumulate per category.
const MAX_RECENT_EVENTS: usize = 80;
const MAX_SESSION_TOKEN_CHECKPOINTS: usize = 120;
/// Sessions whose `events.jsonl` has not been touched in this many
/// seconds are considered stale "ghost" sessions and excluded from
/// the scan. Without this filter the user's accumulated session-state
/// directory floods the picker with old runs that aren't relevant to
/// what they're observing right now.
const STALE_SESSION_CUTOFF_SECS: u64 = 24 * 60 * 60;
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
    "https://danwahlin.github.io/copilot-mission-control/provider-schemas/copilot/index.json";
const SCHEMA_FETCH_TIMEOUT_SECS: u64 = 2;
static COPILOT_SCHEMA: OnceLock<(ProviderSchema, Vec<String>)> = OnceLock::new();
static ACTIVITY_CACHE: OnceLock<RwLock<AgentActivity>> = OnceLock::new();
static ACTIVITY_REFRESH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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
        "forge"
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

fn activity_cache() -> &'static RwLock<AgentActivity> {
    ACTIVITY_CACHE.get_or_init(|| RwLock::new(AgentActivity::default()))
}

fn activity_refresh_lock() -> &'static Mutex<()> {
    ACTIVITY_REFRESH_LOCK.get_or_init(|| Mutex::new(()))
}

fn scan_agent_activity() -> AgentActivity {
    let providers = default_providers();
    let scans: Vec<ProviderScan> = providers.iter().map(|p| p.scan()).collect();
    merge_scans(scans)
}

fn cached_agent_activity_snapshot() -> Option<AgentActivity> {
    match activity_cache().read() {
        Ok(cached) if cached.generated_at_ms > 0 => Some(cached.clone()),
        Ok(_) => None,
        Err(err) => {
            log::warn!("Agent activity cache lock poisoned during read: {}", err);
            None
        }
    }
}

fn scan_and_store_agent_activity() -> AgentActivity {
    let activity = scan_agent_activity();
    match activity_cache().write() {
        Ok(mut cached) => {
            *cached = activity.clone();
        }
        Err(err) => {
            log::warn!("Agent activity cache lock poisoned during refresh: {}", err);
        }
    }
    activity
}

pub fn refresh_agent_activity_cache() -> AgentActivity {
    match activity_refresh_lock().lock() {
        Ok(_guard) => scan_and_store_agent_activity(),
        Err(err) => {
            log::warn!("Agent activity refresh lock poisoned: {}", err);
            cached_agent_activity_snapshot().unwrap_or_else(scan_agent_activity)
        }
    }
}

pub fn collect_agent_activity() -> AgentActivity {
    let now = unix_ms(SystemTime::now());
    match activity_cache().read() {
        Ok(cached)
            if cached.generated_at_ms > 0
                && now.saturating_sub(cached.generated_at_ms) < ACTIVITY_CACHE_MAX_AGE_MS =>
        {
            return cached.clone();
        }
        Ok(_) => {}
        Err(err) => {
            log::warn!("Agent activity cache lock poisoned during read: {}", err);
        }
    }
    match activity_refresh_lock().try_lock() {
        Ok(_guard) => scan_and_store_agent_activity(),
        Err(_) => cached_agent_activity_snapshot().unwrap_or_default(),
    }
}

fn merge_scans(scans: Vec<ProviderScan>) -> AgentActivity {
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
    all_sessions.truncate(MAX_SESSIONS);
    activity.sessions = all_sessions;

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
    fn scan(&self) -> ProviderScan {
        scan_copilot()
    }
}

fn scan_copilot() -> ProviderScan {
    let provider = "copilot";
    let (schema, schema_alerts) = load_copilot_schema();
    let executable_available = is_copilot_available();
    let mut scan = ProviderScan::unavailable(provider);
    scan.available = executable_available;
    scan.alerts.extend(schema_alerts);

    let discovery = discover_copilot_state_roots(&schema);
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
    // Cap per-provider scan effort but leave global truncation to the merger.
    session_dirs.truncate(MAX_SESSIONS);
    scan.scanned_sessions = session_dirs.len();

    // Load once per scan; reused for every tool execution event below.
    let mcp_allowlist = load_mcp_tool_allowlist(&schema);
    let configured_hook_types = load_configured_hook_types(&schema);
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
        let session_name = sanitize_session_title(workspace.get("name"));
        let age_seconds = now
            .duration_since(modified)
            .map(|age| age.as_secs())
            .unwrap_or(0);
        let mut summary = AgentSessionSummary {
            provider: provider.to_string(),
            id: session_id.chars().take(8).collect(),
            session_name: session_name.clone().unwrap_or_default(),
            repository: workspace
                .get("repository")
                .cloned()
                .or_else(|| {
                    workspace
                        .get("git_root")
                        .and_then(|p| Path::new(p).file_name()?.to_str().map(str::to_string))
                })
                .unwrap_or_else(|| "unknown repo".to_string()),
            branch: workspace
                .get("branch")
                .cloned()
                .unwrap_or_else(|| "unknown".to_string()),
            updated_at: workspace.get("updated_at").cloned().unwrap_or_default(),
            is_active: age_seconds < 10 * 60,
            stale_seconds: age_seconds,
            git_root: workspace.get("git_root").cloned().unwrap_or_default(),
            ..Default::default()
        };
        summary.title =
            session_title_from_workspace(&workspace, &summary.repository, &summary.branch);

        let session_schema_stats = summarize_events(
            provider,
            &events_path,
            &session_id,
            &mut summary,
            &mut scan.tool_counts,
            &mut scan.recent_events,
            &mcp_allowlist,
            &configured_hook_types,
            &schema,
        );
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
    }
    if let Some(report) = schema_drift.into_report() {
        scan.alerts.push(report.summary.clone());
        scan.schema_drift.push(report);
    }

    scan
}

#[derive(Default)]
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

    for line in content.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if schema
            .workspace
            .allowed_keys
            .iter()
            .any(|allowed| allowed == key)
        {
            values.insert(key.to_string(), value.trim().trim_matches('"').to_string());
        }
    }

    values
}

fn sanitize_session_title(summary: Option<&String>) -> Option<String> {
    let raw = summary?.trim();
    if raw.is_empty() {
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
        .unwrap_or_else(|| format!("{} {}", repository, branch))
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
) -> SessionSchemaStats {
    let mut schema_stats = SessionSchemaStats::default();
    let Ok(mut file) = fs::File::open(path) else {
        return schema_stats;
    };

    // Tail-window limit. The full-event scan (recent tools, errors,
    // last_tool, recent_events list) only reads the last MAX_READ_BYTES
    // of the file: that gives ~5-15 minutes of busy-session history and
    // parses in a few ms, even for a 100 MB+ events.jsonl. Bumped from
    // 512 KiB → 8 MiB because 512 KiB only captured the most recent
    // ~30-50 tool calls, which made low-volume categories like Intent
    // (`report_intent`) invisible whenever bash bursts dominated.
    const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

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
    if file_len > MAX_READ_BYTES {
        if let Ok(head_file) = fs::File::open(path) {
            let head_reader = BufReader::new(head_file.take(file_len - MAX_READ_BYTES));
            fold_skipped_token_events(head_reader, summary, schema);
        }
        read_offset = file_len - MAX_READ_BYTES;
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
                    turn_id: active_turn_id.clone().unwrap_or_default(),
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
                    turn_id: active_turn_id.clone().unwrap_or_default(),
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
                "forge" => summary.write_count += 1,
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
            // last MAX_READ_BYTES of events.jsonl, the tail often begins
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
    if event_type != schema.events.tool_start {
        return Err("Raw details are only available for tool calls".to_string());
    }

    let raw_args =
        value_from_paths(&value, &schema.events.arguments_paths).map(raw_value_to_string);
    let raw_call_id = raw_tool_call_id(&value, schema);
    let raw_output = find_raw_tool_output(&mut reader, schema, raw_call_id.as_deref());
    Ok(RawToolCallDetails {
        raw_args,
        raw_output,
    })
}

fn find_raw_tool_output<R: BufRead>(
    reader: &mut R,
    schema: &ProviderSchema,
    raw_call_id: Option<&str>,
) -> Option<String> {
    let raw_call_id = raw_call_id?;
    if schema.events.output_paths.is_empty() {
        return None;
    }
    let mut line = String::new();
    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).ok()?;
        if bytes_read == 0 {
            return None;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let event_type =
            string_from_paths(&value, &schema.events.event_type_paths).unwrap_or_default();
        if event_type != schema.events.tool_complete {
            continue;
        }
        if raw_tool_call_id(&value, schema).as_deref() == Some(raw_call_id) {
            return value_from_paths(&value, &schema.events.output_paths).map(raw_value_to_string);
        }
    }
}

fn raw_value_to_string(value: &serde_json::Value) -> String {
    if let Some(value) = value.as_str() {
        value.to_string()
    } else {
        serde_json::to_string_pretty(value)
            .or_else(|_| serde_json::to_string(value))
            .unwrap_or_default()
    }
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
/// output). We deliberately EXCLUDE `cache_read.tokenCount` from the
/// input total: cache reads are the cached prefix the model re-fetches
/// on every turn, which can balloon into the hundreds of millions for
/// a long session (one observed session reported 321M cache reads vs
/// 125K fresh input and 10M cache writes). Including cache reads made
/// the "Tokens · 24h" card report ~333M for a normal day of coding,
/// which both overflowed the card and misrepresented actual model work.
/// Cache reads are billed at a tiny fraction of fresh-input rates and
/// the model doesn't process them from scratch.
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

    let input = sum_token_components(value, &rule.input_components);
    let output = sum_token_components(value, &rule.output_components);
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
fn fold_skipped_token_events<R: BufRead>(
    reader: R,
    summary: &mut AgentSessionSummary,
    schema: &ProviderSchema,
) {
    for line in reader.lines().map_while(Result::ok) {
        if !schema
            .token_events
            .iter()
            .any(|token| line.contains(&format!("\"{}\"", token.event_type)))
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
        "forge" => "Edit tool",
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

    fn test_schema() -> ProviderSchema {
        parse_provider_schema(BUNDLED_COPILOT_SCHEMA).expect("bundled schema")
    }

    #[test]
    fn bundled_provider_schema_parses_and_validates() {
        let schema = test_schema();
        assert_eq!(schema.provider, "copilot");
        assert_eq!(schema.schema_version, "1.2.0");
        assert!(schema
            .session
            .relevant_files
            .contains(&"events.jsonl".to_string()));
        assert!(schema.workspace.allowed_keys.contains(&"name".to_string()));
    }

    #[test]
    fn published_provider_schema_matches_bundled_schema() {
        let published = include_str!("../../docs/provider-schemas/copilot/1.2.0.json");
        assert_eq!(published, BUNDLED_COPILOT_SCHEMA);
        assert_eq!(
            sha256_hex(published),
            "b4fd6f3484bd4ee7b51ab9cdd34d73b3da34fc56f1157e50ee0f85deafddaa8b"
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
        let title = session_title_from_workspace(
            &workspace,
            "DanWahlin/copilot-mission-control",
            "main",
        );

        assert_eq!(title, "Custom Session Name");
        let _ = std::fs::remove_file(&path);
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

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn schema_url_resolution_rejects_encoded_or_external_paths() {
        let index_url =
            "https://danwahlin.github.io/copilot-mission-control/provider-schemas/copilot/index.json";

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
        let activity = merge_scans(vec![ProviderScan::unavailable("test")]);

        assert!(activity
            .alerts
            .iter()
            .any(|alert| alert == "No supported agent activity sources are currently available."));
        assert!(!activity
            .alerts
            .iter()
            .any(|alert| alert.contains("CLI executables")));
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

        let activity = merge_scans(vec![scan]);
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
        let activity = merge_scans(vec![scan]);
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
        let activity = merge_scans(vec![scan]);
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
        let activity = merge_scans(vec![scan]);
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
        assert_eq!(categorize_tool("edit", &allowlist, &schema), "forge");
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
    /// Before the pattern reorder these all landed in forge/library
    /// purely because "read"/"write"/"search" was checked before
    /// "bash"/"agent"/"web".
    #[test]
    fn composite_names_beat_verb_prefixes() {
        let schema = test_schema();
        let allowlist = HashSet::new();
        // *_bash / *_shell / *_sql / *_test should all land in terminal,
        // not in forge (write) or library (read) just because of the
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
        // tool drives a sub-agent, not in library/forge.
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
        );

        assert_eq!(
            summary.input_tokens, 250_000,
            "compaction outside the tail window must still be aggregated; got {}",
            summary.input_tokens
        );
        assert_eq!(summary.output_tokens, 3_000);

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
            "forge",
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
