// Copilot Mission Control — Tauri backend.
// A windowed observability dashboard for the GitHub Copilot CLI.
//
// Backend responsibilities:
//   - Host a single decorated, resizable window
//   - Save/restore window size + position across launches (window-state plugin)
//   - Expose Copilot CLI session summaries to the renderer via
//     `get_copilot_activity` / `get_agent_activity`
//   - Watch the local Copilot state directory and push refresh
//     callbacks into the renderer when sessions change
//   - Open files in an external editor (vscode://) — bypasses the
//     opener plugin's renderer-side URL scope, which only allows
//     http(s)/mailto/tel
//   - Provide a tray icon for quick show/hide

mod agent;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use agent::{collect_agent_activity, AgentActivity};

// Icons baked into the binary so they survive whether the binary is
// launched bare (`tauri dev`) or wrapped in an .app bundle (`tauri build`).
// On macOS the Dock icon must be applied programmatically in dev mode
// because the bare binary has no Info.plist / CFBundleIconFile.
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray_icon.png");
#[cfg(target_os = "macos")]
const DOCK_ICON_BYTES: &[u8] = include_bytes!("../icons/dock_icon.png");

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
fn get_agent_activity() -> AgentActivity {
    collect_agent_activity()
}

/// Backward-compatible alias for `get_agent_activity`. Earlier renderer
/// builds invoke this name.
#[tauri::command]
fn get_copilot_activity() -> AgentActivity {
    collect_agent_activity()
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
    if !scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '+') {
        return Err(format!("Refusing unsupported editor scheme: {}", scheme));
    }
    let url = format!("{}://file/{}", scheme, path);
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ── Window helpers ────────────────────────────────────────────────────

fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
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
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            quit_app,
            hide_app,
            get_agent_activity,
            get_copilot_activity,
            open_in_editor
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

            // Build a minimal system tray with Show/Hide and Quit.
            let is_mac = cfg!(target_os = "macos");
            let toggle_label = "Show / Hide Copilot Mission Control";
            let quit_label = if is_mac { "Quit  (⌘Q)" } else { "Quit  (Ctrl+Q)" };

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
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows {
                    show_window(app);
                }
            }
            let _ = (app, event);
        });
}
