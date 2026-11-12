#!/bin/bash
# install.sh (ticket ACP-C1) — Mac-side install for the ACP proxy.
# Run on the Mac Mini. Idempotent; safe to re-run.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${ACP_PROXY_DEST:-$HOME/acp-proxy}"
# Config lives at the proxy's default lookup path (macOS convention), so
# the proxy finds it without env vars. Overridable via ACP_PROXY_CONFIG.
CONFIG_DIR="$HOME/Library/Application Support/acp-proxy"
CONFIG_PATH="$CONFIG_DIR/config.json"

echo "== acp-proxy install =="
echo "source : $SRC_DIR"
echo "target : $DEST_DIR"
echo "config : $CONFIG_PATH"

# 1. Node check
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH. Install Node 22+ (e.g. brew install node) and re-run." >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_VER="$(node --version)"
echo "node   : $NODE_BIN ($NODE_VER)"
case "$NODE_VER" in
  v1[0-9].*|v20.*|v21.*) echo "ERROR: Node >= 22 required (found $NODE_VER)."; exit 1 ;;
esac

# 2. Copy files + dependencies (ws)
mkdir -p "$DEST_DIR"
cp "$SRC_DIR/acp-proxy.mjs" "$DEST_DIR/"
cp "$SRC_DIR/package.json" "$DEST_DIR/"
chmod 700 "$DEST_DIR"
(cd "$DEST_DIR" && npm install --omit=dev --no-audit --no-fund)
echo "deps   : ws installed in $DEST_DIR"

# 3. Config (never overwrite an existing one)
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_PATH" ] && [ -f "$DEST_DIR/config.json" ]; then
  # migrate: earlier install.sh versions created the config in DEST_DIR
  mv "$DEST_DIR/config.json" "$CONFIG_PATH"
  echo "config : migrated $DEST_DIR/config.json -> $CONFIG_PATH"
elif [ ! -f "$CONFIG_PATH" ]; then
  cp "$SRC_DIR/config.example.json" "$CONFIG_PATH"
  echo "config : created $CONFIG_PATH  (EDIT THIS: wsUrl + apiKey)"
else
  echo "config : kept existing $CONFIG_PATH"
fi
chmod 600 "$CONFIG_PATH"

# 4. Verify
echo "== config check =="
ACP_PROXY_CONFIG="$CONFIG_PATH" node "$DEST_DIR/acp-proxy.mjs" --check
echo "config OK"

echo
echo "== done =="
echo "Edit $CONFIG_PATH (wsUrl + apiKey) if not done already."
echo
echo "Xcode registration (Settings > Intelligence > Agents > Add an Agent):"
echo "  name   : Pi"
echo "  command: $NODE_BIN"
echo "  args   : $DEST_DIR/acp-proxy.mjs"
echo "  (no env vars needed; the key comes from config.json)"
echo
echo "Quick test from the terminal:"
echo "  echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1,\"clientCapabilities\":{}}}' | node $DEST_DIR/acp-proxy.mjs"
