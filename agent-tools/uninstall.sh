#!/bin/sh
# agent-tools — Mac-side uninstaller.
#
# Removes exactly what install.sh creates (plus the pre-rename mcp-relay
# leftovers, for a clean slate):
#   - launchd agents: com.pi.agent-tools, com.pi.agent-tools-macops
#     (and legacy com.pi.mcp-relay / com.pi.mcp-relay-macops, if present)
#   - plists in ~/Library/LaunchAgents (new and legacy names)
#   - install dirs: ~/agent-tools and legacy ~/mcp-relay
#   - configs + bearer keys: ~/Library/Application Support/agent-tools
#     (and legacy ~/Library/Application Support/mcp-relay)
#   - logs in ~/Library/Logs (new and legacy names, incl. mac-ops audit)
#
# WARNING: deleting the config dir removes the bearer keys. Any consumer
# (Hermes / pi) wired to the relays stops working until you re-run
# install.sh and update its env.
#
# Usage: ./uninstall.sh   (asks for "yes" before doing anything)
set -eu

LABEL="com.pi.agent-tools"
MACOPS_LABEL="com.pi.agent-tools-macops"
LEGACY_LABEL="com.pi.mcp-relay"
LEGACY_MACOPS_LABEL="com.pi.mcp-relay-macops"
LEGACY_DEST_DIR="$HOME/mcp-relay"
LEGACY_CONFIG_DIR="$HOME/Library/Application Support/mcp-relay"
LOG_DIR="$HOME/Library/Logs"

echo "== agent-tools uninstall =="
echo "This removes BOTH relay instances, their configs and bearer keys,"
echo "and the install dir(s). Consumers wired to them will stop working."
echo ""
printf "Type 'yes' to continue: "
read -r ANS
if [ "$ANS" != "yes" ]; then
  echo "Aborted. Nothing was changed."
  exit 1
fi

# ---- unload + remove both agents (new and legacy names) ---------------------
for l in "$LABEL" "$MACOPS_LABEL" "$LEGACY_LABEL" "$LEGACY_MACOPS_LABEL"; do
  launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
done
for p in "$LABEL.plist" "$MACOPS_LABEL.plist" "$LEGACY_LABEL.plist" "$LEGACY_MACOPS_LABEL.plist"; do
  rm -f "$HOME/Library/LaunchAgents/$p"
done
echo "launchd: agents unbooted, plists removed"

# ---- install dirs ------------------------------------------------------------
rm -rf "$HOME/agent-tools"
[ -d "$LEGACY_DEST_DIR" ] && rm -rf "$LEGACY_DEST_DIR"
echo "dirs   : ~/agent-tools removed (legacy ~/mcp-relay too, if present)"

# ---- configs + keys -----------------------------------------------------------
rm -rf "$HOME/Library/Application Support/agent-tools"
[ -d "$LEGACY_CONFIG_DIR" ] && rm -rf "$LEGACY_CONFIG_DIR"
echo "config : removed (bearer keys destroyed)"

# ---- logs (new and legacy names) ---------------------------------------------
rm -f "$LOG_DIR/agent-tools.console.log" \
      "$LOG_DIR/agent-tools.stderr.log" \
      "$LOG_DIR/agent-tools-macops.console.log" \
      "$LOG_DIR/agent-tools-macops.stderr.log" \
      "$LOG_DIR/mac-ops.log" \
      "$LOG_DIR/mcp-relay.console.log" \
      "$LOG_DIR/mcp-relay.stderr.log" \
      "$LOG_DIR/mcp-relay-macops.console.log" \
      "$LOG_DIR/mcp-relay-macops.stderr.log"
echo "logs   : removed"

echo ""
echo "Uninstall complete."
