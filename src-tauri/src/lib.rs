// Copilot Mission Control — Tauri backend.
// A windowed observability dashboard for the GitHub Copilot CLI.
//
// Backend responsibilities:
//   - Host a single decorated, resizable window
//   - Save/restore window position across launches (window-state plugin)
//   - Expose Copilot CLI session summaries to the renderer via
//     `get_copilot_activity` / `get_agent_activity`
//     (`get_agent_activity_with_history` is loaded only on the History route)
//   - Watch the local Copilot state directory and push refresh
//     callbacks into the renderer when sessions change
//   - Open files in an external editor (vscode://) — bypasses the
//     opener plugin's renderer-side URL scope, which only allows
//     http(s)/mailto/tel
//   - Provide a tray icon for quick show/hide

mod agent;
mod analytics;
mod definition_paths;
mod executable_env;
mod skill_evaluator;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};
use tauri_plugin_window_state::StateFlags;

use std::sync::atomic::{AtomicBool, Ordering};

use agent::{
    collect_agent_activity, collect_agent_activity_for_provider,
    collect_agent_activity_with_history, list_agent_activity_field_mappings, list_agent_providers,
    AgentActivity, AgentActivityFieldMapping, AgentProviderInfo,
};
use analytics::{
    AnalyticsChatRequest, AnalyticsChatResponse, AnalyticsRangeRequest, AnalyticsRecommendation,
    AnalyticsStatus, AnalyticsUsageSummary, EngineeringDigest, EngineeringDigestRequest,
};
use skill_evaluator::SkillEvaluation;

// Icons baked into the binary so they survive whether the binary is
// launched bare (`tauri dev`) or wrapped in an .app bundle (`tauri build`).
// On macOS the Dock icon must be applied programmatically in dev mode
// because the bare binary has no Info.plist / CFBundleIconFile.
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray_icon.png");
#[cfg(target_os = "macos")]
const DOCK_ICON_BYTES: &[u8] = include_bytes!("../icons/dock_icon.png");
const MIN_VISIBLE_WINDOW_WIDTH: i64 = 240;
const MIN_VISIBLE_WINDOW_HEIGHT: i64 = 160;
static UPDATE_CHECK_DONE: AtomicBool = AtomicBool::new(false);
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// macOS only: set the running app's Dock icon via NSApplication. Tauri
/// dev runs the bare binary (no .app bundle), so macOS otherwise falls
/// back to a generic rocket. Safe to call from the main thread.
#[cfg(target_os = "macos")]
fn set_dock_icon() {
    use objc2::rc::autoreleasepool;
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    autoreleasepool(|_| {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let data = NSData::with_bytes(DOCK_ICON_BYTES);
        let image = NSImage::initWithData(NSImage::alloc(), &data);
        if let Some(image) = image {
            unsafe { app.setApplicationIconImage(Some(&image)) };
        }
    });
}

// ── Tauri commands ────────────────────────────────────────────────────

/// Return the app version baked in at compile time.
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Download and install an available update, then restart the app.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    if UPDATE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return Err("Update already in progress".to_string());
    }

    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater_builder().build().map_err(|e| {
        UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
        e.to_string()
    })?;

    match updater.check().await {
        Ok(Some(update)) => {
            if let Some(win) = app.get_webview_window("main") {
                let _ =
                    win.eval("window.__cmcUpdateStatus && window.__cmcUpdateStatus('downloading')");
            }
            if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
                return Err(e.to_string());
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ =
                    win.eval("window.__cmcUpdateStatus && window.__cmcUpdateStatus('restarting')");
            }
            app.restart();
        }
        Ok(None) => {
            UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
            Err("No update available".to_string())
        }
        Err(e) => {
            UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
            Err(format!("Update check failed: {}", e))
        }
    }
}

/// Quit the application.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Hide the main window (user can re-show from tray).
#[tauri::command]
fn hide_app(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

/// Privacy-preserving summary of local agent CLI activity (currently
/// the GitHub Copilot CLI provider). The Tauri bridge never carries
/// prompt text, assistant text, tool arguments, file paths, or
/// command output — see the allowlist in `agent::summarize_events`.
#[tauri::command]
async fn get_agent_activity() -> Result<AgentActivity, String> {
    tauri::async_runtime::spawn_blocking(collect_agent_activity)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_agent_providers() -> Result<Vec<AgentProviderInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_agent_providers)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_agent_activity_field_mappings() -> Result<Vec<AgentActivityFieldMapping>, String> {
    tauri::async_runtime::spawn_blocking(list_agent_activity_field_mappings)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_agent_activity_for_provider(provider: String) -> Result<AgentActivity, String> {
    tauri::async_runtime::spawn_blocking(move || {
        collect_agent_activity_for_provider(&provider, false)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Full activity summary for the History route. This intentionally runs
/// separately from the mission command so the main dashboard doesn't pay
/// the aggregation cost while the History screen is unloaded.
#[tauri::command]
async fn get_agent_activity_with_history() -> Result<AgentActivity, String> {
    tauri::async_runtime::spawn_blocking(collect_agent_activity_with_history)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_agent_activity_for_provider_with_history(
    provider: String,
) -> Result<AgentActivity, String> {
    tauri::async_runtime::spawn_blocking(move || {
        collect_agent_activity_for_provider(&provider, true)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Backward-compatible alias for `get_agent_activity`. Earlier renderer
/// builds invoke this name.
#[tauri::command]
async fn get_copilot_activity() -> Result<AgentActivity, String> {
    tauri::async_runtime::spawn_blocking(collect_agent_activity)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_analytics_status(app: AppHandle) -> Result<AnalyticsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || analytics::analytics_status(&app))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn run_analytics_ingestion_once(app: AppHandle) -> Result<AnalyticsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || analytics::run_analytics_ingestion_once(&app))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn get_analytics_usage_summary(
    app: AppHandle,
    request: AnalyticsRangeRequest,
) -> Result<AnalyticsUsageSummary, String> {
    tauri::async_runtime::spawn_blocking(move || analytics::analytics_usage_summary(&app, request))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn get_engineering_digest(
    app: AppHandle,
    request: EngineeringDigestRequest,
) -> Result<EngineeringDigest, String> {
    tauri::async_runtime::spawn_blocking(move || analytics::engineering_digest(&app, request))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn get_analytics_recommendation_facts(
    app: AppHandle,
    request: AnalyticsRangeRequest,
) -> Result<Vec<AnalyticsRecommendation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        analytics::analytics_recommendation_facts(&app, request)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn ask_analytics_chat(
    app: AppHandle,
    request: AnalyticsChatRequest,
) -> Result<AnalyticsChatResponse, String> {
    analytics::analytics_chat(&app, request).await
}

#[tauri::command]
async fn set_mcp_server_enabled(
    server: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        analytics::set_mcp_server_enabled(&server, enabled)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn read_copilot_definition(
    app: AppHandle,
    kind: String,
    definition: String,
    root: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        analytics::read_copilot_definition(&app, &kind, &definition, root.as_deref())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn open_copilot_definition(
    kind: String,
    definition: String,
    root: Option<String>,
    scheme: Option<String>,
) -> Result<(), String> {
    let path = analytics::resolve_copilot_definition_path(&kind, &definition, root.as_deref())?;
    open_in_editor(path.to_string_lossy().to_string(), scheme).await
}

#[tauri::command]
async fn open_session_in_editor(
    provider: Option<String>,
    session_id: String,
    scheme: Option<String>,
) -> Result<(), String> {
    let path = agent::session_editor_path(provider, session_id)?;
    open_in_editor(path.to_string_lossy().to_string(), scheme).await
}

#[tauri::command]
async fn evaluate_skill_definition(
    definition: String,
    root: Option<String>,
    mode: Option<String>,
) -> Result<SkillEvaluation, String> {
    evaluate_definition("skills", definition, root, mode).await
}

#[tauri::command]
async fn evaluate_agent_definition(
    definition: String,
    root: Option<String>,
    mode: Option<String>,
) -> Result<SkillEvaluation, String> {
    evaluate_definition("agents", definition, root, mode).await
}

async fn evaluate_definition(
    kind: &'static str,
    definition: String,
    root: Option<String>,
    mode: Option<String>,
) -> Result<SkillEvaluation, String> {
    let parsed_mode = skill_evaluator::EvaluationMode::parse(mode.as_deref())?;
    let root_for_static = root.clone();
    let static_result = tauri::async_runtime::spawn_blocking(move || {
        if kind == "skills" {
            skill_evaluator::evaluate_skill_definition_static(
                &definition,
                root_for_static.as_deref(),
            )
        } else {
            skill_evaluator::evaluate_definition_static(
                kind,
                &definition,
                root_for_static.as_deref(),
            )
        }
    })
    .await
    .map_err(|err| err.to_string())??;

    let mut evaluation = static_result.evaluation;
    if parsed_mode == skill_evaluator::EvaluationMode::Judge {
        let judge_result = if kind == "agents" {
            skill_evaluator::judge_agent_with_copilot(&evaluation, &static_result.source).await
        } else {
            skill_evaluator::judge_skill_with_copilot(&evaluation, &static_result.source).await
        };
        skill_evaluator::merge_judge_result(&mut evaluation, judge_result);
    }
    Ok(evaluation)
}

/// Open the given filesystem path in an external editor by shelling out
/// through the OS default URL handler. Uses `tauri_plugin_opener`'s
/// Rust API directly to bypass the plugin's renderer-side URL scope
/// (which only whitelists http/https/mailto/tel).
#[tauri::command]
async fn open_in_editor(path: String, scheme: Option<String>) -> Result<(), String> {
    let scheme = scheme.unwrap_or_else(|| "vscode".to_string());
    // Defense-in-depth: reject non-trivial schemes so a malicious
    // renderer build can't smuggle arbitrary protocols.
    if !scheme
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '+')
    {
        return Err(format!("Refusing unsupported editor scheme: {}", scheme));
    }
    let url = format!("{}://file/{}", scheme, path);
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let allowed = url
        .starts_with("https://github.com/DanWahlin/copilot-mission-control/issues/new?")
        || url == "https://github.com/DanWahlin/copilot-mission-control/releases/latest";
    if !allowed {
        return Err("Refusing unsupported external URL".to_string());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ── Window helpers ────────────────────────────────────────────────────

fn start_update_check(app: AppHandle) {
    if UPDATE_CHECK_DONE.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        tauri::async_runtime::spawn(async move {
            use tauri_plugin_updater::UpdaterExt;
            let updater = match app.updater_builder().build() {
                Ok(updater) => updater,
                Err(e) => {
                    log::warn!("Failed to build updater: {}", e);
                    return;
                }
            };

            match updater.check().await {
                Ok(Some(update)) => {
                    let version: String = update
                        .version
                        .chars()
                        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
                        .collect();
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.eval(&format!(
                            "window.__cmcUpdateAvailable && window.__cmcUpdateAvailable('{}')",
                            version
                        ));
                    }
                }
                Ok(None) => log::info!("App is up to date"),
                Err(e) => log::warn!("Update check failed: {}", e),
            }
        });
    });
}

fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        ensure_window_visible(&win);
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn ensure_window_visible(win: &WebviewWindow) {
    if window_has_visible_area(win) {
        return;
    }
    let _ = win.center();
}

fn window_has_visible_area(win: &WebviewWindow) -> bool {
    let Ok(position) = win.outer_position() else {
        return true;
    };
    let Ok(size) = win.outer_size() else {
        return true;
    };
    let Ok(monitors) = win.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }

    let win_left = i64::from(position.x);
    let win_top = i64::from(position.y);
    let win_right = win_left + i64::from(size.width);
    let win_bottom = win_top + i64::from(size.height);
    let required_width = MIN_VISIBLE_WINDOW_WIDTH.min(i64::from(size.width));
    let required_height = MIN_VISIBLE_WINDOW_HEIGHT.min(i64::from(size.height));

    monitors.iter().any(|monitor| {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let monitor_left = i64::from(monitor_position.x);
        let monitor_top = i64::from(monitor_position.y);
        let monitor_right = monitor_left + i64::from(monitor_size.width);
        let monitor_bottom = monitor_top + i64::from(monitor_size.height);

        let visible_width = win_right.min(monitor_right) - win_left.max(monitor_left);
        let visible_height = win_bottom.min(monitor_bottom) - win_top.max(monitor_top);
        visible_width >= required_width && visible_height >= required_height
    })
}

fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => show_window(app),
        }
    }
}

// ── App entry point ───────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            quit_app,
            hide_app,
            get_agent_providers,
            get_agent_activity_field_mappings,
            get_agent_activity,
            get_agent_activity_for_provider,
            get_agent_activity_with_history,
            get_agent_activity_for_provider_with_history,
            get_copilot_activity,
            get_analytics_status,
            run_analytics_ingestion_once,
            get_analytics_usage_summary,
            get_engineering_digest,
            get_analytics_recommendation_facts,
            ask_analytics_chat,
            set_mcp_server_enabled,
            read_copilot_definition,
            open_copilot_definition,
            evaluate_skill_definition,
            evaluate_agent_definition,
            install_update,
            open_session_in_editor,
            open_in_editor,
            open_external_url
        ])
        .setup(|app| {
            // macOS dev mode: bare binary has no .app bundle, so set the
            // Dock icon programmatically. No-op on other platforms.
            #[cfg(target_os = "macos")]
            set_dock_icon();

            // Start the multi-agent filesystem watcher. It runs for
            // the app lifetime and pushes refresh callbacks to the
            // renderer whenever any provider's state directory changes.
            agent::start_watcher(app.handle().clone());
            analytics::start_background_ingestion(app.handle().clone());

            if let Some(win) = app.get_webview_window("main") {
                ensure_window_visible(&win);
            }
            start_update_check(app.handle().clone());

            // Build a minimal system tray with Show/Hide and Quit.
            let is_mac = cfg!(target_os = "macos");
            let toggle_label = "Show / Hide Copilot Mission Control";
            let quit_label = if is_mac {
                "Quit  (⌘Q)"
            } else {
                "Quit  (Ctrl+Q)"
            };

            let toggle_item = MenuItemBuilder::with_id("toggle", toggle_label).build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", quit_label).build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&toggle_item, &quit_item])
                .build()?;

            let _tray = TrayIconBuilder::with_id("main")
                .tooltip("Copilot Mission Control")
                .title("")
                .icon(tauri::image::Image::from_bytes(TRAY_ICON_BYTES)?)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "toggle" => toggle_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Copilot Mission Control")
        .run(|app, event| {
            // macOS: re-show window when the user clicks the dock icon
            // after the window has been hidden.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    show_window(app);
                }
            }
            let _ = (app, event);
        });
}
