#!/usr/bin/env bash
# Install (or remove) the watchdog that owns the specialist-subagents daemon's lifetime, on macOS.
#
# The macOS counterpart of tools/install-watchdog.ps1: a LaunchAgent instead of a Startup entry. It fills
# tools/watchdog.plist with this machine's repository path, node and PATH, installs it under
# ~/Library/LaunchAgents and loads it; launchd runs tools/watchdog.mjs at login and restarts it if it
# exits. No sudo needed. Re-running it replaces the installed copy (use it after moving the repository
# or changing node).
#
# Run:    bash tools/install-watchdog.sh
#         bash tools/install-watchdog.sh --remove
# Check:  node bin/specialist-subagents.mjs status
#         launchctl print gui/$(id -u)/com.specialist-subagents.watchdog | grep state
#         tail -5 .data/watchdog.log
set -euo pipefail

LABEL=com.specialist-subagents.watchdog
REPO=$(cd "$(dirname "$0")/.." && pwd)
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && echo "unloaded: $LABEL" || echo "was not loaded: $LABEL"
  if [ -f "$TARGET" ]; then
    # Recoverable where the system has a trash command; the daemon itself keeps running until stopped.
    if command -v trash >/dev/null 2>&1; then trash "$TARGET"; else rm -f "$TARGET"; fi
    echo "removed: $TARGET"
  fi
  echo "the daemon is still up if it was; stop it with: node bin/specialist-subagents.mjs stop"
  exit 0
fi

NODE=$(command -v node) || { echo "node is not on PATH; install node or put it on PATH, then run this again" >&2; exit 1; }
# Not the installing shell's PATH: that one carries whatever the current terminal or agent session added,
# and those directories vanish with it. node's directory, npm's global bin, then the system.
NPM_BIN="$(npm prefix -g 2>/dev/null)/bin"
JOB_PATH="$(dirname "$NODE"):$NPM_BIN:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$HOME/Library/LaunchAgents" "$REPO/.data"

# `|` as the sed delimiter: none of the three values is expected to contain it.
sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE|g" -e "s|__PATH__|$JOB_PATH|g" \
  "$REPO/tools/watchdog.plist" > "$TARGET"
plutil -lint "$TARGET" >/dev/null || { echo "the generated plist does not parse: $TARGET" >&2; exit 1; }
echo "installed: $TARGET"

# Reload so a re-install takes effect now, not at the next login. bootout returns before the job is
# gone, and bootstrapping over it fails with "5: Input/output error", so wait until launchd forgets it.
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 50); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.2; done
fi
launchctl bootstrap "$DOMAIN" "$TARGET"
echo "loaded: $LABEL (watchdog checks port 43130 every 60s; log in .data/watchdog.log)"
