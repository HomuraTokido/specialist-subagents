#!/usr/bin/env bash
# Install (or remove) the watchdog that owns the specialist-subagents daemon's lifetime, on Linux.
#
# The Linux counterpart of tools/install-watchdog.sh (macOS LaunchAgent) and install-watchdog.ps1
# (Windows Startup entry): a systemd user service. systemd starts tools/watchdog.mjs when she logs in
# and restarts it if it exits. No sudo needed. Re-running it replaces the installed unit (use it after
# moving the repository, changing node, or changing the proxy).
#
# KillMode=process: stopping or restarting the watchdog ends only the watchdog. The daemon it started,
# and every seat the daemon is running, keep going; the next watchdog finds the port answering and
# leaves them alone. Without it systemd would kill the whole cgroup, daemon and seats included.
#
# The service does not read ~/.bashrc, so the proxy variables of the installing shell (HTTP(S)_PROXY,
# NO_PROXY, either case) are written into the unit; the backend CLIs the daemon starts need them.
#
# Run:    bash tools/install-watchdog-linux.sh
#         bash tools/install-watchdog-linux.sh --remove
# Check:  node bin/specialist-subagents.mjs status
#         systemctl --user status specialist-subagents-watchdog
#         tail -5 .data/watchdog.log
set -euo pipefail

UNIT=specialist-subagents-watchdog.service
REPO=$(cd "$(dirname "$0")/.." && pwd)
TARGET="$HOME/.config/systemd/user/$UNIT"

if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now "$UNIT" 2>/dev/null && echo "stopped and disabled: $UNIT" || echo "was not enabled: $UNIT"
  if [ -f "$TARGET" ]; then
    # Recoverable where the desktop has a trash; the daemon itself keeps running until stopped.
    if command -v gio >/dev/null 2>&1; then gio trash "$TARGET"; else rm -f "$TARGET"; fi
    systemctl --user daemon-reload
    echo "removed: $TARGET"
  fi
  echo "the daemon is still up if it was; stop it with: node bin/specialist-subagents.mjs stop"
  exit 0
fi

NODE=$(command -v node) || { echo "node is not on PATH; install node or put it on PATH, then run this again" >&2; exit 1; }
# Not the installing shell's PATH: that one carries whatever the current terminal or agent session added.
# node's directory, npm's global bin, the per-user bin where the claude CLI installs itself, then the system.
NPM_BIN="$(npm prefix -g 2>/dev/null)/bin"
JOB_PATH="$(dirname "$NODE"):$NPM_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p "$(dirname "$TARGET")" "$REPO/.data"

{
  echo "# Written by $REPO/tools/install-watchdog-linux.sh; edit that script and re-run it instead."
  echo "[Unit]"
  echo "Description=specialist-subagents watchdog (keeps the daemon on port 43130 up)"
  echo
  echo "[Service]"
  echo "WorkingDirectory=$REPO"
  echo "ExecStart=$NODE $REPO/tools/watchdog.mjs"
  echo "Environment=\"PATH=$JOB_PATH\""
  for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    if [ -n "${!name:-}" ]; then echo "Environment=\"$name=${!name}\""; fi
  done
  echo "Restart=always"
  echo "RestartSec=10"
  echo "KillMode=process"
  echo
  echo "[Install]"
  echo "WantedBy=default.target"
} > "$TARGET"
systemd-analyze --user verify "$TARGET" >/dev/null || { echo "the generated unit does not verify: $TARGET" >&2; exit 1; }
echo "installed: $TARGET"

systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null
systemctl --user restart "$UNIT"
echo "running: $UNIT (watchdog checks port 43130 every 60s; log in .data/watchdog.log)"
