#!/usr/bin/env bash
# Launches an Agent Mission Control .app bundle for automation and pins its
# window to one display. Prints the app process ID on stdout.
#
#   launch-app.sh [path/to/Agent Mission Control.app]
#
# Environment:
#   AMC_DISPLAY  builtin (default) puts the window on the laptop display.
#                main leaves the saved window position unchanged.
#   AMC_WAIT_SECONDS  seconds to wait for the window (default 30).
#
# The window position comes from the tauri-plugin-window-state file, which the
# installed app shares (same bundle identifier). The first run backs it up to
# .window-state.json.automation-backup. Run restore-window-state.sh when done.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
APP="${1:-$REPO_ROOT/src-tauri/target/debug/bundle/macos/Agent Mission Control.app}"
DISPLAY_TARGET="${AMC_DISPLAY:-builtin}"
WAIT_SECONDS="${AMC_WAIT_SECONDS:-30}"
STATE_DIR="$HOME/Library/Application Support/com.danwahlin.copilotmissioncontrol"
STATE_FILE="$STATE_DIR/.window-state.json"
BACKUP_FILE="$STATE_FILE.automation-backup"
WINDOW_WIDTH=1600
WINDOW_HEIGHT=1000
TOP_MARGIN=40

log() { echo "launch-app: $*" >&2; }

[[ -d "$APP" ]] || { log "app bundle not found: $APP (build it with: cargo tauri build --debug --bundles app --no-sign)"; exit 1; }
APP="$(cd "$APP" && pwd)"
BINARY_DIR="$APP/Contents/MacOS/"

# Compile the display helper once per change; `swift file.swift` is slow.
HELPER="${TMPDIR:-/tmp}/amc-displays"
if [[ ! -x "$HELPER" || "$SCRIPT_DIR/displays.swift" -nt "$HELPER" ]]; then
  swiftc -O -o "$HELPER" "$SCRIPT_DIR/displays.swift" 2>/dev/null
fi

# Stop an earlier automation instance of this bundle.
for pid in $(pgrep -f "$BINARY_DIR" || true); do
  log "stopping earlier instance $pid"
  kill "$pid" 2>/dev/null || true
done
for _ in $(seq 1 50); do pgrep -f "$BINARY_DIR" >/dev/null || break; sleep 0.1; done

# The single-instance plugin hands a new launch to any running copy with the
# same bundle identifier, so do not continue if another copy runs.
for pid in $(pgrep -f "Agent Mission Control.app/Contents/MacOS/" || true); do
  log "another Agent Mission Control is running (pid $pid). Quit it first; this script does not stop it."
  exit 1
done

if [[ "$DISPLAY_TARGET" == "builtin" ]]; then
  read -r _ DX DY DW DH _ < <("$HELPER" displays | awk '$1 == "builtin"' | head -1) || true
  if [[ -z "${DX:-}" ]]; then
    log "no built-in display found; keeping the saved window position"
  else
    SCALE="$("$HELPER" mainscale)"
    X=$(( DX + (DW > WINDOW_WIDTH ? (DW - WINDOW_WIDTH) / 2 : 0) ))
    Y=$(( DY + TOP_MARGIN ))
    (( DH < WINDOW_HEIGHT + TOP_MARGIN + 40 )) && log "warning: built-in display is ${DH}pt high; the window can extend past it"
    mkdir -p "$STATE_DIR"
    [[ -f "$STATE_FILE" && ! -f "$BACKUP_FILE" ]] && cp "$STATE_FILE" "$BACKUP_FILE"
    # The plugin stores physical pixels relative to the display the window
    # opens on (the menu-bar display), so scale the point coordinates by it.
    cat > "$STATE_FILE" <<EOF
{
  "main": {
    "width": 0,
    "height": 0,
    "x": $(( X * SCALE )),
    "y": $(( Y * SCALE )),
    "prev_x": $(( X * SCALE )),
    "prev_y": $(( Y * SCALE )),
    "maximized": false,
    "visible": true,
    "decorated": true,
    "fullscreen": false
  }
}
EOF
    log "window state set to built-in display at ${X},${Y} (points)"
  fi
fi

open -g -n "$APP"

PID=""
for _ in $(seq 1 $(( WAIT_SECONDS * 2 ))); do
  PID="$(pgrep -f "$BINARY_DIR" | head -1 || true)"
  [[ -n "$PID" ]] && break
  sleep 0.5
done
[[ -n "$PID" ]] || { log "app process did not start"; exit 1; }

WINDOW="none"
for _ in $(seq 1 $(( WAIT_SECONDS * 2 ))); do
  WINDOW="$("$HELPER" window "$PID" || true)"
  [[ "$WINDOW" != "none" && -n "$WINDOW" ]] && break
  sleep 0.5
done
log "window: $WINDOW"

if [[ "$DISPLAY_TARGET" == "builtin" && -n "${DX:-}" && "$WINDOW" != *" builtin" ]]; then
  log "window is not on the built-in display"
  exit 1
fi

echo "$PID"
