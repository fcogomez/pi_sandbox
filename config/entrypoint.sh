#!/bin/bash
set -euo pipefail

# Generates ${PI_CODING_AGENT_DIR}/models.json from environment variables,
# then execs pi with all arguments. All non-cost fields are parameterizable;
# cost is fixed at 0 (local vLLM = free).

PROVIDER_NAME="${PI_LLM_PROVIDER_NAME:-vllm}"
BASE_URL="${PI_LLM_BASE_URL}"
API="${PI_LLM_API}"
API_KEY="${PI_LLM_API_KEY}"
MODEL_ID="${PI_LLM_MODEL_ID}"
MODEL_NAME="${PI_LLM_MODEL_NAME}"
REASONING="${PI_LLM_REASONING}"
CONTEXT_WINDOW="${PI_LLM_CONTEXT_WINDOW}"
MAX_TOKENS="${PI_LLM_MAX_TOKENS}"

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

exec pi "$@"
