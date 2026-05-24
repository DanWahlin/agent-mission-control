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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, fs};
use std::io::{BufRead, BufReader, Seek, SeekFrom};

use notify::{recommended_watcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Manager};

// ── Public types serialized to the renderer ───────────────────────────

#[derive(serde::Serialize, Default)]
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
    pub generated_at_ms: u64,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct AgentSessionSummary {
    #[serde(default)]
    pub provider: String,
    pub id: String,
    pub title: String,
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
    /// Tools served by MCP servers (github-mcp-server-*, context7-*,
    /// kit-dev-mcp-*, etc.) — separate bucket because they sit on a
    /// dedicated quarter in the renderer.
    #[serde(default)]
    pub mcp_count: usize,
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
}

#[derive(serde::Serialize, Default, Clone)]
pub struct SessionToolCall {
    pub tool: String,
    pub category: String,
    pub timestamp: String,
    pub success: bool,
    /// Duration in ms between matching start/complete events. None when
    /// the call is still in flight or the complete event is missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
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
    /// Directory whose changes should trigger a re-scan. None means the
    /// provider cannot be watched (e.g. it polls a remote endpoint).
    fn state_root(&self) -> Option<PathBuf>;
    fn scan(&self) -> ProviderScan;
}

pub fn default_providers() -> Vec<Box<dyn AgentProvider>> {
    vec![Box::new(CopilotProvider)]
}

// ── Top-level merge ───────────────────────────────────────────────────

const MAX_SESSIONS: usize = 12;
const MAX_TOOLS: usize = 10;
const MAX_TOOLS_PER_CATEGORY: usize = 5;
/// Recent global event feed cap (after merging across providers). Bumped
/// from 18 → 80 so chatty bursts between scans don't drop events that
/// the renderer's workMixHistory needs to accumulate per category.
const MAX_RECENT_EVENTS: usize = 80;
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

pub fn collect_agent_activity() -> AgentActivity {
    let providers = default_providers();
    let scans: Vec<ProviderScan> = providers.iter().map(|p| p.scan()).collect();
    merge_scans(scans)
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
            .push("No supported agent CLI executables were found on PATH.".to_string());
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
    fn state_root(&self) -> Option<PathBuf> {
        home_dir().map(|h| h.join(".copilot").join("session-state"))
    }
    fn scan(&self) -> ProviderScan {
        scan_copilot()
    }
}

fn scan_copilot() -> ProviderScan {
    let provider = "copilot";
    let available = is_copilot_available();
    let mut scan = ProviderScan::unavailable(provider);
    scan.available = available;

    let Some(home) = home_dir() else {
        scan.alerts
            .push("HOME is not available, so Copilot session state cannot be scanned.".to_string());
        return scan;
    };

    let state_dir = home.join(".copilot").join("session-state");
    if !state_dir.exists() {
        scan.alerts
            .push("No ~/.copilot/session-state directory found yet.".to_string());
        return scan;
    }

    let mut session_dirs = match fs::read_dir(&state_dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                if !path.is_dir() {
                    return None;
                }
                let modified = path
                    .join("events.jsonl")
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
                Some((path, modified))
            })
            .collect::<Vec<_>>(),
        Err(err) => {
            scan.alerts
                .push(format!("Unable to scan Copilot session state: {}", err));
            return scan;
        }
    };

    session_dirs.sort_by(|a, b| b.1.cmp(&a.1));
    // Cap per-provider scan effort but leave global truncation to the merger.
    session_dirs.truncate(MAX_SESSIONS);
    scan.scanned_sessions = session_dirs.len();

    // Load once per scan; reused for every tool execution event below.
    let mcp_allowlist = load_mcp_tool_allowlist();

    let now = SystemTime::now();

    for (session_path, modified) in session_dirs {
        let session_id = session_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let workspace = parse_workspace(&session_path.join("workspace.yaml"));
        let age_seconds = now
            .duration_since(modified)
            .map(|age| age.as_secs())
            .unwrap_or(0);
        let mut summary = AgentSessionSummary {
            provider: provider.to_string(),
            id: session_id.chars().take(8).collect(),
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
        summary.title = sanitize_session_title(workspace.get("summary"))
            .unwrap_or_else(|| format!("{} {}", summary.repository, summary.branch));

        summarize_events(
            provider,
            &session_path.join("events.jsonl"),
            &session_id,
            &mut summary,
            &mut scan.tool_counts,
            &mut scan.recent_events,
            &mcp_allowlist,
        );

        // Active sessions report "working" or "thinking" by activity
        // level. We intentionally do NOT escalate to "needs-attention"
        // based on error_count — failed tool calls (view of a missing
        // file, edit where old_str didn't match, grep with no hits) are
        // normal LLM exploration noise, not something the dev needs to
        // act on. If we add real attention signals later (permission
        // requests, session.error events, model failures), wire those
        // here instead.
        summary.status = if summary.is_active && summary.tool_count > 0 {
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

    scan
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

fn parse_workspace(path: &Path) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    let Ok(content) = fs::read_to_string(path) else {
        return values;
    };

    for line in content.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if matches!(
            key,
            "id" | "repository" | "branch" | "summary" | "git_root" | "updated_at"
        ) {
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

fn summarize_events(
    provider: &'static str,
    path: &Path,
    session_id: &str,
    summary: &mut AgentSessionSummary,
    tool_counts: &mut BTreeMap<(String, String), usize>,
    recent_events: &mut Vec<AgentEventSummary>,
    mcp_allowlist: &HashSet<String>,
) {
    let Ok(mut file) = fs::File::open(path) else {
        return;
    };

    if let Ok(metadata) = file.metadata() {
        // Bumped from 512KiB → 8MiB. A long-running Copilot session can
        // accumulate 50MB+ of events; 512KiB only captured the most
        // recent ~30-50 tool calls, which meant low-volume categories
        // like Intent (`report_intent`) were invisible whenever bash
        // bursts dominated the tail. 8MiB gives ~5-15 minutes of
        // history on a busy session and parses in a few ms.
        const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
        if metadata.len() > MAX_READ_BYTES {
            let _ = file.seek(SeekFrom::Start(metadata.len() - MAX_READ_BYTES));
        }
    }

    // Pending tool starts keyed by tool name. Lets us compute duration
    // on the matching complete event without storing the call_id (which
    // events.jsonl doesn't always set). When two calls to the same tool
    // overlap we'd lose the inner duration, but Copilot CLI runs tool
    // calls sequentially within a session so this is safe in practice.
    let mut pending_starts: BTreeMap<String, (String, String)> = BTreeMap::new();
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let timestamp = value
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        summary.event_count += 1;
        let event_category = categorize_event(event_type).to_string();
        record_last_event(summary, &timestamp, event_type, &event_category);

        // Many event types carry `data.model` (assistant.message,
        // tool.execution_start/complete, assistant.streaming_delta,
        // etc.). The JSONL is appended chronologically so the last
        // write wins → newer events overwrite the captured value,
        // letting the renderer surface mid-session model switches.
        if let Some(model) = value
            .get("data")
            .and_then(|data| data.get("model"))
            .and_then(|v| v.as_str())
        {
            if !model.is_empty() {
                summary.last_model = model.to_string();
            }
        }

        if event_type == "tool.execution_start" {
            let raw_tool_name = value
                .get("data")
                .and_then(|data| data.get("toolName"))
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let args = value
                .get("data")
                .and_then(|data| data.get("arguments"));
            let (tool_name, category) = classify_tool(&raw_tool_name, args, mcp_allowlist);
            record_last_event(summary, &timestamp, event_type, &category);

            summary.tool_count += 1;
            summary.last_tool = tool_name.clone();
            match category.as_str() {
                "forge" => summary.write_count += 1,
                "library" => summary.read_count += 1,
                "terminal" => summary.command_count += 1,
                "signal" => summary.web_count += 1,
                "delegates" | "skills" => summary.task_count += 1,
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
                    duration_ms: None,
                },
            );
            pending_starts.insert(tool_name, (timestamp, category));
        } else if event_type == "tool.execution_complete" {
            let success = value
                .get("data")
                .and_then(|data| data.get("success"))
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
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
            });

            // Fold the success/duration back into the most-recent tool
            // call entry whose tool name matches. Keeps the transcript
            // in chrono order. We also use the stashed category to
            // decide whether this failure escalates the session to
            // needs-attention: failed terminal calls (e.g. `grep` with
            // no matches, `test` returning non-zero) aren't actionable
            // for the dev — they're normal LLM exploration — so they
            // don't bump error_count and don't turn the session red.
            let last_tool = summary.last_tool.clone();
            if let Some((start_ts, cat)) = pending_starts.remove(&last_tool) {
                let duration_ms = parse_iso_ms(&timestamp)
                    .zip(parse_iso_ms(&start_ts))
                    .and_then(|(end, start)| if end >= start { Some(end - start) } else { None });
                if let Some(entry) = summary
                    .recent_tool_calls
                    .iter_mut()
                    .rev()
                    .find(|entry| entry.tool == last_tool && entry.duration_ms.is_none())
                {
                    entry.success = success;
                    entry.duration_ms = duration_ms;
                }
                if !success && cat != "terminal" {
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
        } else if event_type == "assistant.message" {
            // Copilot's `assistant.message` carries `outputTokens` per
            // message but not `inputTokens` in practice — input token
            // counts are reported at session.shutdown via tokenDetails
            // (see below), so trying to accumulate them here would
            // silently stay at zero anyway.
            if let Some(tokens) = value
                .get("data")
                .and_then(|data| data.get("outputTokens"))
                .and_then(|v| v.as_u64())
            {
                summary.output_tokens += tokens;
            }
        } else if event_type == "session.compaction_complete" {
            // `compactionTokensUsed.inputTokens` / `outputTokens` are
            // the tokens consumed BY each compaction operation
            // (~200 KTok per call), not a running total of the
            // conversation — so summing them across N compactions
            // legitimately accounts for "tokens the agent spent on
            // self-compaction this session".
            if let Some(used) = value.get("data").and_then(|d| d.get("compactionTokensUsed")) {
                if let Some(n) = used.get("inputTokens").and_then(|v| v.as_u64()) {
                    summary.input_tokens += n;
                }
                if let Some(n) = used.get("outputTokens").and_then(|v| v.as_u64()) {
                    summary.output_tokens += n;
                }
            }
        } else if event_type == "session.shutdown" {
            // On shutdown Copilot emits the cumulative session totals.
            // We deliberately EXCLUDE `cache_read.tokenCount` from the
            // input total: cache reads are the cached prefix the model
            // re-fetches on every turn, which can balloon into the
            // hundreds of millions for a long session (one observed
            // session reported 321M cache reads vs 125K fresh input
            // and 10M cache writes). Including cache reads made the
            // "Tokens · 24h" card report ~333M for a normal day of
            // coding, which both visually overflowed the card and
            // misrepresented actual model work — cache reads are
            // billed at a tiny fraction of fresh input rates and the
            // model doesn't process them from scratch.
            //
            // We DO include `cache_write` because cache writes are the
            // model committing new content to cache and are billed at
            // the same (or higher) rate as fresh input — they
            // represent real work.
            if let Some(details) = value.get("data").and_then(|d| d.get("tokenDetails")) {
                let fresh = details
                    .get("input").and_then(|v| v.get("tokenCount")).and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_write = details
                    .get("cache_write").and_then(|v| v.get("tokenCount")).and_then(|v| v.as_u64()).unwrap_or(0);
                let total_in = fresh + cache_write;
                if total_in > summary.input_tokens {
                    summary.input_tokens = total_in;
                }
                let out = details
                    .get("output").and_then(|v| v.get("tokenCount")).and_then(|v| v.as_u64()).unwrap_or(0);
                if out > summary.output_tokens {
                    summary.output_tokens = out;
                }
            }
        } else if matches!(
            event_type,
            "assistant.turn_start" | "assistant.turn_end" | "user.message" | "session.start"
        ) {
            if event_type == "assistant.turn_start" {
                summary.turn_count += 1;
            }
            recent_events.push(AgentEventSummary {
                provider: provider.to_string(),
                session_id: session_id.chars().take(8).collect(),
                timestamp,
                kind: event_type.to_string(),
                tool: String::new(),
                category: categorize_event(event_type).to_string(),
                success: true,
            });
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

fn classify_tool(
    raw_name: &str,
    args: Option<&serde_json::Value>,
    mcp_allowlist: &HashSet<String>,
) -> (String, String) {
    // Meta-tools like `skill` and `task` carry their real identity in
    // their arguments (skill name, sub-agent type). Surfacing those
    // identifiers makes the activity feed and tool ranking actually
    // useful. We allowlist only the static identifier fields — no
    // prompt text or other args cross the boundary.
    let lower = raw_name.to_ascii_lowercase();
    if lower == "skill" {
        let skill_name = args
            .and_then(|a| a.get("skill"))
            .and_then(|v| v.as_str())
            .unwrap_or("skill")
            .to_string();
        return (skill_name, "skills".to_string());
    }
    if lower == "task" {
        let subagent = args
            .and_then(|a| a.get("subagent_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("task")
            .to_string();
        return (subagent, "delegates".to_string());
    }
    let category = categorize_tool(raw_name, mcp_allowlist).to_string();
    (raw_name.to_string(), category)
}

/// Load all MCP-registered tool names from `~/.copilot/m-mcp-servers.json`
/// so `categorize_tool` can route them to the MCP quarter even when
/// they have underscore-only names (e.g. Playwright MCP registers
/// `browser_close`, `browser_navigate`, etc. which the heuristic-only
/// path silently falls through to "workshop"). Returns an empty set
/// if the file is missing or malformed — categorization then falls
/// back to the hyphen/`mcp` substring heuristic alone, which is the
/// pre-allowlist behavior.
fn load_mcp_tool_allowlist() -> HashSet<String> {
    let mut allowlist = HashSet::new();
    let Some(home) = home_dir() else {
        return allowlist;
    };
    let path = home.join(".copilot").join("m-mcp-servers.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return allowlist;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return allowlist;
    };
    let Some(servers) = value.get("servers").and_then(|v| v.as_object()) else {
        return allowlist;
    };
    for (_server, info) in servers {
        let Some(tools) = info.get("tools").and_then(|v| v.as_array()) else {
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

fn categorize_tool(tool_name: &str, mcp_allowlist: &HashSet<String>) -> &'static str {
    let name = tool_name.to_ascii_lowercase();
    // 1. Authoritative MCP allowlist from ~/.copilot/m-mcp-servers.json.
    //    Catches underscore-only MCP tool names (Playwright's
    //    browser_close / browser_navigate / browser_evaluate / ...,
    //    presentation server's add_slide_from_code, etc.) that the
    //    pattern heuristic below would miss.
    if mcp_allowlist.contains(&name) {
        return "mcp";
    }
    // 2. Pattern heuristic for MCP tools not enumerated in the config
    //    (wildcard tool registrations, MCP servers that connected
    //    after the config was last read, etc.). Copilot CLI's native
    //    tools all use single words or underscore_only names; anything
    //    with a hyphen, or with "mcp" in the name, is overwhelmingly
    //    an MCP server tool (github-mcp-server-*, context7-*,
    //    kit-dev-mcp-*, io-github-ChromeDevTools-..., azure-pricing,
    //    ide-get_diagnostics, ...) and belongs in its own bucket
    //    regardless of what verb it happens to use.
    if name.contains("mcp") || name.contains('-') {
        return "mcp";
    }
    // 3. Composite / suffix patterns FIRST so wrapper tools route to
    //    the quarter that matches the work they actually do. Without
    //    this ordering, `read_bash` matches "read" -> library (wrong)
    //    instead of "bash" -> terminal; `write_agent` matches "write"
    //    -> forge (wrong) instead of "agent" -> delegates;
    //    `web_search` matches "search" -> library (wrong) instead of
    //    "web" -> signal.
    if name.contains("bash")
        || name.contains("shell")
        || name.contains("sql")
        || name.contains("test")
    {
        return "terminal";
    }
    if name.contains("agent") || name.contains("task") {
        return "delegates";
    }
    if name.contains("web")
        || name.contains("fetch")
        || name.contains("docs")
        || name.contains("github")
    {
        return "signal";
    }
    // 4. Verb-only patterns for the remaining single-word native tools.
    if name.contains("edit")
        || name.contains("create")
        || name.contains("apply_patch")
        || name.contains("write")
    {
        return "forge";
    }
    if name.contains("view")
        || name.contains("read")
        || name.contains("grep")
        || name.contains("rg")
        || name.contains("glob")
        || name.contains("search")
    {
        return "library";
    }
    // 5. Meta / control tools. Knowledge stores (store_memory,
    //    vote_memory, ...) live in Tome Hall alongside skills since
    //    both represent learned/persisted state the agent carries
    //    forward. Planning, intent, scheduling, and "exit plan mode"
    //    live in Royal Court — the dev-facing "what should we do
    //    next" bucket.
    if name.contains("skill") || name.contains("memory") {
        return "skills";
    }
    if name.contains("ask")
        || name.contains("intent")
        || name.contains("plan")
        || name.contains("schedule")
    {
        return "court";
    }
    // 6. Final fallback: Royal Court is the dev-facing "control"
    //    quarter and is the closest analogue for an unrecognized meta
    //    tool. We deliberately do NOT fall back to "workshop" —
    //    that produced invisible tool calls (no pulse, no quarter
    //    count, no drill-down listing) for any future tool we didn't
    //    enumerate above. Routing to an existing quarter keeps every
    //    tool call visible somewhere on the map.
    "court"
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
    let mut watch_targets: Vec<(PathBuf, RecursiveMode)> = Vec::new();

    for provider in providers {
        let Some(root) = provider.state_root() else {
            continue;
        };
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
            if !event.paths.iter().any(|p| is_relevant_path(p)) {
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
fn is_relevant_path(path: &Path) -> bool {
    match path.file_name().and_then(|n| n.to_str()) {
        Some("events.jsonl") | Some("workspace.yaml") => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let mcp_tools: Vec<&AgentToolMetric> =
            activity.tools.iter().filter(|t| t.category == "mcp").collect();
        assert!(
            !mcp_tools.is_empty(),
            "MCP tools must survive truncation even when terminal/library dominate; \
             got tools = {:?}",
            activity.tools.iter().map(|t| (&t.name, &t.category, t.count)).collect::<Vec<_>>()
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
        let terminal_count = activity.tools.iter().filter(|t| t.category == "terminal").count();
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
        let mut allowlist = HashSet::new();
        allowlist.insert("browser_close".to_string());
        allowlist.insert("browser_navigate".to_string());
        allowlist.insert("add_slide_from_code".to_string());

        assert_eq!(categorize_tool("browser_close", &allowlist), "mcp");
        assert_eq!(categorize_tool("browser_navigate", &allowlist), "mcp");
        assert_eq!(categorize_tool("add_slide_from_code", &allowlist), "mcp");
        // Case-insensitive match.
        assert_eq!(categorize_tool("Browser_Close", &allowlist), "mcp");
    }

    /// Tools NOT in the allowlist and without hyphen/`mcp` markers
    /// should still hit the original heuristic path (native Copilot
    /// tools land in their proper quarters).
    #[test]
    fn empty_allowlist_falls_back_to_heuristics() {
        let allowlist = HashSet::new();
        // Native Copilot tools — should hit the verb-based branches,
        // not "mcp".
        assert_eq!(categorize_tool("bash", &allowlist), "terminal");
        assert_eq!(categorize_tool("view", &allowlist), "library");
        assert_eq!(categorize_tool("edit", &allowlist), "forge");
        // Hyphenated tool still routes to mcp via the heuristic.
        assert_eq!(categorize_tool("github-mcp-server-list", &allowlist), "mcp");
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
        let allowlist = HashSet::new();
        // *_bash / *_shell / *_sql / *_test should all land in terminal,
        // not in forge (write) or library (read) just because of the
        // prefix verb.
        assert_eq!(categorize_tool("read_bash", &allowlist), "terminal");
        assert_eq!(categorize_tool("write_bash", &allowlist), "terminal");
        assert_eq!(categorize_tool("stop_bash", &allowlist), "terminal");
        assert_eq!(categorize_tool("list_bash", &allowlist), "terminal");
        // *_agent should land in delegates (Guild Hall) since the
        // tool drives a sub-agent, not in library/forge.
        assert_eq!(categorize_tool("read_agent", &allowlist), "delegates");
        assert_eq!(categorize_tool("write_agent", &allowlist), "delegates");
        assert_eq!(categorize_tool("list_agents", &allowlist), "delegates");
        assert_eq!(categorize_tool("stop_agent", &allowlist), "delegates");
        // web_search is a web tool — Signal Tower, not Library.
        assert_eq!(categorize_tool("web_search", &allowlist), "signal");
        assert_eq!(categorize_tool("web_fetch", &allowlist), "signal");
    }

    /// Built-in meta/control tools (vote_memory, store_memory,
    /// exit_plan_mode, manage_schedule, ...) previously fell through
    /// every heuristic branch and landed in the "workshop" fallback,
    /// which had no quarter — so the tool call appeared in the
    /// Activity Feed but no building's count incremented and no pulse
    /// flew to any quarter. They must route to a quarter that exists.
    #[test]
    fn meta_control_tools_land_in_a_real_quarter() {
        let allowlist = HashSet::new();
        // Memory tools = persisted knowledge = Tome Hall (skills).
        assert_eq!(categorize_tool("store_memory", &allowlist), "skills");
        assert_eq!(categorize_tool("vote_memory", &allowlist), "skills");
        // Plan/schedule/intent = Royal Court (dev-facing control).
        assert_eq!(categorize_tool("exit_plan_mode", &allowlist), "court");
        assert_eq!(categorize_tool("manage_schedule", &allowlist), "court");
        assert_eq!(categorize_tool("ask_user", &allowlist), "court");
        assert_eq!(categorize_tool("report_intent", &allowlist), "court");
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
        summarize_events(
            "test",
            &path,
            "test-session",
            &mut summary,
            &mut tool_counts,
            &mut recent_events,
            &allowlist,
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

        let _ = std::fs::remove_file(&path);
    }

    /// Sanity check: every Copilot CLI built-in tool we've observed
    /// must land in one of the eight known quarter keys. No tool
    /// should ever be invisible on the mission map.
    #[test]
    fn every_observed_builtin_routes_to_a_known_quarter() {
        let allowlist = HashSet::new();
        const QUARTERS: &[&str] = &[
            "forge", "library", "terminal", "signal", "delegates", "skills", "court", "mcp",
        ];
        let tools = [
            "bash", "write_bash", "read_bash", "stop_bash", "list_bash",
            "view", "edit", "create", "apply_patch", "grep", "glob",
            "web_fetch", "web_search", "fetch_copilot_cli_documentation",
            "ask_user", "report_intent",
            "store_memory", "vote_memory",
            "exit_plan_mode", "manage_schedule",
            "list_agents", "read_agent", "write_agent", "stop_agent",
            "sql", "session_store_sql",
            "tool_search_tool_regex",
        ];
        for tool in tools {
            let cat = categorize_tool(tool, &allowlist);
            assert!(
                QUARTERS.contains(&cat),
                "tool {tool} -> {cat}, which is not a real quarter"
            );
        }
    }
}
