# pi-sandbox

Docker image for the **Pi coding agent** ([earendil-works/pi](https://github.com/earendil-works/pi)),
modeled on the upstream "Plain Docker" pattern and the `mark/pi-sandbox` reference,
with **`PI_UID`/`PI_GID` build args** so the in-container user matches the external
Unraid user.

Three ways to drive pi:

- **Interactive** — `docker compose run` one-shots and shells.
- **MCP task queue** (`mcp` mode) — Hermes (or any MCP client) delegates
  coding tasks to a persistent bridge.
- **ACP server** (`acp` mode) — **Xcode 27** (or any ACP client) drives pi
  remotely, including file operations executed on the Mac.
- **MCP relay** (reverse direction) — agents on Unraid invoke Xcode's MCP
  tools (builds, tests, devices, docs) that live on the Mac.

All `models.json` fields (except `cost`) are parameterizable via environment
variables — override at build time (`--build-arg`) or runtime (`-e` / compose
`environment:`) without rebuilding.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | ubuntu:24.04, non-root user (matching UID/GID), Node 26, Python 3 (+pip, venv), OpenJDK 25 + Gradle, global `pi` install, bundled MCP bridge (`mcp/`), ACP adapter (`acp/`), MCP relay consumer shim (`agent-tools/`) |
| `config/entrypoint.sh` | Startup script: generates `models.json` from env vars, then `exec pi "$@"` — or the MCP bridge daemon in `mcp` mode / the ACP server in `acp` mode; registers the `xcode-tools` MCP server when relay env is set |
| `config/models.json` | Reference example of the generated `models.json` (not loaded directly) |
| `mcp/server.js` | MCP bridge (HTTP/StreamableHTTP, Node + `@modelcontextprotocol/sdk`): exposes pi as a serial task queue to MCP clients (Hermes) |
| `mcp/package.json` | Bridge dependencies (SDK + zod); `package-lock.json` pinned for `npm ci` |
| `acp/` | ACP adapter package (stdio + WS transports): tool mapping, permission prompts, fs read/write delegation, session load/resume — see `acp/README.md` |
| `proxy/` | Mac-side ACP proxy: stdio↔WS bridge between Xcode and the ACP server — see `proxy/README.md` |
| `agent-tools/` | Mac-side MCP relay daemon (launchd) + Unraid stdio shim: lets agents on Unraid use Xcode's MCP tools — see `agent-tools/README.md` |
| `scripts/mcpbridge-probe.mjs` | MCP wire research probe for `xcrun mcpbridge` (handshake, tool list, read-only call) |
| `docker-compose.yml` | Standalone services: `pi-sandbox` (interactive) + `pi-sandbox-mcp` (daemon) + `pi-sandbox-acp` (ACP daemon), joins `traefik` network |
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

# Persistent daemons
docker compose up -d pi-sandbox-mcp   # MCP task queue (needs PI_MCP_API_KEY)
docker compose up -d pi-sandbox-acp   # ACP server (needs PI_ACP_API_KEY)
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

### ACP mode env vars (`pi-sandbox-acp` service)

| Var | Default | Purpose |
|-----|---------|---------|
| `PI_ACP_API_KEY` | *(no default — REQUIRED)* | Bearer key for the WS endpoint; the server refuses to start without it |
| `PI_ACP_PORT` | `3123` | WS listen port (container-only; never published) |
| `PI_ACP_HOST` | `0.0.0.0` | Bind address — all container interfaces so Traefik can reach it (safe: no host port publish) |
| `PI_ACP_DOMAIN` | `pi.example.lan` (placeholder) | Traefik `Host()` rule — a name under your own domain (DNS record + auto-issued cert) |
| `PI_ACP_ENTRYPOINTS` | `https` | Traefik entrypoint |
| `PI_ACP_CERTRESOLVER` | `production` | Let's Encrypt certresolver |
| `PI_ACP_MIDDLEWARES` | `secured@file` | LAN IP whitelist + security headers — keeps the endpoint LAN-only despite the public domain |

### MCP relay env vars (any pi-sandbox service)

| Var | Default | Purpose |
|-----|---------|---------|
| `AGENT_TOOLS_URL` | `ws://MAC_IP:3129` (placeholder) | Mac relay address (the Mac's VLAN IP). When set to a real value together with the key, the entrypoint registers the `xcode-tools` MCP server for in-container pi |
| `AGENT_TOOLS_KEY` | *(placeholder)* | Bearer key for the relay — printed once by `agent-tools/install.sh` on the Mac |

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

## ACP mode (Xcode 27 → Pi)

The image bundles an [Agent Client Protocol (ACP)](https://agentclientprotocol.com)
adapter (`acp/`) so **Xcode 27's coding assistant** — or any ACP client — can
drive pi remotely. Xcode spawns the registered agent over stdio; a small
Mac-side proxy (`proxy/`) forwards every record over a WebSocket to the
`acp serve` endpoint in the `pi-sandbox-acp` container.

```
Xcode (ACP client, on the Mac)
  |  stdio NDJSON
  v
acp-proxy (~/acp-proxy, launched by Xcode)
  |  WSS, Authorization: Bearer <PI_ACP_API_KEY>
  v
acp serve (pi-sandbox-acp container, via the host's Traefik — LAN-only)
  |  JSONL stdio
  v
pi --mode rpc  ->  LLM
```

Features:

- **Streaming** — text and thinking chunks stream back as ACP
  `session/update` notifications; Xcode renders them live.
- **Tool calls + permissions** — pi's tool use is rendered as ACP tool
  calls; gated tools (`bash`, `write`, `edit`) require a permission prompt
  (allow once / reject) from Xcode.
- **File operations on the Mac** — when the client advertises the fs
  capability (Xcode does), `read`/`write` go through ACP
  `fs/read_text_file` / `fs/write_text_file`: Xcode executes them on the Mac
  side, with a permission prompt per write (content never travels in the
  dialog).
- **Sessions** — `session/load` + `session/resume` (session map under
  `~/.acp-pi/sessions.json`); thinking level is a runtime config option.

Conformance: the protocol layer is verified **CONFORMANT** by the official
ACP Test Compatibility Kit on both transports (stdio and WS) — see
`acp/README.md` for the full record.

### Setup

1. **Unraid** — set the ACP vars in `.env` (see env tables above) and start
   the daemon:
   ```bash
   docker compose up -d pi-sandbox-acp
   ```
   No host port is published. Traefik exposes `$PI_ACP_DOMAIN` on the LAN
   behind the `secured` middleware (LAN IP whitelist + security headers),
   and the WS endpoint additionally requires the bearer key.
2. **Mac** — install the proxy:
   ```bash
   git pull && cd proxy && bash install.sh
   ```
   then set `wsUrl` (`wss://<PI_ACP_DOMAIN>`) and `apiKey`
   (`PI_ACP_API_KEY`) in `~/Library/Application Support/acp-proxy/config.json`.
3. **Xcode** — Settings → Intelligence → Agents → **Add an Agent**: name
   `Pi`, command `node`, args = the proxy path printed by `install.sh`.
   Open a coding assistant conversation (⌘0) and prompt as usual.

Debug: set `"debug": true` in the proxy config to log every ACP frame to
`~/Library/Logs/acp-proxy.log`.

## MCP relay (Pi/Hermes → Xcode tools)

The reverse direction: agents **on Unraid** invoke **Xcode's MCP tools** —
53 tools covering builds, tests, run destinations, device interaction,
crash logs, localization, project file ops, and documentation search — that
live on the Mac.

Xcode exposes those tools only through `xcrun mcpbridge`, a stdio MCP server
that auto-detects the running Xcode (no env vars required). `agent-tools/`
ships two pieces:

- **`relay.mjs`** (Mac daemon under launchd): one WS listener that spawns
  `xcrun mcpbridge` per connection and pipes stdio 1:1. Bearer key required
  on every connection; binds to `127.0.0.1` unless `install.sh --bind <ip>`
  says otherwise; no public exposure.
- **`remote-stdio.mjs`** (in the image at `/opt/agent-tools/`): the consumer
  shim — a stdio MCP server that pipes to the relay over WS.

When `AGENT_TOOLS_URL` + `AGENT_TOOLS_KEY` are set to real values, the entrypoint
registers an **`xcode-tools`** MCP server for in-container pi (stdio → shim →
relay → mcpbridge → Xcode). The same shim works directly as an Hermes
`mcp_servers` entry. In ACP (Xcode-driven) sessions the mutating Xcode tools
are permission-gated — Xcode shows a prompt before each runs — while the
read-only tools (documentation search, logs, project state, …) run without a
prompt.

Requirements: Xcode running with the project open, and Xcode → Settings →
Intelligence → Model Context Protocol → "Allow External Agents to Use Xcode
Tools" set to Always or While Xcode is Open. With Xcode closed, the bridge
fails cleanly and the error is visible to the consumer (retry after opening
Xcode).

Install: `git pull && cd agent-tools && ./install.sh --bind <mac-static-ip>`
on the Mac — prints the key once plus a ready-to-paste consumer snippet.
Details and the security model: `agent-tools/README.md`.

## Example: use in a shared compose stack

Copy the block from `docker-compose.snippet.yml` into your existing
`docker-compose.yml`, adjusting the image name, network, and env vars.
