# pi-sandbox

Docker image for the **Pi coding agent** ([earendil-works/pi](https://github.com/earendil-works/pi)),
modeled on the upstream "Plain Docker" pattern and the `mark/pi-sandbox` reference,
with **`PI_UID`/`PI_GID` build args** so the in-container user matches the external
Unraid user.

All `models.json` fields (except `cost`) are parameterizable via environment
variables — override at build time (`--build-arg`) or runtime (`-e` / compose
`environment:`) without rebuilding.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | ubuntu:24.04, non-root user (matching UID/GID), Node 26, global `pi` install |
| `config/entrypoint.sh` | Startup script: generates `models.json` from env vars, then `exec pi "$@"` |
| `config/models.json` | Reference example of the generated `models.json` (not loaded directly) |
| `docker-compose.yml` | Standalone service, joins `traefik` network |
| `docker-compose.snippet.yml` | Block to merge into a shared stack |
| `.env.example` | All env vars with defaults |

## Build

```bash
cp .env.example .env
# Edit .env — set PI_UID / PI_GID to your Unraid user, and HOST_WORKSPACE
docker compose build
```

## Run

```bash
# Interactive shell
docker compose run --rm -it pi-sandbox bash

# Non-interactive one-shot
docker compose run --rm pi-sandbox -p "Summarize this repo"

# Specific model + provider (override at runtime)
docker compose run --rm pi-sandbox \
  --provider vllm \
  --model Qwen/Qwen3.8-27B \
  -p "Refactor auth module"

# Read-only review
docker compose run --rm pi-sandbox \
  --tools read,grep,find,ls -p "Review this codebase for bugs"

# Continue last session
docker compose run --rm pi-sandbox -c -p "Continue where we left off"
```

## Environment variables

All `PI_LLM_*` vars are optional — the image ships with sensible defaults.
Override at build time (`--build-arg`) or runtime (`-e` / compose `environment:`).

### Build args (Dockerfile)

| Arg | Default | Purpose |
|-----|---------|---------|
| `PI_UID` | `1000` | In-container user UID (match Unraid user) |
| `PI_GID` | `100` | In-container user GID (match Unraid user) |
| `PI_USER_NAME` | `pi` | Username (also used for `$HOME`) |
| `NODE_MAJOR_VERSION` | `26` | Major Node line |
| `PI_NPM_VERSION` | `latest` | npm tag/version of `pi-coding-agent` |

### Runtime env vars (entrypoint.sh)

| Var | Default | `models.json` field |
|-----|---------|---------------------|
| `PI_LLM_PROVIDER_NAME` | `vllm` | Provider key |
| `PI_LLM_BASE_URL` | `http://vLLM_Qwen3.8_27B_BF16:8000/v1` | `baseUrl` |
| `PI_LLM_API` | `openai-completions` | `api` |
| `PI_LLM_API_KEY` | `nerdtastic` | `apiKey` |
| `PI_LLM_MODEL_ID` | `Qwen/Qwen3.8-27B` | `models[0].id` |
| `PI_LLM_MODEL_NAME` | `Qwen/Qwen3.8-27B (vLLM)` | `models[0].name` |
| `PI_LLM_REASONING` | `true` | `models[0].reasoning` |
| `PI_LLM_INPUT` | `text` | `models[0].input` (comma-separated: `text`, `text,image`) |
| `PI_LLM_CONTEXT_WINDOW` | `262144` | `models[0].contextWindow` |
| `PI_LLM_MAX_TOKENS` | `32768` | `models[0].maxTokens` |

`cost` is fixed at `{input:0, output:0, cacheRead:0, cacheWrite:0}` (local vLLM = free).

### pi runtime env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `PI_CODING_AGENT_DIR` | `/home/pi/.pi/agent` | Config + sessions dir |
| `WORKSPACE_DIR` | `/home/pi/workspace` | Working dir for tasks |
| `PI_OFFLINE` | `1` | Disable startup network ops |
| `PI_SKIP_VERSION_CHECK` | `1` | Skip pi.dev version check |
| `PI_TELEMETRY` | `0` | Disable telemetry |

## How UID/GID works

- `PI_UID` / `PI_GID` are **build args** — they create a numeric user/group inside
  the image. Rebuild the image when they change.
- The entrypoint script generates `models.json` into `$PI_CODING_AGENT_DIR/` at
  container start (so it is owned by the in-container user, not root).
- `HOST_WORKSPACE` is mounted at `/home/pi/workspace`; all file reads/writes
  by `pi` write through to that host dir.

## Example: override model at runtime

```bash
docker run --rm -it \
  -e PI_LLM_MODEL_ID="AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-Multimodal-NVFP4-MTP" \
  -e PI_LLM_BASE_URL="http://vLLM_Qwen3.6_NVFP4_MTP:8000/v1" \
  -e PI_LLM_API_KEY="nerdtastic" \
  -v /mnt/user/appdata/pi/workspace:/home/pi/workspace \
  pi-sandbox:latest \
  -p "Write a Python function that does X"
```

## Example: use in a shared compose stack

Copy the block from `docker-compose.snippet.yml` into your existing
`docker-compose.yml`, adjusting the image name, network, and env vars.
