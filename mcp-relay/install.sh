#!/bin/bash
# install.sh (ticket M1.2) — Mac-side install for the mcp-relay daemon.
# Run on the Mac (where Xcode + `xcrun mcpbridge` live). Idempotent; safe to re-run.
#
#   node relay.mjs            WS (bearer) <-> xcrun mcpbridge (stdio), one child per connection
#
# Defaults: port 3129, bind 127.0.0.1 (loopback only — VLAN exposure requires
# the explicit --bind flag; see mcp-relay/README.md security model).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${MCP_RELAY_DEST:-$HOME/mcp-relay}"
CONFIG_DIR="$HOME/Library/Application Support/mcp-relay"
CONFIG_PATH="$CONFIG_DIR/config.json"
LOGS_DIR="$HOME/Library/Logs"
PLIST_PATH="$HOME/Library/LaunchAgents/com.pi.mcp-relay.plist"
LABEL="com.pi.mcp-relay"

PORT=3129
BIND="127.0.0.1"
PORT_SET=0
BIND_SET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port requires a value}"; PORT_SET=1; shift 2 ;;
    --bind) BIND="${2:?--bind requires a value}"; BIND_SET=1; shift 2 ;;
    *) echo "Unknown flag: $1 (usage: install.sh [--port N] [--bind IP])" >&2; exit 2 ;;
  esac
done

echo "== mcp-relay install =="
echo "source : $SRC_DIR"
echo "target : $DEST_DIR"
echo "config : $CONFIG_PATH"
echo "port   : $PORT"
echo "bind   : $BIND"

# 1. Node check (>= 20)
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH. Install Node 20+ (e.g. brew install node) and re-run." >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_VER="$(node --version)"
echo "node   : $NODE_BIN ($NODE_VER)"
NODE_MAJOR="${NODE_VER#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node >= 20 required (found $NODE_VER). Upgrade and re-run." >&2
  exit 1
fi

# 2. Copy files + npm ci (deps: ws only; package-lock.json is committed)
mkdir -p "$DEST_DIR"
cp "$SRC_DIR/relay.mjs" "$DEST_DIR/"
cp "$SRC_DIR/package.json" "$DEST_DIR/"
cp "$SRC_DIR/package-lock.json" "$DEST_DIR/"
(cd "$DEST_DIR" && npm ci --omit=dev --no-audit --no-fund)
echo "deps   : ws installed in $DEST_DIR"

# 3. Config (never overwrite an existing one)
mkdir -p "$CONFIG_DIR" "$LOGS_DIR"
KEY_CREATED=0
if [ ! -f "$CONFIG_PATH" ]; then
  NEW_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")"
  cat > "$CONFIG_PATH" <<EOF
{
  "port": $PORT,
  "bind": "$BIND",
  "key": "$NEW_KEY",
  "debug": false
}
EOF
  KEY_CREATED=1
  echo "config : created $CONFIG_PATH (new key generated)"
else
  KEY_CREATED=0
  echo "config : kept existing $CONFIG_PATH"
  # Explicitly requested --port/--bind are applied to the existing config.
  if [ "$PORT_SET" = "1" ] || [ "$BIND_SET" = "1" ]; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      if (process.argv[2] === "1") cfg.port = parseInt(process.argv[3], 10);
      if (process.argv[4] === "1") cfg.bind = process.argv[5];
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    ' "$CONFIG_PATH" "$PORT_SET" "$PORT" "$BIND_SET" "$BIND"
    echo "config : updated port/bind in $CONFIG_PATH"
  fi
fi
chmod 600 "$CONFIG_PATH"

# 4. launchd agent
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DEST_DIR/relay.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DEST_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOGS_DIR/mcp-relay.console.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGS_DIR/mcp-relay.console.log</string>
</dict>
</plist>
EOF
echo "plist  : wrote $PLIST_PATH"

# 5. (Re)load the launchd agent
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
sleep 1
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "launchd: $LABEL loaded"
else
  echo "WARN: $LABEL may not have loaded; check $LOGS_DIR/mcp-relay.console.log" >&2
fi

# 6. Credentials (printed ONCE, at key creation only)
EFFECTIVE_PORT="$(node -e 'const fs=require("fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).port))' "$CONFIG_PATH")"
EFFECTIVE_BIND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).bind)' "$CONFIG_PATH")"
if [ "$KEY_CREATED" = "1" ]; then
  EFFECTIVE_KEY="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).key)' "$CONFIG_PATH")"
  echo
  echo "== mcp-relay is running =="
  echo
  echo "YOUR RELAY KEY (printed ONLY ONCE — stored in $CONFIG_PATH, mode 600):"
  echo
  echo "  $EFFECTIVE_KEY"
  echo
  echo "Consumer env snippet (set this on the Unraid side, e.g. in the .env of the"
  echo "docker-compose service that runs pi / the Hermes mcp_servers env):"
  echo
  if [ "$EFFECTIVE_BIND" = "127.0.0.1" ]; then
    echo "  # bound to loopback: replace MAC_LAN_IP with the Mac's VLAN IP"
    echo "  MCP_RELAY_URL=ws://MAC_LAN_IP:$EFFECTIVE_PORT"
  else
    echo "  MCP_RELAY_URL=ws://$EFFECTIVE_BIND:$EFFECTIVE_PORT"
  fi
  echo "  MCP_RELAY_KEY=$EFFECTIVE_KEY"
else
  echo
  echo "== mcp-relay is running (existing config kept; key not reprinted) =="
  echo "Current config: port=$EFFECTIVE_PORT bind=$EFFECTIVE_BIND"
  echo "The key lives in $CONFIG_PATH. If you lost it, delete the config file and"
  echo "re-run install.sh to generate a new one (consumers will need the new key)."
fi

echo
echo "Notes:"
echo "  - Xcode must be running (mcpbridge auto-detects it; no env vars needed)."
echo "  - Console log : $LOGS_DIR/mcp-relay.console.log"
echo "  - Child stderr: $LOGS_DIR/mcp-relay.stderr.log"
echo "  - Unload     : launchctl bootout gui/\$(id -u)/$LABEL"
