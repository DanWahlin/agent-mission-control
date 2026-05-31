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

use crate::agent::{
    collect_agent_activity_with_history, AgentActivity, AgentEventSummary, AgentSessionSummary,
    SessionToolCall,
};

const ANALYTICS_DB_FILE: &str = "analytics.sqlite3";
const SCHEMA_VERSION: i64 = 1;
const ROLLUP_VERSION: i64 = 1;
const DEFAULT_RANGE_DAYS: u32 = 7;
const MAX_RANGE_DAYS: u32 = 180;
const LOCAL_HISTORY_INGEST_DAYS: u32 = 30;
const RECENT_FACT_RETENTION_DAYS: u32 = 30;
const ROLLUP_RETENTION_DAYS: u32 = 180;
const INGEST_STALE_MS: i64 = 5 * 60 * 1000;
const ACTIVE_EVENT_WINDOW_MS: u64 = 5 * 60 * 1000;
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
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub rows: Vec<Vec<String>>,
    #[serde(default)]
    pub points: Vec<AnalyticsDailyPoint>,
    #[serde(default)]
    pub cards: Vec<AnalyticsRecommendation>,
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
    let dynamic_answer = synthesize_chat_answer_with_copilot(app, &prompt, &summary).await;
    let mut response = chat_response_from_summary(prompt, summary.clone());
    match dynamic_answer {
        Ok(answer) => {
            response.answer = answer.answer;
            response.mode = "copilot_sdk".to_string();
            response.mode_reason = None;
            if !answer.in_scope {
                response.artifacts.clear();
                response.caveats.clear();
                response.mode_reason = Some(
                    "Question is outside Copilot Mission Control analytics scope.".to_string(),
                );
            } else {
                let mut artifacts = artifacts_for_keys(&summary, &answer.artifacts);
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
            if requires_insights_tools(&response.prompt) {
                response.answer = format!(
                    "I'm unable to provide that information because it requires local prompt, skill, or agent inspection and the Copilot SDK/MCP tool flow is unavailable right now. {}",
                    reason
                );
                response.artifacts.clear();
                response.caveats.clear();
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
    arguments.insert("max_chars".to_string(), Value::from(120000));
    call_insights_mcp_tool_with_args(app, tool_name, Value::Object(arguments))
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
    ]
    .iter()
    .any(|needle| lower.contains(needle))
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
    let now = unix_ms_now() as i64;
    if last
        .map(|value| now.saturating_sub(value) > INGEST_STALE_MS)
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
        parse_local_events_file(
            &events_path,
            session_id,
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
}

struct PendingLocalTool {
    tool: String,
    category: String,
    started_at_ms: u64,
}

fn parse_local_events_file(
    path: &Path,
    session_id: &str,
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
    let input_known = session.input_tokens > 0
        || session.output_tokens == 0
        || session.last_status == "completed";
    if let Some(daily) = rollups
        .daily
        .get_mut(&(provider.clone(), local_day(session.last_seen_ms)))
    {
        daily.input_tokens = daily.input_tokens.saturating_add(session.input_tokens);
        daily.output_tokens = daily.output_tokens.saturating_add(session.output_tokens);
        daily.token_data_partial |= !input_known;
    }
    rollups.sessions.push(AnalyticsSessionRow {
        provider,
        session_id_hash: session_hash,
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
        if line.contains(MISSION_CONTROL_ANALYTICS_MARKER)
            || line.contains("copilot-mission-control-analytics")
        {
            return Ok(true);
        }
    }
    Ok(false)
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
                add_model_tokens(
                    rollups,
                    provider,
                    day,
                    &session.session_hash,
                    &session.last_model,
                    0,
                    tokens,
                    true,
                );
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
                add_model_tokens(
                    rollups,
                    provider,
                    day,
                    &session.session_hash,
                    &model,
                    input,
                    output,
                    false,
                );
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
                provider, session_id_hash, first_seen_ms, last_seen_ms, status, is_active,
                event_count, tool_count, turn_count, input_tokens, output_tokens,
                input_tokens_known, output_tokens_known, token_data_partial, last_model
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            "#,
            params![
                session.provider,
                session.session_id_hash,
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
            provider, session_id_hash, first_seen_ms, last_seen_ms, status, is_active,
            event_count, tool_count, turn_count, input_tokens, output_tokens,
            input_tokens_known, output_tokens_known, token_data_partial, last_model
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?14)
        "#,
        params![
            provider,
            session_hash,
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
    for turn in &session.recent_turns {
        let model_name = safe_label(&turn.model, "Unknown");
        if model_name == "Unknown" {
            continue;
        }
        counted_turn_model = true;
        let model_key = (provider.clone(), model_name, day.clone());
        let model_acc = model.entry(model_key).or_default();
        model_acc.session_ids.insert(session_hash.clone());
        model_acc.turn_count += 1;
        model_acc.output_tokens += turn.output_tokens;
        model_acc.token_data_partial |= turn.partial;
    }
    if !counted_turn_model {
        let model_name = safe_label(&session.last_model, "Unknown");
        if model_name != "Unknown" || session.turn_count > 0 || session.output_tokens > 0 {
            let model_key = (provider.clone(), model_name, day.clone());
            let model_acc = model.entry(model_key).or_default();
            model_acc.session_ids.insert(session_hash.clone());
            model_acc.turn_count += session.turn_count.max(1) as u64;
            model_acc.input_tokens += session.input_tokens;
            model_acc.output_tokens += session.output_tokens;
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
        ("forge", session.write_count),
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
        ) VALUES (?1, ?2, 0, 0, ?3)
        "#,
        params![
            safe_label(&activity.source, "agent"),
            SNAPSHOT_SOURCE_HASH,
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
        privacy_summary: "Analytics is indexed from local Copilot CLI session history and stores derived counts, hashed session ids, models, tool/category names, token totals, and coverage caveats.".to_string(),
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
) -> Result<SdkAnalyticsAnswer, String> {
    use github_copilot_sdk::types::{MessageOptions, SessionConfig, SystemMessageConfig};
    use github_copilot_sdk::{Client, ClientOptions};

    let summary_json = serde_json::to_string(summary).map_err(|err| err.to_string())?;
    let mcp_script = ensure_insights_mcp_server_script(app)?;
    let project_root = project_root_for_mcp().or_else(|| std::env::current_dir().ok());
    let mcp_tools = mission_control_insights_tools_for_prompt(prompt);
    let mcp_servers =
        mission_control_insights_mcp_servers(&mcp_script, project_root.as_deref(), mcp_tools);
    let client = Client::start(ClientOptions::new())
        .await
        .map_err(|err| err.to_string())?;
    let sdk_event_state = Arc::new(Mutex::new(AnalyticsSdkEventState::default()));
    let system_message = SystemMessageConfig::new()
        .with_mode("append")
        .with_content(format!(
            "{marker}\nYou are the Copilot Mission Control Analytics assistant.\n\nAllowed scope: answer questions about Copilot CLI usage analytics and improvement opportunities based on this app's indexed analytics plus the Mission Control Insights MCP tools. Indexed JSON covers sessions, turns, token usage, model mix, tool usage, failures, trends, comparisons, recommendations, and indexing status. MCP tools can inspect bounded local prompt samples, skills, and agent definitions when the user asks about prompts, skills, agents, or improvement analysis.\n\nNot allowed: weather, temperature, general knowledge, coding help unrelated to these local analytics, external facts, live web data, personal advice, arbitrary SQL, or details not present in the supplied JSON or MCP tool results. Do not reveal raw file paths. Do not quote raw prompt text unless the user explicitly asks to inspect prompts; prefer summaries and improvement recommendations.\n\nIf the user asks anything outside the allowed scope, set in_scope=false and answer exactly: \"I can only answer questions about indexed Copilot CLI usage, prompts, skills, agents, and analytics.\"\n\nIf the question is in scope but the supplied JSON and available tools do not include the requested detail, set in_scope=true and say the indexed analytics do not include that detail.\n\nUse only Mission Control Insights MCP tools when tools are needed. Do not call built-in filesystem, shell, view, edit, search, planning, or status tools. For prompt-pattern, prompt-improvement, skill-review, agent-review, or missing-skill/agent questions, call the relevant Mission Control Insights MCP tool before answering. Do not answer those questions from aggregate metrics alone. For broad skill audits such as \"Review my Copilot skills\", call analyze_copilot_skills first and answer from that result. For broad agent audits such as \"Review my Copilot agents\", call analyze_copilot_agents first and answer from that result. Use list_* and read_* only for targeted follow-up on specific named definitions.\n\nFormat answer text for readability using lightweight Markdown: short paragraphs, blank lines between paragraphs, and '-' bullet lists when listing steps, patterns, recommendations, or examples. Keep answers concise.\n\nChoose only the supporting UI artifacts that directly answer metric questions. Definition-review charts are attached automatically when analyze_copilot_skills or analyze_copilot_agents runs. Other artifact keys you may request: changes, token_trend, token_hotspots, model_mix, model_shifts, tool_failures, tool_changes, recommendations. Examples: top models -> [\"model_mix\"]; token hotspots -> [\"token_hotspots\"]; what changed -> [\"changes\",\"model_shifts\",\"tool_changes\"]; top failed tools -> [\"tool_failures\"]; prompt improvements -> [].\n\nReturn strict JSON only with this shape: {{\"in_scope\": boolean, \"answer\": string, \"artifacts\": [string]}}. The answer string may contain lightweight Markdown. Do not include code fences, extra keys, SQL, or preambles outside the JSON.",
            marker = MISSION_CONTROL_ANALYTICS_MARKER
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
        "{marker}\nUser question: {prompt}\n\nIndexed analytics JSON:\n{summary_json}\n\nMission Control Insights MCP tools are available in this session. Use them when the user asks about prompts, skills, agents, or improvements.\n\nReturn strict JSON only: {{\"in_scope\": boolean, \"answer\": string, \"artifacts\": [string]}}. The answer string may contain lightweight Markdown for paragraphs and bullet lists.",
        marker = MISSION_CONTROL_ANALYTICS_MARKER
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
    let mut command = Command::new("node");
    command
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
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
) -> HashMap<String, github_copilot_sdk::types::McpServerConfig> {
    use github_copilot_sdk::types::{McpServerConfig, McpStdioServerConfig};

    let mut env = HashMap::new();
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
            command: "node".to_string(),
            args: vec![script_path.to_string_lossy().to_string()],
            env,
            cwd: project_root.map(|path| path.to_string_lossy().to_string()),
        }),
    );
    servers
}

fn mission_control_insights_tools_for_prompt(prompt: &str) -> Vec<String> {
    let lower = prompt.to_ascii_lowercase();
    let broad_review = [
        "review",
        "audit",
        "improve",
        "coverage",
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
        "health",
    ]
    .iter()
    .map(|tool| (*tool).to_string())
    .collect()
}

fn project_root_for_mcp() -> Option<PathBuf> {
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
            title: "Biggest changes this week".to_string(),
            cards: comparison_cards(comparison),
            ..Default::default()
        });
    }
    artifacts.extend([
        AnalyticsArtifact {
            kind: "chart".to_string(),
            title: "Token trend".to_string(),
            points: summary.daily.clone(),
            ..Default::default()
        },
        AnalyticsArtifact {
            kind: "table".to_string(),
            title: if summary.comparison.is_some() {
                "Model shifts".to_string()
            } else {
                "Model mix".to_string()
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
                "Tool and failure changes".to_string()
            } else {
                "Tool failures".to_string()
            },
            columns: comparison_columns("Tool", "Calls/failures"),
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
                        title: "Biggest changes this week".to_string(),
                        cards: comparison_cards(comparison),
                        ..Default::default()
                    });
                }
            }
            "token_trend" => artifacts.push(AnalyticsArtifact {
                kind: "chart".to_string(),
                title: "Token trend".to_string(),
                points: summary.daily.clone(),
                ..Default::default()
            }),
            "token_hotspots" => artifacts.push(AnalyticsArtifact {
                kind: "table".to_string(),
                title: "Session token hotspots".to_string(),
                columns: vec![
                    "Session".to_string(),
                    "Group".to_string(),
                    "Output tokens".to_string(),
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
                title: "Model mix".to_string(),
                columns: vec![
                    "Model".to_string(),
                    "Turns".to_string(),
                    "Output tokens".to_string(),
                ],
                rows: summary
                    .model_mix
                    .iter()
                    .map(|item| {
                        vec![
                            item.label.clone(),
                            item.secondary_value.to_string(),
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
                        title: "Model shifts".to_string(),
                        columns: comparison_columns("Model", "Turns"),
                        rows: comparison_rows(Some(&comparison.model_shifts), &summary.model_mix),
                        ..Default::default()
                    });
                }
            }
            "tool_failures" => artifacts.push(AnalyticsArtifact {
                kind: "table".to_string(),
                title: "Tool failures".to_string(),
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
                        title: "Tool and failure changes".to_string(),
                        columns: comparison_columns("Tool", "Calls/failures"),
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
        title: format!("{} inventory", label_plural),
        cards: definition_inventory_cards(review, label_plural),
        ..Default::default()
    });
    let duplicate_rows = definition_duplicate_rows(review);
    if !duplicate_rows.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "wide_table".to_string(),
            title: format!("Duplicate {} IDs", label.to_ascii_lowercase()),
            columns: vec!["ID".to_string(), "Count".to_string(), "Roots".to_string()],
            rows: duplicate_rows,
            ..Default::default()
        });
    }
    let definition_rows = definition_inventory_rows(review, kind);
    if !definition_rows.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "definition_inventory".to_string(),
            title: format!("All {}", label_plural.to_ascii_lowercase()),
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
            title: format!("Largest {} definitions", label.to_ascii_lowercase()),
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
            title: format!("Longest {} descriptions", label.to_ascii_lowercase()),
            columns: vec![label.to_string(), "Root".to_string(), "Chars".to_string()],
            rows: description_rows,
            ..Default::default()
        });
    }
    let completeness_rows = definition_completeness_rows(review, label);
    if !completeness_rows.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "wide_table".to_string(),
            title: format!("{} completeness gaps", label),
            columns: vec![
                label.to_string(),
                "Score".to_string(),
                "Description".to_string(),
            ],
            rows: completeness_rows,
            ..Default::default()
        });
    }
    let overlap_rows = definition_overlap_rows(review, 8);
    if !overlap_rows.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "wide_table".to_string(),
            title: format!("{} overlap candidates", label),
            columns: vec![
                "Definition A".to_string(),
                "Definition B".to_string(),
                "Score".to_string(),
                "Shared terms".to_string(),
            ],
            rows: overlap_rows,
            ..Default::default()
        });
    }
    let action_cards = definition_action_cards(review);
    if !action_cards.is_empty() {
        artifacts.push(AnalyticsArtifact {
            kind: "cards".to_string(),
            title: format!("Prioritized {} fixes", label.to_ascii_lowercase()),
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
            let details = serde_json::json!({
                "name": name,
                "definition": json_string(item, "definition_ref").unwrap_or_else(|| name.clone()),
                "kind": if kind == "agents" { "agents" } else { "skills" },
                "summary": summary,
                "enabled": enabled,
                "root": json_string(item, "root").unwrap_or_else(|| "unknown".to_string()),
                "size": json_u64(item, "source_chars"),
                "descriptionChars": json_u64(item, "description_chars"),
                "score": json_u64(item, "completeness_score"),
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
            title: format!("{} discovered", label_plural),
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
            title: "Source roots".to_string(),
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
    review
        .get("completeness")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|item| {
            let id = json_string(item, "id")?;
            let score = json_u64(item, "completeness_score");
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
            Some(vec![id, format!("{}/5", score), issues])
        })
        .collect()
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
            turns: row.get::<_, i64>(2)?.max(0) as u64,
            tool_calls: row.get::<_, i64>(3)?.max(0) as u64,
            failures: row.get::<_, i64>(4)?.max(0) as u64,
            input_tokens: row.get::<_, i64>(5)?.max(0) as u64,
            output_tokens: row.get::<_, i64>(6)?.max(0) as u64,
            estimated_active_ms: row.get::<_, i64>(7)?.max(0) as u64,
            partial: row.get::<_, i64>(8)? > 0,
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
            SELECT session_id_hash, output_tokens, input_tokens, token_data_partial
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
            Ok(AnalyticsRankedItem {
                label: format!("Session {}", short_hash),
                category: "session".to_string(),
                value: row.get::<_, i64>(1)?.max(0) as u64,
                secondary_value: row.get::<_, i64>(2)?.max(0) as u64,
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
            SELECT model, SUM(output_tokens), SUM(turn_count), MAX(token_data_partial)
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
                partial: row.get::<_, i64>(3)? > 0,
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
    let turns = daily.iter().map(|d| d.turns).sum();
    let tool_calls = daily.iter().map(|d| d.tool_calls).sum();
    let failures = daily.iter().map(|d| d.failures).sum();
    let input_tokens = daily.iter().map(|d| d.input_tokens).sum();
    let output_tokens = daily.iter().map(|d| d.output_tokens).sum();
    let active = daily.iter().map(|d| d.estimated_active_ms).sum();
    let partial = daily.iter().any(|d| d.partial);
    vec![
        exact_metric("Sessions", sessions),
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
            title: "Review repeated tool failures".to_string(),
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
            title: "Investigate token hotspot".to_string(),
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
            title: "Model mix context".to_string(),
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
            title: "No major friction found".to_string(),
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
        "Current".to_string(),
        "Previous".to_string(),
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
        ("forge", ["edit", "create", "apply_patch", "write"]),
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
        "forge" => "Edits",
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
            .any(|artifact| artifact.title == "Skills inventory"));
        let rendered = serde_json::to_string(&artifacts).expect("serialize artifacts");
        assert!(!rendered.contains("relative_path"));
        assert!(!rendered.contains("copilot:"));
        assert!(rendered.contains("Largest skill definitions"));
        assert!(rendered.contains("Skill completeness gaps"));
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
    fn mcp_server_config_exposes_insights_tools() {
        let script_path = PathBuf::from("/tmp/mission-control-insights.js");
        let project_root = PathBuf::from("/tmp/project");
        let servers = mission_control_insights_mcp_servers(
            &script_path,
            Some(&project_root),
            all_mission_control_insights_tools(),
        );
        let server = servers
            .get("mission-control-insights")
            .expect("insights server configured");
        let github_copilot_sdk::types::McpServerConfig::Stdio(config) = server else {
            panic!("expected stdio MCP server");
        };
        assert_eq!(config.command, "node");
        assert_eq!(config.args, vec!["/tmp/mission-control-insights.js"]);
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
