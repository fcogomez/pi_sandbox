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
| `Dockerfile` | ubuntu:24.04, non-root user (matching UID/GID), Node 26, global `pi` install, bundled MCP bridge (`mcp/`) |
| `config/entrypoint.sh` | Startup script: generates `models.json` from env vars, then `exec pi "$@"` — or the MCP bridge daemon in `mcp` mode |
| `config/models.json` | Reference example of the generated `models.json` (not loaded directly) |
| `mcp/server.js` | MCP bridge (HTTP/StreamableHTTP, Node + `@modelcontextprotocol/sdk`): exposes pi as a serial task queue to MCP clients (Hermes) |
| `mcp/package.json` | Bridge dependencies (SDK + zod); `package-lock.json` pinned for `npm ci` |
| `docker-compose.yml` | Standalone services: `pi-sandbox` (interactive) + `pi-sandbox-mcp` (daemon), joins `traefik` network |
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
| `PI_LLM_BASE_URL` | `http://your-llm-host:8000/v1` (placeholder — set yours) | `baseUrl` |
| `PI_LLM_API` | `openai-completions` | `api` |
| `PI_LLM_API_KEY` | *(no default — set in `.env`)* | `apiKey` |
| `PI_LLM_MODEL_ID` | `your-org/your-model` (placeholder) | `models[0].id` |
| `PI_LLM_MODEL_NAME` | `your-org/your-model (example)` (placeholder) | `models[0].name` |
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
  -e PI_LLM_MODEL_ID="your-org/your-model" \
  -e PI_LLM_BASE_URL="http://your-llm-host:8000/v1" \
  -e PI_LLM_API_KEY="***" \
  -v /path/to/your/workspace:/home/pi/workspace \
  pi-sandbox:latest \
  -p "Write a Python function that does X"
```

## MCP mode (persistent bridge for Hermes)

The image bundles an MCP bridge (`mcp/`) that exposes pi as a serial task
queue over HTTP/StreamableHTTP, so an MCP client (Hermes Agent) can delegate
coding tasks to it without any Docker access.

Run:

```bash
# PI_MCP_API_KEY must be set (openssl rand -hex 32)
docker compose up -d pi-sandbox-mcp
# or standalone:
docker run -d --name pi-sandbox-mcp --net traefik \
  -e PI_MCP_API_KEY="***" -e PI_MCP_PORT=3103 \
  -e PI_LLM_BASE_URL="http://your-llm-host:8000/v1" \
  -e PI_LLM_API_KEY="***" \
  -e PI_LLM_MODEL_ID="your-org/your-model" \
  -v /path/to/your/workspace:/home/pi/workspace \
  ghcr.io/fcogomez/pi_sandbox:latest mcp
```

The bridge (port 3103, `Authorization: Bearer <key>` on every request):

| Tool | Purpose |
|------|---------|
| `pi_task_submit(goal, workdir?)` | Queue a task; returns `task_id` immediately |
| `pi_task_wait(task_id, timeout_s?)` | Block until done (or current progress) |
| `pi_task_log(task_id)` | Non-blocking progress check |
| `pi_task_list()` | Queue/running/finished state |
| `pi_health()` | pi version, loaded models, vLLM reachability |
| `pi_memory_show(days?)` | Read the shared memory folder |

Behavior notes:

- **Serial queue** — one `pi -p --mode json` child at a time; results include
  final text, exit code, and changed files (git-aware).
- **workdir is sandboxed** — resolved against `/home/pi/workspace`; path
  escapes are rejected.
- **Memory protocol** — the entrypoint's shared-memory system prompt is
  appended to every task, and each task is logged to `memory/log/`.
- **Hermes registration** (`~/.hermes/config.yaml`). Use the Docker DNS
  hostname when Hermes is on the same bridge network (no port publishing
  needed — preferred); otherwise use the host LAN IP with a published port:
  ```yaml
  mcp_servers:
    pi-sandbox:
      url: "http://pi-sandbox-mcp:3103/mcp"   # or http://<host-lan-ip>:3103/mcp
      headers: { Authorization: "Bearer <PI_MCP_API_KEY>" }
      timeout: 3600
  ```
  Tools register as `mcp_pi_sandbox_pi_task_submit`, etc.

## Example: use in a shared compose stack

Copy the block from `docker-compose.snippet.yml` into your existing
`docker-compose.yml`, adjusting the image name, network, and env vars.
