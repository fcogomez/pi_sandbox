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

# Tell pi to maintain the memory
cat > /tmp/.pi-mem-prompt <<EOF

## Shared memory protocol
You have a shared memory folder at ${MEMORY_DIR} (format: ${MEMORY_DIR}/PROTOCOL.md).
Before starting a task, run: bash ${MEMORY_DIR}/pi-mem.sh show 3   (if pi-mem.sh exists)
When your task finishes, append one entry to ${MEMORY_DIR}/log/$(date +%F).md using the format in PROTOCOL.md.
Durable facts (env, conventions, pitfalls) go in ${MEMORY_DIR}/MEMORY.md via: bash ${MEMORY_DIR}/pi-mem.sh fact "..."
Never write secrets into these files.
EOF
ARGS+=("--append-system-prompt" "$(cat /tmp/.pi-mem-prompt)")

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

exec pi "${ARGS[@]}" "$@"
