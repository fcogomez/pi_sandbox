#!/bin/bash
# uninstall.sh — remove the mcp-relay + mac-ops install from this Mac.
#
# Removes EXACTLY what install.sh created:
#   - launchd agents : com.pi.mcp-relay, com.pi.mcp-relay-macops (+ plists)
#   - install dir    : $MCP_RELAY_DEST (default $HOME/mcp-relay)
#   - config + keys  : ~/Library/Application Support/mcp-relay/
#   - logs           : ~/Library/Logs/mcp-relay*.log, mac-ops.log
#
# Touches nothing else. Requires typing "yes" to confirm.
set -euo pipefail

DEST_DIR="${MCP_RELAY_DEST:-$HOME/mcp-relay}"
CONFIG_DIR="$HOME/Library/Application Support/mcp-relay"
LOGS_DIR="$HOME/Library/Logs"
LABELS=("com.pi.mcp-relay" "com.pi.mcp-relay-macops")
PLISTS=("$HOME/Library/LaunchAgents/com.pi.mcp-relay.plist"
        "$HOME/Library/LaunchAgents/com.pi.mcp-relay-macops.plist")
LOGS=("$LOGS_DIR/mcp-relay.console.log" "$LOGS_DIR/mcp-relay.log"
      "$LOGS_DIR/mcp-relay.stderr.log" "$LOGS_DIR/mcp-relay-macops.console.log"
      "$LOGS_DIR/mcp-relay-macops.log" "$LOGS_DIR/mcp-relay-macops.stderr.log"
      "$LOGS_DIR/mac-ops.log")

echo "== mcp-relay + mac-ops UNINSTALL =="
echo
echo "Will remove:"
for l in "${LABELS[@]}"; do
  if [ -f "$HOME/Library/LaunchAgents/$l.plist" ]; then echo "  launchd agent: $l"; fi
done
[ -d "$DEST_DIR" ] && echo "  install dir  : $DEST_DIR"
[ -d "$CONFIG_DIR" ] && echo "  config+keys  : $CONFIG_DIR  (relay keys are destroyed; consumers break until re-installed)"
for f in "${LOGS[@]}"; do [ -f "$f" ] && echo "  log          : $f"; done
echo
printf 'Type "yes" to continue: '
read -r answer
if [ "$answer" != "yes" ]; then
  echo "Aborted — nothing removed."
  exit 1
fi

# 1. Stop + unregister the launchd agents
UID_NUM="$(id -u)"
for l in "${LABELS[@]}"; do
  launchctl bootout "gui/$UID_NUM/$l" 2>/dev/null || true
done

# 2. Remove plists
for p in "${PLISTS[@]}"; do
  rm -f "$p" && echo "removed: $p"
done

# 3. Remove install dir (scripts + node_modules)
if [ -d "$DEST_DIR" ]; then
  rm -rf "$DEST_DIR" && echo "removed: $DEST_DIR"
fi

# 4. Remove config + keys
if [ -d "$CONFIG_DIR" ]; then
  rm -rf "$CONFIG_DIR" && echo "removed: $CONFIG_DIR"
fi

# 5. Remove logs
for f in "${LOGS[@]}"; do
  rm -f "$f" && echo "removed: $f"
done

echo
echo "== uninstall complete =="
echo "Consumers (Unraid side) will lose connectivity. To restore, re-run install.sh"
echo "on the Mac and update MCP_RELAY_URL/MCP_RELAY_KEY where the consumer runs."
