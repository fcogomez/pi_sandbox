#!/bin/bash
set -euo pipefail

# Generates ${PI_CODING_AGENT_DIR}/models.json from environment variables,
# then execs pi with all arguments. All non-cost fields are parameterizable;
# cost is fixed at 0 (local vLLM = free).

PROVIDER_NAME="${PI_LLM_PROVIDER_NAME:-vllm}"
ARGS=()
BASE_URL="${PI_LLM_BASE_URL}"
API="${PI_LLM_API}"
API_KEY="${PI_LLM_API_KEY}"
MODEL_ID="${PI_LLM_MODEL_ID}"
MODEL_NAME="${PI_LLM_MODEL_NAME}"
REASONING="${PI_LLM_REASONING}"
CONTEXT_WINDOW="${PI_LLM_CONTEXT_WINDOW}"
MAX_TOKENS="${PI_LLM_MAX_TOKENS}"

# The image ships only placeholder defaults (public repo — no real endpoints).
# Fail fast if a required value was not overridden at runtime.
MISSING=()
if [ -z "$BASE_URL" ] || [ "$BASE_URL" = "http://your-llm-host:8000/v1" ]; then
  MISSING+=("PI_LLM_BASE_URL")
fi
if [ -z "$API_KEY" ] || [ "$API_KEY" = "<your-api-key>" ]; then
  MISSING+=("PI_LLM_API_KEY")
fi
if [ -z "$MODEL_ID" ] || [ "$MODEL_ID" = "your-org/your-model" ]; then
  MISSING+=("PI_LLM_MODEL_ID")
fi
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "[pi-sandbox] FATAL: missing LLM provider config — set: ${MISSING[*]}" >&2
  echo "[pi-sandbox] Example: docker run -e PI_LLM_BASE_URL=http://host:8000/v1 -e PI_LLM_API_KEY=*** -e PI_LLM_MODEL_ID=org/model ..." >&2
  exit 1
fi

# Build a JSON array from a comma-separated env var (e.g. "text" or "text,image")
INPUT_RAW="${PI_LLM_INPUT:-text}"
INPUT_JSON="["
FIRST=true
IFS=',' read -ra _PARTS <<< "${INPUT_RAW}"
for part in "${_PARTS[@]}"; do
  part="$(echo "${part}" | xargs)"
  if [ "${FIRST}" = true ]; then
    INPUT_JSON+="\"${part}\""
    FIRST=false
  else
    INPUT_JSON+=", \"${part}\""
  fi
done
INPUT_JSON+="]"

mkdir -p "${PI_CODING_AGENT_DIR}"

cat > "${PI_CODING_AGENT_DIR}/models.json" <<EOF
{
  "providers": {
    "${PROVIDER_NAME}": {
      "baseUrl": "${BASE_URL}",
      "api": "${API}",
      "apiKey": "${API_KEY}",
      "models": [
        {
          "id": "${MODEL_ID}",
          "name": "${MODEL_NAME}",
          "reasoning": ${REASONING},
          "input": ${INPUT_JSON},
          "contextWindow": ${CONTEXT_WINDOW},
          "maxTokens": ${MAX_TOKENS},
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
EOF

echo "[pi-sandbox] Generated ${PI_CODING_AGENT_DIR}/models.json (provider=${PROVIDER_NAME}, model=${MODEL_ID})"

# --- shared memory (pi-memory protocol) ------------------------------------
MEMORY_DIR="${PI_MEMORY_DIR:-/home/pi/memory}"
# Fallback: if the memory bind mount is absent, use a copy inside the shared
# workspace so Hermes can still reach it.
if [ ! -d "$MEMORY_DIR" ] && [ -n "${WORKSPACE_DIR:-}" ] && [ -d "$WORKSPACE_DIR" ]; then
  MEMORY_DIR="$WORKSPACE_DIR/.pi-memory"
fi
mkdir -p "$MEMORY_DIR"

mem_hook() {
  # Copy latest memory back to the workspace so it's visible outside the container.
  local ws="${WORKSPACE_DIR:-/home/pi/workspace}"
  if [ -d "$ws" ] && [ -d "$MEMORY_DIR" ]; then
    cp -a "$MEMORY_DIR"/. "$ws"/.pi-memory/ 2>/dev/null || true
  fi
}
trap mem_hook EXIT

# Seed from workspace if local copy is empty
if [ ! -f "$MEMORY_DIR/MEMORY.md" ]; then
  local_src="${WORKSPACE_DIR:-/home/pi/workspace}/.pi-memory"
  [ -d "$local_src" ] && cp -a "$local_src"/. "$MEMORY_DIR"/ 2>/dev/null || true
fi

# Tell pi to use the shared Hindsight memory (official CLI — no 3rd-party ext)
HS_BANK="${HINDSIGHT_BANK_ID:-agents}"
cat > /tmp/.pi-mem-prompt <<EOF

## Shared memory (Hindsight CLI — shared bank with Hermes)
You have long-term shared memory via the \`hindsight\` CLI (bank: ${HS_BANK}).
Before starting a task, run: hindsight memory recall ${HS_BANK} "<task summary in one sentence>"
  — read the recalled memories and let them inform your work. No results is normal for new topics.
When your task finishes, run: hindsight memory retain ${HS_BANK} "<what you did: files changed, key decisions, test results, remaining risks>" --async
Durable facts worth remembering long-term (conventions, pitfalls, environment) are retained the same way — the server extracts facts on its side.
Never write secrets into memory. If hindsight errors (server down, auth), continue the task and note the failure in your summary.
EOF
ARGS+=("--append-system-prompt" "$(cat /tmp/.pi-mem-prompt)")

# --- xcode MCP relay (mcp-relay, ticket M1.2) ---------------------------
# Registers the "xcode" MCP server (in-image pi) pointing at the consumer
# shim /opt/mcp-relay/remote-stdio.mjs, which speaks WS (bearer) to the
# Mac-side relay. Only when real (non-placeholder) values are configured.
# Upserts mcpServers.xcode in ${PI_CODING_AGENT_DIR}/mcp.json (pi 1.5.2
# user-level MCP config), preserving any other entries the user added.
MCP_RELAY_URL="${MCP_RELAY_URL:-}"
MCP_RELAY_KEY="${MCP_RELAY_KEY:-}"
if [ -n "$MCP_RELAY_URL" ] && [ -n "$MCP_RELAY_KEY" ] \
   && [ "$MCP_RELAY_URL" != "ws://MAC_IP:3129" ] && [ "$MCP_RELAY_KEY" != "CHANGE_ME_RELAY_KEY" ]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    let cfg = { mcpServers: {} };
    try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
    cfg.mcpServers.xcode = {
      command: "node",
      args: ["/opt/mcp-relay/remote-stdio.mjs"],
      env: { MCP_RELAY_URL: process.env.MCP_RELAY_URL, MCP_RELAY_KEY: process.env.MCP_RELAY_KEY },
      description: "Xcode tooling relayed from the Mac (DocumentationSearch, project state, builds)."
    };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  ' "${PI_CODING_AGENT_DIR}/mcp.json"
  echo "[pi-sandbox] Registered xcode MCP server (relay: ${MCP_RELAY_URL})"
else
  echo "[pi-sandbox] xcode MCP relay not configured (set MCP_RELAY_URL + MCP_RELAY_KEY to real values to enable)"
fi

# --- mcp mode: run the MCP bridge daemon instead of exec'ing pi ------------
# models.json and the memory prompt file are already in place; the bridge
# reads both (and appends the memory prompt itself to each pi task).
if [ "${1:-}" = "mcp" ]; then
  if [ -z "${PI_MCP_API_KEY:-}" ]; then
    echo "[pi-sandbox] FATAL: PI_MCP_API_KEY is not set; the MCP bridge refuses to start open." >&2
    exit 1
  fi
  echo "[pi-sandbox] Starting MCP bridge on :${PI_MCP_PORT:-3103} (workspace=${WORKSPACE_DIR})"
  exec node /opt/pi-mcp/server.js
fi

# --- acp mode: run the ACP adapter daemon (WebSocket server) ----------------
# `acp serve` listens on ${PI_ACP_HOST:-127.0.0.1}:${PI_ACP_PORT:-3123};
# bearer-key auth (PI_ACP_API_KEY) is required — the server refuses to start
# open. models.json is already in place; each ACP session spawns its own
# `pi --mode rpc` child.
if [ "${1:-}" = "acp" ]; then
  if [ -z "${PI_ACP_API_KEY:-}" ]; then
    echo "[pi-sandbox] FATAL: PI_ACP_API_KEY is not set; the ACP server refuses to start open." >&2
    exit 1
  fi
  echo "[pi-sandbox] Starting ACP server on ${PI_ACP_HOST:-127.0.0.1}:${PI_ACP_PORT:-3123}"
  exec node /opt/acp/dist/index.js serve
fi

exec pi "${ARGS[@]}" "$@"
