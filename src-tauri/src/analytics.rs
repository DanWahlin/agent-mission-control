//! Local analytics storage and grounded chat responses.
//!
//! This module indexes local Copilot CLI event logs into durable rollups so
//! weekly and historical questions are based on local session history rather
//! than the live dashboard snapshot.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::definition_paths::resolve_definition_path;
use crate::executable_env::{copilot_sdk_client_options, resolve_executable_env, ExecutableEnv};

use crate::agent::{
    collect_agent_activity_with_history, AgentActivity, AgentEventSummary, AgentSessionSummary,
    SessionToolCall,
};

const ANALYTICS_DB_FILE: &str = "analytics.sqlite3";
const SCHEMA_VERSION: i64 = 2;
const ROLLUP_VERSION: i64 = 3;
const DEFAULT_RANGE_DAYS: u32 = 7;
const MAX_RANGE_DAYS: u32 = 180;
const LOCAL_HISTORY_INGEST_DAYS: u32 = 30;
const RECENT_FACT_RETENTION_DAYS: u32 = 30;
const ROLLUP_RETENTION_DAYS: u32 = 180;
const INGEST_STALE_MS: i64 = 5 * 60 * 1000;
const ACTIVE_EVENT_WINDOW_MS: u64 = 5 * 60 * 1000;
const HOUR_MS: u64 = 60 * 60 * 1000;
const SNAPSHOT_SOURCE_HASH: &str = "agent-activity-snapshot";
const LOCAL_HISTORY_SOURCE_HASH: &str = "copilot-local-history";
const LOCAL_HISTORY_PROVIDER: &str = "copilot";
const MISSION_CONTROL_ANALYTICS_MARKER: &str = "COPILOT_MISSION_CONTROL_ANALYTICS_CHAT_IGNORE";
const INSIGHTS_MCP_SERVER_SOURCE: &str = include_str!("../../mcp/mission-control-insights.ts");
const ANALYTICS_EXCLUDED_BUILT_IN_TOOLS: &[&str] = &[
    "apply_patch",
    "ask_user",
    "bash",
    "edit",
    "glob",
    "grep",
    "list_bash",
    "read_bash",
    "report_intent",
    "rg",
    "run_in_terminal",
    "shell",
    "stop_bash",
    "terminal",
    "view",
    "write_bash",
];
static INGESTION_RUNNING: AtomicBool = AtomicBool::new(false);
static SCHEMA_READY_DB: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(serde::Deserialize, Default)]
pub struct AnalyticsRangeRequest {
    #[serde(default)]
    pub range_days: Option<u32>,
    #[serde(default)]
    pub compare_previous: bool,
}

#[derive(serde::Deserialize, Default)]
pub struct AnalyticsChatRequest {
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub range_days: Option<u32>,
}

#[derive(serde::Deserialize, Default)]
pub struct EngineeringDigestRequest {
    #[serde(default)]
    pub selected_day: Option<String>,
    #[serde(default)]
    pub month: Option<String>,
}

#[derive(serde::Serialize, Default)]
pub struct AnalyticsStatus {
    pub available: bool,
    #[serde(default)]
    pub ingestion_running: bool,
    pub generated_at_ms: u64,
    pub last_ingested_at_ms: u64,
    pub session_count: usize,
    pub event_count: usize,
    pub db_size_bytes: u64,
    pub retention_recent_days: u32,
    pub retention_rollup_days: u32,
    pub snapshot_limited: bool,
    pub privacy_summary: String,
    pub warnings: Vec<String>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AnalyticsMetricValue {
    pub label: String,
    pub value: u64,
    #[serde(default)]
    pub exact: bool,
    #[serde(default)]
    pub estimated: bool,
    #[serde(default)]
    pub partial: bool,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AnalyticsDailyPoint {
    pub local_day: String,
    pub sessions: u64,
    pub events: u64,
    pub turns: u64,
    pub tool_calls: u64,
    pub failures: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated_active_ms: u64,
    pub partial: bool,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AnalyticsRankedItem {
    pub label: String,
    pub category: String,
    pub value: u64,
    #[serde(default)]
    pub secondary_value: u64,
    #[serde(default)]
    pub tertiary_value: u64,
    #[serde(default)]
    pub partial: bool,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AnalyticsRecommendation {
    pub title: String,
    pub body: String,
    pub severity: String,
    pub metric: String,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AnalyticsUsageSummary {
    pub generated_at_ms: u64,
    pub range_days: u32,
    pub snapshot_limited: bool,
    #[serde(default)]
    pub ingestion_running: bool,
    pub metrics: Vec<AnalyticsMetricValue>,
    pub daily: Vec<AnalyticsDailyPoint>,
    pub token_hotspots: Vec<AnalyticsRankedItem>,
    pub model_mix: Vec<AnalyticsRankedItem>,
    pub tool_failures: Vec<AnalyticsRankedItem>,
    pub recommendations: Vec<AnalyticsRecommendation>,
    pub caveats: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comparison: Option<AnalyticsComparison>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct EngineeringDigest {
    pub generated_at_ms: u64,
    pub selected_day: String,
    pub month: String,
    pub available_years: Vec<i32>,
    pub calendar_days: Vec<EngineeringDigestCalendarDay>,
    pub day: EngineeringDigestDay,
    pub caveats: Vec<String>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct EngineeringDigestCalendarDay {
    pub local_day: String,
    pub day_number: u32,
    pub in_month: bool,
    pub enabled: bool,
    pub is_today: bool,
    pub intensity: u8,
    pub sessions: u64,
    pub events: u64,
    pub turns: u64,
    pub tool_calls: u64,
    pub failures: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated_active_ms: u64,
    pub partial: bool,
    pub badges: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dominant_repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dominant_branch: Option<String>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct EngineeringDigestDay {
    pub local_day: String,
    pub totals: Vec<AnalyticsMetricValue>,
    #[serde(default)]
    pub activity_rate: Vec<EngineeringDigestActivityBucket>,
    pub repos: Vec<EngineeringDigestRepoGroup>,
    pub models: Vec<AnalyticsRankedItem>,
    pub tools: Vec<EngineeringDigestTool>,
    pub failures: Vec<EngineeringDigestFailure>,
    pub token_hotspots: Vec<EngineeringDigestSession>,
    pub useful_sessions: Vec<EngineeringDigestSession>,
    pub narrative: String,
    pub exports: Vec<EngineeringDigestExport>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct EngineeringDigestActivityBucket {
    pub start_ms: u64,
    pub label: String,
    pub event_count: u64,
    pub tool_call_count: u64,
    pub turn_count: u64,
    pub failure_count: u64,
    pub session_count: u64,
    pub intensity: f64,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct EngineeringDigestRepoGroup {
    pub repository: String,
    pub branch: String,
    pub sessions: Vec<EngineeringDigestSession>,
    pub events: u64,
    pub failures: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub first_seen_ms: u64,
    pub last_seen_ms: u64,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct EngineeringDigestSession {
    pub session_hash: String,
    pub title: String,
    pub repository: String,
    pub branch: String,
    pub status: String,
    pub is_active: bool,
    pub events: u64,
    pub failures: u64,
    pub turns: u64,
    pub tool_calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub last_model: String,
    pub first_seen_ms: u64,
    pub last_seen_ms: u64,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct EngineeringDigestTool {
    pub name: String,
    pub category: String,
    pub calls: u64,
    pub successes: u64,
    pub failures: u64,
    pub total_duration_ms: u64,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct EngineeringDigestFailure {
    pub kind: String,
    pub tool: String,
    pub category: String,
    pub count: u64,
    pub last_seen_ms: u64,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct EngineeringDigestExport {
    pub kind: String,
    pub label: String,
    pub body: String,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AnalyticsComparison {
    pub current_label: String,
    pub previous_label: String,
    pub changes: Vec<AnalyticsChangeItem>,
    pub model_shifts: Vec<AnalyticsChangeItem>,
    pub tool_shifts: Vec<AnalyticsChangeItem>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AnalyticsChangeItem {
    pub label: String,
    pub category: String,
    pub current: u64,
    pub previous: u64,
    pub delta: i64,
    #[serde(default)]
    pub percent_change: Option<f64>,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AnalyticsArtifact {
    pub kind: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub rows: Vec<Vec<String>>,
    #[serde(default)]
    pub points: Vec<AnalyticsDailyPoint>,
    #[serde(default)]
    pub cards: Vec<AnalyticsRecommendation>,
}

#[derive(Default)]
struct McpServerInventory {
    name: String,
    enabled: bool,
    tools: BTreeSet<String>,
}

#[derive(Default, Clone)]
struct McpToolUsage {
    tool: String,
    calls: u64,
    successes: u64,
    failures: u64,
    duration_ms: u64,
}

#[derive(Default)]
struct McpServerUsage {
    name: String,
    configured: bool,
    enabled: bool,
    registered_tools: u64,
    tools: BTreeMap<String, McpToolUsage>,
}

#[derive(Default)]
struct McpUsageReport {
    total_calls: u64,
    total_failures: u64,
    enabled_servers: u64,
    configured_servers: u64,
    used_servers: u64,
    registered_tools: u64,
    artifacts: Vec<AnalyticsArtifact>,
    caveats: Vec<String>,
}

#[derive(serde::Serialize, Default)]
pub struct AnalyticsChatResponse {
    pub id: String,
    pub prompt: String,
    pub answer: String,
    pub generated_at_ms: u64,
    pub artifacts: Vec<AnalyticsArtifact>,
    pub caveats: Vec<String>,
    #[serde(default)]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_reason: Option<String>,
}

pub fn analytics_status(app: &AppHandle) -> Result<AnalyticsStatus, String> {
    let mut conn = open_connection(app)?;
    ensure_schema(app, &mut conn)?;
    status_from_db(app, &conn)
}

pub fn run_analytics_ingestion_once(app: &AppHandle) -> Result<AnalyticsStatus, String> {
    if !begin_ingestion() {
        let mut conn = open_connection(app)?;
        ensure_schema(app, &mut conn)?;
        return status_from_db(app, &conn);
    }
    let result = run_analytics_ingestion(app);
    finish_ingestion(app);
    result?;
    let mut conn = open_connection(app)?;
    ensure_schema(app, &mut conn)?;
    status_from_db(app, &conn)
}

pub fn start_background_ingestion(app: AppHandle) {
    if !begin_ingestion() {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(err) = run_analytics_ingestion(&app) {
            log::warn!("Background analytics ingestion failed: {}", err);
        }
        finish_ingestion(&app);
    });
}

fn run_analytics_ingestion(app: &AppHandle) -> Result<(), String> {
    let mut conn = open_connection(app)?;
    ensure_schema(app, &mut conn)?;
    if !ingest_local_copilot_history(&mut conn)? {
        let activity = collect_agent_activity_with_history();
        ingest_activity(&mut conn, &activity)?;
    }
    Ok(())
}

pub fn analytics_usage_summary(
    app: &AppHandle,
    request: AnalyticsRangeRequest,
) -> Result<AnalyticsUsageSummary, String> {
    ensure_recent_ingestion(app)?;
    let mut conn = open_connection(app)?;
    ensure_schema(app, &mut conn)?;
    usage_summary_from_db(
        &conn,
        normalize_range_days(request.range_days),
        request.compare_previous,
    )
}

pub fn engineering_digest(
    app: &AppHandle,
    request: EngineeringDigestRequest,
) -> Result<EngineeringDigest, String> {
    ensure_recent_ingestion(app)?;
    let mut conn = open_connection(app)?;
    ensure_schema(app, &mut conn)?;
    engineering_digest_from_db(&conn, request)
}

pub fn analytics_recommendation_facts(
    app: &AppHandle,
    request: AnalyticsRangeRequest,
) -> Result<Vec<AnalyticsRecommendation>, String> {
    let summary = analytics_usage_summary(app, request)?;
    Ok(summary.recommendations)
}

pub async fn analytics_chat(
    app: &AppHandle,
    request: AnalyticsChatRequest,
) -> Result<AnalyticsChatResponse, String> {
    let prompt = sanitize_prompt_for_echo(&request.prompt);
    let summary = analytics_usage_summary(
        app,
        AnalyticsRangeRequest {
            range_days: request.range_days,
            compare_previous: true,
        },
    )?;
    let mut response = chat_response_from_summary(prompt.clone(), summary.clone());
    let definition_gap_prompt = is_definition_gap_prompt(&response.prompt);
    let mcp_usage_prompt = is_mcp_usage_prompt(&response.prompt);
    let mcp_report = if mcp_usage_prompt {
        let mut conn = open_connection(app)?;
        ensure_schema(app, &mut conn)?;
        Some(mcp_usage_report(&conn, summary.range_days)?)
    } else {
        None
    };

    let dynamic_answer =
        synthesize_chat_answer_with_copilot(app, &prompt, &summary, definition_gap_prompt).await;
    match dynamic_answer {
        Ok(answer) => {
            response.answer = answer.answer;
            response.mode = "copilot_sdk".to_string();
            response.mode_reason = None;
            if !answer.in_scope {
                response.artifacts.clear();
                response.caveats.clear();
                response.mode_reason = Some(
                    "Question is outside Agent Mission Control analytics scope.".to_string(),
                );
            } else {
                let mut artifacts = if definition_gap_prompt {
                    Vec::new()
                } else {
                    artifacts_for_keys(&summary, &answer.artifacts)
                };
                if let Some(report) = &mcp_report {
                    extend_unique_artifacts(&mut artifacts, report.artifacts.clone());
                    response.caveats =
                        merge_caveats(response.caveats.clone(), report.caveats.clone());
                }
                artifacts.extend(answer.definition_review_artifacts);
                extend_unique_artifacts(
                    &mut artifacts,
                    local_definition_review_artifacts_for_prompt(app, &response.prompt),
                );
                response.artifacts = artifacts;
            }
        }
        Err(err) => {
            response.mode = "deterministic_fallback".to_string();
            let reason = format!("Copilot SDK answer generation was unavailable: {}", err);
            response.mode_reason = Some(reason.clone());
            if let Some(report) = mcp_report {
                response.answer = mcp_usage_answer(summary.range_days, &report);
                response.artifacts = report.artifacts;
                response.caveats = merge_caveats(report.caveats, vec![reason]);
            } else if requires_insights_tools(&response.prompt) {
                let local_artifacts =
                    local_definition_review_artifacts_for_prompt(app, &response.prompt);
                if local_artifacts.is_empty() {
                    response.answer = format!(
                        "I'm unable to provide that information because it requires local prompt, skill, or agent inspection and the Copilot SDK/MCP tool flow is unavailable right now. {}",
                        reason
                    );
                    response.artifacts.clear();
                    response.caveats.clear();
                } else {
                    response.answer = "I found local skill and agent readiness checks below. The Copilot SDK answer timed out, so this response is showing deterministic local analysis instead.".to_string();
                    response.artifacts = local_artifacts;
                    response.caveats = vec![reason];
                }
            } else {
                response.caveats.push(
                    format!(
                        "Copilot SDK answer generation was unavailable, so this response used deterministic local analytics. {}",
                        reason
                    ),
                );
            }
        }
    }
    Ok(response)
}

pub fn read_copilot_definition(
    app: &AppHandle,
    kind: &str,
    definition: &str,
    root: Option<&str>,
) -> Result<Value, String> {
    let (tool_name, argument_name) = match kind {
        "agents" | "agent" => ("read_agent_definition", "agent"),
        "skills" | "skill" => ("read_skill_definition", "skill"),
        _ => return Err(format!("Unsupported definition kind: {}", kind)),
    };
    let mut arguments = serde_json::Map::new();
    arguments.insert(
        argument_name.to_string(),
        Value::String(definition.to_string()),
    );
    if let Some(root) = root.map(str::trim).filter(|value| !value.is_empty()) {
        arguments.insert("root".to_string(), Value::String(root.to_string()));
    }
    arguments.insert("max_chars".to_string(), Value::from(120000));
    call_insights_mcp_tool_with_args(app, tool_name, Value::Object(arguments))
}

pub fn resolve_copilot_definition_path(
    kind: &str,
    definition: &str,
    root: Option<&str>,
) -> Result<PathBuf, String> {
    resolve_definition_path(kind, definition, root)
}

fn requires_insights_tools(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    [
        "prompt",
        "prompts",
        "skill",
        "skills",
        "agent",
        "agents",
        "sub-agent",
        "subagent",
        "mcp",
        "mcp server",
        "mcp servers",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn is_definition_gap_prompt(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    let mentions_definitions = [
        "skill",
        "skills",
        "agent",
        "agents",
        "sub-agent",
        "subagent",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let asks_for_gaps = [
        "gap",
        "gaps",
        "missing",
        "coverage",
        "readiness",
        "audit",
        "review",
        "improve",
        "weak",
        "weakness",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    mentions_definitions && asks_for_gaps
}

fn definition_gap_focus_instructions(definition_gap_prompt: bool) -> &'static str {
    if definition_gap_prompt {
        "Skill/agent gap focus: this prompt must be answered only from skill and agent concepts. Use analyze_copilot_skills and/or analyze_copilot_agents, then discuss definition coverage, routing clarity, activation boundaries, instructions, validation criteria, handoffs, duplication, overlap, and missing conceptual roles. Do not recommend generic tool-failure, web/docs retrieval, patch/editing, shell, token-control, model-usage, or usage-metric fixes unless the recommendation is explicitly framed as a missing or weak skill/agent concept."
    } else {
        "No special skill/agent-only focus is active for this question."
    }
}

fn is_mcp_usage_prompt(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    lower.contains("mcp")
        && [
            "usage", "server", "servers", "tool", "tools", "enabled", "disabled", "context",
            "token", "tokens",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn mcp_usage_report(conn: &Connection, range_days: u32) -> Result<McpUsageReport, String> {
    let today = local_day(unix_ms_now());
    let since_day = local_day_shift(&today, -((range_days as i64) - 1));
    let inventory = load_mcp_server_inventory();
    let mut tool_to_server = BTreeMap::<String, String>::new();
    let mut servers = BTreeMap::<String, McpServerUsage>::new();

    for server in inventory {
        let name = safe_label(&server.name, "mcp-server");
        for tool in &server.tools {
            tool_to_server
                .entry(tool.to_ascii_lowercase())
                .or_insert_with(|| name.clone());
        }
        servers.insert(
            name.clone(),
            McpServerUsage {
                name,
                configured: true,
                enabled: server.enabled,
                registered_tools: server.tools.len() as u64,
                ..Default::default()
            },
        );
    }

    for usage in mcp_tool_usage(conn, &since_day, &tool_to_server)? {
        let Some(server_name) = tool_to_server
            .get(&usage.tool.to_ascii_lowercase())
            .cloned()
            .or_else(|| infer_mcp_server_from_tool(&usage.tool, servers.keys(), &tool_to_server))
        else {
            continue;
        };
        let entry = servers
            .entry(server_name.clone())
            .or_insert_with(|| McpServerUsage {
                name: server_name,
                configured: false,
                enabled: true,
                registered_tools: 0,
                ..Default::default()
            });
        entry
            .tools
            .entry(usage.tool.clone())
            .and_modify(|existing| {
                existing.calls = existing.calls.saturating_add(usage.calls);
                existing.successes = existing.successes.saturating_add(usage.successes);
                existing.failures = existing.failures.saturating_add(usage.failures);
                existing.duration_ms = existing.duration_ms.saturating_add(usage.duration_ms);
            })
            .or_insert(usage);
    }

    let mut rows = Vec::new();
    let mut total_calls = 0_u64;
    let mut total_failures = 0_u64;
    let mut enabled_servers = 0_u64;
    let mut configured_servers = 0_u64;
    let mut used_servers = 0_u64;
    let mut registered_tools = 0_u64;

    for usage in servers.values() {
        if usage.configured {
            configured_servers += 1;
            registered_tools = registered_tools.saturating_add(usage.registered_tools);
            if usage.enabled {
                enabled_servers += 1;
            }
        }
        let calls: u64 = usage.tools.values().map(|tool| tool.calls).sum();
        let failures: u64 = usage.tools.values().map(|tool| tool.failures).sum();
        let successes: u64 = usage.tools.values().map(|tool| tool.successes).sum();
        let duration_ms: u64 = usage.tools.values().map(|tool| tool.duration_ms).sum();
        if calls > 0 {
            used_servers += 1;
        }
        total_calls = total_calls.saturating_add(calls);
        total_failures = total_failures.saturating_add(failures);
        let completed = successes.saturating_add(failures);
        rows.push(vec![
            usage.name.clone(),
            if usage.configured {
                if usage.enabled { "on" } else { "off" }.to_string()
            } else {
                "on".to_string()
            },
            usage.registered_tools.to_string(),
            usage.tools.len().to_string(),
            calls.to_string(),
            failures.to_string(),
            if completed > 0 {
                format!("{} ms", duration_ms / completed)
            } else {
                "n/a".to_string()
            },
            top_mcp_tools(&usage.tools),
            if usage.configured { "1" } else { "0" }.to_string(),
        ]);
    }

    let mut artifacts = Vec::new();
    artifacts.push(AnalyticsArtifact {
        kind: "cards".to_string(),
        title: "MCP Usage Summary".to_string(),
        cards: vec![
            AnalyticsRecommendation {
                title: "MCP calls".to_string(),
                body: format!(
                    "{} MCP tool call{} across {} server{} in the last {} day{}.",
                    total_calls,
                    plural(total_calls),
                    used_servers,
                    plural(used_servers),
                    range_days,
                    if range_days == 1 { "" } else { "s" }
                ),
                severity: "info".to_string(),
                metric: "mcp_calls".to_string(),
            },
            AnalyticsRecommendation {
                title: "Enabled servers".to_string(),
                body: format!(
                    "{} of {} configured MCP server{} appear enabled.",
                    enabled_servers,
                    configured_servers,
                    plural(configured_servers)
                ),
                severity: "info".to_string(),
                metric: "mcp_enabled_servers".to_string(),
            },
            AnalyticsRecommendation {
                title: "Context pressure".to_string(),
                body: format!(
                    "{} registered MCP tool{} can add tool-schema context when enabled; exact token cost is not emitted by Copilot CLI.",
                    registered_tools,
                    plural(registered_tools)
                ),
                severity: "review".to_string(),
                metric: "mcp_context_pressure".to_string(),
            },
        ],
        ..Default::default()
    });
    artifacts.push(AnalyticsArtifact {
        kind: "mcp_server_usage".to_string(),
        title: "MCP Server Usage".to_string(),
        description: "Enabled is read from the local MCP server registry. Registered tools and observed calls are shown because exact MCP schema/result token costs are not exposed in Copilot CLI analytics.".to_string(),
        columns: vec![
            "Server".to_string(),
            "Enabled".to_string(),
            "Registered tools".to_string(),
            "Used tools".to_string(),
            "Calls".to_string(),
            "Failures".to_string(),
            "Avg duration".to_string(),
            "Top tools".to_string(),
        ],
        rows,
        ..Default::default()
    });

    let mut caveats = vec![
        "Exact MCP token/context cost is unavailable from Copilot CLI events; Mission Control reports registered tool count and observed MCP calls as the closest local proxies.".to_string(),
    ];
    if configured_servers == 0 {
        caveats.push(
            "No local MCP server registry was found, so the table only includes MCP tools observed in history."
                .to_string(),
        );
    }

    Ok(McpUsageReport {
        total_calls,
        total_failures,
        enabled_servers,
        configured_servers,
        used_servers,
        registered_tools,
        artifacts,
        caveats,
    })
}

fn mcp_tool_usage(
    conn: &Connection,
    since_day: &str,
    tool_to_server: &BTreeMap<String, String>,
) -> Result<Vec<McpToolUsage>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT tool_name,
                   tool_category,
                   COALESCE(SUM(call_count), 0),
                   COALESCE(SUM(success_count), 0),
                   COALESCE(SUM(failure_count), 0),
                   COALESCE(SUM(total_duration_ms), 0)
            FROM tool_rollups
            WHERE local_day >= ?1
            GROUP BY tool_name, tool_category
            ORDER BY SUM(call_count) DESC, tool_name ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![since_day], |row| {
            let tool: String = row.get(0)?;
            let category: String = row.get(1)?;
            Ok((
                tool,
                category,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|err| err.to_string())?;
    let mut usage = Vec::new();
    for row in rows {
        let (tool, category, calls, successes, failures, duration_ms) =
            row.map_err(|err| err.to_string())?;
        let is_mcp = category == "mcp" || tool_to_server.contains_key(&tool.to_ascii_lowercase());
        if !is_mcp {
            continue;
        }
        usage.push(McpToolUsage {
            tool,
            calls: calls.max(0) as u64,
            successes: successes.max(0) as u64,
            failures: failures.max(0) as u64,
            duration_ms: duration_ms.max(0) as u64,
        });
    }
    Ok(usage)
}

fn load_mcp_server_inventory() -> Vec<McpServerInventory> {
    let Some(path) = mcp_registry_path() else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    mcp_server_inventory_from_value(&value)
}

fn mcp_registry_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .map(|home| home.join(".copilot").join("m-mcp-servers.json"))
}

pub fn set_mcp_server_enabled(server: &str, enabled: bool) -> Result<Value, String> {
    let safe_server = safe_label(server, "");
    if safe_server.is_empty() {
        return Err("MCP server name is required.".to_string());
    }
    let path = mcp_registry_path().ok_or_else(|| "Unable to locate home directory.".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let mut value = serde_json::from_str::<Value>(&raw).map_err(|err| err.to_string())?;
    let servers = value
        .get_mut("servers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "MCP registry does not contain a servers object.".to_string())?;
    let server_key = if servers.contains_key(&safe_server) {
        safe_server.clone()
    } else if servers.contains_key(server) {
        server.to_string()
    } else {
        return Err(format!(
            "MCP server '{}' was not found in the local registry.",
            safe_server
        ));
    };
    let entry = servers.get_mut(&server_key).ok_or_else(|| {
        format!(
            "MCP server '{}' was not found in the local registry.",
            safe_server
        )
    })?;
    let object = entry.as_object_mut().ok_or_else(|| {
        format!(
            "MCP server '{}' has an unsupported registry shape.",
            safe_server
        )
    })?;
    object.insert("disabled".to_string(), Value::Bool(!enabled));
    object.insert("enabled".to_string(), Value::Bool(enabled));
    let pretty = serde_json::to_string_pretty(&value).map_err(|err| err.to_string())?;
    fs::write(&path, format!("{}\n", pretty)).map_err(|err| err.to_string())?;
    Ok(serde_json::json!({
        "server": safe_server,
        "enabled": enabled
    }))
}

fn mcp_server_inventory_from_value(value: &Value) -> Vec<McpServerInventory> {
    let Some(servers) = value_at_path(value, "servers").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut inventory = Vec::new();
    for (name, info) in servers {
        let tools = mcp_tool_names_from_value(info);
        inventory.push(McpServerInventory {
            name: safe_label(name, "mcp-server"),
            enabled: mcp_server_is_enabled(info),
            tools,
        });
    }
    inventory.sort_by(|a, b| a.name.cmp(&b.name));
    inventory
}

fn mcp_tool_names_from_value(value: &Value) -> BTreeSet<String> {
    let mut tools = BTreeSet::new();
    let Some(items) = value.get("tools").and_then(Value::as_array) else {
        return tools;
    };
    for item in items {
        let name = item.as_str().map(str::to_string).or_else(|| {
            item.get("name")
                .or_else(|| item.get("tool"))
                .or_else(|| item.get("toolName"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        if let Some(name) = name {
            let safe = safe_label(&name, "");
            if !safe.is_empty() {
                tools.insert(safe);
            }
        }
    }
    tools
}

fn mcp_server_is_enabled(value: &Value) -> bool {
    if bool_at_path(value, "disabled").unwrap_or(false)
        || bool_at_path(value, "config.disabled").unwrap_or(false)
    {
        return false;
    }
    if matches!(bool_at_path(value, "enabled"), Some(false))
        || matches!(bool_at_path(value, "config.enabled"), Some(false))
    {
        return false;
    }
    if let Some(status) = string_at_path(value, "status")
        .or_else(|| string_at_path(value, "state"))
        .or_else(|| string_at_path(value, "config.status"))
    {
        let normalized = status.to_ascii_lowercase();
        if matches!(normalized.as_str(), "disabled" | "off" | "inactive") {
            return false;
        }
    }
    true
}

fn infer_mcp_server_from_tool<'a, I>(
    tool: &str,
    configured_servers: I,
    tool_to_server: &BTreeMap<String, String>,
) -> Option<String>
where
    I: IntoIterator<Item = &'a String>,
{
    let lower = tool.to_ascii_lowercase();
    if let Some(server) = tool_to_server.get(&lower) {
        return Some(server.clone());
    }
    for server in configured_servers {
        let server_lower = server.to_ascii_lowercase();
        if lower.starts_with(&server_lower)
            || (server_lower == "playwright" && lower.starts_with("browser_"))
            || (server_lower == "filesystem"
                && (lower.contains("file")
                    || lower.contains("directory")
                    || lower.contains("path")
                    || lower.contains("tree")))
        {
            return Some(server.clone());
        }
    }
    for prefix in [
        "github-mcp-server",
        "kit-dev-mcp",
        "context7",
        "microsoft-learn",
        "azure",
        "devbox",
        "workiq",
    ] {
        if lower.starts_with(prefix) {
            return Some(prefix.to_string());
        }
    }
    None
}

fn top_mcp_tools(tools: &BTreeMap<String, McpToolUsage>) -> String {
    let mut ranked: Vec<_> = tools.values().collect();
    ranked.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.tool.cmp(&b.tool)));
    if ranked.is_empty() {
        return "No calls in range".to_string();
    }
    ranked
        .into_iter()
        .take(3)
        .map(|tool| format!("{} ({})", tool.tool, tool.calls))
        .collect::<Vec<_>>()
        .join(", ")
}

fn mcp_usage_answer(range_days: u32, report: &McpUsageReport) -> String {
    if report.configured_servers == 0 && report.total_calls == 0 {
        return format!(
            "I did not find configured MCP servers or observed MCP tool usage in the last {} day{}.",
            range_days,
            if range_days == 1 { "" } else { "s" }
        );
    }
    format!(
        "I found {} MCP tool call{} across {} used server{} in the last {} day{}, including {} failure{}. {} of {} configured MCP server{} appear enabled, with {} registered tool{} exposed. Exact MCP schema/result token cost is not emitted by Copilot CLI, so the table uses registered tool count and observed calls as context-impact proxies.",
        report.total_calls,
        plural(report.total_calls),
        report.used_servers,
        plural(report.used_servers),
        range_days,
        if range_days == 1 { "" } else { "s" },
        report.total_failures,
        plural(report.total_failures),
        report.enabled_servers,
        report.configured_servers,
        plural(report.configured_servers),
        report.registered_tools,
        plural(report.registered_tools)
    )
}

fn merge_caveats(primary: Vec<String>, secondary: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut merged = Vec::new();
    for caveat in primary.into_iter().chain(secondary) {
        if seen.insert(caveat.clone()) {
            merged.push(caveat);
        }
    }
    merged
}

fn open_connection(app: &AppHandle) -> Result<Connection, String> {
    let dir = analytics_dir(app)?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let conn = Connection::open(dir.join(ANALYTICS_DB_FILE)).map_err(|err| err.to_string())?;
    conn.busy_timeout(Duration::from_secs(15))
        .map_err(|err| err.to_string())?;
    if let Err(err) = conn.pragma_update(None, "journal_mode", "WAL") {
        if !is_sqlite_locked_error(&err) {
            return Err(err.to_string());
        }
        log::debug!("Analytics database is busy while enabling WAL: {}", err);
    }
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|err| err.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|err| err.to_string())?;
    Ok(conn)
}

fn is_sqlite_locked_error(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(error, _)
            if matches!(
                error.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            )
    )
}

fn analytics_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("analytics"))
}

fn ensure_schema(app: &AppHandle, conn: &mut Connection) -> Result<(), String> {
    let db_path = analytics_dir(app)?.join(ANALYTICS_DB_FILE);
    if schema_ready_for(&db_path) {
        return Ok(());
    }
    conn.execute(
        "CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )
    .map_err(|err| err.to_string())?;
    let current_schema = db_schema_version(conn)?;
    if current_schema != SCHEMA_VERSION {
        rebuild_analytics_schema(conn)?;
    }
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS analytics_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ingestion_cursors (
            provider TEXT NOT NULL,
            source_id_hash TEXT NOT NULL,
            last_offset INTEGER NOT NULL DEFAULT 0,
            source_generation INTEGER NOT NULL DEFAULT 0,
            last_ingested_at_ms INTEGER NOT NULL,
            PRIMARY KEY (provider, source_id_hash)
        );

        CREATE TABLE IF NOT EXISTS sessions (
            provider TEXT NOT NULL,
            session_id_hash TEXT NOT NULL,
            repository TEXT NOT NULL DEFAULT '',
            branch TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            first_seen_ms INTEGER NOT NULL,
            last_seen_ms INTEGER NOT NULL,
            status TEXT NOT NULL,
            is_active INTEGER NOT NULL,
            event_count INTEGER NOT NULL,
            tool_count INTEGER NOT NULL,
            turn_count INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            input_tokens_known INTEGER NOT NULL,
            output_tokens_known INTEGER NOT NULL,
            token_data_partial INTEGER NOT NULL,
            last_model TEXT NOT NULL,
            PRIMARY KEY (provider, session_id_hash)
        );

        CREATE TABLE IF NOT EXISTS daily_rollups (
            provider TEXT NOT NULL,
            local_day TEXT NOT NULL,
            bucket_start_ms INTEGER NOT NULL,
            bucket_end_ms INTEGER NOT NULL,
            timezone_offset_minutes INTEGER NOT NULL,
            session_count INTEGER NOT NULL,
            event_count INTEGER NOT NULL,
            turn_count INTEGER NOT NULL,
            tool_call_count INTEGER NOT NULL,
            failure_count INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            estimated_active_ms INTEGER NOT NULL,
            token_data_partial INTEGER NOT NULL,
            PRIMARY KEY (provider, local_day)
        );

        CREATE TABLE IF NOT EXISTS model_rollups (
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            local_day TEXT NOT NULL,
            session_count INTEGER NOT NULL,
            turn_count INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            token_data_partial INTEGER NOT NULL,
            PRIMARY KEY (provider, model, local_day)
        );

        CREATE TABLE IF NOT EXISTS category_rollups (
            provider TEXT NOT NULL,
            category TEXT NOT NULL,
            local_day TEXT NOT NULL,
            turn_count INTEGER NOT NULL,
            tool_call_count INTEGER NOT NULL,
            failure_count INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            token_data_partial INTEGER NOT NULL,
            PRIMARY KEY (provider, category, local_day)
        );

        CREATE TABLE IF NOT EXISTS tool_rollups (
            provider TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            tool_category TEXT NOT NULL,
            local_day TEXT NOT NULL,
            call_count INTEGER NOT NULL,
            success_count INTEGER NOT NULL,
            failure_count INTEGER NOT NULL,
            total_duration_ms INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (provider, tool_name, tool_category, local_day)
        );

        CREATE TABLE IF NOT EXISTS failure_rollups (
            provider TEXT NOT NULL,
            kind TEXT NOT NULL,
            tool TEXT NOT NULL,
            category TEXT NOT NULL,
            local_day TEXT NOT NULL,
            count INTEGER NOT NULL,
            last_seen_ms INTEGER NOT NULL,
            PRIMARY KEY (provider, kind, tool, category, local_day)
        );

        CREATE TABLE IF NOT EXISTS recent_event_facts (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            session_id_hash TEXT NOT NULL,
            event_key TEXT NOT NULL,
            occurred_at_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            tool TEXT NOT NULL,
            category TEXT NOT NULL,
            success INTEGER NOT NULL,
            input_tokens INTEGER,
            output_tokens INTEGER,
            safe_detail_kind TEXT NOT NULL DEFAULT '',
            safe_detail_value TEXT NOT NULL DEFAULT '',
            safe_detail_is_estimate INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS ingested_event_keys (
            provider TEXT NOT NULL,
            source_id_hash TEXT NOT NULL,
            event_key TEXT NOT NULL,
            occurred_at_ms INTEGER,
            ingested_at_ms INTEGER NOT NULL,
            rollup_version INTEGER NOT NULL,
            PRIMARY KEY (provider, source_id_hash, event_key, rollup_version)
        );

        CREATE TABLE IF NOT EXISTS ingestion_audit (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            source_id_hash TEXT,
            occurred_at_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            severity TEXT NOT NULL,
            safe_code TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS analytics_size_audit (
            id TEXT PRIMARY KEY,
            occurred_at_ms INTEGER NOT NULL,
            db_size_bytes INTEGER NOT NULL,
            soft_cap_exceeded INTEGER NOT NULL,
            hard_cap_exceeded INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "INSERT OR REPLACE INTO analytics_meta (key, value) VALUES ('schema_version', ?1)",
        params![SCHEMA_VERSION.to_string()],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    mark_schema_ready(db_path);
    Ok(())
}

fn db_schema_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT value FROM analytics_meta WHERE key = 'schema_version'",
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
    .map(|value| value.and_then(|raw| raw.parse::<i64>().ok()).unwrap_or(0))
}

fn rebuild_analytics_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        DROP TABLE IF EXISTS analytics_meta;
        DROP TABLE IF EXISTS ingestion_cursors;
        DROP TABLE IF EXISTS sessions;
        DROP TABLE IF EXISTS daily_rollups;
        DROP TABLE IF EXISTS model_rollups;
        DROP TABLE IF EXISTS category_rollups;
        DROP TABLE IF EXISTS tool_rollups;
        DROP TABLE IF EXISTS failure_rollups;
        DROP TABLE IF EXISTS recent_event_facts;
        DROP TABLE IF EXISTS ingested_event_keys;
        DROP TABLE IF EXISTS ingestion_audit;
        "#,
    )
    .map_err(|err| err.to_string())
}

fn ensure_recent_ingestion(app: &AppHandle) -> Result<(), String> {
    let mut conn = open_connection(app)?;
    ensure_schema(app, &mut conn)?;
    let last: Option<i64> = conn
        .query_row(
            "SELECT MAX(last_ingested_at_ms) FROM ingestion_cursors",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten();
    let generation: Option<i64> = conn
        .query_row(
            "SELECT MAX(source_generation) FROM ingestion_cursors",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten();
    let now = unix_ms_now() as i64;
    if last
        .map(|value| now.saturating_sub(value) > INGEST_STALE_MS)
        .unwrap_or(true)
        || generation
            .map(|value| value < ROLLUP_VERSION)
            .unwrap_or(true)
    {
        start_background_ingestion(app.clone());
    }
    Ok(())
}

fn schema_ready_for(path: &Path) -> bool {
    SCHEMA_READY_DB
        .lock()
        .map(|ready_path| ready_path.as_deref() == Some(path))
        .unwrap_or(false)
}

fn mark_schema_ready(path: PathBuf) {
    if let Ok(mut ready_path) = SCHEMA_READY_DB.lock() {
        *ready_path = Some(path);
    }
}

fn begin_ingestion() -> bool {
    INGESTION_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

fn finish_ingestion(app: &AppHandle) {
    INGESTION_RUNNING.store(false, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window("main") {
        let _ =
            win.eval("window.__cmcAnalyticsStatusChanged && window.__cmcAnalyticsStatusChanged()");
    }
}

fn ingestion_running() -> bool {
    INGESTION_RUNNING.load(Ordering::SeqCst)
}

fn ingest_activity(conn: &mut Connection, activity: &AgentActivity) -> Result<(), String> {
    let now = unix_ms_now();
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    tx.execute_batch(
        r#"
        DELETE FROM sessions;
        DELETE FROM daily_rollups;
        DELETE FROM model_rollups;
        DELETE FROM category_rollups;
        DELETE FROM tool_rollups;
        DELETE FROM failure_rollups;
        DELETE FROM recent_event_facts;
        "#,
    )
    .map_err(|err| err.to_string())?;

    let mut daily = BTreeMap::<(String, String), DailyAccumulator>::new();
    let mut model = BTreeMap::<(String, String, String), ModelAccumulator>::new();
    let mut category = BTreeMap::<(String, String, String), CategoryAccumulator>::new();
    let mut tools = BTreeMap::<(String, String, String, String), ToolAccumulator>::new();
    let mut failures =
        BTreeMap::<(String, String, String, String, String), FailureAccumulator>::new();

    for session in &activity.sessions {
        ingest_session(
            &tx,
            session,
            &mut daily,
            &mut model,
            &mut category,
            &mut tools,
            now,
        )?;
    }

    for event in &activity.recent_events {
        ingest_event(&tx, event, &mut daily, &mut category, &mut failures, now)?;
    }

    write_daily_rollups(&tx, daily)?;
    write_model_rollups(&tx, model)?;
    write_category_rollups(&tx, category)?;
    write_tool_rollups(&tx, tools)?;
    write_failure_rollups(&tx, failures)?;
    write_audits(&tx, activity, now)?;
    tx.commit().map_err(|err| err.to_string())
}

fn ingest_local_copilot_history(conn: &mut Connection) -> Result<bool, String> {
    let Some(root) = local_copilot_history_root() else {
        return Ok(false);
    };
    if !root.is_dir() {
        return Ok(false);
    }

    let now = unix_ms_now();
    let start_day = local_day_shift(&local_day(now), -((LOCAL_HISTORY_INGEST_DAYS as i64) - 1));
    let (since_ms, _, _) = local_day_bounds(&start_day);
    let mut rollups = LocalHistoryRollups::default();
    let mut scanned_files = 0_u64;
    let mut parse_errors = 0_u64;

    for entry in fs::read_dir(&root).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let session_dir = entry.path();
        if !session_dir.is_dir() {
            continue;
        }
        let events_path = session_dir.join("events.jsonl");
        let Ok(metadata) = fs::metadata(&events_path) else {
            continue;
        };
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(system_time_to_ms)
            .unwrap_or(0);
        if modified_ms < since_ms {
            continue;
        }
        scanned_files += 1;
        let session_id = session_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("session");
        let metadata = read_local_session_metadata(&session_dir);
        parse_local_events_file(
            &events_path,
            session_id,
            metadata,
            since_ms,
            now,
            &mut rollups,
            &mut parse_errors,
        )?;
    }

    if scanned_files == 0 {
        return Ok(false);
    }

    let tx = conn.transaction().map_err(|err| err.to_string())?;
    delete_analytics_range(&tx, &start_day)?;
    write_local_sessions(&tx, rollups.sessions)?;
    write_event_facts(&tx, rollups.event_facts)?;
    write_daily_rollups(&tx, rollups.daily)?;
    write_model_rollups(&tx, rollups.model)?;
    write_category_rollups(&tx, rollups.category)?;
    write_tool_rollups(&tx, rollups.tools)?;
    write_failure_rollups(&tx, rollups.failures)?;
    write_local_history_audit(&tx, now, scanned_files, parse_errors)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(true)
}

fn delete_analytics_range(conn: &Connection, start_day: &str) -> Result<(), String> {
    let (start_ms, _, _) = local_day_bounds(start_day);
    for table in [
        "daily_rollups",
        "model_rollups",
        "category_rollups",
        "tool_rollups",
        "failure_rollups",
    ] {
        conn.execute(
            &format!("DELETE FROM {} WHERE local_day >= ?1", table),
            params![start_day],
        )
        .map_err(|err| err.to_string())?;
    }
    conn.execute(
        "DELETE FROM sessions WHERE last_seen_ms >= ?1",
        params![start_ms as i64],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM recent_event_facts WHERE occurred_at_ms >= ?1",
        params![start_ms as i64],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Default)]
struct LocalHistoryRollups {
    sessions: Vec<AnalyticsSessionRow>,
    event_facts: Vec<AnalyticsEventFact>,
    daily: BTreeMap<(String, String), DailyAccumulator>,
    model: BTreeMap<(String, String, String), ModelAccumulator>,
    category: BTreeMap<(String, String, String), CategoryAccumulator>,
    tools: BTreeMap<(String, String, String, String), ToolAccumulator>,
    failures: BTreeMap<(String, String, String, String, String), FailureAccumulator>,
}

#[derive(Default)]
struct AnalyticsSessionRow {
    provider: String,
    session_id_hash: String,
    repository: String,
    branch: String,
    title: String,
    first_seen_ms: u64,
    last_seen_ms: u64,
    status: String,
    is_active: bool,
    event_count: u64,
    tool_count: u64,
    turn_count: u64,
    input_tokens: u64,
    output_tokens: u64,
    input_tokens_known: bool,
    output_tokens_known: bool,
    token_data_partial: bool,
    last_model: String,
}

struct AnalyticsEventFact {
    id: String,
    provider: String,
    session_id_hash: String,
    event_key: String,
    occurred_at_ms: u64,
    kind: String,
    tool: String,
    category: String,
    success: bool,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

#[derive(Default)]
struct LocalSessionBuilder {
    session_hash: String,
    repository: String,
    branch: String,
    title: String,
    first_seen_ms: u64,
    last_seen_ms: u64,
    event_count: u64,
    tool_count: u64,
    turn_count: u64,
    input_tokens: u64,
    output_tokens: u64,
    last_model: String,
    last_status: String,
    pending_tools: HashMap<String, PendingLocalTool>,
    model_tokens: BTreeMap<String, LocalModelTokenAccumulator>,
}

#[derive(Default)]
struct LocalModelTokenAccumulator {
    assistant_output_tokens: u64,
    shutdown_input_tokens: u64,
    shutdown_output_tokens: u64,
}

struct PendingLocalTool {
    tool: String,
    category: String,
    started_at_ms: u64,
}

#[derive(Default)]
struct LocalSessionMetadata {
    repository: String,
    branch: String,
    title: String,
}

fn read_local_session_metadata(session_dir: &Path) -> LocalSessionMetadata {
    let mut values = BTreeMap::<String, String>::new();
    let workspace_path = session_dir.join("workspace.yaml");
    if let Ok(content) = fs::read_to_string(workspace_path) {
        for line in content.lines() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim();
            if !matches!(
                key,
                "repository" | "branch" | "name" | "summary" | "git_root"
            ) {
                continue;
            }
            values.insert(
                key.to_string(),
                value
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string(),
            );
        }
    }
    let repository = values
        .get("repository")
        .or_else(|| values.get("git_root"))
        .map(|value| sanitize_repository_label(value))
        .unwrap_or_else(|| "Unknown".to_string());
    let branch = values
        .get("branch")
        .map(|value| sanitize_branch_label(value))
        .unwrap_or_else(|| "unknown".to_string());
    let title = values
        .get("name")
        .or_else(|| values.get("summary"))
        .map(|value| sanitize_title_label(value))
        .filter(|value| value != "Untitled")
        .unwrap_or_else(|| format!("{} {}", repository, branch));
    LocalSessionMetadata {
        repository,
        branch,
        title,
    }
}

fn parse_local_events_file(
    path: &Path,
    session_id: &str,
    metadata: LocalSessionMetadata,
    since_ms: u64,
    now: u64,
    rollups: &mut LocalHistoryRollups,
    parse_errors: &mut u64,
) -> Result<(), String> {
    if file_contains_mission_control_marker(path)? {
        return Ok(());
    }
    let file = File::open(path).map_err(|err| err.to_string())?;
    let reader = BufReader::new(file);
    let provider = LOCAL_HISTORY_PROVIDER.to_string();
    let session_hash = hash_with_provider(&provider, session_id);
    let mut session = LocalSessionBuilder {
        session_hash: session_hash.clone(),
        repository: metadata.repository,
        branch: metadata.branch,
        title: metadata.title,
        last_status: "completed".to_string(),
        ..Default::default()
    };

    for line in reader.lines() {
        let line = line.map_err(|err| err.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            *parse_errors += 1;
            continue;
        };
        let event_type = string_at_path(&value, "type").unwrap_or_default();
        let timestamp = string_at_path(&value, "timestamp").unwrap_or_default();
        let event_ms = parse_iso_ms(&timestamp).unwrap_or(now);
        if event_ms < since_ms {
            continue;
        }

        session.event_count += 1;
        session.first_seen_ms = if session.first_seen_ms == 0 {
            event_ms
        } else {
            session.first_seen_ms.min(event_ms)
        };
        session.last_seen_ms = session.last_seen_ms.max(event_ms);

        let day = local_day(event_ms);
        add_daily_event(rollups, &provider, &session_hash, &day, event_ms);
        let (tool, category, success) = apply_local_event(
            &value,
            &event_type,
            event_ms,
            &day,
            &provider,
            &mut session,
            rollups,
        );
        rollups.event_facts.push(AnalyticsEventFact {
            id: hash_str(&format!(
                "{}:{}:{}",
                provider,
                session_hash,
                event_id(&value, event_ms)
            )),
            provider: provider.clone(),
            session_id_hash: session_hash.clone(),
            event_key: event_id(&value, event_ms),
            occurred_at_ms: event_ms,
            kind: safe_label(&event_type, "activity"),
            tool,
            category,
            success,
            input_tokens: Some(session.input_tokens),
            output_tokens: Some(session.output_tokens),
        });
    }

    if session.event_count == 0 {
        return Ok(());
    }
    if session.last_status == "running" && now.saturating_sub(session.last_seen_ms) > 10 * 60 * 1000
    {
        session.last_status = "idle".to_string();
    }
    let token_day = local_day(session.last_seen_ms);
    reconcile_local_session_model_tokens(&mut session, rollups, &provider, &token_day);
    let input_known = session.input_tokens > 0
        || session.output_tokens == 0
        || session.last_status == "completed";
    if let Some(daily) = rollups.daily.get_mut(&(provider.clone(), token_day)) {
        daily.input_tokens = daily.input_tokens.saturating_add(session.input_tokens);
        daily.output_tokens = daily.output_tokens.saturating_add(session.output_tokens);
        daily.token_data_partial |= !input_known;
    }
    rollups.sessions.push(AnalyticsSessionRow {
        provider,
        session_id_hash: session_hash,
        repository: session.repository,
        branch: session.branch,
        title: session.title,
        first_seen_ms: session.first_seen_ms,
        last_seen_ms: session.last_seen_ms,
        status: session.last_status,
        is_active: now.saturating_sub(session.last_seen_ms) <= 5 * 60 * 1000,
        event_count: session.event_count,
        tool_count: session.tool_count,
        turn_count: session.turn_count,
        input_tokens: session.input_tokens,
        output_tokens: session.output_tokens,
        input_tokens_known: input_known,
        output_tokens_known: true,
        token_data_partial: !input_known,
        last_model: safe_label(&session.last_model, "Unknown"),
    });
    Ok(())
}

fn file_contains_mission_control_marker(path: &Path) -> Result<bool, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let line = line.map_err(|err| err.to_string())?;
        if line_marks_mission_control_analytics_session(&line) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn line_marks_mission_control_analytics_session(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
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

fn apply_local_event(
    value: &Value,
    event_type: &str,
    event_ms: u64,
    day: &str,
    provider: &str,
    session: &mut LocalSessionBuilder,
    rollups: &mut LocalHistoryRollups,
) -> (String, String, bool) {
    match event_type {
        "session.start" => {
            session.last_status = "running".to_string();
            if let Some(model) = string_at_path(value, "data.selectedModel") {
                session.last_model = safe_label(&model, "Unknown");
            }
            ("session".to_string(), "arrival".to_string(), true)
        }
        "session.model_change" => {
            if let Some(model) = string_at_path(value, "data.newModel") {
                session.last_model = safe_label(&model, "Unknown");
            }
            ("model".to_string(), "activity".to_string(), true)
        }
        "assistant.turn_start" => {
            session.turn_count += 1;
            if let Some(daily) = rollups
                .daily
                .get_mut(&(provider.to_string(), day.to_string()))
            {
                daily.turn_count += 1;
            }
            add_model_turn(
                rollups,
                provider,
                day,
                &session.session_hash,
                &session.last_model,
            );
            ("turn".to_string(), "thinking".to_string(), true)
        }
        "assistant.message" => {
            if let Some(model) = string_at_path(value, "data.model") {
                session.last_model = safe_label(&model, "Unknown");
            }
            if let Some(tokens) = u64_at_path(value, "data.outputTokens") {
                session.output_tokens = session.output_tokens.saturating_add(tokens);
                record_session_model_assistant_output(session, tokens);
            }
            ("assistant".to_string(), "activity".to_string(), true)
        }
        "tool.execution_start" => {
            let raw_tool =
                string_at_path(value, "data.toolName").unwrap_or_else(|| "tool".to_string());
            let args = value_at_path(value, "data.arguments");
            let (tool, category) = classify_local_tool(&raw_tool, args);
            let call_id = string_at_path(value, "data.toolCallId").unwrap_or_else(|| tool.clone());
            session.tool_count += 1;
            if let Some(daily) = rollups
                .daily
                .get_mut(&(provider.to_string(), day.to_string()))
            {
                daily.tool_call_count += 1;
            }
            session.pending_tools.insert(
                call_id,
                PendingLocalTool {
                    tool: tool.clone(),
                    category: category.clone(),
                    started_at_ms: event_ms,
                },
            );
            add_category_count(
                &mut rollups.category,
                provider,
                &category,
                day,
                0,
                1,
                0,
                false,
            );
            add_tool_started(&mut rollups.tools, provider, &tool, &category, day);
            (tool, category, true)
        }
        "tool.execution_complete" => {
            if let Some(model) = string_at_path(value, "data.model") {
                session.last_model = safe_label(&model, "Unknown");
            }
            let success = bool_at_path(value, "data.success").unwrap_or(true);
            let call_id = string_at_path(value, "data.toolCallId").unwrap_or_default();
            if let Some(start) = session.pending_tools.remove(&call_id) {
                let duration = event_ms.saturating_sub(start.started_at_ms);
                add_tool_completed(
                    &mut rollups.tools,
                    provider,
                    &start.tool,
                    &start.category,
                    day,
                    success,
                    duration,
                );
                if !success {
                    add_failure(
                        rollups,
                        provider,
                        "tool.execution_complete",
                        &start.tool,
                        &start.category,
                        day,
                        event_ms,
                    );
                }
                return (start.tool, start.category, success);
            }
            (
                "tool".to_string(),
                if success { "complete" } else { "alert" }.to_string(),
                success,
            )
        }
        "hook.start" => {
            add_category_count(
                &mut rollups.category,
                provider,
                "hooks",
                day,
                0,
                1,
                0,
                false,
            );
            (
                string_at_path(value, "data.hookType").unwrap_or_else(|| "hook".to_string()),
                "hooks".to_string(),
                true,
            )
        }
        "hook.end" => {
            let success = bool_at_path(value, "data.success").unwrap_or(true);
            let hook = string_at_path(value, "data.hookType").unwrap_or_else(|| "hook".to_string());
            if !success {
                add_failure(rollups, provider, event_type, &hook, "hooks", day, event_ms);
            }
            (hook, "hooks".to_string(), success)
        }
        "skill.invoked" => {
            let skill = string_at_path(value, "data.name").unwrap_or_else(|| "skill".to_string());
            add_category_count(
                &mut rollups.category,
                provider,
                "skills",
                day,
                0,
                1,
                0,
                false,
            );
            (safe_label(&skill, "skill"), "skills".to_string(), true)
        }
        "subagent.started" | "subagent.completed" => {
            add_category_count(
                &mut rollups.category,
                provider,
                "delegates",
                day,
                0,
                1,
                0,
                false,
            );
            ("subagent".to_string(), "delegates".to_string(), true)
        }
        "session.shutdown" => {
            session.last_status = "completed".to_string();
            if let Some(model) = string_at_path(value, "data.currentModel") {
                session.last_model = safe_label(&model, "Unknown");
            }
            let (input, output, by_model) = shutdown_token_totals(value);
            session.input_tokens = session.input_tokens.max(input);
            session.output_tokens = session.output_tokens.max(output);
            for (model, input, output) in by_model {
                record_session_model_shutdown_tokens(session, &model, input, output);
            }
            ("session".to_string(), "activity".to_string(), true)
        }
        "session.error" | "abort" | "session.warning" => {
            add_failure(
                rollups, provider, event_type, "session", "alert", day, event_ms,
            );
            ("session".to_string(), "alert".to_string(), false)
        }

        "user.message" => ("user".to_string(), "prompt".to_string(), true),
        "assistant.turn_end" => ("turn".to_string(), "waiting".to_string(), true),
        _ => ("event".to_string(), "activity".to_string(), true),
    }
}

fn record_session_model_assistant_output(session: &mut LocalSessionBuilder, output_tokens: u64) {
    if output_tokens == 0 {
        return;
    }
    let model = safe_label(&session.last_model, "Unknown");
    let acc = session.model_tokens.entry(model).or_default();
    acc.assistant_output_tokens = acc.assistant_output_tokens.saturating_add(output_tokens);
}

fn record_session_model_shutdown_tokens(
    session: &mut LocalSessionBuilder,
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
) {
    if input_tokens == 0 && output_tokens == 0 {
        return;
    }
    let model = safe_label(model, "Unknown");
    let acc = session.model_tokens.entry(model).or_default();
    acc.shutdown_input_tokens = acc.shutdown_input_tokens.max(input_tokens);
    acc.shutdown_output_tokens = acc.shutdown_output_tokens.max(output_tokens);
}

fn reconcile_local_session_model_tokens(
    session: &mut LocalSessionBuilder,
    rollups: &mut LocalHistoryRollups,
    provider: &str,
    day: &str,
) {
    let mut resolved = BTreeMap::<String, (u64, u64, bool)>::new();
    for (model, acc) in &session.model_tokens {
        let input = acc.shutdown_input_tokens;
        let output = acc.shutdown_output_tokens.max(acc.assistant_output_tokens);
        if model == "Unknown" && input == 0 && output == 0 {
            continue;
        }
        resolved.insert(
            model.clone(),
            (
                input,
                output,
                acc.shutdown_input_tokens == 0 && acc.shutdown_output_tokens == 0,
            ),
        );
    }

    let input_sum = resolved
        .values()
        .fold(0_u64, |sum, (input, _, _)| sum.saturating_add(*input));
    let output_sum = resolved
        .values()
        .fold(0_u64, |sum, (_, output, _)| sum.saturating_add(*output));
    let input_target = session.input_tokens.max(input_sum);
    let output_target = session.output_tokens.max(output_sum);
    let residual_input = input_target.saturating_sub(input_sum);
    let residual_output = output_target.saturating_sub(output_sum);
    if residual_input > 0 || residual_output > 0 {
        let model = safe_label(&session.last_model, "Unknown");
        let entry = resolved.entry(model).or_insert((0, 0, false));
        entry.0 = entry.0.saturating_add(residual_input);
        entry.1 = entry.1.saturating_add(residual_output);
        entry.2 |= session.last_status != "completed";
    }

    let final_input = resolved
        .values()
        .fold(0_u64, |sum, (input, _, _)| sum.saturating_add(*input));
    let final_output = resolved
        .values()
        .fold(0_u64, |sum, (_, output, _)| sum.saturating_add(*output));
    session.input_tokens = final_input;
    session.output_tokens = final_output;

    for (model, (input, output, partial)) in resolved {
        add_model_tokens(
            rollups,
            provider,
            day,
            &session.session_hash,
            &model,
            input,
            output,
            partial,
        );
    }
}

fn add_daily_event(
    rollups: &mut LocalHistoryRollups,
    provider: &str,
    session_hash: &str,
    day: &str,
    event_ms: u64,
) {
    let acc = rollups
        .daily
        .entry((provider.to_string(), day.to_string()))
        .or_insert_with(|| DailyAccumulator::new(event_ms));
    acc.session_ids.insert(session_hash.to_string());
    acc.event_count += 1;
    acc.estimated_active_ms += estimate_active_ms(1);
}

fn add_model_turn(
    rollups: &mut LocalHistoryRollups,
    provider: &str,
    day: &str,
    session_hash: &str,
    model: &str,
) {
    let model = safe_label(model, "Unknown");
    if model == "Unknown" {
        return;
    }
    let acc = rollups
        .model
        .entry((provider.to_string(), model, day.to_string()))
        .or_default();
    acc.session_ids.insert(session_hash.to_string());
    acc.turn_count += 1;
}

fn add_model_tokens(
    rollups: &mut LocalHistoryRollups,
    provider: &str,
    day: &str,
    session_hash: &str,
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    partial: bool,
) {
    let model = safe_label(model, "Unknown");
    if model == "Unknown" && input_tokens == 0 && output_tokens == 0 {
        return;
    }
    let acc = rollups
        .model
        .entry((provider.to_string(), model, day.to_string()))
        .or_default();
    acc.session_ids.insert(session_hash.to_string());
    acc.input_tokens = acc.input_tokens.saturating_add(input_tokens);
    acc.output_tokens = acc.output_tokens.saturating_add(output_tokens);
    acc.token_data_partial |= partial;
}

fn add_category_count(
    category_rollups: &mut BTreeMap<(String, String, String), CategoryAccumulator>,
    provider: &str,
    category: &str,
    day: &str,
    turn_count: u64,
    tool_count: u64,
    failure_count: u64,
    partial: bool,
) {
    let acc = category_rollups
        .entry((
            provider.to_string(),
            safe_label(category, "activity"),
            day.to_string(),
        ))
        .or_default();
    acc.turn_count += turn_count;
    acc.tool_call_count += tool_count;
    acc.failure_count += failure_count;
    acc.token_data_partial |= partial;
}

fn add_tool_started(
    tools: &mut BTreeMap<(String, String, String, String), ToolAccumulator>,
    provider: &str,
    tool: &str,
    category: &str,
    day: &str,
) {
    let acc = tools
        .entry((
            provider.to_string(),
            safe_label(tool, "tool"),
            safe_label(category, "activity"),
            day.to_string(),
        ))
        .or_default();
    acc.call_count += 1;
}

fn add_tool_completed(
    tools: &mut BTreeMap<(String, String, String, String), ToolAccumulator>,
    provider: &str,
    tool: &str,
    category: &str,
    day: &str,
    success: bool,
    duration_ms: u64,
) {
    let acc = tools
        .entry((
            provider.to_string(),
            safe_label(tool, "tool"),
            safe_label(category, "activity"),
            day.to_string(),
        ))
        .or_default();
    if success {
        acc.success_count += 1;
    } else {
        acc.failure_count += 1;
    }
    acc.total_duration_ms = acc.total_duration_ms.saturating_add(duration_ms);
}

fn add_failure(
    rollups: &mut LocalHistoryRollups,
    provider: &str,
    kind: &str,
    tool: &str,
    category: &str,
    day: &str,
    event_ms: u64,
) {
    if let Some(daily) = rollups
        .daily
        .get_mut(&(provider.to_string(), day.to_string()))
    {
        daily.failure_count += 1;
    }
    add_category_count(
        &mut rollups.category,
        provider,
        category,
        day,
        0,
        0,
        1,
        false,
    );
    let key = (
        provider.to_string(),
        safe_label(kind, "failure"),
        safe_label(tool, "tool"),
        safe_label(category, "activity"),
        day.to_string(),
    );
    let acc = rollups.failures.entry(key).or_default();
    acc.count += 1;
    acc.last_seen_ms = acc.last_seen_ms.max(event_ms);
}

fn write_local_sessions(
    conn: &Connection,
    sessions: Vec<AnalyticsSessionRow>,
) -> Result<(), String> {
    for session in sessions {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO sessions (
                provider, session_id_hash, repository, branch, title,
                first_seen_ms, last_seen_ms, status, is_active,
                event_count, tool_count, turn_count, input_tokens, output_tokens,
                input_tokens_known, output_tokens_known, token_data_partial, last_model
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
            "#,
            params![
                session.provider,
                session.session_id_hash,
                session.repository,
                session.branch,
                session.title,
                session.first_seen_ms as i64,
                session.last_seen_ms as i64,
                session.status,
                bool_i64(session.is_active),
                session.event_count as i64,
                session.tool_count as i64,
                session.turn_count as i64,
                session.input_tokens as i64,
                session.output_tokens as i64,
                bool_i64(session.input_tokens_known),
                bool_i64(session.output_tokens_known),
                bool_i64(session.token_data_partial),
                session.last_model,
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn write_event_facts(conn: &Connection, facts: Vec<AnalyticsEventFact>) -> Result<(), String> {
    for fact in facts {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO recent_event_facts (
                id, provider, session_id_hash, event_key, occurred_at_ms, kind, tool, category,
                success, input_tokens, output_tokens, safe_detail_kind, safe_detail_value, safe_detail_is_estimate
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '', '', 0)
            "#,
            params![
                fact.id,
                fact.provider,
                fact.session_id_hash,
                fact.event_key,
                fact.occurred_at_ms as i64,
                fact.kind,
                fact.tool,
                fact.category,
                bool_i64(fact.success),
                fact.input_tokens.map(|v| v as i64),
                fact.output_tokens.map(|v| v as i64),
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn write_local_history_audit(
    conn: &Connection,
    now: u64,
    scanned_files: u64,
    parse_errors: u64,
) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT OR REPLACE INTO ingestion_cursors (
            provider, source_id_hash, last_offset, source_generation, last_ingested_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5)
        "#,
        params![
            LOCAL_HISTORY_PROVIDER,
            LOCAL_HISTORY_SOURCE_HASH,
            scanned_files as i64,
            ROLLUP_VERSION,
            now as i64,
        ],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        r#"
        INSERT OR REPLACE INTO ingestion_audit (
            id, provider, source_id_hash, occurred_at_ms, kind, severity, safe_code, count
        ) VALUES (?1, ?2, ?3, ?4, 'local_history_ingestion', ?5, ?6, ?7)
        "#,
        params![
            hash_str(&format!("local-history:{}:{}", now, scanned_files)),
            LOCAL_HISTORY_PROVIDER,
            LOCAL_HISTORY_SOURCE_HASH,
            now as i64,
            if parse_errors > 0 { "warning" } else { "info" },
            if parse_errors > 0 {
                "LOCAL_HISTORY_WITH_PARSE_SKIPS"
            } else {
                "LOCAL_HISTORY_COMPLETE"
            },
            scanned_files as i64,
        ],
    )
    .map_err(|err| err.to_string())?;
    if parse_errors > 0 {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO ingestion_audit (
                id, provider, source_id_hash, occurred_at_ms, kind, severity, safe_code, count
            ) VALUES (?1, ?2, ?3, ?4, 'local_history_parse', 'warning', 'MALFORMED_JSONL_SKIPPED', ?5)
            "#,
            params![
                hash_str(&format!("local-history-parse:{}:{}", now, parse_errors)),
                LOCAL_HISTORY_PROVIDER,
                LOCAL_HISTORY_SOURCE_HASH,
                now as i64,
                parse_errors as i64,
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn ingest_session(
    conn: &Connection,
    session: &AgentSessionSummary,
    daily: &mut BTreeMap<(String, String), DailyAccumulator>,
    model: &mut BTreeMap<(String, String, String), ModelAccumulator>,
    category: &mut BTreeMap<(String, String, String), CategoryAccumulator>,
    tools: &mut BTreeMap<(String, String, String, String), ToolAccumulator>,
    now: u64,
) -> Result<(), String> {
    let provider = normalized_provider(&session.provider);
    let session_hash = hash_with_provider(&provider, &session.id);
    let event_ms = parse_iso_ms(&session.last_event_timestamp)
        .or_else(|| parse_iso_ms(&session.updated_at))
        .unwrap_or(now);
    let day = local_day(event_ms);
    let input_known = !(session.input_tokens == 0 && session.output_tokens > 0);
    conn.execute(
        r#"
        INSERT OR REPLACE INTO sessions (
            provider, session_id_hash, repository, branch, title,
            first_seen_ms, last_seen_ms, status, is_active,
            event_count, tool_count, turn_count, input_tokens, output_tokens,
            input_tokens_known, output_tokens_known, token_data_partial, last_model
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1, ?16, ?17)
        "#,
        params![
            provider,
            session_hash,
            sanitize_repository_label(&session.repository),
            sanitize_branch_label(&session.branch),
            sanitize_title_label(&session.title),
            event_ms as i64,
            event_ms as i64,
            safe_label(&session.status, "unknown"),
            bool_i64(session.is_active),
            session.event_count as i64,
            session.tool_count as i64,
            session.turn_count as i64,
            session.input_tokens as i64,
            session.output_tokens as i64,
            bool_i64(input_known),
            bool_i64(!input_known),
            safe_label(&session.last_model, "Unknown"),
        ],
    )
    .map_err(|err| err.to_string())?;

    let daily_key = (provider.clone(), day.clone());
    let daily_acc = daily
        .entry(daily_key)
        .or_insert_with(|| DailyAccumulator::new(event_ms));
    daily_acc.session_ids.insert(session_hash.clone());
    daily_acc.event_count += session.event_count as u64;
    daily_acc.turn_count += session.turn_count as u64;
    daily_acc.tool_call_count += session.tool_count as u64;
    daily_acc.failure_count += session.error_count as u64;
    daily_acc.input_tokens += session.input_tokens;
    daily_acc.output_tokens += session.output_tokens;
    daily_acc.estimated_active_ms += estimate_active_ms(session.event_count as u64);
    daily_acc.token_data_partial |= !input_known;

    let mut counted_turn_model = false;
    let mut turn_model_output = BTreeMap::<String, u64>::new();
    for turn in &session.recent_turns {
        let model_name = safe_label(&turn.model, "Unknown");
        if model_name == "Unknown" {
            continue;
        }
        counted_turn_model = true;
        let model_key = (provider.clone(), model_name.clone(), day.clone());
        let model_acc = model.entry(model_key).or_default();
        model_acc.session_ids.insert(session_hash.clone());
        model_acc.turn_count += 1;
        model_acc.output_tokens += turn.output_tokens;
        model_acc.token_data_partial |= turn.partial;
        *turn_model_output.entry(model_name).or_insert(0) += turn.output_tokens;
    }
    let model_name = safe_label(&session.last_model, "Unknown");
    let observed_turn_output = turn_model_output
        .values()
        .fold(0_u64, |sum, output| sum.saturating_add(*output));
    let residual_input = session.input_tokens;
    let residual_output = session.output_tokens.saturating_sub(observed_turn_output);
    if !counted_turn_model || residual_input > 0 || residual_output > 0 {
        if model_name != "Unknown"
            || session.turn_count > 0
            || session.output_tokens > 0
            || session.input_tokens > 0
        {
            let model_key = (provider.clone(), model_name, day.clone());
            let model_acc = model.entry(model_key).or_default();
            model_acc.session_ids.insert(session_hash.clone());
            if !counted_turn_model {
                model_acc.turn_count += session.turn_count.max(1) as u64;
            }
            model_acc.input_tokens += residual_input;
            model_acc.output_tokens += residual_output;
            model_acc.token_data_partial |= !input_known;
        }
    }

    add_category_session_counts(category, &provider, &day, session, !input_known);
    for call in &session.recent_tool_calls {
        add_tool_call(tools, &provider, &day, call);
    }
    Ok(())
}

fn ingest_event(
    conn: &Connection,
    event: &AgentEventSummary,
    daily: &mut BTreeMap<(String, String), DailyAccumulator>,
    category: &mut BTreeMap<(String, String, String), CategoryAccumulator>,
    failures: &mut BTreeMap<(String, String, String, String, String), FailureAccumulator>,
    now: u64,
) -> Result<(), String> {
    let provider = normalized_provider(&event.provider);
    let session_hash = hash_with_provider(&provider, &event.session_id);
    let event_ms = parse_iso_ms(&event.timestamp).unwrap_or(now);
    let day = local_day(event_ms);
    let event_key = event_dedupe_key(event, event_ms);
    conn.execute(
        r#"
        INSERT OR IGNORE INTO ingested_event_keys (
            provider, source_id_hash, event_key, occurred_at_ms, ingested_at_ms, rollup_version
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![
            provider,
            SNAPSHOT_SOURCE_HASH,
            event_key,
            event_ms as i64,
            now as i64,
            ROLLUP_VERSION,
        ],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        r#"
        INSERT OR REPLACE INTO recent_event_facts (
            id, provider, session_id_hash, event_key, occurred_at_ms, kind, tool, category,
            success, input_tokens, output_tokens, safe_detail_kind, safe_detail_value, safe_detail_is_estimate
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '', '', 0)
        "#,
        params![
            hash_str(&format!("{}:{}:{}", provider, session_hash, event_key)),
            provider,
            session_hash,
            event_key,
            event_ms as i64,
            safe_label(&event.kind, "activity"),
            safe_label(&event.tool, "none"),
            safe_label(&event.category, "activity"),
            bool_i64(event.success),
            event.input_tokens.map(|v| v as i64),
            event.output_tokens.map(|v| v as i64),
        ],
    )
    .map_err(|err| err.to_string())?;

    let daily_acc = daily
        .entry((normalized_provider(&event.provider), day.clone()))
        .or_insert_with(|| DailyAccumulator::new(event_ms));
    daily_acc.event_count += 1;
    if !event.success {
        daily_acc.failure_count += 1;
    }
    // Event token fields are cumulative session checkpoints. Do not add
    // them into rollups here or categories like hooks/tool starts can look
    // like token hotspots. Session totals above own token rollups.

    let cat_key = (
        normalized_provider(&event.provider),
        safe_label(&event.category, "activity"),
        day.clone(),
    );
    let cat = category.entry(cat_key).or_default();
    if event.kind.contains("turn") {
        cat.turn_count += 1;
    }
    if event.kind.contains("tool.") {
        cat.tool_call_count += 1;
    }
    if !event.success {
        cat.failure_count += 1;
    }

    if !event.success {
        let key = (
            normalized_provider(&event.provider),
            safe_label(&event.kind, "failure"),
            safe_label(&event.tool, "tool"),
            safe_label(&event.category, "activity"),
            day,
        );
        let acc = failures.entry(key).or_default();
        acc.count += 1;
        acc.last_seen_ms = acc.last_seen_ms.max(event_ms);
    }
    Ok(())
}

fn add_category_session_counts(
    category: &mut BTreeMap<(String, String, String), CategoryAccumulator>,
    provider: &str,
    day: &str,
    session: &AgentSessionSummary,
    partial: bool,
) {
    let counts = [
        ("edits", session.write_count),
        ("library", session.read_count),
        ("terminal", session.command_count),
        ("signal", session.web_count),
        ("delegates", session.delegates_count),
        ("skills", session.skills_count),
        ("court", session.court_count),
        ("mcp", session.mcp_count),
        ("hooks", session.hooks_count),
        ("alert", session.error_count),
    ];
    for (name, count) in counts {
        if count == 0 {
            continue;
        }
        let acc = category
            .entry((provider.to_string(), name.to_string(), day.to_string()))
            .or_default();
        acc.tool_call_count += count as u64;
        if name == "alert" {
            acc.failure_count += count as u64;
        }
        acc.token_data_partial |= partial;
    }
}

fn add_tool_call(
    tools: &mut BTreeMap<(String, String, String, String), ToolAccumulator>,
    provider: &str,
    day: &str,
    call: &SessionToolCall,
) {
    let key = (
        provider.to_string(),
        safe_label(&call.tool, "tool"),
        safe_label(&call.category, "activity"),
        day.to_string(),
    );
    let acc = tools.entry(key).or_default();
    acc.call_count += 1;
    if call.success {
        acc.success_count += 1;
    } else {
        acc.failure_count += 1;
    }
    acc.total_duration_ms += call.duration_ms.unwrap_or(0);
}

fn write_daily_rollups(
    conn: &Connection,
    rollups: BTreeMap<(String, String), DailyAccumulator>,
) -> Result<(), String> {
    for ((provider, day), acc) in rollups {
        let (start, end, offset) = local_day_bounds(&day);
        conn.execute(
            r#"
            INSERT OR REPLACE INTO daily_rollups (
                provider, local_day, bucket_start_ms, bucket_end_ms, timezone_offset_minutes,
                session_count, event_count, turn_count, tool_call_count, failure_count,
                input_tokens, output_tokens, estimated_active_ms, token_data_partial
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            "#,
            params![
                provider,
                day,
                start as i64,
                end as i64,
                offset,
                acc.session_ids.len() as i64,
                acc.event_count as i64,
                acc.turn_count as i64,
                acc.tool_call_count as i64,
                acc.failure_count as i64,
                acc.input_tokens as i64,
                acc.output_tokens as i64,
                acc.estimated_active_ms as i64,
                bool_i64(acc.token_data_partial),
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn write_model_rollups(
    conn: &Connection,
    rollups: BTreeMap<(String, String, String), ModelAccumulator>,
) -> Result<(), String> {
    for ((provider, model, day), acc) in rollups {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO model_rollups (
                provider, model, local_day, session_count, turn_count, input_tokens,
                output_tokens, cache_read_tokens, cache_write_tokens, token_data_partial
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, ?8)
            "#,
            params![
                provider,
                model,
                day,
                acc.session_ids.len() as i64,
                acc.turn_count as i64,
                acc.input_tokens as i64,
                acc.output_tokens as i64,
                bool_i64(acc.token_data_partial),
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn write_category_rollups(
    conn: &Connection,
    rollups: BTreeMap<(String, String, String), CategoryAccumulator>,
) -> Result<(), String> {
    for ((provider, category, day), acc) in rollups {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO category_rollups (
                provider, category, local_day, turn_count, tool_call_count, failure_count,
                input_tokens, output_tokens, token_data_partial
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                provider,
                category,
                day,
                acc.turn_count as i64,
                acc.tool_call_count as i64,
                acc.failure_count as i64,
                acc.input_tokens as i64,
                acc.output_tokens as i64,
                bool_i64(acc.token_data_partial),
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn write_tool_rollups(
    conn: &Connection,
    rollups: BTreeMap<(String, String, String, String), ToolAccumulator>,
) -> Result<(), String> {
    for ((provider, tool, category, day), acc) in rollups {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO tool_rollups (
                provider, tool_name, tool_category, local_day, call_count,
                success_count, failure_count, total_duration_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                provider,
                tool,
                category,
                day,
                acc.call_count as i64,
                acc.success_count as i64,
                acc.failure_count as i64,
                acc.total_duration_ms as i64,
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn write_failure_rollups(
    conn: &Connection,
    rollups: BTreeMap<(String, String, String, String, String), FailureAccumulator>,
) -> Result<(), String> {
    for ((provider, kind, tool, category, day), acc) in rollups {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO failure_rollups (
                provider, kind, tool, category, local_day, count, last_seen_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                provider,
                kind,
                tool,
                category,
                day,
                acc.count as i64,
                acc.last_seen_ms as i64,
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn write_audits(conn: &Connection, activity: &AgentActivity, now: u64) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT OR REPLACE INTO ingestion_cursors (
            provider, source_id_hash, last_offset, source_generation, last_ingested_at_ms
        ) VALUES (?1, ?2, 0, ?3, ?4)
        "#,
        params![
            safe_label(&activity.source, "agent"),
            SNAPSHOT_SOURCE_HASH,
            ROLLUP_VERSION,
            now as i64
        ],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        r#"
        INSERT OR REPLACE INTO ingestion_audit (
            id, provider, source_id_hash, occurred_at_ms, kind, severity, safe_code, count
        ) VALUES (?1, ?2, ?3, ?4, 'snapshot_ingestion', 'info', ?5, 1)
        "#,
        params![
            hash_str(&format!("snapshot:{}:{}", activity.source, now)),
            safe_label(&activity.source, "agent"),
            SNAPSHOT_SOURCE_HASH,
            now as i64,
            if activity.scanned_sessions > activity.sessions.len() {
                "SNAPSHOT_LIMITED"
            } else {
                "SNAPSHOT_COMPLETE"
            },
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn status_from_db(app: &AppHandle, conn: &Connection) -> Result<AnalyticsStatus, String> {
    let generated_at_ms = unix_ms_now();
    let last_ingested_at_ms: u64 = conn
        .query_row(
            "SELECT COALESCE(MAX(last_ingested_at_ms), 0) FROM ingestion_cursors",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?
        .max(0) as u64;
    let session_count = count_table(conn, "sessions")?;
    let event_count = count_table(conn, "recent_event_facts")?;
    let db_size_bytes = db_size_bytes(app)?;
    let snapshot_limited = latest_audit_code(conn)?
        .map(|code| code == "SNAPSHOT_LIMITED")
        .unwrap_or(false);
    let warnings = warnings_from_db(conn, snapshot_limited)?;
    Ok(AnalyticsStatus {
        available: last_ingested_at_ms > 0,
        ingestion_running: ingestion_running(),
        generated_at_ms,
        last_ingested_at_ms,
        session_count,
        event_count,
        db_size_bytes,
        retention_recent_days: RECENT_FACT_RETENTION_DAYS,
        retention_rollup_days: ROLLUP_RETENTION_DAYS,
        snapshot_limited,
        privacy_summary: "Analytics is indexed from local Copilot CLI session history and stores derived counts, hashed session ids, sanitized repo/branch/title labels, models, tool/category names, token totals, and coverage caveats.".to_string(),
        warnings,
    })
}

fn usage_summary_from_db(
    conn: &Connection,
    range_days: u32,
    compare_previous: bool,
) -> Result<AnalyticsUsageSummary, String> {
    let generated_at_ms = unix_ms_now();
    let today = local_day(generated_at_ms);
    let since_day = local_day_shift(&today, -((range_days as i64) - 1));
    let previous_since_day = local_day_shift(&since_day, -(range_days as i64));
    let daily = daily_points_window(conn, &since_day, None)?;
    let token_hotspots = token_hotspots(conn, &since_day)?;
    let model_mix = model_mix(conn, &since_day)?;
    let tool_failures = tool_failures(conn, &since_day)?;
    let snapshot_limited = latest_audit_code(conn)?
        .map(|code| code == "SNAPSHOT_LIMITED")
        .unwrap_or(false);
    let mut caveats = Vec::new();
    let ingestion_running = ingestion_running();
    caveats.push(
        "Active window is estimated from activity events and is not precise attention time."
            .to_string(),
    );
    if ingestion_running {
        caveats.push("Copilot history is still being analyzed; this answer may refresh when indexing finishes.".to_string());
    }
    if snapshot_limited {
        caveats.push("Current ingestion is based on the live activity snapshot and may omit sessions outside the dashboard scan window.".to_string());
    }
    if daily.iter().any(|point| point.partial) {
        caveats.push("Some token totals are partial because input usage can arrive after output usage in live sessions.".to_string());
    }
    let metrics = summary_metrics(&daily);
    let recommendations =
        recommendations_from_parts(&daily, &token_hotspots, &model_mix, &tool_failures);
    let comparison = if compare_previous {
        Some(comparison_from_db(
            conn,
            &since_day,
            &previous_since_day,
            range_days,
            &daily,
        )?)
    } else {
        None
    };
    Ok(AnalyticsUsageSummary {
        generated_at_ms,
        range_days,
        snapshot_limited,
        ingestion_running,
        metrics,
        daily,
        token_hotspots,
        model_mix,
        tool_failures,
        recommendations,
        caveats,
        comparison,
    })
}

fn engineering_digest_from_db(
    conn: &Connection,
    request: EngineeringDigestRequest,
) -> Result<EngineeringDigest, String> {
    let generated_at_ms = unix_ms_now();
    let today = local_day(generated_at_ms);
    let selected_day = normalize_selected_day(request.selected_day.as_deref(), &today);
    let month = normalize_digest_month(request.month.as_deref(), &selected_day);
    let grid = rolling_calendar_days(&selected_day, &month);
    let first_day = grid
        .first()
        .map(|day| day.local_day.clone())
        .unwrap_or_else(|| selected_day.clone());
    let after_last_day = grid
        .last()
        .map(|day| local_day_shift(&day.local_day, 1))
        .unwrap_or_else(|| local_day_shift(&selected_day, 1));
    let daily_points = daily_points_window(conn, &first_day, Some(&after_last_day))?;
    let daily_by_day = daily_points
        .into_iter()
        .map(|point| (point.local_day.clone(), point))
        .collect::<BTreeMap<_, _>>();
    let dominant_by_day = dominant_session_labels(conn, &first_day, &after_last_day)?;
    let max_events = daily_by_day
        .values()
        .map(|point| point.events)
        .max()
        .unwrap_or(0);
    let max_tokens = daily_by_day
        .values()
        .map(|point| point.input_tokens.saturating_add(point.output_tokens))
        .max()
        .unwrap_or(0);
    let mcp_by_day = category_calls_by_day(conn, &first_day, &after_last_day, "mcp")?;
    let mut available_years = available_digest_years(conn)?;
    if available_years.is_empty() {
        available_years.push(
            selected_day
                .chars()
                .take(4)
                .collect::<String>()
                .parse::<i32>()
                .unwrap_or_else(|_| Local::now().year()),
        );
    }
    let calendar_days = grid
        .into_iter()
        .map(|slot| {
            let point = daily_by_day.get(&slot.local_day);
            let events = point.map(|p| p.events).unwrap_or(0);
            let tokens = point
                .map(|p| p.input_tokens.saturating_add(p.output_tokens))
                .unwrap_or(0);
            let failures = point.map(|p| p.failures).unwrap_or(0);
            let mcp_calls = *mcp_by_day.get(&slot.local_day).unwrap_or(&0);
            let mut badges = Vec::new();
            if failures > 0 {
                badges.push("Failure".to_string());
            }
            if max_tokens > 0 && tokens >= ((max_tokens as f64) * 0.75).ceil() as u64 {
                badges.push("Token spike".to_string());
            }
            if mcp_calls >= 3 {
                badges.push("MCP".to_string());
            }
            if point.map(|p| p.sessions).unwrap_or(0) > 0 {
                badges.push("Active".to_string());
            }
            let dominant = dominant_by_day.get(&slot.local_day);
            EngineeringDigestCalendarDay {
                local_day: slot.local_day.clone(),
                day_number: slot.day_number,
                in_month: slot.in_month,
                enabled: events > 0,
                is_today: slot.local_day == today,
                intensity: heatmap_intensity(events, max_events),
                sessions: point.map(|p| p.sessions).unwrap_or(0),
                events,
                turns: point.map(|p| p.turns).unwrap_or(0),
                tool_calls: point.map(|p| p.tool_calls).unwrap_or(0),
                failures,
                input_tokens: point.map(|p| p.input_tokens).unwrap_or(0),
                output_tokens: point.map(|p| p.output_tokens).unwrap_or(0),
                estimated_active_ms: point.map(|p| p.estimated_active_ms).unwrap_or(0),
                partial: point.map(|p| p.partial).unwrap_or(false),
                badges,
                dominant_repo: dominant.map(|item| item.0.clone()),
                dominant_branch: dominant.map(|item| item.1.clone()),
            }
        })
        .collect::<Vec<_>>();

    let day = engineering_digest_day(conn, &selected_day)?;
    let snapshot_limited = latest_audit_code(conn)?
        .map(|code| code == "SNAPSHOT_LIMITED")
        .unwrap_or(false);
    let mut caveats = vec![format!(
        "Daily Log uses indexed local analytics for the most recent {} days.",
        LOCAL_HISTORY_INGEST_DAYS
    )];
    if snapshot_limited {
        caveats.push(
            "Current analytics are snapshot-limited until local history indexing completes."
                .to_string(),
        );
    }
    if day.totals.iter().any(|metric| metric.partial) {
        caveats.push("Some token totals are partial because input usage can arrive after output usage in live sessions.".to_string());
    }

    Ok(EngineeringDigest {
        generated_at_ms,
        selected_day,
        month,
        available_years,
        calendar_days,
        day,
        caveats,
    })
}

#[derive(Clone)]
struct MonthGridSlot {
    local_day: String,
    day_number: u32,
    in_month: bool,
}

fn normalize_selected_day(value: Option<&str>, fallback: &str) -> String {
    let fallback_date = NaiveDate::parse_from_str(fallback, "%Y-%m-%d")
        .unwrap_or_else(|_| Local::now().date_naive());
    let requested = value
        .and_then(|day| NaiveDate::parse_from_str(day, "%Y-%m-%d").ok())
        .unwrap_or(fallback_date);
    let selected = requested.min(fallback_date);
    format!(
        "{:04}-{:02}-{:02}",
        selected.year(),
        selected.month(),
        selected.day()
    )
}

fn normalize_digest_month(value: Option<&str>, selected_day: &str) -> String {
    let selected_month: String = selected_day.chars().take(7).collect();
    if let Some(month) = value {
        if month.len() == 7
            && NaiveDate::parse_from_str(&format!("{}-01", month), "%Y-%m-%d").is_ok()
        {
            return month.min(selected_month.as_str()).to_string();
        }
    }
    selected_month
}

fn rolling_calendar_days(selected_day: &str, month: &str) -> Vec<MonthGridSlot> {
    let selected = NaiveDate::parse_from_str(selected_day, "%Y-%m-%d")
        .unwrap_or_else(|_| Local::now().date_naive());
    let visible_week_start = selected
        .checked_sub_signed(chrono::Duration::days(
            selected.weekday().num_days_from_sunday() as i64,
        ))
        .unwrap_or(selected);
    let grid_start = visible_week_start
        .checked_sub_signed(chrono::Duration::days(28))
        .unwrap_or(visible_week_start);
    let grid_end = visible_week_start
        .checked_add_signed(chrono::Duration::days(6))
        .unwrap_or(selected);
    let total_days = (grid_end - grid_start).num_days().max(0) + 1;
    (0..total_days)
        .filter_map(|offset| grid_start.checked_add_signed(chrono::Duration::days(offset)))
        .map(|day| MonthGridSlot {
            local_day: format!("{:04}-{:02}-{:02}", day.year(), day.month(), day.day()),
            day_number: day.day(),
            in_month: format!("{:04}-{:02}", day.year(), day.month()) == month,
        })
        .collect()
}

fn heatmap_intensity(events: u64, max_events: u64) -> u8 {
    if events == 0 || max_events == 0 {
        return 0;
    }
    let pct = events as f64 / max_events as f64;
    if pct >= 0.75 {
        4
    } else if pct >= 0.5 {
        3
    } else if pct >= 0.25 {
        2
    } else {
        1
    }
}

fn engineering_digest_day(
    conn: &Connection,
    selected_day: &str,
) -> Result<EngineeringDigestDay, String> {
    let daily = daily_points_window(conn, selected_day, Some(&local_day_shift(selected_day, 1)))?;
    let totals = summary_metrics(&daily);
    let activity_rate = activity_rate_for_day(conn, selected_day)?;
    let sessions = digest_sessions_for_day(conn, selected_day)?;
    let repos = group_digest_sessions(&sessions);
    let models = model_mix_for_day(conn, selected_day)?;
    let tools = tools_for_day(conn, selected_day)?;
    let failures = failures_for_day(conn, selected_day)?;
    let mut token_hotspots = sessions.clone();
    token_hotspots.sort_by(|a, b| {
        b.output_tokens
            .cmp(&a.output_tokens)
            .then_with(|| b.input_tokens.cmp(&a.input_tokens))
    });
    token_hotspots.truncate(6);
    let mut useful_sessions = sessions.clone();
    useful_sessions.sort_by(|a, b| {
        b.turns
            .cmp(&a.turns)
            .then_with(|| b.tool_calls.cmp(&a.tool_calls))
            .then_with(|| b.events.cmp(&a.events))
            .then_with(|| b.output_tokens.cmp(&a.output_tokens))
            .then_with(|| b.last_seen_ms.cmp(&a.last_seen_ms))
    });
    useful_sessions.truncate(6);
    let narrative = digest_narrative(selected_day, &totals, &repos, &models, &tools, &failures);
    let exports = digest_exports(
        selected_day,
        &narrative,
        &totals,
        &repos,
        &models,
        &tools,
        &failures,
    );
    Ok(EngineeringDigestDay {
        local_day: selected_day.to_string(),
        totals,
        activity_rate,
        repos,
        models,
        tools,
        failures,
        token_hotspots,
        useful_sessions,
        narrative,
        exports,
    })
}

fn activity_rate_for_day(
    conn: &Connection,
    selected_day: &str,
) -> Result<Vec<EngineeringDigestActivityBucket>, String> {
    let (start_ms, end_ms, _) = local_day_bounds(selected_day);
    let mut buckets = (0..24)
        .map(|hour| {
            let bucket_start = start_ms.saturating_add(hour * HOUR_MS);
            EngineeringDigestActivityBucket {
                start_ms: bucket_start,
                label: local_hour_label(bucket_start),
                ..Default::default()
            }
        })
        .collect::<Vec<_>>();
    let mut session_sets = (0..24).map(|_| BTreeSet::<String>::new()).collect::<Vec<_>>();

    let mut stmt = conn
        .prepare(
            r#"
            SELECT occurred_at_ms, session_id_hash, kind, success
            FROM recent_event_facts
            WHERE occurred_at_ms >= ?1 AND occurred_at_ms < ?2
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![start_ms as i64, end_ms as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?.max(0) as u64,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|err| err.to_string())?;

    for row in rows {
        let (occurred_at_ms, session_hash, kind, success) = row.map_err(|err| err.to_string())?;
        if occurred_at_ms < start_ms || occurred_at_ms >= end_ms {
            continue;
        }
        let index = ((occurred_at_ms - start_ms) / HOUR_MS) as usize;
        let Some(bucket) = buckets.get_mut(index) else {
            continue;
        };
        bucket.event_count += 1;
        if kind.starts_with("tool.") || kind.starts_with("hook.") {
            bucket.tool_call_count += 1;
        }
        if kind.contains("turn") {
            bucket.turn_count += 1;
        }
        if success == 0 {
            bucket.failure_count += 1;
        }
        if let Some(sessions) = session_sets.get_mut(index) {
            sessions.insert(session_hash);
        }
    }

    let peak = buckets
        .iter()
        .map(|bucket| bucket.event_count)
        .max()
        .unwrap_or(0);
    for (index, bucket) in buckets.iter_mut().enumerate() {
        bucket.session_count = session_sets
            .get(index)
            .map(|sessions| sessions.len() as u64)
            .unwrap_or(0);
        bucket.intensity = if peak > 0 && bucket.event_count > 0 {
            (bucket.event_count as f64 / peak as f64).clamp(0.0, 1.0)
        } else {
            0.0
        };
    }

    Ok(buckets)
}

fn local_hour_label(start_ms: u64) -> String {
    let local = Utc
        .timestamp_millis_opt(start_ms as i64)
        .single()
        .unwrap_or_else(Utc::now)
        .with_timezone(&Local);
    local.format("%-I %p").to_string()
}

fn dominant_session_labels(
    conn: &Connection,
    first_day: &str,
    after_last_day: &str,
) -> Result<BTreeMap<String, (String, String)>, String> {
    let (start_ms, _, _) = local_day_bounds(first_day);
    let (end_ms, _, _) = local_day_bounds(after_last_day);
    let mut stmt = conn
        .prepare(
            r#"
            SELECT s.repository, s.branch, f.occurred_at_ms, COUNT(*)
            FROM recent_event_facts f
            JOIN sessions s
              ON s.provider = f.provider AND s.session_id_hash = f.session_id_hash
            WHERE f.occurred_at_ms >= ?1 AND f.occurred_at_ms < ?2
            GROUP BY s.repository, s.branch, f.session_id_hash, f.occurred_at_ms / 86400000
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![start_ms as i64, end_ms as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?.max(0) as u64,
                row.get::<_, i64>(3)?.max(0) as u64,
            ))
        })
        .map_err(|err| err.to_string())?;
    let mut winners = BTreeMap::<String, (String, String, u64)>::new();
    for row in rows {
        let (repo, branch, occurred_at_ms, events) = row.map_err(|err| err.to_string())?;
        let day = local_day(occurred_at_ms);
        let entry = winners
            .entry(day)
            .or_insert_with(|| (repo.clone(), branch.clone(), 0));
        if events > entry.2 {
            *entry = (repo, branch, events);
        }
    }
    Ok(winners
        .into_iter()
        .map(|(day, (repo, branch, _))| (day, (repo, branch)))
        .collect())
}

fn category_calls_by_day(
    conn: &Connection,
    first_day: &str,
    after_last_day: &str,
    category: &str,
) -> Result<BTreeMap<String, u64>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT local_day, SUM(tool_call_count)
            FROM category_rollups
            WHERE local_day >= ?1 AND local_day < ?2 AND category = ?3
            GROUP BY local_day
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![first_day, after_last_day, category], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?.max(0) as u64,
            ))
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(|err| err.to_string())
}

fn available_digest_years(conn: &Connection) -> Result<Vec<i32>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT DISTINCT CAST(substr(local_day, 1, 4) AS INTEGER)
            FROM daily_rollups
            WHERE event_count > 0
               OR session_count > 0
               OR turn_count > 0
               OR tool_call_count > 0
               OR failure_count > 0
            ORDER BY 1 DESC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, i32>(0))
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn digest_sessions_for_day(
    conn: &Connection,
    selected_day: &str,
) -> Result<Vec<EngineeringDigestSession>, String> {
    let (start_ms, end_ms, _) = local_day_bounds(selected_day);
    let mut stmt = conn
        .prepare(
            r#"
            SELECT s.session_id_hash,
                   s.title,
                   s.repository,
                   s.branch,
                   s.status,
                   s.is_active,
                   COALESCE(MIN(f.occurred_at_ms), s.first_seen_ms),
                   COALESCE(MAX(f.occurred_at_ms), s.last_seen_ms),
                   COALESCE(COUNT(f.id), 0),
                   COALESCE(SUM(CASE WHEN f.success = 0 THEN 1 ELSE 0 END), 0),
                   CASE
                     WHEN COUNT(f.id) > 0 THEN COALESCE(SUM(CASE WHEN f.kind LIKE '%turn%' THEN 1 ELSE 0 END), 0)
                     ELSE s.turn_count
                   END,
                   CASE
                     WHEN COUNT(f.id) > 0 THEN COALESCE(SUM(CASE WHEN f.kind LIKE 'tool.%' OR f.kind LIKE 'hook.%' THEN 1 ELSE 0 END), 0)
                     ELSE s.tool_count
                   END,
                   COALESCE(MAX(f.input_tokens), 0),
                   COALESCE(MAX(f.output_tokens), 0),
                   COALESCE((
                     SELECT MAX(p.input_tokens)
                     FROM recent_event_facts p
                     WHERE p.provider = s.provider
                       AND p.session_id_hash = s.session_id_hash
                       AND p.occurred_at_ms < ?1
                       AND p.input_tokens IS NOT NULL
                   ), 0),
                   COALESCE((
                     SELECT MAX(p.output_tokens)
                     FROM recent_event_facts p
                     WHERE p.provider = s.provider
                       AND p.session_id_hash = s.session_id_hash
                       AND p.occurred_at_ms < ?1
                       AND p.output_tokens IS NOT NULL
                   ), 0),
                   s.input_tokens,
                   s.output_tokens,
                   s.last_model
            FROM sessions s
            LEFT JOIN recent_event_facts f
              ON f.provider = s.provider
             AND f.session_id_hash = s.session_id_hash
             AND f.occurred_at_ms >= ?1
             AND f.occurred_at_ms < ?2
            WHERE (f.id IS NOT NULL)
               OR (s.last_seen_ms >= ?1 AND s.last_seen_ms < ?2)
            GROUP BY s.provider, s.session_id_hash
            ORDER BY COALESCE(MAX(f.occurred_at_ms), s.last_seen_ms) DESC
            LIMIT 24
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![start_ms as i64, end_ms as i64], |row| {
            let session_hash: String = row.get(0)?;
            Ok(EngineeringDigestSession {
                session_hash: session_hash.chars().take(8).collect(),
                title: row.get::<_, String>(1)?,
                repository: row.get::<_, String>(2)?,
                branch: row.get::<_, String>(3)?,
                status: row.get::<_, String>(4)?,
                is_active: row.get::<_, i64>(5)? > 0,
                first_seen_ms: row.get::<_, i64>(6)?.max(0) as u64,
                last_seen_ms: row.get::<_, i64>(7)?.max(0) as u64,
                events: row.get::<_, i64>(8)?.max(0) as u64,
                failures: row.get::<_, i64>(9)?.max(0) as u64,
                turns: row.get::<_, i64>(10)?.max(0) as u64,
                tool_calls: row.get::<_, i64>(11)?.max(0) as u64,
                input_tokens: token_delta_for_day(
                    row.get::<_, i64>(8)?.max(0) as u64,
                    row.get::<_, i64>(12)?.max(0) as u64,
                    row.get::<_, i64>(14)?.max(0) as u64,
                    row.get::<_, i64>(16)?.max(0) as u64,
                ),
                output_tokens: token_delta_for_day(
                    row.get::<_, i64>(8)?.max(0) as u64,
                    row.get::<_, i64>(13)?.max(0) as u64,
                    row.get::<_, i64>(15)?.max(0) as u64,
                    row.get::<_, i64>(17)?.max(0) as u64,
                ),
                last_model: row.get::<_, String>(18)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn group_digest_sessions(sessions: &[EngineeringDigestSession]) -> Vec<EngineeringDigestRepoGroup> {
    let mut groups = BTreeMap::<(String, String), EngineeringDigestRepoGroup>::new();
    for session in sessions {
        let key = (session.repository.clone(), session.branch.clone());
        let entry = groups
            .entry(key)
            .or_insert_with(|| EngineeringDigestRepoGroup {
                repository: session.repository.clone(),
                branch: session.branch.clone(),
                first_seen_ms: session.first_seen_ms,
                last_seen_ms: session.last_seen_ms,
                ..Default::default()
            });
        entry.events += session.events;
        entry.failures += session.failures;
        entry.input_tokens += session.input_tokens;
        entry.output_tokens += session.output_tokens;
        entry.first_seen_ms = if entry.first_seen_ms == 0 {
            session.first_seen_ms
        } else {
            entry.first_seen_ms.min(session.first_seen_ms)
        };
        entry.last_seen_ms = entry.last_seen_ms.max(session.last_seen_ms);
        entry.sessions.push(session.clone());
    }
    let mut values = groups.into_values().collect::<Vec<_>>();
    values.sort_by(|a, b| {
        b.events
            .cmp(&a.events)
            .then_with(|| b.output_tokens.cmp(&a.output_tokens))
            .then_with(|| a.repository.cmp(&b.repository))
    });
    values
}

fn model_mix_for_day(
    conn: &Connection,
    selected_day: &str,
) -> Result<Vec<AnalyticsRankedItem>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT model, SUM(output_tokens), SUM(turn_count), SUM(input_tokens), MAX(token_data_partial)
            FROM model_rollups
            WHERE local_day = ?1
              AND model != 'Unknown'
              AND (turn_count > 0 OR output_tokens > 0 OR input_tokens > 0)
            GROUP BY model
            ORDER BY SUM(turn_count) DESC, SUM(output_tokens) DESC
            LIMIT 8
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![selected_day], |row| {
            Ok(AnalyticsRankedItem {
                label: row.get(0)?,
                category: "model".to_string(),
                value: row.get::<_, i64>(1)?.max(0) as u64,
                secondary_value: row.get::<_, i64>(2)?.max(0) as u64,
                tertiary_value: row.get::<_, i64>(3)?.max(0) as u64,
                partial: row.get::<_, i64>(4)? > 0,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn tools_for_day(
    conn: &Connection,
    selected_day: &str,
) -> Result<Vec<EngineeringDigestTool>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT tool_name, tool_category, SUM(call_count), SUM(success_count), SUM(failure_count), SUM(total_duration_ms)
            FROM tool_rollups
            WHERE local_day = ?1
            GROUP BY tool_name, tool_category
            ORDER BY SUM(call_count) DESC, SUM(failure_count) DESC
            LIMIT 10
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![selected_day], |row| {
            Ok(EngineeringDigestTool {
                name: row.get(0)?,
                category: row.get(1)?,
                calls: row.get::<_, i64>(2)?.max(0) as u64,
                successes: row.get::<_, i64>(3)?.max(0) as u64,
                failures: row.get::<_, i64>(4)?.max(0) as u64,
                total_duration_ms: row.get::<_, i64>(5)?.max(0) as u64,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn failures_for_day(
    conn: &Connection,
    selected_day: &str,
) -> Result<Vec<EngineeringDigestFailure>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT kind, tool, category, SUM(count), MAX(last_seen_ms)
            FROM failure_rollups
            WHERE local_day = ?1
            GROUP BY kind, tool, category
            ORDER BY SUM(count) DESC, MAX(last_seen_ms) DESC
            LIMIT 10
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![selected_day], |row| {
            Ok(EngineeringDigestFailure {
                kind: row.get(0)?,
                tool: row.get(1)?,
                category: row.get(2)?,
                count: row.get::<_, i64>(3)?.max(0) as u64,
                last_seen_ms: row.get::<_, i64>(4)?.max(0) as u64,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn token_delta_for_day(
    event_count: u64,
    max_within_day: u64,
    max_before_day: u64,
    fallback: u64,
) -> u64 {
    if event_count == 0 {
        return fallback;
    }
    max_within_day.saturating_sub(max_before_day)
}

fn digest_narrative(
    selected_day: &str,
    totals: &[AnalyticsMetricValue],
    repos: &[EngineeringDigestRepoGroup],
    models: &[AnalyticsRankedItem],
    tools: &[EngineeringDigestTool],
    _failures: &[EngineeringDigestFailure],
) -> String {
    let sessions = metric_value(totals, "Sessions");
    if sessions == 0 {
        return format!(
            "No indexed Copilot CLI activity is available for {}.",
            selected_day
        );
    }
    let top_repo = repos
        .first()
        .map(|repo| format!("{} on {}", repo.repository, repo.branch))
        .unwrap_or_else(|| "local projects".to_string());
    let top_model = models
        .first()
        .map(|model| model.label.clone())
        .unwrap_or_else(|| "Unknown model".to_string());
    let top_tool = tools
        .first()
        .map(|tool| tool.name.clone())
        .unwrap_or_else(|| "tools".to_string());
    format!(
        "On {}, you worked mostly in {}, across {} session{}. {} handled most observed model activity, and {} was the busiest tool.",
        selected_day,
        top_repo,
        sessions,
        plural(sessions),
        top_model,
        top_tool
    )
}

fn digest_token_pair(input_tokens: u64, output_tokens: u64) -> String {
    let input_label = if input_tokens == 0 && output_tokens > 0 {
        "pending input tokens".to_string()
    } else {
        format!("{} input tokens", input_tokens)
    };
    format!("{} / {} output tokens", input_label, output_tokens)
}

fn digest_exports(
    selected_day: &str,
    narrative: &str,
    totals: &[AnalyticsMetricValue],
    repos: &[EngineeringDigestRepoGroup],
    models: &[AnalyticsRankedItem],
    tools: &[EngineeringDigestTool],
    failures: &[EngineeringDigestFailure],
) -> Vec<EngineeringDigestExport> {
    let sessions = metric_value(totals, "Sessions");
    let turns = metric_value(totals, "Turns");
    let output_tokens = metric_value(totals, "Output tokens");
    let repo_line = repos
        .iter()
        .take(3)
        .map(|repo| format!("{} ({})", repo.repository, repo.branch))
        .collect::<Vec<_>>()
        .join(", ");
    let model_line = models
        .iter()
        .take(3)
        .map(|model| {
            format!(
                "{} ({})",
                model.label,
                digest_token_pair(model.tertiary_value, model.value)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let tool_line = tools
        .iter()
        .take(5)
        .map(|tool| format!("{} ({})", tool.name, tool.calls))
        .collect::<Vec<_>>()
        .join(", ");
    let failure_line = if failures.is_empty() {
        "No repeated failure pattern stood out.".to_string()
    } else {
        failures
            .iter()
            .take(3)
            .map(|failure| {
                format!(
                    "{} / {}: {}",
                    category_label(&failure.category),
                    failure.tool,
                    failure.count
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let daily_digest = format!(
        "## Daily Digest - {}\n\n{}\n\n### Scope\n{}\n\n### AI usage\n{} session{}, {} turn{}, {} output tokens.\n\n### Models\n{}\n\n### Tools\n{}",
        selected_day,
        narrative,
        if repo_line.is_empty() { "No indexed project activity." } else { &repo_line },
        sessions,
        plural(sessions),
        turns,
        plural(turns),
        output_tokens,
        if model_line.is_empty() { "No model activity indexed." } else { &model_line },
        if tool_line.is_empty() { "No tool activity indexed." } else { &tool_line }
    );
    let resume = format!(
        "Use the Mission Control Daily Log for {} as context. Continue from this summary: {} Focus first on: {}",
        selected_day,
        narrative,
        failure_line
    );
    vec![
        EngineeringDigestExport {
            kind: "daily-digest".to_string(),
            label: "Copy Daily Digest".to_string(),
            body: daily_digest,
        },
        EngineeringDigestExport {
            kind: "resume".to_string(),
            label: "Copy resume prompt".to_string(),
            body: resume,
        },
    ]
}

fn chat_response_from_summary(
    prompt: String,
    summary: AnalyticsUsageSummary,
) -> AnalyticsChatResponse {
    let mut answer = format!(
        "I reviewed the indexed local Copilot CLI activity for the last {} day{}.",
        summary.range_days,
        if summary.range_days == 1 { "" } else { "s" }
    );
    let sessions = metric_value(&summary.metrics, "Sessions");
    let turns = metric_value(&summary.metrics, "Turns");
    let output = metric_value(&summary.metrics, "Output tokens");
    let failures = metric_value(&summary.metrics, "Failures");
    answer.push_str(&format!(
        " I found {} session{}, {} turn{}, {} output token{}, and {} failure{}.",
        sessions,
        plural(sessions),
        turns,
        plural(turns),
        output,
        plural(output),
        failures,
        plural(failures)
    ));
    if summary.ingestion_running {
        answer.push_str(
            " Copilot history is still being analyzed in the background, so this answer uses the data indexed so far.",
        );
    }
    if let Some(comparison) = &summary.comparison {
        if let Some(change) = comparison.changes.first() {
            answer.push_str(&format!(
                " Biggest change versus the {}: {} {} from {} to {}.",
                comparison.previous_label,
                change.label,
                delta_phrase(change.delta),
                change.previous,
                change.current
            ));
        }
        if let Some(model) = comparison.model_shifts.first() {
            answer.push_str(&format!(
                " Model shift: {} {} from {} to {} observed turn{}.",
                model.label,
                delta_phrase(model.delta),
                model.previous,
                model.current,
                plural(model.current)
            ));
        }
    }
    if let Some(top) = summary.token_hotspots.first() {
        answer.push_str(&format!(
            " The biggest token hotspot is {} with {} output tokens.",
            top.label, top.value
        ));
    }
    if let Some(failure) = summary.tool_failures.first() {
        answer.push_str(&format!(
            " The top failure pattern is {} in {} with {} failure{}.",
            failure.label,
            failure.category,
            failure.value,
            plural(failure.value)
        ));
    }
    if let Some(card) = summary.recommendations.first() {
        answer.push_str(&format!(" Recommendation: {}", card.body));
    }
    AnalyticsChatResponse {
        id: hash_str(&format!("{}:{}", prompt, summary.generated_at_ms)),
        prompt,
        answer,
        generated_at_ms: summary.generated_at_ms,
        artifacts: artifacts_from_summary(&summary),
        caveats: summary.caveats,
        mode: "deterministic".to_string(),
        mode_reason: None,
    }
}

async fn synthesize_chat_answer_with_copilot(
    app: &AppHandle,
    prompt: &str,
    summary: &AnalyticsUsageSummary,
    definition_gap_prompt: bool,
) -> Result<SdkAnalyticsAnswer, String> {
    use github_copilot_sdk::types::{MessageOptions, SessionConfig, SystemMessageConfig};
    use github_copilot_sdk::Client;

    let summary_json = serde_json::to_string(summary).map_err(|err| err.to_string())?;
    let executable_env = resolve_executable_env();
    let mcp_script = ensure_insights_mcp_server_script(app)?;
    let project_root = project_root_for_mcp().or_else(|| std::env::current_dir().ok());
    let mcp_tools = mission_control_insights_tools_for_prompt(prompt);
    let mcp_servers = mission_control_insights_mcp_servers(
        &mcp_script,
        project_root.as_deref(),
        mcp_tools,
        &executable_env,
    );
    let client = Client::start(copilot_sdk_client_options())
        .await
        .map_err(|err| err.to_string())?;
    let sdk_event_state = Arc::new(Mutex::new(AnalyticsSdkEventState::default()));
    let definition_focus = definition_gap_focus_instructions(definition_gap_prompt);
    let system_message = SystemMessageConfig::new()
        .with_mode("append")
        .with_content(format!(
            "{marker}\nYou are the Agent Mission Control Analytics assistant.\n\nAllowed scope: answer questions about Copilot CLI usage analytics and improvement opportunities based on this app's indexed analytics plus the Mission Control Insights MCP tools. Indexed JSON covers sessions, turns, token usage, model mix, tool usage, failures, trends, comparisons, recommendations, and indexing status. MCP tools can inspect bounded local prompt samples, skills, agent definitions, and MCP server inventory when the user asks about prompts, skills, agents, MCP servers, or improvement analysis.\n\nNot allowed: weather, temperature, general knowledge, coding help unrelated to these local analytics, external facts, live web data, personal advice, arbitrary SQL, or details not present in the supplied JSON or MCP tool results. Do not reveal raw file paths. Do not quote raw prompt text unless the user explicitly asks to inspect prompts; prefer summaries and improvement recommendations.\n\nIf the user asks anything outside the allowed scope, set in_scope=false and answer exactly: \"I can only answer questions about indexed Copilot CLI usage, prompts, skills, agents, MCP servers, and analytics.\"\n\nIf the question is in scope but the supplied JSON and available tools do not include the requested detail, set in_scope=true and say the indexed analytics do not include that detail.\n\nUse only Mission Control Insights MCP tools when tools are needed. Do not call built-in filesystem, shell, view, edit, search, planning, or status tools. For prompt-pattern, prompt-improvement, skill-review, agent-review, MCP-review, or missing-skill/agent questions, call the relevant Mission Control Insights MCP tool before answering. Do not answer those questions from aggregate metrics alone. For broad skill audits such as \"Review my Copilot skills\", call analyze_copilot_skills first and answer from that result. For broad agent audits such as \"Review my Copilot agents\", call analyze_copilot_agents first and answer from that result. For broad MCP usage or MCP server audits such as \"What's my MCP server usage?\", call analyze_mcp_servers first and answer from that result plus indexed usage metrics. Use list_* and read_* only for targeted follow-up on specific named definitions.\n\n{definition_focus}\n\nFormat answer text for readability using lightweight Markdown: short paragraphs, blank lines between paragraphs, and '-' bullet lists when listing steps, patterns, recommendations, or examples. Keep answers concise.\n\nChoose only the supporting UI artifacts that directly answer metric questions. Definition-review charts are attached automatically when analyze_copilot_skills or analyze_copilot_agents runs. MCP server usage tables are attached automatically when analyze_mcp_servers runs or the question asks about MCP usage. Other artifact keys you may request: changes, token_trend, token_hotspots, model_mix, model_shifts, tool_failures, tool_changes, recommendations. Examples: top models -> [\"model_mix\"]; token hotspots -> [\"token_hotspots\"]; what changed -> [\"changes\",\"model_shifts\",\"tool_changes\"]; top failed tools -> [\"tool_failures\"]; prompt improvements -> []. For skill/agent/MCP gap prompts, return [] for artifacts because specialized artifacts are attached outside the SDK response.\n\nReturn strict JSON only with this shape: {{\"in_scope\": boolean, \"answer\": string, \"artifacts\": [string]}}. The answer string may contain lightweight Markdown. Do not include code fences, extra keys, SQL, or preambles outside the JSON.",
            marker = MISSION_CONTROL_ANALYTICS_MARKER,
        ));
    let mut config = SessionConfig::default()
        .with_handler(Arc::new(AnalyticsSdkHandler {
            app: app.clone(),
            state: sdk_event_state.clone(),
        }))
        .with_system_message(system_message)
        .with_excluded_tools(ANALYTICS_EXCLUDED_BUILT_IN_TOOLS.iter().copied())
        .with_enable_config_discovery(false)
        .with_request_user_input(false)
        .with_request_exit_plan_mode(false)
        .with_request_elicitation(false)
        .with_mcp_servers(mcp_servers)
        .approve_permissions_if(is_mission_control_insights_permission);
    config.client_name = Some("copilot-mission-control-analytics".to_string());
    config.streaming = Some(false);
    config.hooks = Some(false);

    let session = match client.create_session(config).await {
        Ok(session) => session,
        Err(err) => {
            let _ = client.stop().await;
            return Err(err.to_string());
        }
    };
    let message = format!(
        "{marker}\nUser question: {prompt}\n\nIndexed analytics JSON:\n{summary_json}\n\nMission Control Insights MCP tools are available in this session. Use them when the user asks about prompts, skills, agents, MCP servers, or improvements.\n\n{definition_focus}\n\nReturn strict JSON only: {{\"in_scope\": boolean, \"answer\": string, \"artifacts\": [string]}}. The answer string may contain lightweight Markdown for paragraphs and bullet lists.",
        marker = MISSION_CONTROL_ANALYTICS_MARKER,
    );
    let result = session
        .send_and_wait(MessageOptions::new(message).with_wait_timeout(Duration::from_secs(75)))
        .await;
    let _ = session.destroy().await;
    let _ = client.stop().await;

    let event = result.map_err(|err| err.to_string())?;
    let content = event
        .as_ref()
        .and_then(sdk_assistant_message_content)
        .or_else(|| sdk_event_state_content(&sdk_event_state))
        .ok_or_else(|| "Copilot SDK did not return answer content".to_string())?;
    let mut answer = parse_sdk_analytics_answer(&content)?;
    answer.definition_review_artifacts = definition_review_artifacts_from_state(&sdk_event_state);
    Ok(answer)
}

#[derive(Default)]
struct AnalyticsSdkEventState {
    last_assistant_content: Option<String>,
    streamed_content: String,
    definition_reviews: HashMap<String, Value>,
}

fn sdk_event_state_content(state: &Arc<Mutex<AnalyticsSdkEventState>>) -> Option<String> {
    let state = state.lock().ok()?;
    state
        .last_assistant_content
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let content = state.streamed_content.trim();
            if content.is_empty() {
                None
            } else {
                Some(content.to_string())
            }
        })
}

fn sdk_assistant_message_content(
    event: &github_copilot_sdk::types::SessionEvent,
) -> Option<String> {
    if event.event_type != "assistant.message" {
        return None;
    }
    clean_sdk_text(event.data.get("content").or_else(|| {
        event
            .data
            .get("message")
            .and_then(|message| message.get("content"))
    }))
}

fn sdk_assistant_delta_content(event: &github_copilot_sdk::types::SessionEvent) -> Option<String> {
    if event.event_type != "assistant.message_delta" {
        return None;
    }
    clean_sdk_text(
        event
            .data
            .get("deltaContent")
            .or_else(|| event.data.get("delta_content")),
    )
}

fn clean_sdk_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn local_definition_review_artifacts_for_prompt(
    app: &AppHandle,
    prompt: &str,
) -> Vec<AnalyticsArtifact> {
    let lower = prompt.to_ascii_lowercase();
    let mut artifacts = Vec::new();
    if lower.contains("skill") {
        artifacts.extend(local_definition_review_artifacts(
            app,
            "analyze_copilot_skills",
        ));
    }
    if lower.contains("agent") {
        artifacts.extend(local_definition_review_artifacts(
            app,
            "analyze_copilot_agents",
        ));
    }
    artifacts
}

fn extend_unique_artifacts(
    artifacts: &mut Vec<AnalyticsArtifact>,
    additions: Vec<AnalyticsArtifact>,
) {
    let mut seen: BTreeSet<String> = artifacts
        .iter()
        .map(|artifact| format!("{}:{}", artifact.kind, artifact.title))
        .collect();
    for artifact in additions {
        let key = format!("{}:{}", artifact.kind, artifact.title);
        if seen.insert(key) {
            artifacts.push(artifact);
        }
    }
}

fn local_definition_review_artifacts(app: &AppHandle, tool_name: &str) -> Vec<AnalyticsArtifact> {
    match call_insights_mcp_tool(app, tool_name) {
        Ok(payload) => normalize_definition_review_payload(payload)
            .map(|(_, payload)| definition_review_artifacts_from_payload(&payload))
            .unwrap_or_default(),
        Err(err) => {
            log::debug!(
                "Local definition review artifact generation failed: {}",
                err
            );
            Vec::new()
        }
    }
}

fn call_insights_mcp_tool(app: &AppHandle, tool_name: &str) -> Result<Value, String> {
    call_insights_mcp_tool_with_args(
        app,
        tool_name,
        serde_json::json!({ "max_definitions": 1, "max_total_chars": 1000 }),
    )
}

fn call_insights_mcp_tool_with_args(
    app: &AppHandle,
    tool_name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let script = ensure_insights_mcp_server_script(app)?;
    let executable_env = resolve_executable_env();
    let node = executable_env.node.as_ref().ok_or_else(|| {
        "Node.js executable was not found for Mission Control Insights MCP.".to_string()
    })?;
    let mut command = Command::new(node);
    command
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(path) = &executable_env.path {
        command.env("PATH", path);
    }
    if let Some(project_root) = project_root_for_mcp() {
        command.env("CMC_PROJECT_ROOT", project_root);
    }
    let mut child = command.spawn().map_err(|err| err.to_string())?;
    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "MCP process stdin unavailable".to_string())?;
        writeln!(
            stdin,
            "{}",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "mission-control", "version": "0" }
                }
            })
        )
        .map_err(|err| err.to_string())?;
        writeln!(
            stdin,
            "{}",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": tool_name,
                    "arguments": arguments
                }
            })
        )
        .map_err(|err| err.to_string())?;
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "MCP process stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut line = String::new();
    loop {
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("MCP tool call timed out".to_string());
        }
        line.clear();
        let bytes = reader.read_line(&mut line).map_err(|err| err.to_string())?;
        if bytes == 0 {
            break;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("id").and_then(Value::as_u64) != Some(2) {
            continue;
        }
        let _ = child.kill();
        let text = message
            .get("result")
            .and_then(|result| result.get("content"))
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|item| item.get("text"))
            .and_then(Value::as_str)
            .ok_or_else(|| "MCP tool result did not include text content".to_string())?;
        return serde_json::from_str(text).map_err(|err| err.to_string());
    }
    let _ = child.kill();
    Err("MCP tool call exited without a result".to_string())
}

fn strip_mission_control_marker(answer: &str) -> String {
    answer
        .replace(MISSION_CONTROL_ANALYTICS_MARKER, "")
        .trim()
        .to_string()
}

fn ensure_insights_mcp_server_script(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = analytics_dir(app)?.join("mcp");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let script_path = dir.join("mission-control-insights.js");
    fs::write(&script_path, INSIGHTS_MCP_SERVER_SOURCE).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&script_path)
            .map_err(|err| err.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions).map_err(|err| err.to_string())?;
    }
    Ok(script_path)
}

fn mission_control_insights_mcp_servers(
    script_path: &Path,
    project_root: Option<&Path>,
    tools: Vec<String>,
    executable_env: &ExecutableEnv,
) -> HashMap<String, github_copilot_sdk::types::McpServerConfig> {
    use github_copilot_sdk::types::{McpServerConfig, McpStdioServerConfig};

    let mut env = HashMap::new();
    if let Some(path) = &executable_env.path {
        env.insert("PATH".to_string(), path.to_string_lossy().to_string());
    }
    if let Some(project_root) = project_root {
        env.insert(
            "CMC_PROJECT_ROOT".to_string(),
            project_root.to_string_lossy().to_string(),
        );
    }
    let mut servers = HashMap::new();
    servers.insert(
        "mission-control-insights".to_string(),
        McpServerConfig::Stdio(McpStdioServerConfig {
            tools,
            timeout: Some(20_000),
            command: executable_env
                .node
                .as_ref()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|| "node".to_string()),
            args: vec![script_path.to_string_lossy().to_string()],
            env,
            cwd: project_root.map(|path| path.to_string_lossy().to_string()),
        }),
    );
    servers
}

fn mission_control_insights_tools_for_prompt(prompt: &str) -> Vec<String> {
    let lower = prompt.to_ascii_lowercase();
    if is_mcp_usage_prompt(prompt) {
        return vec!["analyze_mcp_servers".to_string()];
    }
    let broad_review = [
        "review",
        "audit",
        "improve",
        "coverage",
        "gap",
        "gaps",
        "missing",
        "duplicate",
        "overlap",
        "compare",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let asks_for_list = ["list", "which", "show me", "available"]
        .iter()
        .any(|needle| lower.contains(needle));
    if broad_review && !asks_for_list {
        let mut tools = Vec::new();
        if lower.contains("skill") {
            tools.push("analyze_copilot_skills".to_string());
        }
        if lower.contains("agent") {
            tools.push("analyze_copilot_agents".to_string());
        }
        if !tools.is_empty() {
            return tools;
        }
    }
    all_mission_control_insights_tools()
}

fn all_mission_control_insights_tools() -> Vec<String> {
    [
        "list_prompt_samples",
        "get_prompt_sample",
        "summarize_prompt_patterns",
        "list_copilot_skills",
        "read_skill_definition",
        "analyze_copilot_skills",
        "list_copilot_agents",
        "read_agent_definition",
        "analyze_copilot_agents",
        "analyze_mcp_servers",
        "health",
    ]
    .iter()
    .map(|tool| (*tool).to_string())
    .collect()
}

fn project_root_for_mcp() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("CMC_PROJECT_ROOT").map(PathBuf::from) {
        return Some(root);
    }
    let cwd = std::env::current_dir().ok()?;
    if cwd.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        return cwd.parent().map(Path::to_path_buf);
    }
    Some(cwd)
}

struct AnalyticsSdkHandler {
    app: AppHandle,
    state: Arc<Mutex<AnalyticsSdkEventState>>,
}

#[async_trait::async_trait]
impl github_copilot_sdk::handler::SessionHandler for AnalyticsSdkHandler {
    async fn on_session_event(
        &self,
        _session_id: github_copilot_sdk::types::SessionId,
        event: github_copilot_sdk::types::SessionEvent,
    ) {
        if let Some(tool_name) = analytics_mcp_tool_name(&event) {
            emit_analytics_chat_tool_started(&self.app, &tool_name);
        }
        if let Some(content) = sdk_assistant_message_content(&event) {
            if let Ok(mut state) = self.state.lock() {
                state.last_assistant_content = Some(content);
            }
        }
        if let Some(delta) = sdk_assistant_delta_content(&event) {
            if let Ok(mut state) = self.state.lock() {
                state.streamed_content.push_str(&delta);
            }
        }
        if let Some((kind, payload)) = sdk_definition_review_payload(&event) {
            if let Ok(mut state) = self.state.lock() {
                state.definition_reviews.insert(kind, payload);
            }
        }
    }
}

fn sdk_definition_review_payload(
    event: &github_copilot_sdk::types::SessionEvent,
) -> Option<(String, Value)> {
    if event.event_type != "tool.execution_complete" {
        return None;
    }
    if event
        .data
        .get("success")
        .and_then(Value::as_bool)
        .is_some_and(|success| !success)
    {
        return None;
    }
    let result = event.data.get("result")?;
    for content in sdk_tool_result_texts(result) {
        if let Ok(payload) = serde_json::from_str::<Value>(&content) {
            if let Some((kind, payload)) = normalize_definition_review_payload(payload) {
                return Some((kind, payload));
            }
        }
        if let Some((kind, payload)) = partial_definition_review_payload(&content) {
            return Some((kind, payload));
        }
    }
    None
}

fn normalize_definition_review_payload(payload: Value) -> Option<(String, Value)> {
    let kind = payload.get("kind").and_then(Value::as_str)?;
    if !matches!(kind, "skills" | "agents") {
        return None;
    }
    if payload.get("review").is_some() {
        return Some((kind.to_string(), payload));
    }
    if let Some(review) = payload.get("artifact_review") {
        return Some((
            kind.to_string(),
            serde_json::json!({ "kind": kind, "review": review }),
        ));
    }
    None
}

fn partial_definition_review_payload(content: &str) -> Option<(String, Value)> {
    let kind = extract_json_string_field(content, "kind")?;
    if !matches!(kind.as_str(), "skills" | "agents") {
        return None;
    }
    let review = extract_json_object_field(content, "artifact_review")?;
    Some((
        kind.clone(),
        serde_json::json!({ "kind": kind, "review": review }),
    ))
}

fn extract_json_string_field(content: &str, field: &str) -> Option<String> {
    let needle = format!("\"{}\"", field);
    let start = content.find(&needle)?;
    let after_key = &content[start + needle.len()..];
    let colon = after_key.find(':')?;
    let after_colon = after_key[colon + 1..].trim_start();
    let value_start = after_colon.strip_prefix('"')?;
    let end = value_start.find('"')?;
    Some(value_start[..end].to_string())
}

fn extract_json_object_field(content: &str, field: &str) -> Option<Value> {
    let needle = format!("\"{}\"", field);
    let start = content.find(&needle)?;
    let after_key = &content[start + needle.len()..];
    let colon = after_key.find(':')?;
    let after_colon = &after_key[colon + 1..];
    let object_offset = after_colon.find('{')?;
    let object_start = start + needle.len() + colon + 1 + object_offset;
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in content[object_start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && in_string {
            escaped = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                let end = object_start + offset + ch.len_utf8();
                return serde_json::from_str(&content[object_start..end]).ok();
            }
        }
    }
    None
}

fn sdk_tool_result_texts(result: &Value) -> Vec<String> {
    let mut texts = Vec::new();
    for key in ["detailedContent", "content"] {
        match result.get(key) {
            Some(Value::String(value)) => texts.push(value.clone()),
            Some(Value::Array(items)) => {
                for item in items {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        texts.push(text.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    texts
}

fn analytics_mcp_tool_name(event: &github_copilot_sdk::types::SessionEvent) -> Option<String> {
    if event.event_type != "tool.execution_start" {
        return None;
    }
    const INSIGHTS_TOOLS: &[&str] = &[
        "health",
        "list_prompt_samples",
        "get_prompt_sample",
        "summarize_prompt_patterns",
        "list_copilot_skills",
        "read_skill_definition",
        "analyze_copilot_skills",
        "list_copilot_agents",
        "read_agent_definition",
        "analyze_copilot_agents",
    ];
    let tool_name = event
        .data
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if INSIGHTS_TOOLS.contains(&tool_name) {
        return Some(tool_name.to_string());
    }
    let data = event.data.to_string();
    INSIGHTS_TOOLS
        .iter()
        .find(|name| data.contains(**name))
        .map(|name| (*name).to_string())
}

fn emit_analytics_chat_tool_started(app: &AppHandle, tool_name: &str) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let Ok(tool_json) = serde_json::to_string(tool_name) else {
        return;
    };
    let _ = win.eval(&format!(
        "window.__cmcAnalyticsChatToolStarted && window.__cmcAnalyticsChatToolStarted({})",
        tool_json
    ));
}

fn is_mission_control_insights_permission(
    data: &github_copilot_sdk::types::PermissionRequestData,
) -> bool {
    if matches!(
        data.kind,
        Some(github_copilot_sdk::types::PermissionRequestKind::Mcp)
    ) && permission_server_name(&data.extra).as_deref() == Some("mission-control-insights")
    {
        return true;
    }
    ["permissionRequest", "promptRequest"]
        .iter()
        .filter_map(|key| data.extra.get(*key))
        .any(|value| {
            value.get("kind").and_then(Value::as_str) == Some("mcp")
                && value.get("serverName").and_then(Value::as_str)
                    == Some("mission-control-insights")
        })
}

fn permission_server_name(value: &Value) -> Option<String> {
    value
        .get("serverName")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("permissionRequest")
                .and_then(|request| request.get("serverName"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            value
                .get("promptRequest")
                .and_then(|request| request.get("serverName"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

#[derive(serde::Deserialize)]
struct SdkAnalyticsAnswer {
    in_scope: bool,
    answer: String,
    #[serde(default)]
    artifacts: Vec<String>,
    #[serde(default, skip_deserializing)]
    definition_review_artifacts: Vec<AnalyticsArtifact>,
}

fn parse_sdk_analytics_answer(content: &str) -> Result<SdkAnalyticsAnswer, String> {
    let cleaned = strip_mission_control_marker(content);
    let json = extract_json_object(&cleaned);
    let mut answer: SdkAnalyticsAnswer =
        serde_json::from_str(json).map_err(|err| format!("Invalid Copilot SDK JSON: {}", err))?;
    answer.answer = strip_mission_control_marker(&answer.answer);
    if answer.answer.is_empty() {
        return Err("Copilot SDK returned an empty answer".to_string());
    }
    if !answer.in_scope {
        answer.answer =
            "I can only answer questions about indexed Copilot CLI usage, prompts, skills, agents, and analytics."
                .to_string();
        answer.artifacts.clear();
    }
    Ok(answer)
}

fn extract_json_object(content: &str) -> &str {
    let Some(start) = content.find('{') else {
        return content.trim();
    };
    let Some(end) = content.rfind('}') else {
        return content[start..].trim();
    };
    content[start..=end].trim()
}

fn artifacts_from_summary(summary: &AnalyticsUsageSummary) -> Vec<AnalyticsArtifact> {
    let mut artifacts = Vec::new();
    if let Some(comparison) = &summary.comparison {
        artifacts.push(AnalyticsArtifact {
            kind: "cards".to_string(),
            title: "Biggest Changes This Week".to_string(),
            cards: comparison_cards(comparison),
            ..Default::default()
        });
    }
    artifacts.extend([
        AnalyticsArtifact {
            kind: "chart".to_string(),
            title: "Token Trend".to_string(),
            points: summary.daily.clone(),
            ..Default::default()
        },
        AnalyticsArtifact {
            kind: "table".to_string(),
            title: if summary.comparison.is_some() {
                "Model Shifts".to_string()
            } else {
                "Model Mix".to_string()
            },
            columns: comparison_columns("Model", "Turns"),
            rows: comparison_rows(
                summary
                    .comparison
                    .as_ref()
                    .map(|comparison| &comparison.model_shifts),
                &summary.model_mix,
            ),
            ..Default::default()
        },
        AnalyticsArtifact {
            kind: "table".to_string(),
            title: if summary.comparison.is_some() {
                "Tool and Failure Changes".to_string()
            } else {
                "Tool Failures".to_string()
            },
            columns: comparison_columns("Tool", "Calls/Failures"),
            rows: comparison_rows(
                summary
                    .comparison
                    .as_ref()
                    .map(|comparison| &comparison.tool_shifts),
                &summary.tool_failures,
            ),
            ..Default::default()
        },
        AnalyticsArtifact {
            kind: "cards".to_string(),
            title: "Recommendations".to_string(),
            cards: summary.recommendations.clone(),
            ..Default::default()
        },
    ]);
    artifacts
}

fn artifacts_for_keys(summary: &AnalyticsUsageSummary, keys: &[String]) -> Vec<AnalyticsArtifact> {
    let mut artifacts = Vec::new();
    let mut seen = BTreeSet::new();
    for key in keys {
        let normalized = key.trim().to_ascii_lowercase().replace('-', "_");
        if !seen.insert(normalized.clone()) {
            continue;
        }
        match normalized.as_str() {
            "changes" => {
                if let Some(comparison) = &summary.comparison {
                    artifacts.push(AnalyticsArtifact {
                        kind: "cards".to_string(),
                        title: "Biggest Changes This Week".to_string(),
                        cards: comparison_cards(comparison),
                        ..Default::default()
                    });
                }
            }
            "token_trend" => artifacts.push(AnalyticsArtifact {
                kind: "chart".to_string(),
                title: "Token Trend".to_string(),
                points: summary.daily.clone(),
                ..Default::default()
            }),
            "token_hotspots" => artifacts.push(AnalyticsArtifact {
                kind: "table".to_string(),
                title: "Session Token Hotspots".to_string(),
                columns: vec![
                    "Session".to_string(),
                    "Model".to_string(),
                    "Output Tokens".to_string(),
                ],
                rows: summary
                    .token_hotspots
                    .iter()
                    .map(|item| {
                        vec![
                            item.label.clone(),
                            item.category.clone(),
                            item.value.to_string(),
                        ]
                    })
                    .collect(),
                ..Default::default()
            }),
            "model_mix" | "models" => artifacts.push(AnalyticsArtifact {
                kind: "table".to_string(),
                title: "Model Mix".to_string(),
                columns: vec![
                    "Model".to_string(),
                    "Turns".to_string(),
                    "Input Tokens".to_string(),
                    "Output Tokens".to_string(),
                ],
                rows: summary
                    .model_mix
                    .iter()
                    .map(|item| {
                        vec![
                            item.label.clone(),
                            item.secondary_value.to_string(),
                            item.tertiary_value.to_string(),
                            item.value.to_string(),
                        ]
                    })
                    .collect(),
                ..Default::default()
            }),
            "model_shifts" => {
                if let Some(comparison) = &summary.comparison {
                    artifacts.push(AnalyticsArtifact {
                        kind: "table".to_string(),
                        title: "Model Shifts".to_string(),
                        columns: comparison_columns("Model", "Turns"),
                        rows: comparison_rows(Some(&comparison.model_shifts), &summary.model_mix),
                        ..Default::default()
                    });
                }
            }
            "tool_failures" => artifacts.push(AnalyticsArtifact {
                kind: "table".to_string(),
                title: "Tool Failures".to_string(),
                columns: vec![
                    "Tool".to_string(),
                    "Category".to_string(),
                    "Failures".to_string(),
                ],
                rows: summary
                    .tool_failures
                    .iter()
                    .map(|item| {
                        vec![
                            item.label.clone(),
                            item.category.clone(),
                            item.value.to_string(),
                        ]
                    })
                    .collect(),
                ..Default::default()
            }),
            "tool_changes" => {
                if let Some(comparison) = &summary.comparison {
                    artifacts.push(AnalyticsArtifact {
                        kind: "table".to_string(),
                        title: "Tool and Failure Changes".to_string(),
                        columns: comparison_columns("Tool", "Calls/Failures"),
                        rows: comparison_rows(
                            Some(&comparison.tool_shifts),
                            &summary.tool_failures,
                        ),
                        ..Default::default()
                    });
                }
            }
            "recommendations" => artifacts.push(AnalyticsArtifact {
                kind: "cards".to_string(),
                title: "Recommendations".to_string(),
                cards: summary.recommendations.clone(),
                ..Default::default()
            }),
            _ => {}
        }
    }
    artifacts
}

fn definition_review_artifacts_from_state(
    state: &Arc<Mutex<AnalyticsSdkEventState>>,
) -> Vec<AnalyticsArtifact> {
    let Ok(state) = state.lock() else {
        return Vec::new();
    };
    let mut keys: Vec<_> = state.definition_reviews.keys().cloned().collect();
    keys.sort();
    keys.into_iter()
        .filter_map(|key| state.definition_reviews.get(&key))
        .flat_map(definition_review_artifacts_from_payload)
        .collect()
}

fn definition_review_artifacts_from_payload(payload: &Value) -> Vec<AnalyticsArtifact> {
    let kind = payload
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("definitions");
    let label = if kind == "agents" { "Agent" } else { "Skill" };
    let label_plural = if kind == "agents" { "Agents" } else { "Skills" };
    let Some(review) = payload.get("review") else {
        return Vec::new();
    };
    let mut artifacts = Vec::new();
    artifacts.push(AnalyticsArtifact {
        kind: "cards".to_string(),
        title: format!("{} Inventory", label_plural),
        cards: definition_inventory_cards(review, label_plural),
        ..Default::default()
    });
    let duplicate_rows = definition_duplicate_rows(review);
    if !duplicate_rows.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "wide_table".to_string(),
            title: format!("Duplicate {} IDs", label),
            columns: vec!["ID".to_string(), "Count".to_string(), "Roots".to_string()],
            rows: duplicate_rows,
            ..Default::default()
        });
    }
    let definition_rows = definition_inventory_rows(review, kind);
    if !definition_rows.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "definition_inventory".to_string(),
            title: format!("All {} ({})", label_plural, definition_rows.len()),
            columns: vec![
                "Name".to_string(),
                "Summary".to_string(),
                "Enabled".to_string(),
                "Details".to_string(),
            ],
            rows: definition_rows,
            ..Default::default()
        });
    }
    let context_rows = definition_review_rows(
        review
            .get("context_cost")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        "source_chars",
        10,
    );
    if !context_rows.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "bars".to_string(),
            title: format!("Largest {} Definitions", label),
            columns: vec![label.to_string(), "Root".to_string(), "Chars".to_string()],
            rows: context_rows,
            ..Default::default()
        });
    }
    let description_rows = definition_review_rows(
        review
            .get("description_lengths")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        "description_chars",
        10,
    );
    if !description_rows.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "bars".to_string(),
            title: format!("Longest {} Descriptions", label),
            columns: vec![label.to_string(), "Root".to_string(), "Chars".to_string()],
            rows: description_rows,
            ..Default::default()
        });
    }
    let completeness_rows = definition_completeness_rows(review, label);
    if !completeness_rows.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "wide_table".to_string(),
            title: format!("{} Readiness Checks", label),
            description: if label == "Skill" {
                "Automated checks for whether a skill explains when to use it, when not to use it, how to run it, and how to validate the result. Use View before making changes.".to_string()
            } else {
                "Automated checks for whether an agent explains when to use it, when not to use it, how to run it, and how to validate the result. Use View before making changes.".to_string()
            },
            columns: vec![
                label.to_string(),
                "Readiness".to_string(),
                "Suggested Fixes".to_string(),
                "Details".to_string(),
            ],
            rows: completeness_rows,
            ..Default::default()
        });
    }
    let overlap_rows = definition_overlap_rows(review, 8);
    if !overlap_rows.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "wide_table".to_string(),
            title: format!("{} Overlap Candidates", label),
            columns: vec![
                "Definition A".to_string(),
                "Definition B".to_string(),
                "Score".to_string(),
                "Shared Terms".to_string(),
            ],
            rows: overlap_rows,
            ..Default::default()
        });
    }
    let action_cards = definition_action_cards(review);
    if !action_cards.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "cards".to_string(),
            title: format!("Prioritized {} Fixes", label),
            cards: action_cards,
            ..Default::default()
        });
    }
    artifacts
}

fn definition_duplicate_rows(review: &Value) -> Vec<Vec<String>> {
    review
        .get("duplicate_groups")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|item| {
            let roots = item
                .get("roots")
                .and_then(Value::as_array)
                .map(|roots| {
                    roots
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            Some(vec![
                json_string(item, "id")?,
                json_u64(item, "count").to_string(),
                roots,
            ])
        })
        .collect()
}

fn definition_inventory_rows(review: &Value, kind: &str) -> Vec<Vec<String>> {
    review
        .get("definitions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|item| {
            let name = json_string(item, "id")?;
            let summary =
                json_string(item, "summary").unwrap_or_else(|| "No summary available.".to_string());
            let enabled = if item.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
                "Yes"
            } else {
                "No"
            };
            let issues = item
                .get("issues")
                .and_then(Value::as_array)
                .map(|issues| {
                    issues
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let static_eval = static_definition_evaluation_for_item(item, kind);
            let (score, max_score, score_label, readiness) = static_eval
                .as_ref()
                .map(|eval| {
                    (
                        eval.score,
                        eval.max_score,
                        eval.score_label.clone(),
                        eval.readiness.clone(),
                    )
                })
                .unwrap_or_else(|| fallback_definition_score(item));
            let details = serde_json::json!({
                "name": name,
                "definition": json_string(item, "definition_ref").unwrap_or_else(|| name.clone()),
                "kind": if kind == "agents" { "agents" } else { "skills" },
                "summary": summary,
                "enabled": enabled,
                "root": json_string(item, "root").unwrap_or_else(|| "unknown".to_string()),
                "size": json_u64(item, "source_chars"),
                "descriptionChars": json_u64(item, "description_chars"),
                "score": score,
                "maxScore": max_score,
                "scoreLabel": score_label,
                "readiness": readiness,
                "issues": issues,
            })
            .to_string();
            Some(vec![name, summary, enabled.to_string(), details])
        })
        .collect()
}

fn definition_inventory_cards(review: &Value, label_plural: &str) -> Vec<AnalyticsRecommendation> {
    let inventory = review.get("inventory").unwrap_or(&Value::Null);
    let discovered = json_u64(inventory, "discovered_definitions");
    let analyzed = json_u64(inventory, "analyzed_definitions");
    let skipped = json_u64(inventory, "skipped_definitions");
    let model_context_definitions = json_u64(inventory, "model_context_definitions");
    let model_context_skipped = json_u64(inventory, "model_context_skipped");
    let roots = inventory
        .get("roots")
        .and_then(Value::as_array)
        .map(|roots| {
            roots
                .iter()
                .filter_map(|root| {
                    Some(format!(
                        "{}: {}",
                        root.get("root").and_then(Value::as_str)?,
                        json_u64(root, "count")
                    ))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "No roots reported".to_string());
    vec![
        AnalyticsRecommendation {
            title: format!("{} Discovered", label_plural),
            body: if model_context_skipped > 0 {
                format!(
                    "{} discovered and {} analyzed for dashboard metrics. {} definition{} were included in model context; {} skipped model context because of content caps.",
                    discovered,
                    analyzed,
                    model_context_definitions,
                    plural(model_context_definitions),
                    model_context_skipped
                )
            } else {
                format!(
                    "{} discovered, {} analyzed{}.",
                    discovered,
                    analyzed,
                    if skipped > 0 {
                        format!(", {} skipped by caps", skipped)
                    } else {
                        String::new()
                    }
                )
            },
            severity: "info".to_string(),
            metric: "inventory".to_string(),
        },
        AnalyticsRecommendation {
            title: "Source Roots".to_string(),
            body: roots,
            severity: "info".to_string(),
            metric: "roots".to_string(),
        },
    ]
}

fn definition_review_rows(items: &[Value], value_key: &str, limit: usize) -> Vec<Vec<String>> {
    items
        .iter()
        .take(limit)
        .filter_map(|item| {
            Some(vec![
                json_string(item, "id")?,
                json_string(item, "root").unwrap_or_else(|| "unknown".to_string()),
                json_u64(item, value_key).to_string(),
            ])
        })
        .collect()
}

fn definition_completeness_rows(review: &Value, label: &str) -> Vec<Vec<String>> {
    let static_rows = static_definition_completeness_rows(review, label);
    if !static_rows.is_empty() {
        return static_rows;
    }

    review
        .get("completeness")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|item| {
            let id = json_string(item, "id")?;
            let score = json_u64(item, "completeness_score");
            let details = serde_json::json!({
                "name": id,
                "definition": json_string(item, "definition_ref").unwrap_or_else(|| id.clone()),
                "kind": if label == "Agent" { "agents" } else { "skills" },
                "root": json_string(item, "root").unwrap_or_else(|| "unknown".to_string()),
                "score": score,
                "maxScore": 5,
                "scoreLabel": format!("{}/5", score),
            })
            .to_string();
            let issues = item
                .get("issues")
                .and_then(Value::as_array)
                .map(|issues| {
                    issues
                        .iter()
                        .filter_map(Value::as_str)
                        .take(5)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("{} looks complete", label));
            Some(vec![id, format!("{}/5", score), issues, details])
        })
        .collect()
}

#[derive(Debug)]
struct StaticDefinitionRow {
    id: String,
    root: String,
    definition_ref: String,
    kind: &'static str,
    score: u64,
    max_score: u64,
    score_label: String,
    readiness: String,
    issues: Vec<String>,
}

fn static_definition_completeness_rows(review: &Value, label: &str) -> Vec<Vec<String>> {
    let kind = if label == "Agent" { "agents" } else { "skills" };
    let mut rows = review
        .get("definitions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|item| static_definition_evaluation_for_item(item, kind))
        .filter(|row| row.score < row.max_score || !row.issues.is_empty())
        .collect::<Vec<_>>();

    rows.sort_by(|a, b| {
        let left = (a.score as f64) / (a.max_score.max(1) as f64);
        let right = (b.score as f64) / (b.max_score.max(1) as f64);
        left.partial_cmp(&right)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });

    rows.into_iter()
        .take(16)
        .map(|row| {
            let details = serde_json::json!({
                "name": row.id,
                "definition": row.definition_ref,
                "kind": row.kind,
                "root": row.root,
                "score": row.score,
                "maxScore": row.max_score,
                "scoreLabel": row.score_label,
                "readiness": row.readiness,
                "issues": row.issues.join(", "),
            })
            .to_string();
            let issues = if row.issues.is_empty() {
                format!("{} readiness", row.readiness)
            } else {
                row.issues
                    .iter()
                    .take(5)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            vec![row.id, row.score_label, issues, details]
        })
        .collect()
}

fn static_definition_evaluation_for_item(item: &Value, kind: &str) -> Option<StaticDefinitionRow> {
    let kind = crate::definition_paths::normalize_definition_kind(kind).ok()?;
    let id = json_string(item, "id")?;
    let definition_ref = json_string(item, "definition_ref").unwrap_or_else(|| id.clone());
    let root = json_string(item, "root").unwrap_or_else(|| "unknown".to_string());
    let root_arg = (root != "unknown").then_some(root.as_str());
    let evaluation =
        crate::skill_evaluator::evaluate_definition_static(kind, &definition_ref, root_arg)
            .ok()?
            .evaluation;
    let issues = if evaluation.top_actions.is_empty() {
        evaluation
            .dimensions
            .iter()
            .filter(|dimension| dimension.status != "pass")
            .map(|dimension| format!("{} needs review", dimension.label))
            .take(5)
            .collect()
    } else {
        evaluation
            .top_actions
            .iter()
            .map(|action| action.title.clone())
            .take(5)
            .collect()
    };
    Some(StaticDefinitionRow {
        id,
        root,
        definition_ref,
        kind,
        score: evaluation.score as u64,
        max_score: evaluation.max_score as u64,
        score_label: format!("{}/{}", evaluation.score, evaluation.max_score),
        readiness: evaluation.readiness,
        issues,
    })
}

fn fallback_definition_score(item: &Value) -> (u64, u64, String, String) {
    let score = json_u64(item, "completeness_score");
    (score, 5, format!("{}/5", score), String::new())
}

fn definition_overlap_rows(review: &Value, limit: usize) -> Vec<Vec<String>> {
    review
        .get("overlap_pairs")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .take(limit)
        .filter_map(|item| {
            let terms = item
                .get("shared_tokens")
                .and_then(Value::as_array)
                .map(|tokens| {
                    tokens
                        .iter()
                        .filter_map(Value::as_str)
                        .take(6)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            Some(vec![
                json_string(item, "left_id")?,
                json_string(item, "right_id")?,
                format!(
                    "{:.2}",
                    item.get("score").and_then(Value::as_f64).unwrap_or(0.0)
                ),
                terms,
            ])
        })
        .collect()
}

fn definition_action_cards(review: &Value) -> Vec<AnalyticsRecommendation> {
    review
        .get("actions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .take(6)
        .filter_map(|item| {
            Some(AnalyticsRecommendation {
                title: json_string(item, "title")?,
                body: json_string(item, "body").unwrap_or_default(),
                severity: json_string(item, "severity").unwrap_or_else(|| "info".to_string()),
                metric: json_string(item, "metric")
                    .unwrap_or_else(|| "definition_review".to_string()),
            })
        })
        .collect()
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn json_u64(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn daily_points_window(
    conn: &Connection,
    since_day: &str,
    before_day: Option<&str>,
) -> Result<Vec<AnalyticsDailyPoint>, String> {
    let before_clause = if before_day.is_some() {
        " AND local_day < ?2"
    } else {
        ""
    };
    let mut stmt = conn
        .prepare(&format!(
            r#"
            SELECT local_day,
                   SUM(session_count),
                   SUM(event_count),
                   SUM(turn_count),
                   SUM(tool_call_count),
                   SUM(failure_count),
                   SUM(input_tokens),
                   SUM(output_tokens),
                   SUM(estimated_active_ms),
                   MAX(token_data_partial)
            FROM daily_rollups
            WHERE local_day >= ?1{}
            GROUP BY local_day
            ORDER BY local_day ASC
            "#,
            before_clause
        ))
        .map_err(|err| err.to_string())?;
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(AnalyticsDailyPoint {
            local_day: row.get(0)?,
            sessions: row.get::<_, i64>(1)?.max(0) as u64,
            events: row.get::<_, i64>(2)?.max(0) as u64,
            turns: row.get::<_, i64>(3)?.max(0) as u64,
            tool_calls: row.get::<_, i64>(4)?.max(0) as u64,
            failures: row.get::<_, i64>(5)?.max(0) as u64,
            input_tokens: row.get::<_, i64>(6)?.max(0) as u64,
            output_tokens: row.get::<_, i64>(7)?.max(0) as u64,
            estimated_active_ms: row.get::<_, i64>(8)?.max(0) as u64,
            partial: row.get::<_, i64>(9)? > 0,
        })
    };
    if let Some(before_day) = before_day {
        let rows = stmt
            .query_map(params![since_day, before_day], map_row)
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    } else {
        let rows = stmt
            .query_map(params![since_day], map_row)
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }
}

fn token_hotspots(conn: &Connection, since_day: &str) -> Result<Vec<AnalyticsRankedItem>, String> {
    let (since_ms, _, _) = local_day_bounds(since_day);
    let mut stmt = conn
        .prepare(
            r#"
            SELECT session_id_hash, output_tokens, input_tokens, token_data_partial, last_model, turn_count, last_seen_ms
            FROM sessions
            WHERE last_seen_ms >= ?1 AND (output_tokens > 0 OR input_tokens > 0)
            ORDER BY output_tokens DESC, input_tokens DESC
            LIMIT 8
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![since_ms as i64], |row| {
            let session_hash: String = row.get(0)?;
            let short_hash: String = session_hash.chars().take(8).collect();
            let turn_count = row.get::<_, i64>(5)?.max(0) as u64;
            let last_seen_ms = row.get::<_, i64>(6)?.max(0) as u64;
            Ok(AnalyticsRankedItem {
                label: format!(
                    "{} - {} turn{}\nSession {}",
                    local_time_label(last_seen_ms),
                    turn_count,
                    if turn_count == 1 { "" } else { "s" },
                    short_hash
                ),
                category: row.get::<_, String>(4)?,
                value: row.get::<_, i64>(1)?.max(0) as u64,
                secondary_value: row.get::<_, i64>(2)?.max(0) as u64,
                tertiary_value: 0,
                partial: row.get::<_, i64>(3)? > 0,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn model_mix(conn: &Connection, since_day: &str) -> Result<Vec<AnalyticsRankedItem>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT model, SUM(output_tokens), SUM(turn_count), SUM(input_tokens), MAX(token_data_partial)
            FROM model_rollups
            WHERE local_day >= ?1
              AND model != 'Unknown'
              AND (turn_count > 0 OR output_tokens > 0 OR input_tokens > 0)
            GROUP BY model
            ORDER BY SUM(turn_count) DESC, SUM(output_tokens) DESC
            LIMIT 8
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![since_day], |row| {
            Ok(AnalyticsRankedItem {
                label: row.get(0)?,
                category: "model".to_string(),
                value: row.get::<_, i64>(1)?.max(0) as u64,
                secondary_value: row.get::<_, i64>(2)?.max(0) as u64,
                tertiary_value: row.get::<_, i64>(3)?.max(0) as u64,
                partial: row.get::<_, i64>(4)? > 0,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn tool_failures(conn: &Connection, since_day: &str) -> Result<Vec<AnalyticsRankedItem>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT tool_name, tool_category, SUM(failure_count), SUM(call_count)
            FROM tool_rollups
            WHERE local_day >= ?1 AND failure_count > 0
            GROUP BY tool_name, tool_category
            ORDER BY SUM(failure_count) DESC, SUM(call_count) DESC
            LIMIT 8
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![since_day], |row| {
            Ok(AnalyticsRankedItem {
                label: row.get(0)?,
                category: row.get(1)?,
                value: row.get::<_, i64>(2)?.max(0) as u64,
                secondary_value: row.get::<_, i64>(3)?.max(0) as u64,
                tertiary_value: 0,
                partial: false,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn comparison_from_db(
    conn: &Connection,
    current_start_day: &str,
    previous_start_day: &str,
    range_days: u32,
    current_daily: &[AnalyticsDailyPoint],
) -> Result<AnalyticsComparison, String> {
    let previous_daily = daily_points_window(conn, previous_start_day, Some(current_start_day))?;
    let current_metrics = summary_metrics(current_daily);
    let previous_metrics = summary_metrics(&previous_daily);
    let mut changes = [
        "Sessions",
        "Turns",
        "Tool calls",
        "Failures",
        "Input tokens",
        "Output tokens",
    ]
    .iter()
    .map(|label| {
        change_item(
            label,
            "metric",
            metric_value(&current_metrics, label),
            metric_value(&previous_metrics, label),
        )
    })
    .collect::<Vec<_>>();
    changes.sort_by(|a, b| b.delta.unsigned_abs().cmp(&a.delta.unsigned_abs()));
    changes.truncate(6);

    Ok(AnalyticsComparison {
        current_label: format!("last {} day{}", range_days, plural(range_days as u64)),
        previous_label: format!("previous {} day{}", range_days, plural(range_days as u64)),
        changes,
        model_shifts: ranked_shift_items(
            &model_values_between(conn, current_start_day, None)?,
            &model_values_between(conn, previous_start_day, Some(current_start_day))?,
            "model",
            6,
        ),
        tool_shifts: ranked_shift_items(
            &tool_values_between(conn, current_start_day, None)?,
            &tool_values_between(conn, previous_start_day, Some(current_start_day))?,
            "tool",
            8,
        ),
    })
}

fn model_values_between(
    conn: &Connection,
    start_day: &str,
    before_day: Option<&str>,
) -> Result<BTreeMap<String, u64>, String> {
    query_value_map(
        conn,
        "model",
        "model_rollups",
        "model != 'Unknown' AND (turn_count > 0 OR output_tokens > 0)",
        "SUM(turn_count)",
        start_day,
        before_day,
    )
}

fn tool_values_between(
    conn: &Connection,
    start_day: &str,
    before_day: Option<&str>,
) -> Result<BTreeMap<String, u64>, String> {
    query_value_map(
        conn,
        "tool_name",
        "tool_rollups",
        "call_count > 0 OR failure_count > 0",
        "SUM(call_count + failure_count)",
        start_day,
        before_day,
    )
}

fn query_value_map(
    conn: &Connection,
    label_column: &str,
    table: &str,
    extra_where: &str,
    value_expr: &str,
    start_day: &str,
    before_day: Option<&str>,
) -> Result<BTreeMap<String, u64>, String> {
    let before_clause = if before_day.is_some() {
        " AND local_day < ?2"
    } else {
        ""
    };
    let sql = format!(
        "SELECT {label_column}, {value_expr} FROM {table} WHERE local_day >= ?1{before_clause} AND {extra_where} GROUP BY {label_column}",
    );
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?.max(0) as u64,
        ))
    };
    let pairs = if let Some(before_day) = before_day {
        stmt.query_map(params![start_day, before_day], map_row)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    } else {
        stmt.query_map(params![start_day], map_row)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };
    Ok(pairs.into_iter().collect())
}

fn ranked_shift_items(
    current: &BTreeMap<String, u64>,
    previous: &BTreeMap<String, u64>,
    category: &str,
    limit: usize,
) -> Vec<AnalyticsChangeItem> {
    let labels = current
        .keys()
        .chain(previous.keys())
        .collect::<BTreeSet<_>>();
    let mut items = labels
        .into_iter()
        .map(|label| {
            change_item(
                label,
                category,
                *current.get(label).unwrap_or(&0),
                *previous.get(label).unwrap_or(&0),
            )
        })
        .filter(|item| item.current > 0 || item.previous > 0)
        .collect::<Vec<_>>();
    items.sort_by(|a, b| b.delta.unsigned_abs().cmp(&a.delta.unsigned_abs()));
    items.truncate(limit);
    items
}

fn change_item(label: &str, category: &str, current: u64, previous: u64) -> AnalyticsChangeItem {
    let delta = current as i64 - previous as i64;
    let percent_change = if previous == 0 {
        None
    } else {
        Some((delta as f64 / previous as f64) * 100.0)
    };
    AnalyticsChangeItem {
        label: label.to_string(),
        category: category.to_string(),
        current,
        previous,
        delta,
        percent_change,
    }
}

fn summary_metrics(daily: &[AnalyticsDailyPoint]) -> Vec<AnalyticsMetricValue> {
    let sessions = daily.iter().map(|d| d.sessions).sum();
    let events = daily.iter().map(|d| d.events).sum();
    let turns = daily.iter().map(|d| d.turns).sum();
    let tool_calls = daily.iter().map(|d| d.tool_calls).sum();
    let failures = daily.iter().map(|d| d.failures).sum();
    let input_tokens = daily.iter().map(|d| d.input_tokens).sum();
    let output_tokens = daily.iter().map(|d| d.output_tokens).sum();
    let active = daily.iter().map(|d| d.estimated_active_ms).sum();
    let partial = daily.iter().any(|d| d.partial);
    vec![
        exact_metric("Sessions", sessions),
        exact_metric("Events", events),
        exact_metric("Turns", turns),
        exact_metric("Tool calls", tool_calls),
        exact_metric("Failures", failures),
        partial_metric("Input tokens", input_tokens, partial),
        exact_metric("Output tokens", output_tokens),
        AnalyticsMetricValue {
            label: "Estimated active window".to_string(),
            value: active,
            exact: false,
            estimated: true,
            partial,
        },
    ]
}

fn recommendations_from_parts(
    daily: &[AnalyticsDailyPoint],
    hotspots: &[AnalyticsRankedItem],
    models: &[AnalyticsRankedItem],
    failures: &[AnalyticsRankedItem],
) -> Vec<AnalyticsRecommendation> {
    let mut cards = Vec::new();
    if let Some(failure) = failures.first() {
        cards.push(AnalyticsRecommendation {
            title: "Review Repeated Tool Failures".to_string(),
            body: format!(
                "{} in {} failed {} time{}. Check whether that workflow needs setup, permissions, or a smaller retry loop.",
                failure.label,
                category_label(&failure.category),
                failure.value,
                plural(failure.value)
            ),
            severity: "review".to_string(),
            metric: "tool_failures".to_string(),
        });
    }
    if let Some(hotspot) = hotspots.first() {
        cards.push(AnalyticsRecommendation {
            title: "Investigate Token Hotspot".to_string(),
            body: format!(
                "{} produced {} output token{}. If this is unexpected, compare the related workflow against a shorter session.",
                hotspot.label,
                hotspot.value,
                plural(hotspot.value)
            ),
            severity: "watch".to_string(),
            metric: "token_hotspot".to_string(),
        });
    }
    if let Some(model) = models.first() {
        cards.push(AnalyticsRecommendation {
            title: "Model Mix Context".to_string(),
            body: format!(
                "{} appears most often in this range with {} observed turn{}. Use this when comparing behavior across date ranges.",
                model.label,
                model.secondary_value,
                plural(model.secondary_value)
            ),
            severity: "info".to_string(),
            metric: "model_mix".to_string(),
        });
    }
    let failures_total: u64 = daily.iter().map(|point| point.failures).sum();
    if cards.is_empty() && !daily.is_empty() {
        cards.push(AnalyticsRecommendation {
            title: "No Major Friction Found".to_string(),
            body: format!(
                "No repeated failure pattern stands out in this range ({} total failure{}). Keep an eye on changes after workflow or model changes.",
                failures_total,
                plural(failures_total)
            ),
            severity: "info".to_string(),
            metric: "failure_count".to_string(),
        });
    }
    cards
}

fn comparison_cards(comparison: &AnalyticsComparison) -> Vec<AnalyticsRecommendation> {
    comparison
        .changes
        .iter()
        .take(4)
        .map(|change| AnalyticsRecommendation {
            title: change.label.clone(),
            body: format!(
                "{} {} versus the {} ({} -> {}).",
                change.label,
                delta_phrase(change.delta),
                comparison.previous_label,
                change.previous,
                change.current
            ),
            severity: if change.delta == 0 { "info" } else { "review" }.to_string(),
            metric: change.category.clone(),
        })
        .collect()
}

fn comparison_columns(label: &str, value_label: &str) -> Vec<String> {
    vec![
        label.to_string(),
        format!("Current {}", value_label),
        format!("Previous {}", value_label),
        format!("Delta {}", value_label),
    ]
}

fn comparison_rows(
    changes: Option<&Vec<AnalyticsChangeItem>>,
    fallback: &[AnalyticsRankedItem],
) -> Vec<Vec<String>> {
    if let Some(changes) = changes {
        return changes
            .iter()
            .map(|item| {
                vec![
                    item.label.clone(),
                    item.current.to_string(),
                    item.previous.to_string(),
                    signed_number(item.delta),
                ]
            })
            .collect();
    }
    fallback
        .iter()
        .map(|item| {
            vec![
                item.label.clone(),
                item.secondary_value.to_string(),
                "0".to_string(),
                item.value.to_string(),
            ]
        })
        .collect()
}

fn delta_phrase(delta: i64) -> String {
    if delta > 0 {
        format!("increased by {}", delta)
    } else if delta < 0 {
        format!("decreased by {}", delta.unsigned_abs())
    } else {
        "stayed flat".to_string()
    }
}

fn signed_number(value: i64) -> String {
    if value > 0 {
        format!("+{}", value)
    } else {
        value.to_string()
    }
}

fn count_table(conn: &Connection, table: &str) -> Result<usize, String> {
    let sql = format!("SELECT COUNT(*) FROM {}", table);
    Ok(conn
        .query_row(&sql, [], |row| row.get::<_, i64>(0))
        .map_err(|err| err.to_string())?
        .max(0) as usize)
}

fn db_size_bytes(app: &AppHandle) -> Result<u64, String> {
    let path = analytics_dir(app)?.join(ANALYTICS_DB_FILE);
    Ok(fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0))
}

fn latest_audit_code(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT safe_code FROM ingestion_audit ORDER BY occurred_at_ms DESC LIMIT 1",
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn warnings_from_db(conn: &Connection, snapshot_limited: bool) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    if ingestion_running() {
        warnings.push("Analyzing Copilot history in the background.".to_string());
    }
    if snapshot_limited {
        warnings.push(
            "Snapshot-limited: analytics currently reflects the live dashboard scan window."
                .to_string(),
        );
    }
    let drift_count: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(count), 0) FROM ingestion_audit WHERE safe_code LIKE '%DRIFT%'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if drift_count > 0 {
        warnings.push("Provider schema drift was observed during analytics ingestion.".to_string());
    }
    Ok(warnings)
}

fn exact_metric(label: &str, value: u64) -> AnalyticsMetricValue {
    AnalyticsMetricValue {
        label: label.to_string(),
        value,
        exact: true,
        estimated: false,
        partial: false,
    }
}

fn partial_metric(label: &str, value: u64, partial: bool) -> AnalyticsMetricValue {
    AnalyticsMetricValue {
        label: label.to_string(),
        value,
        exact: !partial,
        estimated: false,
        partial,
    }
}

fn metric_value(metrics: &[AnalyticsMetricValue], label: &str) -> u64 {
    metrics
        .iter()
        .find(|metric| metric.label == label)
        .map(|metric| metric.value)
        .unwrap_or(0)
}

#[derive(Default)]
struct DailyAccumulator {
    session_ids: BTreeSet<String>,
    event_count: u64,
    turn_count: u64,
    tool_call_count: u64,
    failure_count: u64,
    input_tokens: u64,
    output_tokens: u64,
    estimated_active_ms: u64,
    token_data_partial: bool,
}

impl DailyAccumulator {
    fn new(_event_ms: u64) -> Self {
        Self::default()
    }
}

#[derive(Default)]
struct ModelAccumulator {
    session_ids: BTreeSet<String>,
    turn_count: u64,
    input_tokens: u64,
    output_tokens: u64,
    token_data_partial: bool,
}

#[derive(Default)]
struct CategoryAccumulator {
    turn_count: u64,
    tool_call_count: u64,
    failure_count: u64,
    input_tokens: u64,
    output_tokens: u64,
    token_data_partial: bool,
}

#[derive(Default)]
struct ToolAccumulator {
    call_count: u64,
    success_count: u64,
    failure_count: u64,
    total_duration_ms: u64,
}

#[derive(Default)]
struct FailureAccumulator {
    count: u64,
    last_seen_ms: u64,
}

fn normalize_range_days(range_days: Option<u32>) -> u32 {
    range_days
        .unwrap_or(DEFAULT_RANGE_DAYS)
        .clamp(1, MAX_RANGE_DAYS)
}

fn normalized_provider(provider: &str) -> String {
    safe_label(provider, "copilot")
}

fn safe_label(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    trimmed
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(*ch, '.' | '_' | '-' | ':' | '/'))
        .take(80)
        .collect::<String>()
}

fn sanitize_repository_label(value: &str) -> String {
    let normalized = value.trim().replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    let candidate = trimmed
        .rsplit('/')
        .find(|segment| !segment.trim().is_empty())
        .unwrap_or(trimmed);
    safe_label(candidate, "Unknown")
}

fn sanitize_branch_label(value: &str) -> String {
    let trimmed = value
        .trim()
        .strip_prefix("refs/heads/")
        .unwrap_or(value.trim());
    safe_label(trimmed, "unknown")
}

fn sanitize_title_label(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "Untitled".to_string();
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("~/") {
        return "Untitled".to_string();
    }
    trimmed
        .chars()
        .filter(|ch| {
            ch.is_ascii_alphanumeric() || *ch == ' ' || matches!(*ch, '.' | '_' | '-' | ':' | '#')
        })
        .take(96)
        .collect::<String>()
        .trim()
        .to_string()
}

fn local_copilot_history_root() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .map(|home| home.join(".copilot").join("session-state"))
}

fn value_at_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in path.split('.') {
        if segment.is_empty() {
            return None;
        }
        current = current.get(segment)?;
    }
    Some(current)
}

fn string_at_path(value: &Value, path: &str) -> Option<String> {
    value_at_path(value, path)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn bool_at_path(value: &Value, path: &str) -> Option<bool> {
    value_at_path(value, path).and_then(Value::as_bool)
}

fn u64_at_path(value: &Value, path: &str) -> Option<u64> {
    value_at_path(value, path).and_then(Value::as_u64)
}

fn event_id(value: &Value, event_ms: u64) -> String {
    string_at_path(value, "id").unwrap_or_else(|| event_ms.to_string())
}

fn classify_local_tool(raw_name: &str, args: Option<&Value>) -> (String, String) {
    let lower = raw_name.to_ascii_lowercase();
    if lower == "skill" {
        let fallback = "skill".to_string();
        let skill = args
            .and_then(|args| string_at_path(args, "skill"))
            .map(|value| safe_label(&value, &fallback))
            .unwrap_or(fallback);
        return (skill, "skills".to_string());
    }
    if lower == "task" {
        let fallback = "task".to_string();
        let agent = args
            .and_then(|args| {
                string_at_path(args, "agent_type")
                    .or_else(|| string_at_path(args, "subagent_type"))
                    .or_else(|| string_at_path(args, "name"))
            })
            .map(|value| safe_label(&value, &fallback))
            .unwrap_or(fallback);
        return (agent, "delegates".to_string());
    }
    let category = categorize_local_tool(raw_name);
    (safe_label(raw_name, "tool"), category)
}

fn categorize_local_tool(tool_name: &str) -> String {
    let name = tool_name.to_ascii_lowercase();
    let rules = [
        ("mcp", ["mcp", "-", "", ""]),
        ("terminal", ["bash", "shell", "sql", "test"]),
        ("delegates", ["agent", "task", "", ""]),
        ("signal", ["web", "fetch", "docs", "github"]),
        ("edits", ["edit", "create", "apply_patch", "write"]),
        ("library", ["view", "read", "grep", "rg"]),
        ("library", ["glob", "search", "", ""]),
        ("skills", ["skill", "memory", "", ""]),
        ("court", ["ask", "intent", "plan", "schedule"]),
    ];
    for (category, needles) in rules {
        if needles
            .iter()
            .filter(|needle| !needle.is_empty())
            .any(|needle| name.contains(needle))
        {
            return category.to_string();
        }
    }
    "court".to_string()
}

fn shutdown_token_totals(value: &Value) -> (u64, u64, Vec<(String, u64, u64)>) {
    let mut by_model = Vec::new();
    let mut model_input = 0_u64;
    let mut model_output = 0_u64;
    if let Some(metrics) = value_at_path(value, "data.modelMetrics").and_then(Value::as_object) {
        for (model, metric) in metrics {
            let input = u64_at_path(metric, "usage.inputTokens")
                .unwrap_or(0)
                .saturating_sub(u64_at_path(metric, "usage.cacheReadTokens").unwrap_or(0));
            let output = u64_at_path(metric, "usage.outputTokens").unwrap_or(0);
            model_input = model_input.saturating_add(input);
            model_output = model_output.saturating_add(output);
            by_model.push((safe_label(model, "Unknown"), input, output));
        }
    }
    let input = [
        "data.tokenDetails.input.tokenCount",
        "data.tokenDetails.cache_write.tokenCount",
    ]
    .iter()
    .filter_map(|path| u64_at_path(value, path))
    .sum::<u64>()
    .max(model_input);
    let output = u64_at_path(value, "data.tokenDetails.output.tokenCount")
        .unwrap_or(0)
        .max(model_output);
    (input, output, by_model)
}

fn sanitize_prompt_for_echo(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return "What changed in my Copilot CLI usage this week?".to_string();
    }
    trimmed.chars().take(240).collect()
}

fn hash_with_provider(provider: &str, value: &str) -> String {
    hash_str(&format!("{}:{}", provider, value))
}

fn hash_str(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut hex = String::with_capacity(24);
    for byte in digest.iter().take(12) {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

fn event_dedupe_key(event: &AgentEventSummary, occurred_at_ms: u64) -> String {
    hash_str(&format!(
        "{}:{}:{}:{}:{}:{}:{}:{}:{}",
        normalized_provider(&event.provider),
        event.session_id,
        occurred_at_ms,
        event.kind,
        event.tool,
        event.category,
        event.success,
        event.input_tokens.unwrap_or(0),
        event.output_tokens.unwrap_or(0)
    ))
}

fn parse_iso_ms(value: &str) -> Option<u64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .and_then(|dt| u64::try_from(dt.timestamp_millis()).ok())
}

fn local_day(ms: u64) -> String {
    let dt = Utc
        .timestamp_millis_opt(ms as i64)
        .single()
        .unwrap_or_else(Utc::now)
        .with_timezone(&Local);
    format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day())
}

fn local_time_label(ms: u64) -> String {
    let dt = Utc
        .timestamp_millis_opt(ms as i64)
        .single()
        .unwrap_or_else(Utc::now)
        .with_timezone(&Local);
    dt.format("%b %-d, %-I:%M %p").to_string()
}

fn local_day_shift(day: &str, offset_days: i64) -> String {
    let parsed =
        NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap_or_else(|_| Local::now().date_naive());
    let shifted = parsed
        .checked_add_signed(chrono::Duration::days(offset_days))
        .unwrap_or(parsed);
    format!(
        "{:04}-{:02}-{:02}",
        shifted.year(),
        shifted.month(),
        shifted.day()
    )
}

fn local_day_bounds(day: &str) -> (u64, u64, i32) {
    let parsed = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .unwrap_or_else(|_| Local::now().date_naive());
    let start = parsed
        .and_hms_opt(0, 0, 0)
        .and_then(|naive| Local.from_local_datetime(&naive).earliest())
        .unwrap_or_else(Local::now);
    let end = parsed
        .succ_opt()
        .and_then(|next| next.and_hms_opt(0, 0, 0))
        .and_then(|naive| Local.from_local_datetime(&naive).earliest())
        .unwrap_or(start);
    (
        start.timestamp_millis().max(0) as u64,
        end.timestamp_millis().max(0) as u64,
        start.offset().local_minus_utc() / 60,
    )
}

fn system_time_to_ms(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn estimate_active_ms(event_count: u64) -> u64 {
    event_count.min(1).saturating_mul(ACTIVE_EVENT_WINDOW_MS)
}

fn bool_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn category_label(category: &str) -> &'static str {
    match category {
        "edits" => "Edits",
        "library" => "Reads",
        "terminal" => "Commands",
        "signal" => "Web/Docs",
        "hooks" => "Hooks",
        "delegates" => "Sub-Agents",
        "skills" => "Skills",
        "court" => "Intent",
        "mcp" => "MCP",
        "alert" => "Failures",
        _ => "Activity",
    }
}

fn plural(value: u64) -> &'static str {
    if value == 1 {
        ""
    } else {
        "s"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn safe_label_filters_control_characters() {
        assert_eq!(safe_label("tool\nname?", "x"), "toolname");
    }

    #[test]
    fn hash_is_short_and_stable() {
        assert_eq!(hash_str("abc"), hash_str("abc"));
        assert_eq!(hash_str("abc").len(), 24);
    }

    #[test]
    fn token_hotspots_include_friendly_session_label_and_model() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE sessions (
                session_id_hash TEXT NOT NULL,
                output_tokens INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                token_data_partial INTEGER NOT NULL,
                last_model TEXT NOT NULL,
                turn_count INTEGER NOT NULL,
                last_seen_ms INTEGER NOT NULL
            );
            "#,
        )
        .expect("create sessions table");
        let now = unix_ms_now();
        conn.execute(
            r#"
            INSERT INTO sessions (
                session_id_hash, output_tokens, input_tokens, token_data_partial,
                last_model, turn_count, last_seen_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                "abcdef1234567890",
                123_456_i64,
                12_345_i64,
                0_i64,
                "gpt-5.5",
                7_i64,
                now as i64
            ],
        )
        .expect("insert session row");

        let rows = token_hotspots(&conn, &local_day(now)).expect("token hotspots");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].label.contains("7 turns\nSession abcdef12"));
        assert_eq!(rows[0].category, "gpt-5.5");
        assert_eq!(rows[0].value, 123_456);
        assert_eq!(rows[0].secondary_value, 12_345);
    }

    #[test]
    fn model_mix_artifact_includes_input_tokens() {
        let summary = AnalyticsUsageSummary {
            model_mix: vec![AnalyticsRankedItem {
                label: "gpt-5.5".to_string(),
                category: "model".to_string(),
                value: 4_250_783,
                secondary_value: 4_848,
                tertiary_value: 812_345,
                partial: false,
            }],
            ..Default::default()
        };

        let artifacts = artifacts_for_keys(&summary, &["model_mix".to_string()]);
        let model_mix = artifacts
            .iter()
            .find(|artifact| artifact.title == "Model Mix")
            .expect("model mix artifact");
        assert_eq!(
            model_mix.columns,
            vec!["Model", "Turns", "Input Tokens", "Output Tokens"]
        );
        assert_eq!(
            model_mix.rows[0],
            vec!["gpt-5.5", "4848", "812345", "4250783"]
        );
    }

    #[test]
    fn local_model_tokens_replace_partial_output_with_shutdown_totals() {
        let mut rollups = LocalHistoryRollups::default();
        let mut session = LocalSessionBuilder {
            session_hash: "session-a".to_string(),
            input_tokens: 800,
            output_tokens: 180,
            last_model: "gpt-5.5".to_string(),
            last_status: "completed".to_string(),
            ..Default::default()
        };
        record_session_model_assistant_output(&mut session, 150);
        record_session_model_shutdown_tokens(&mut session, "gpt-5.5", 800, 180);

        reconcile_local_session_model_tokens(&mut session, &mut rollups, "copilot", "2026-06-03");

        let acc = rollups
            .model
            .get(&(
                "copilot".to_string(),
                "gpt-5.5".to_string(),
                "2026-06-03".to_string(),
            ))
            .expect("model rollup");
        assert_eq!(session.input_tokens, 800);
        assert_eq!(session.output_tokens, 180);
        assert_eq!(acc.input_tokens, 800);
        assert_eq!(acc.output_tokens, 180);
    }

    #[test]
    fn local_model_tokens_attribute_residual_session_tokens_to_last_model() {
        let mut rollups = LocalHistoryRollups::default();
        let mut session = LocalSessionBuilder {
            session_hash: "session-a".to_string(),
            input_tokens: 1_000,
            output_tokens: 180,
            last_model: "gpt-5.5".to_string(),
            last_status: "completed".to_string(),
            ..Default::default()
        };
        record_session_model_shutdown_tokens(&mut session, "gpt-5.5", 800, 180);

        reconcile_local_session_model_tokens(&mut session, &mut rollups, "copilot", "2026-06-03");

        let acc = rollups
            .model
            .get(&(
                "copilot".to_string(),
                "gpt-5.5".to_string(),
                "2026-06-03".to_string(),
            ))
            .expect("model rollup");
        assert_eq!(session.input_tokens, 1_000);
        assert_eq!(session.output_tokens, 180);
        assert_eq!(acc.input_tokens, 1_000);
        assert_eq!(acc.output_tokens, 180);
    }

    #[test]
    fn local_history_parser_reconciles_daily_and_model_token_rollups() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "cmc_analytics_rollup_reconcile_{}_{}.jsonl",
            std::process::id(),
            unix_ms_now()
        ));
        std::fs::write(
            &path,
            [
                r#"{"type":"session.start","timestamp":"2026-06-03T10:00:00Z","data":{"selectedModel":"gpt-5.5"}}"#,
                r#"{"type":"assistant.turn_start","timestamp":"2026-06-03T10:00:01Z","data":{"turnId":"turn-1"}}"#,
                r#"{"type":"assistant.message","timestamp":"2026-06-03T10:00:02Z","data":{"model":"gpt-5.5","outputTokens":150}}"#,
                r#"{"type":"session.shutdown","timestamp":"2026-06-03T10:00:03Z","data":{"currentModel":"gpt-5.5","modelMetrics":{"gpt-5.5":{"usage":{"inputTokens":1000,"cacheReadTokens":200,"outputTokens":180}}}}}"#,
            ]
            .join("\n"),
        )
        .expect("write fixture");

        let mut rollups = LocalHistoryRollups::default();
        let mut parse_errors = 0;
        parse_local_events_file(
            &path,
            "session-a",
            LocalSessionMetadata {
                repository: "copilot-mission-control".to_string(),
                branch: "main".to_string(),
                title: "Build Daily Log".to_string(),
            },
            0,
            unix_ms_now(),
            &mut rollups,
            &mut parse_errors,
        )
        .expect("parse local history");
        let _ = std::fs::remove_file(&path);

        let daily = rollups
            .daily
            .get(&("copilot".to_string(), "2026-06-03".to_string()))
            .expect("daily rollup");
        let model = rollups
            .model
            .get(&(
                "copilot".to_string(),
                "gpt-5.5".to_string(),
                "2026-06-03".to_string(),
            ))
            .expect("model rollup");

        assert_eq!(parse_errors, 0);
        assert_eq!(daily.input_tokens, 800);
        assert_eq!(daily.output_tokens, 180);
        assert_eq!(model.input_tokens, daily.input_tokens);
        assert_eq!(model.output_tokens, daily.output_tokens);
        assert_eq!(model.turn_count, 1);
    }

    #[test]
    fn prompt_echo_is_bounded() {
        let prompt = "x".repeat(500);
        assert_eq!(sanitize_prompt_for_echo(&prompt).len(), 240);
    }

    #[test]
    fn local_tool_classification_keeps_skill_identity() {
        let args = serde_json::json!({ "skill": "coder", "prompt": "SECRET" });
        assert_eq!(
            classify_local_tool("skill", Some(&args)),
            ("coder".to_string(), "skills".to_string())
        );
    }

    #[test]
    fn mcp_usage_prompt_is_detected() {
        assert!(is_mcp_usage_prompt("What's my MCP server usage?"));
        assert!(is_mcp_usage_prompt(
            "Which MCP tools affect context tokens?"
        ));
        assert!(!is_mcp_usage_prompt("Review my Copilot skills."));
    }

    #[test]
    fn mcp_usage_prompt_routes_to_mcp_analyzer_tool() {
        assert_eq!(
            mission_control_insights_tools_for_prompt("What's my MCP server usage?"),
            vec!["analyze_mcp_servers".to_string()]
        );
    }

    #[test]
    fn mcp_inventory_parses_enabled_status_and_tools() {
        let inventory = mcp_server_inventory_from_value(&serde_json::json!({
            "servers": {
                "github-mcp-server": {
                    "enabled": true,
                    "tools": ["search_code", { "name": "get_file_contents" }]
                },
                "playwright": {
                    "disabled": true,
                    "tools": ["browser_navigate"]
                }
            }
        }));

        assert_eq!(inventory.len(), 2);
        let github = inventory
            .iter()
            .find(|server| server.name == "github-mcp-server")
            .expect("github server");
        assert!(github.enabled);
        assert_eq!(github.tools.len(), 2);
        assert!(github.tools.contains("search_code"));

        let playwright = inventory
            .iter()
            .find(|server| server.name == "playwright")
            .expect("playwright server");
        assert!(!playwright.enabled);
        assert_eq!(playwright.tools.len(), 1);
    }

    #[test]
    fn marker_is_removed_from_sdk_answers() {
        assert_eq!(
            strip_mission_control_marker(&format!(
                "{} Answer text.",
                MISSION_CONTROL_ANALYTICS_MARKER
            )),
            "Answer text."
        );
    }

    #[test]
    fn sdk_out_of_scope_answer_is_normalized() {
        let answer = parse_sdk_analytics_answer(
            r#"```json
            {"in_scope":false,"answer":"The indexed analytics don't include temperature data."}
            ```"#,
        )
        .expect("valid SDK answer");
        assert!(!answer.in_scope);
        assert_eq!(
            answer.answer,
            "I can only answer questions about indexed Copilot CLI usage, prompts, skills, agents, and analytics."
        );
        assert!(answer.artifacts.is_empty());
    }

    #[test]
    fn sdk_artifact_keys_are_parsed() {
        let answer = parse_sdk_analytics_answer(
            r#"{"in_scope":true,"answer":"Top models are available.","artifacts":["model_mix"]}"#,
        )
        .expect("valid SDK answer");
        assert!(answer.in_scope);
        assert_eq!(answer.artifacts, vec!["model_mix"]);
    }

    #[test]
    fn flight_log_sanitizes_workspace_metadata() {
        assert_eq!(
            sanitize_repository_label("/Users/example/secret-client/copilot-mission-control"),
            "copilot-mission-control"
        );
        assert_eq!(
            sanitize_branch_label("refs/heads/feature/flight-log"),
            "feature/flight-log"
        );
        assert_eq!(
            sanitize_title_label("Build Daily Log\nwith raw\tcontrol chars"),
            "Build Daily Logwith rawcontrol chars"
        );
        assert_eq!(
            sanitize_title_label("/Users/example/secret/file.rs"),
            "Untitled"
        );
    }

    #[test]
    fn flight_log_calendar_rolls_up_to_selected_day_without_future_cells() {
        let days = rolling_calendar_days("2026-06-03", "2026-06");
        assert_eq!(
            days.last().map(|day| day.local_day.as_str()),
            Some("2026-06-06")
        );
        assert!(days.iter().any(|day| day.local_day == "2026-05-31"));
        assert!(days.iter().any(|day| day.local_day == "2026-06-04"));
    }

    #[test]
    fn flight_log_digest_queries_selected_day_and_exports_safe_text() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE sessions (
                provider TEXT NOT NULL,
                session_id_hash TEXT NOT NULL,
                repository TEXT NOT NULL DEFAULT '',
                branch TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                first_seen_ms INTEGER NOT NULL,
                last_seen_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                is_active INTEGER NOT NULL,
                event_count INTEGER NOT NULL,
                tool_count INTEGER NOT NULL,
                turn_count INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                input_tokens_known INTEGER NOT NULL,
                output_tokens_known INTEGER NOT NULL,
                token_data_partial INTEGER NOT NULL,
                last_model TEXT NOT NULL,
                PRIMARY KEY (provider, session_id_hash)
            );
            CREATE TABLE daily_rollups (
                provider TEXT NOT NULL,
                local_day TEXT NOT NULL,
                bucket_start_ms INTEGER NOT NULL,
                bucket_end_ms INTEGER NOT NULL,
                timezone_offset_minutes INTEGER NOT NULL,
                session_count INTEGER NOT NULL,
                event_count INTEGER NOT NULL,
                turn_count INTEGER NOT NULL,
                tool_call_count INTEGER NOT NULL,
                failure_count INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                estimated_active_ms INTEGER NOT NULL,
                token_data_partial INTEGER NOT NULL,
                PRIMARY KEY (provider, local_day)
            );
            CREATE TABLE model_rollups (
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                local_day TEXT NOT NULL,
                session_count INTEGER NOT NULL,
                turn_count INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                token_data_partial INTEGER NOT NULL,
                PRIMARY KEY (provider, model, local_day)
            );
            CREATE TABLE category_rollups (
                provider TEXT NOT NULL,
                category TEXT NOT NULL,
                local_day TEXT NOT NULL,
                turn_count INTEGER NOT NULL,
                tool_call_count INTEGER NOT NULL,
                failure_count INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                token_data_partial INTEGER NOT NULL,
                PRIMARY KEY (provider, category, local_day)
            );
            CREATE TABLE tool_rollups (
                provider TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                tool_category TEXT NOT NULL,
                local_day TEXT NOT NULL,
                call_count INTEGER NOT NULL,
                success_count INTEGER NOT NULL,
                failure_count INTEGER NOT NULL,
                total_duration_ms INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (provider, tool_name, tool_category, local_day)
            );
            CREATE TABLE failure_rollups (
                provider TEXT NOT NULL,
                kind TEXT NOT NULL,
                tool TEXT NOT NULL,
                category TEXT NOT NULL,
                local_day TEXT NOT NULL,
                count INTEGER NOT NULL,
                last_seen_ms INTEGER NOT NULL,
                PRIMARY KEY (provider, kind, tool, category, local_day)
            );
            CREATE TABLE recent_event_facts (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                session_id_hash TEXT NOT NULL,
                event_key TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL,
                kind TEXT NOT NULL,
                tool TEXT NOT NULL,
                category TEXT NOT NULL,
                success INTEGER NOT NULL,
                input_tokens INTEGER,
                output_tokens INTEGER,
                safe_detail_kind TEXT NOT NULL DEFAULT '',
                safe_detail_value TEXT NOT NULL DEFAULT '',
                safe_detail_is_estimate INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE ingestion_audit (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                source_id_hash TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL,
                safe_code TEXT NOT NULL,
                count INTEGER NOT NULL,
                soft_cap_exceeded INTEGER NOT NULL,
                hard_cap_exceeded INTEGER NOT NULL
            );
            "#,
        )
        .expect("schema");
        let (start_ms, end_ms, offset) = local_day_bounds("2026-06-03");
        conn.execute(
            "INSERT INTO daily_rollups VALUES ('copilot','2026-06-03',?1,?2,?3,2,24,6,11,2,1200,3400,600000,0)",
            params![start_ms as i64, end_ms as i64, offset],
        )
        .expect("daily");
        conn.execute(
            "INSERT INTO sessions VALUES ('copilot','sessionhash1','copilot-mission-control','main','Build Daily Log',?1,?2,'needs-attention',1,24,11,6,1200,3400,1,1,0,'gpt-5.5')",
            params![start_ms as i64, (start_ms + 60_000) as i64],
        )
        .expect("session");
        conn.execute(
            "INSERT INTO recent_event_facts (id,provider,session_id_hash,event_key,occurred_at_ms,kind,tool,category,success,input_tokens,output_tokens) VALUES ('e1','copilot','sessionhash1','k1',?1,'tool.execution_complete','bash','terminal',0,1200,3400)",
            params![(start_ms + 10_000) as i64],
        )
        .expect("event");
        conn.execute(
            "INSERT INTO model_rollups VALUES ('copilot','gpt-5.5','2026-06-03',1,6,1200,3400,0,0,0)",
            [],
        )
        .expect("model");
        conn.execute(
            "INSERT INTO category_rollups VALUES ('copilot','mcp','2026-06-03',0,4,0,0,0,0)",
            [],
        )
        .expect("category");
        conn.execute(
            "INSERT INTO tool_rollups VALUES ('copilot','bash','terminal','2026-06-03',7,5,2,90000)",
            [],
        )
        .expect("tool");
        conn.execute(
            "INSERT INTO failure_rollups VALUES ('copilot','tool.execution_complete','bash','terminal','2026-06-03',2,?1)",
            params![(start_ms + 10_000) as i64],
        )
        .expect("failure");

        let digest = engineering_digest_from_db(
            &conn,
            EngineeringDigestRequest {
                selected_day: Some("2026-06-03".to_string()),
                month: Some("2026-06".to_string()),
            },
        )
        .expect("digest");

        assert_eq!(digest.selected_day, "2026-06-03");
        assert_eq!(digest.day.repos[0].repository, "copilot-mission-control");
        assert_eq!(digest.day.models[0].label, "gpt-5.5");
        assert_eq!(digest.day.tools[0].name, "bash");
        assert_eq!(digest.day.failures[0].count, 2);
        assert!(digest
            .day
            .narrative
            .contains("copilot-mission-control on main"));
        assert!(digest
            .day
            .exports
            .iter()
            .any(|export| export.kind == "daily-digest"
                && export.body.contains("copilot-mission-control")
                && export.body.contains("## Daily Digest - 2026-06-03")
                && export.body.contains("### AI usage")
                && export
                    .body
                    .contains("gpt-5.5 (1200 input tokens / 3400 output tokens)")
                && !export.body.contains("### Follow-up")
                && !export.body.contains("Yesterday/Today:")));
        assert_eq!(
            digest_token_pair(0, 3400),
            "pending input tokens / 3400 output tokens"
        );
        assert!(!digest.day.narrative.contains("/Users/"));
        assert!(digest
            .calendar_days
            .iter()
            .any(|day| day.local_day == "2026-06-03" && day.badges.contains(&"MCP".to_string())));
    }

    #[test]
    fn sdk_content_is_recovered_from_assistant_message() {
        let event = test_session_event(
            "assistant.message",
            serde_json::json!({ "content": " {\"in_scope\":true,\"answer\":\"ok\"} " }),
        );
        assert_eq!(
            sdk_assistant_message_content(&event),
            Some(r#"{"in_scope":true,"answer":"ok"}"#.to_string())
        );
    }

    #[test]
    fn sdk_content_is_recovered_from_streamed_deltas() {
        let state = Arc::new(Mutex::new(AnalyticsSdkEventState::default()));
        {
            let mut state = state.lock().expect("state lock");
            state.streamed_content.push_str(r#"{"in_scope":true,"#);
            state.streamed_content.push_str(r#""answer":"ok"}"#);
        }
        assert_eq!(
            sdk_event_state_content(&state),
            Some(r#"{"in_scope":true,"answer":"ok"}"#.to_string())
        );
    }

    #[test]
    fn sdk_definition_review_payload_is_captured_from_tool_result() {
        let event = test_session_event(
            "tool.execution_complete",
            serde_json::json!({
                "success": true,
                "result": {
                    "detailedContent": sample_definition_review_payload().to_string()
                }
            }),
        );
        let (kind, payload) = sdk_definition_review_payload(&event).expect("review payload");
        assert_eq!(kind, "skills");
        assert_eq!(
            json_u64(
                payload.get("review").unwrap().get("inventory").unwrap(),
                "discovered_definitions"
            ),
            2
        );
    }

    #[test]
    fn sdk_definition_review_payload_is_captured_from_truncated_tool_result() {
        let review = sample_definition_review_payload()
            .get("review")
            .unwrap()
            .to_string();
        let compact = format!(
            r#"{{"schemaVersion":1,"kind":"skills","artifact_review":{},"summary":{{"discovered_definitions":2}},"definitions":["#,
            review
        );
        let event = test_session_event(
            "tool.execution_complete",
            serde_json::json!({
                "success": true,
                "result": { "detailedContent": compact }
            }),
        );
        let (kind, payload) =
            sdk_definition_review_payload(&event).expect("partial review payload");
        assert_eq!(kind, "skills");
        assert!(payload.get("review").is_some());
    }

    #[test]
    fn definition_review_artifacts_do_not_expose_paths() {
        let payload = sample_definition_review_payload();
        let artifacts = definition_review_artifacts_from_payload(&payload);
        assert!(artifacts
            .iter()
            .any(|artifact| artifact.title == "Skills Inventory"));
        assert!(artifacts
            .iter()
            .any(|artifact| artifact.title == "All Skills (2)"));
        let rendered = serde_json::to_string(&artifacts).expect("serialize artifacts");
        assert!(!rendered.contains("relative_path"));
        assert!(!rendered.contains("copilot:"));
        assert!(rendered.contains("Largest Skill Definitions"));
        assert!(rendered.contains("Skill Readiness Checks"));
    }

    #[test]
    fn definition_completeness_open_payload_keeps_root() {
        let payload = sample_definition_review_payload();
        let artifacts = definition_review_artifacts_from_payload(&payload);
        let completeness = artifacts
            .iter()
            .find(|artifact| artifact.title == "Skill Readiness Checks")
            .expect("completeness artifact");
        assert_eq!(
            completeness.columns,
            vec![
                "Skill".to_string(),
                "Readiness".to_string(),
                "Suggested Fixes".to_string(),
                "Details".to_string()
            ]
        );
        assert!(completeness
            .description
            .contains("Automated checks for whether a skill explains when to use it"));
        let details: Value = serde_json::from_str(&completeness.rows[0][3]).expect("open payload");
        assert_eq!(
            details.get("definition").and_then(Value::as_str),
            Some("small-skill")
        );
        assert_eq!(
            details.get("root").and_then(Value::as_str),
            Some("~/.copilot/skills")
        );
    }

    #[test]
    fn skill_completeness_artifact_uses_payload_score() {
        let id = "cmc-static-eval-test";
        let payload = serde_json::json!({
            "kind": "skills",
            "review": {
                "inventory": {
                    "discovered_definitions": 1,
                    "analyzed_definitions": 1,
                    "skipped_definitions": 0,
                    "duplicate_id_groups": 0,
                    "roots": [{ "root": "project:.copilot/skills", "count": 1 }]
                },
                "definitions": [{
                    "id": id,
                    "root": "project:.copilot/skills",
                    "definition_ref": id,
                    "summary": "Static eval test",
                    "source_chars": 96,
                    "description_chars": 0,
                    "completeness_score": 5,
                    "issues": []
                }],
                "completeness": [{
                    "id": id,
                    "root": "project:.copilot/skills",
                    "definition_ref": id,
                    "completeness_score": 3,
                    "issues": ["Add validation guidance"]
                }],
                "context_cost": [],
                "description_lengths": [],
                "overlap_pairs": [],
                "actions": []
            }
        });

        let artifacts = definition_review_artifacts_from_payload(&payload);
        let completeness = artifacts
            .iter()
            .find(|artifact| artifact.title == "Skill Readiness Checks")
            .expect("completeness artifact");
        let score = &completeness.rows[0][1];
        let details: Value = serde_json::from_str(&completeness.rows[0][3]).expect("details");

        assert_eq!(score, "3/5");
        assert_eq!(
            details.get("scoreLabel").and_then(Value::as_str),
            Some(score.as_str())
        );
        assert_eq!(details.get("maxScore").and_then(Value::as_u64), Some(5));
    }

    #[test]
    fn agent_readiness_artifact_uses_payload_score() {
        let id = "cmc-static-agent-test";
        let payload = serde_json::json!({
            "kind": "agents",
            "review": {
                "inventory": {
                    "discovered_definitions": 1,
                    "analyzed_definitions": 1,
                    "skipped_definitions": 0,
                    "duplicate_id_groups": 0,
                    "roots": [{ "root": "project:.copilot/agents", "count": 1 }]
                },
                "definitions": [{
                    "id": id,
                    "root": "project:.copilot/agents",
                    "definition_ref": id,
                    "summary": "Static agent test",
                    "source_chars": 96,
                    "description_chars": 0,
                    "completeness_score": 5,
                    "issues": []
                }],
                "completeness": [{
                    "id": id,
                    "root": "project:.copilot/agents",
                    "definition_ref": id,
                    "completeness_score": 3,
                    "issues": ["Add validation guidance"]
                }],
                "context_cost": [],
                "description_lengths": [],
                "overlap_pairs": [],
                "actions": []
            }
        });

        let artifacts = definition_review_artifacts_from_payload(&payload);
        let readiness = artifacts
            .iter()
            .find(|artifact| artifact.title == "Agent Readiness Checks")
            .expect("readiness artifact");
        let score = &readiness.rows[0][1];
        let details: Value = serde_json::from_str(&readiness.rows[0][3]).expect("details");

        assert!(readiness
            .description
            .contains("Automated checks for whether an agent explains when to use it"));
        assert_eq!(score, "3/5");
        assert_eq!(details.get("kind").and_then(Value::as_str), Some("agents"));
        assert_eq!(
            details.get("scoreLabel").and_then(Value::as_str),
            Some(score.as_str())
        );
        assert_eq!(details.get("maxScore").and_then(Value::as_u64), Some(5));
    }

    #[test]
    fn prompt_skill_agent_questions_require_insights_tools() {
        assert!(requires_insights_tools(
            "Analyze my recent Copilot prompts."
        ));
        assert!(requires_insights_tools("Review my local skills."));
        assert!(requires_insights_tools("Which agents are missing?"));
        assert!(!requires_insights_tools("What are my top models?"));
    }

    #[test]
    fn skill_agent_gap_prompts_use_definition_focus() {
        assert!(is_definition_gap_prompt(
            "What skill or agent gaps do I have?"
        ));
        assert!(is_definition_gap_prompt(
            "Review my custom agents for weak spots."
        ));
        assert!(is_definition_gap_prompt("Do I have missing skills?"));
        assert!(!is_definition_gap_prompt("Which tools failed most often?"));
        assert!(!is_definition_gap_prompt("What are my top models?"));

        let instructions = definition_gap_focus_instructions(true);
        assert!(instructions.contains("only from skill and agent concepts"));
        assert!(instructions.contains("Do not recommend generic tool-failure"));
        assert!(instructions.contains("missing or weak skill/agent concept"));
    }

    #[test]
    fn mcp_server_config_exposes_insights_tools() {
        let script_path = PathBuf::from("/tmp/mission-control-insights.js");
        let project_root = PathBuf::from("/tmp/project");
        let executable_env = ExecutableEnv {
            path: Some(OsString::from("/tmp/bin")),
            node: Some(PathBuf::from("/tmp/bin/node")),
            copilot: None,
        };
        let servers = mission_control_insights_mcp_servers(
            &script_path,
            Some(&project_root),
            all_mission_control_insights_tools(),
            &executable_env,
        );
        let server = servers
            .get("mission-control-insights")
            .expect("insights server configured");
        let github_copilot_sdk::types::McpServerConfig::Stdio(config) = server else {
            panic!("expected stdio MCP server");
        };
        assert_eq!(config.command, "/tmp/bin/node");
        assert_eq!(config.args, vec!["/tmp/mission-control-insights.js"]);
        assert_eq!(config.env.get("PATH"), Some(&"/tmp/bin".to_string()));
        assert!(config.tools.contains(&"list_prompt_samples".to_string()));
        assert!(config.tools.contains(&"read_skill_definition".to_string()));
        assert!(config.tools.contains(&"analyze_copilot_skills".to_string()));
        assert!(config.tools.contains(&"analyze_copilot_agents".to_string()));
        assert_eq!(
            config.env.get("CMC_PROJECT_ROOT"),
            Some(&"/tmp/project".to_string())
        );
    }

    #[test]
    fn broad_agent_review_only_exposes_bulk_agent_tool() {
        assert_eq!(
            mission_control_insights_tools_for_prompt("Review my Copilot agents."),
            vec!["analyze_copilot_agents".to_string()]
        );
    }

    #[test]
    fn broad_skill_review_only_exposes_bulk_skill_tool() {
        assert_eq!(
            mission_control_insights_tools_for_prompt("Review my Copilot skills."),
            vec!["analyze_copilot_skills".to_string()]
        );
    }

    #[test]
    fn skill_agent_gap_prompt_exposes_bulk_definition_tools() {
        assert_eq!(
            mission_control_insights_tools_for_prompt("What skill or agent gaps do I have?"),
            vec![
                "analyze_copilot_skills".to_string(),
                "analyze_copilot_agents".to_string()
            ]
        );
    }

    #[test]
    fn nested_mcp_permission_for_insights_server_is_approved() {
        let data = github_copilot_sdk::types::PermissionRequestData {
            extra: serde_json::json!({
                "permissionRequest": {
                    "kind": "mcp",
                    "serverName": "mission-control-insights",
                    "toolName": "mission-control-insights-summarize_prompt_patterns"
                }
            }),
            ..Default::default()
        };
        assert!(is_mission_control_insights_permission(&data));
    }

    #[test]
    fn non_insights_mcp_permission_is_not_approved() {
        let data = github_copilot_sdk::types::PermissionRequestData {
            extra: serde_json::json!({
                "permissionRequest": {
                    "kind": "mcp",
                    "serverName": "other-server",
                    "toolName": "other-tool"
                }
            }),
            ..Default::default()
        };
        assert!(!is_mission_control_insights_permission(&data));
    }

    fn test_session_event(
        event_type: &str,
        data: Value,
    ) -> github_copilot_sdk::types::SessionEvent {
        github_copilot_sdk::types::SessionEvent {
            id: "event-1".to_string(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            parent_id: None,
            ephemeral: None,
            agent_id: None,
            debug_cli_received_at_ms: None,
            debug_ws_forwarded_at_ms: None,
            event_type: event_type.to_string(),
            data,
        }
    }

    fn sample_definition_review_payload() -> Value {
        serde_json::json!({
            "kind": "skills",
            "review": {
                "inventory": {
                    "discovered_definitions": 2,
                    "analyzed_definitions": 2,
                    "skipped_definitions": 0,
                    "duplicate_id_groups": 0,
                    "roots": [{ "root": "~/.copilot/skills", "count": 2 }]
                },
                "definitions": [
                    {
                        "id": "large-skill",
                        "root": "~/.copilot/skills",
                        "definition_ref": "large-skill",
                        "summary": "Large skill fixture",
                        "source_chars": 16000,
                        "description_chars": 720,
                        "completeness_score": 4,
                        "issues": []
                    },
                    {
                        "id": "small-skill",
                        "root": "~/.copilot/skills",
                        "definition_ref": "small-skill",
                        "summary": "Small skill fixture",
                        "source_chars": 1200,
                        "description_chars": 0,
                        "completeness_score": 2,
                        "issues": ["missing anti-triggers", "missing validation"]
                    }
                ],
                "context_cost": [
                    { "id": "large-skill", "root": "~/.copilot/skills", "source_chars": 16000 },
                    { "id": "small-skill", "root": "~/.copilot/skills", "source_chars": 1200 }
                ],
                "description_lengths": [
                    { "id": "large-skill", "root": "~/.copilot/skills", "description_chars": 720 }
                ],
                "completeness": [
                    {
                        "id": "small-skill",
                        "root": "~/.copilot/skills",
                        "completeness_score": 2,
                        "issues": ["missing anti-triggers", "missing validation"]
                    }
                ],
                "overlap_pairs": [
                    {
                        "left_id": "large-skill",
                        "right_id": "small-skill",
                        "score": 0.44,
                        "shared_tokens": ["skill", "review", "routing"]
                    }
                ],
                "actions": [
                    {
                        "title": "Trim oversized skills",
                        "body": "large-skill has the largest context footprint.",
                        "severity": "warning",
                        "metric": "definition_size"
                    }
                ]
            }
        })
    }
}
