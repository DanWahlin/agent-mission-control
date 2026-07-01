#!/usr/bin/env bash
#
# test-linux-remote.sh — runs ON your Mac.
#
# Syncs the current working tree (including uncommitted changes) to a Linux
# host over SSH and runs scripts/test-linux.sh there, streaming the result back.
# This lets you verify the issue #3 Linux fixes on a real (headless) Linux box
# without committing or pushing anything.
#
# Configuration (env vars, or an optional gitignored scripts/.linux-test.env):
#   AMC_LINUX_HOST   SSH target / alias        (default: hetzner)
#   AMC_LINUX_DIR    remote working directory  (default: ~/amc-linux-test)
#   AMC_RUN_SECONDS  how long to keep the app running under Xvfb (default: 20)
#
# Usage:
#   npm run test:linux
#   AMC_LINUX_HOST=deploy@1.2.3.4 npm run test:linux
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Optional local config (gitignored).
ENV_FILE="$SCRIPT_DIR/.linux-test.env"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

HOST="${AMC_LINUX_HOST:-hetzner}"
REMOTE_DIR="${AMC_LINUX_DIR:-~/amc-linux-test}"
RUN_SECONDS="${AMC_RUN_SECONDS:-20}"

log() { printf '\033[36m[test-linux-remote]\033[0m %s\n' "$*"; }

command -v rsync >/dev/null 2>&1 || { echo "rsync is required on your Mac" >&2; exit 1; }
command -v ssh   >/dev/null 2>&1 || { echo "ssh is required on your Mac" >&2; exit 1; }

log "Host: $HOST   Remote dir: $REMOTE_DIR"
log "Checking SSH connectivity ..."
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'echo connected' >/dev/null \
  || { echo "Cannot SSH to '$HOST'. Check your ~/.ssh/config alias or set AMC_LINUX_HOST." >&2; exit 1; }

ssh "$HOST" "mkdir -p $REMOTE_DIR"

log "Syncing working tree (uncommitted changes included) ..."
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'src-tauri/target/' \
  --exclude 'src-tauri/gen/' \
  --exclude 'test-results/' \
  --exclude 'playwright-report/' \
  --exclude '.snapshots/' \
  "$REPO_ROOT/" "$HOST:$REMOTE_DIR/"

log "Running scripts/test-linux.sh on $HOST ..."
# -t allocates a TTY so colored output streams live.
ssh -t "$HOST" "cd $REMOTE_DIR && AMC_RUN_SECONDS=$RUN_SECONDS bash scripts/test-linux.sh"
