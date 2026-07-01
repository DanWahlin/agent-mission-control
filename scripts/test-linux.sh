#!/usr/bin/env bash
#
# test-linux.sh — runs ON a Linux host (e.g. a headless Hetzner VM).
#
# Reproduces the WSL2 / headless Linux scenario from issue #3: build the app,
# then launch it under a virtual framebuffer (Xvfb) WITHOUT the system-tray
# library (libayatana-appindicator3 / libappindicator3) installed. Before the
# fix the app hard-panicked at tray init and never showed a window. After the
# fix it logs "System tray unavailable, continuing without it" and keeps running.
#
# Designed to be idempotent: only missing dependencies are installed, so repeat
# runs only pay for an incremental cargo rebuild.
#
# Usage (normally invoked remotely by scripts/test-linux-remote.sh):
#   bash scripts/test-linux.sh
#
set -euo pipefail

RUN_SECONDS="${AMC_RUN_SECONDS:-20}"
BIN_NAME="copilot-mission-control"

log()  { printf '\033[36m[test-linux]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[test-linux] FAIL:\033[0m %s\n' "$*"; exit 1; }

command -v apt-get >/dev/null 2>&1 || fail "this script expects a Debian/Ubuntu host (apt-get not found)."

# --- 1. System dependencies (NOTE: appindicator is intentionally omitted) ---
# dbus-x11 (dbus-run-session) + Xvfb let WebKitGTK initialize headlessly so the
# app actually reaches its setup hook (and thus the tray code) instead of
# hanging during webview creation.
APT_PKGS=(curl git build-essential file libwebkit2gtk-4.1-dev librsvg2-dev patchelf xvfb dbus-x11 libgtk-3-0)
MISSING=()
for pkg in "${APT_PKGS[@]}"; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING+=("$pkg")
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  log "Installing missing apt packages: ${MISSING[*]}"
  sudo apt-get update -y
  sudo apt-get install -y "${MISSING[@]}"
else
  log "All apt build/runtime deps already present."
fi

# Guardrail: this test is only meaningful when the tray lib is absent.
if dpkg -s libayatana-appindicator3-1 >/dev/null 2>&1 || dpkg -s libappindicator3-1 >/dev/null 2>&1; then
  log "WARNING: an appindicator library is installed, so the tray will build"
  log "         successfully and the no-tray fallback path will NOT be exercised."
fi

# --- 2. Toolchains ---
if ! command -v node >/dev/null 2>&1; then
  log "Installing Node.js 20.x"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v cargo >/dev/null 2>&1; then
  log "Installing Rust toolchain via rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# --- 3. Build ---
log "Installing npm deps"
npm install --no-audit --no-fund
log "Building frontend (embedded into the binary)"
npm run build:frontend
log "Building Rust release binary (this is the slow step on first run)"
( cd src-tauri && cargo build --release )

BIN="src-tauri/target/release/${BIN_NAME}"
[ -x "$BIN" ] || BIN="$(find src-tauri/target/release -maxdepth 1 -type f -name "${BIN_NAME}" | head -n1)"
[ -n "${BIN:-}" ] && [ -x "$BIN" ] || fail "could not locate built binary '${BIN_NAME}' under src-tauri/target/release"

# --- 4. Launch headless and capture output ---
# dbus-run-session + Xvfb provide a session bus and a virtual display; the
# WEBKIT_* flags disable GPU/compositing/sandbox features that aren't available
# on a headless server, so WebKitGTK initializes instead of hanging in webview
# creation. Without these the app never reaches its setup hook (or the tray).
LOG="$(mktemp)"
log "Launching '$BIN' headless (dbus + Xvfb) for ${RUN_SECONDS}s ..."
set +e
timeout "${RUN_SECONDS}" dbus-run-session -- \
  xvfb-run -a \
  env WEBKIT_DISABLE_COMPOSITING_MODE=1 \
      WEBKIT_DISABLE_DMABUF_RENDERER=1 \
      WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 \
  "$BIN" >"$LOG" 2>&1
EXIT=$?
set -e

echo "----- app output -----"
cat "$LOG"
echo "----------------------"
log "exit code: ${EXIT} (124 = killed by timeout = still running)"

# --- 5. Evaluate ----------------------------------------------------------
# Pass/fail is based on log signals, NOT just survival: a hang during webview
# init would also survive the timeout. A healthy launch reaches the tray
# decision, which (with no appindicator installed) prints the skip message.
SKIP_MSG="System tray library (libayatana-appindicator3) not found"
ERR_MSG="System tray unavailable, continuing without it"

if grep -q "Failed to load ayatana-appindicator3 or appindicator3" "$LOG"; then
  rm -f "$LOG"
  fail "appindicator panic reproduced — the app crashed at tray init (fix NOT working)."
fi
if grep -qi "panicked at" "$LOG"; then
  rm -f "$LOG"
  fail "app panicked during launch (see output above)."
fi

if grep -qF "$SKIP_MSG" "$LOG"; then
  rm -f "$LOG"
  printf '\033[32m[test-linux] PASS:\033[0m no tray library present — the app pre-flighted it, skipped the tray, and completed setup without crashing.\n'
  exit 0
fi
if grep -qF "$ERR_MSG" "$LOG"; then
  rm -f "$LOG"
  printf '\033[32m[test-linux] PASS:\033[0m tray build failed but was handled gracefully — the app continued.\n'
  exit 0
fi

# Neither tray-decision line appeared. If an appindicator library happens to be
# installed, the tray builds silently and surviving the timeout is success.
# Otherwise the app never reached the tray code (crashed or hung before setup).
if dpkg -s libayatana-appindicator3-1 >/dev/null 2>&1 || dpkg -s libappindicator3-1 >/dev/null 2>&1; then
  if [ "$EXIT" -eq 124 ]; then
    rm -f "$LOG"
    printf '\033[32m[test-linux] PASS:\033[0m a tray library is installed; the tray built and the app stayed running.\n'
    exit 0
  fi
fi
rm -f "$LOG"
fail "app did not reach the tray decision (exit ${EXIT}) — it likely crashed or hung before completing setup. See output above."
