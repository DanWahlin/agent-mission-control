#!/usr/bin/env bash
# Restores the window-state file that launch-app.sh backed up. Quit the
# automation instance first so the app does not write the file again on exit.
set -euo pipefail

STATE_FILE="$HOME/Library/Application Support/com.danwahlin.copilotmissioncontrol/.window-state.json"
BACKUP_FILE="$STATE_FILE.automation-backup"

if [[ -f "$BACKUP_FILE" ]]; then
  mv "$BACKUP_FILE" "$STATE_FILE"
  echo "restore-window-state: restored $STATE_FILE"
else
  echo "restore-window-state: no backup found; nothing to restore"
fi
