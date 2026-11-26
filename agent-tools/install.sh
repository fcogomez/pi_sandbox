#!/bin/sh
# agent-tools — Mac-side installer (two relay instances).
#
# Installs TWO isolated launchd agents:
#
#   1) com.pi.agent-tools          port 3129  bridge cmd: xcrun mcpbridge
#      (Xcode tooling; Xcode must be running)
#   2) com.pi.agent-tools-macops   port 3130  bridge cmd: node mac-ops.mjs
#      (allowlist ops: xcode_cleanup + git tools; no free-form commands)
#
# Each instance has its OWN bearer key and its own console/stderr logs, so
# a compromised or revoked key on one instance does not touch the other.
#
# What this script does (all under ~/agent-tools and ~/Library/...):
#   1. checks for a node binary (>= 20)
#   2. copies the project files into ~/agent-tools and runs npm ci there
#   3. migrates a pre-rename mcp-relay install (old labels booted out,
#      existing configs — and keys — carried over to
#      ~/Library/Application Support/agent-tools; old plists removed after
#      the new agents load; the old ~/mcp-relay dir is left in place)
#   4. creates ~/Library/Application Support/agent-tools/config.json (and
#      config-macops.json) with a freshly generated bearer key, unless an
#      (or migrated) config already exists — re-runs keep existing keys
#   5. writes + loads the two launchd agents (KeepAlive, RunAtLoad)
#   6. prints the ready-to-paste consumer env snippet (keys shown once)
#
# Usage:
#   ./install.sh [--bind IP] [--port N] [--macops-port N]
#
#   --bind IP        IP to bind to. Default: 127.0.0.1 (loopback only).
#                    The mac-ops instance inherits this value unless
#                    --macops-bind is given. Use your machine's LAN IP to
#                    expose the relays on the local network — that is a
#                    deliberate security decision, so it is never the
#                    default.
#   --port N         Xcode-bridge WS port. Default: 3129.
#   --macops-port N  mac-ops WS port. Default: 3130.
#
# Environment (consumer wiring, optional):
#   AGENT_TOOLS_URL / AGENT_TOOLS_KEY (or legacy MCP_RELAY_URL / MCP_RELAY_KEY)
#   used only to prefill the printed consumer snippet.
#
# Idempotent: safe to re-run; keeps existing configs (and keys), rewrites
# and reloads both agents.
set -eu

# ---- configuration ---------------------------------------------------------
SRC_DIR=$(cd "$(dirname "$0")" && pwd)
DEST_DIR="$HOME/agent-tools"
CONFIG_DIR="$HOME/Library/Application Support/agent-tools"
LEGACY_CONFIG_DIR="$HOME/Library/Application Support/mcp-relay"
LEGACY_DEST_DIR="$HOME/mcp-relay"
LABEL="com.pi.agent-tools"
LEGACY_LABEL="com.pi.mcp-relay"
MACOPS_LABEL="com.pi.agent-tools-macops"
LEGACY_MACOPS_LABEL="com.pi.mcp-relay-macops"
LOG_DIR="$HOME/Library/Logs"

PORT=3129
MACOPS_PORT=3130
BIND=""
MACOPS_BIND=""

usage() {
  sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bind)        BIND="${2:?--bind needs a value}"; shift 2 ;;
    --port)        PORT="${2:?--port needs a value}"; shift 2 ;;
    --macops-port) MACOPS_PORT="${2:?--macops-port needs a value}"; shift 2 ;;
    --macops-bind) MACOPS_BIND="${2:?--macops-bind needs a value}"; shift 2 ;;
    -h|--help)     usage 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

[ -n "$BIND" ] || BIND="127.0.0.1"

echo "== agent-tools install =="
echo "source : $SRC_DIR"
echo "target : $DEST_DIR"
echo "config : $CONFIG_DIR/config.json"
echo "port   : $PORT (xcode) / $MACOPS_PORT (mac-ops)"
echo "bind   : $BIND (pass --bind <IP> to expose on the LAN)"

# ---- migration from the pre-rename mcp-relay install (M2.1) ----------------
# Boot out legacy agents (ignore failures — most won't be loaded).
for l in "$LEGACY_LABEL" "$LEGACY_MACOPS_LABEL"; do
  launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
done
# Carry existing configs (and their keys) over to the new config dir.
if [ -d "$LEGACY_CONFIG_DIR" ]; then
  mkdir -p "$CONFIG_DIR"
  for f in config.json config-macops.json; do
    if [ -f "$LEGACY_CONFIG_DIR/$f" ] && [ ! -f "$CONFIG_DIR/$f" ]; then
      cp -p "$LEGACY_CONFIG_DIR/$f" "$CONFIG_DIR/$f"
      chmod 600 "$CONFIG_DIR/$f"
      echo "migrate: carried $f over from the mcp-relay config dir (key kept)"
    fi
  done
fi

# ---- node check -------------------------------------------------------------
NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ] && [ -x "$HOME/.local/bin/node" ]; then
  NODE_BIN="$HOME/.local/bin/node"
fi
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH (or ~/.local/bin/node). Install Node.js >= 20 and re-run." >&2
  exit 1
fi
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "error: node >= 20 required (found $("$NODE_BIN" --version))." >&2
  exit 1
fi
echo "node   : $NODE_BIN ($("$NODE_BIN" --version))"

# ---- copy project -----------------------------------------------------------
if [ "$SRC_DIR" = "$DEST_DIR" ]; then
  echo "note: running from the install dir itself; skipping copy"
else
  mkdir -p "$DEST_DIR"
  cp -R "$SRC_DIR/." "$DEST_DIR/"
fi
rm -rf "$DEST_DIR/test"
( cd "$DEST_DIR" && "$NODE_BIN" "$("$NODE_BIN" -e 'console.log(require.resolve("npm/bin/npm-cli.js"))' 2>/dev/null || echo npm)" ci --omit=dev --no-audit --no-fund >/dev/null ) || \
  ( cd "$DEST_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null )
echo "deps   : ws installed in $DEST_DIR"

# ---- config + key (Xcode bridge instance) ------------------------------------
mkdir -p "$CONFIG_DIR"
CFG="$CONFIG_DIR/config.json"
KEY=""
if [ -f "$CFG" ]; then
  echo "config : kept existing $CFG"
else
  KEY=$("$NODE_BIN" -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')
  printf '{"port":%s,"bind":"%s","key":"%s","debug":false}\n' "$PORT" "$BIND" "$KEY" > "$CFG"
  chmod 600 "$CFG"
  echo "config : created $CFG (new key generated)"
fi

# ---- config + key (mac-ops instance, isolated from the Xcode bridge) ----------
# mac-ops repo target: NOT an install-time setting. Every git tool call takes
# the repo path itself (required per-call parameter, validated each time), so
# re-running this script never pins or changes a repo. (A legacy mac-ops.json
# from mac-ops v1.0.x is removed below.)
MACOPS_CFG="$CONFIG_DIR/config-macops.json"
MACOPS_KEY=""
if [ -f "$MACOPS_CFG" ]; then
  echo "config : kept existing $MACOPS_CFG"
else
  MACOPS_KEY=$("$NODE_BIN" -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')
  # Bind: explicit --macops-bind > explicit --bind > inherit the Xcode
  # instance's current bind > 127.0.0.1 (keeps both instances symmetric).
  [ -n "$MACOPS_BIND" ] || MACOPS_BIND="$BIND"
  if [ "$MACOPS_BIND" = "127.0.0.1" ] && [ -f "$CFG" ]; then
    CUR_BIND=$("$NODE_BIN" -e 'try{process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8") && JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).bind||"")}catch(e){}' "$CFG")
    [ -n "$CUR_BIND" ] || CUR_BIND="127.0.0.1"
    if [ "$CUR_BIND" != "127.0.0.1" ]; then
      MACOPS_BIND="$CUR_BIND"
      echo "config : mac-ops inherits bind $MACOPS_BIND from the Xcode instance"
    fi
  fi
  printf '{"port":%s,"bind":"%s","key":"%s","debug":false}\n' "$MACOPS_PORT" "$MACOPS_BIND" "$MACOPS_KEY" > "$MACOPS_CFG"
  chmod 600 "$MACOPS_CFG"
  echo "config : created $MACOPS_CFG (new key generated, bind $MACOPS_BIND)"
fi
# Remove the legacy mac-ops v1.0.x repo-pin config if one lingers.
if [ -f "$CONFIG_DIR/mac-ops.json" ]; then
  rm -f "$CONFIG_DIR/mac-ops.json"
  echo "config : removed legacy mac-ops.json (repo is now a per-call parameter)"
fi

# ---- launchd agent (Xcode bridge) --------------------------------------------
mkdir -p "$LOG_DIR"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DEST_DIR/relay.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/agent-tools.console.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/agent-tools.stderr.log</string>
  <key>WorkingDirectory</key><string>$DEST_DIR</string>
</dict>
</plist>
EOF

# ---- launchd agent (mac-ops) --------------------------------------------------
MACOPS_PLIST="$HOME/Library/LaunchAgents/$MACOPS_LABEL.plist"
cat > "$MACOPS_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$MACOPS_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DEST_DIR/relay.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_TOOLS_CONFIG</key><string>$MACOPS_CFG</string>
    <key>AGENT_TOOLS_BRIDGE_CMD</key><string>$NODE_BIN $DEST_DIR/mac-ops.mjs</string>
    <key>AGENT_TOOLS_FRAME_LOG</key><string>$LOG_DIR/agent-tools-macops.console.log</string>
    <key>AGENT_TOOLS_STDERR_LOG</key><string>$LOG_DIR/agent-tools-macops.stderr.log</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/agent-tools-macops.console.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/agent-tools-macops.stderr.log</string>
  <key>WorkingDirectory</key><string>$DEST_DIR</string>
</dict>
</plist>
EOF

# ---- load both agents ---------------------------------------------------------
# Reload: bootout ignores "not loaded"; bootstrap re-registers.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "launchd: $LABEL loaded (port $PORT, bind $BIND)"

launchctl bootout "gui/$(id -u)/$MACOPS_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$MACOPS_PLIST"
echo "launchd: $MACOPS_LABEL loaded (port $MACOPS_PORT, bind $MACOPS_BIND)"

# Both new agents are live: now remove the legacy mcp-relay plists, if any.
for p in "com.pi.mcp-relay.plist" "com.pi.mcp-relay-macops.plist"; do
  if [ -f "$HOME/Library/LaunchAgents/$p" ]; then
    rm -f "$HOME/Library/LaunchAgents/$p"
    echo "migrate: removed legacy plist $p"
  fi
done
if [ -d "$LEGACY_DEST_DIR" ]; then
  echo "note   : the old mcp-relay install dir is still at $LEGACY_DEST_DIR (harmless)."
  echo "         Delete it by hand once the new install is verified."
fi

# ---- consumer wiring snippet ----------------------------------------------------
# Canonical env names: AGENT_TOOLS_URL / AGENT_TOOLS_KEY. Legacy MCP_RELAY_URL /
# MCP_RELAY_KEY are still accepted by the shim (deprecated).
URL="${AGENT_TOOLS_URL:-${MCP_RELAY_URL:-ws://$BIND:$PORT}}"
CKEY="${AGENT_TOOLS_KEY:-${MCP_RELAY_KEY:-}}"
if [ -z "$CKEY" ] && [ -n "$KEY" ]; then
  CKEY="$KEY"
fi
if [ -z "$CKEY" ]; then
  CKEY=$("$NODE_BIN" -e 'try{process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).key||"")}catch(e){}' "$CFG")
fi

echo ""
if [ -n "$KEY" ]; then
  echo "== agent-tools is running — NEW XCODE-BRIDGE KEY (shown once): =="
  echo "$KEY"
else
  echo "== agent-tools is running (existing config kept; key not reprinted) =="
fi
echo "Current config: port=$PORT bind=$BIND"
echo "The key lives in $CFG. If you lost it, delete the config file and"
echo "re-run install.sh to generate a new one (consumers will need the new key)."

echo ""
if [ -n "$MACOPS_KEY" ]; then
  echo "== mac-ops is running — NEW MAC-OPS KEY (shown once): =="
  echo "$MACOPS_KEY"
else
  echo "== mac-ops is running (existing config kept; key not reprinted) =="
fi
echo "mac-ops config: port=$MACOPS_PORT bind=$MACOPS_BIND (key lives in $MACOPS_CFG)"

echo ""
echo "Consumer env snippet (Hermes / pi / any stdio MCP client):"
echo "  AGENT_TOOLS_URL = \"$URL\""
echo "  AGENT_TOOLS_KEY = \"$CKEY\""
echo "(legacy names MCP_RELAY_URL / MCP_RELAY_KEY still work)"
echo "mac-ops snippet (same shim, second instance):"
echo "  AGENT_TOOLS_URL = \"ws://$BIND:$MACOPS_PORT\""
if [ -n "$MACOPS_KEY" ]; then
  echo "  AGENT_TOOLS_KEY = \"$MACOPS_KEY\"   # new key, shown once"
else
  echo "  AGENT_TOOLS_KEY = <the key from $MACOPS_CFG>   # existing key, not reprinted"
fi
echo ""
echo "Notes:"
echo "  - Xcode must be running (mcpbridge auto-detects it; no env vars needed)."
echo "  - mac-ops is allowlist-only: xcode_cleanup + git tools. The repo is a"
echo "    required per-call parameter — no repo is pinned at install time."
echo "  - Console logs : $LOG_DIR/agent-tools.console.log, $LOG_DIR/agent-tools-macops.console.log"
echo "  - mac-ops audit: $LOG_DIR/mac-ops.log (JSONL, every invocation)"
echo "  - Child stderr: $LOG_DIR/agent-tools.stderr.log, $LOG_DIR/agent-tools-macops.stderr.log"
echo "  - Uninstall    : uninstall.sh (removes both agents, configs, keys, logs)"
echo "  - Unload       : launchctl bootout gui/\$(id -u)/$LABEL (and $MACOPS_LABEL)"
