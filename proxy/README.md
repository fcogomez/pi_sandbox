# acp-proxy — Mac-side ACP proxy (ticket ACP-C1)

Bridges **Xcode** to the **remote pi ACP agent** (pi-sandbox, Unraid).

Xcode 26.6+/27 registers third-party ACP agents via
**Settings → Intelligence → Agents → Add an Agent** and launches the
registered command as a child process, speaking ACP over **stdio**
(NDJSON JSON-RPC). This proxy is that command: a minimal stdio ACP
"agent" that forwards every record over a **WebSocket** (bearer auth)
to the `acp serve` endpoint in the pi-sandbox repo.

```
Xcode (ACP client)
  |  stdio NDJSON (spawn + JSON-RPC)
  v
acp-proxy (this package, on the Mac)
  |  WebSocket, Authorization: *** <PI_ACP_API_KEY>
  v
acp serve (pi-sandbox container, Unraid, ticket B1)
  |  stdio JSONL
  v
pi --mode rpc  ->  LLM
```

The protocol layer behind the WS endpoint is verified CONFORMANT by the
official ACP Test Compatibility Kit on **both** transports (ticket B2),
so the proxy is a transport relay, not a protocol re-implementation.
It adds no protocol framing of its own: one record per WS text message
in both directions (the server normalizes inbound frames to end with LF).

## Files

| File | Purpose |
|---|---|
| `acp-proxy.mjs` | The proxy (single file, only dep: `ws`) |
| `package.json` | Package metadata; install `ws` once: `npm ci` or `npm i` |
| `config.example.json` | Template: `wsUrl` + `apiKey` |
| `install.sh` | Mac install: copies to `~/acp-proxy`, creates 600 config, prints Xcode registration values |
| `com.pi.acp-proxy.plist` | OPTIONAL launchd agent for standalone use (Xcode launches the proxy itself during sessions) |

## Install (on the Mac Mini)

```bash
git pull                      # this repo
cd proxy
bash install.sh
# edit ~/acp-proxy/config.json:
#   wsUrl  : the Unraid host:port for acp serve (e.g. ws://<unraid-ip>:3123),
#            or ws://127.0.0.1:<tunnel-port> if the port is not reachable on
#            the LAN and you front it with an SSH tunnel — the ticket
#            forbids Internet exposure, so keep it private-path only
#   apiKey : the PI_ACP_API_KEY the pi-sandbox adapter was started with
```

Install the `ws` dependency on the Mac (once):

```bash
cd ~/acp-proxy && npm i        # or: npm ci
```

## Register in Xcode

1. Xcode → **Settings → Intelligence → Agents → Add an Agent**
   (first connect to a third-party agent shows an explicit consent
   prompt — allow it).
2. Name: `Pi`. Command: the Node binary path (`/usr/local/bin/node` or
   `~/.nvm/versions/node/<ver>/bin/node`). Args:
   `~/acp-proxy/acp-proxy.mjs`. No env vars needed.
3. Start a session; the agent name `pi-acp-adapter` (from `initialize`)
   confirms the round trip.

`install.sh` prints the exact command/args for step 2.

## Behavior notes

- **Reconnect with backoff + jitter** (500 ms base, 30 s cap): server
  restarts do not hard-fail the transport; buffered records flush to the
  fresh connection.
- **Auto re-initialize after reconnect:** the server creates a fresh
  per-connection agent on every WS connection (B1). After the proxy
  reconnects, it re-sends the client's own `initialize` (with a reserved
  internal id, response swallowed) and holds ALL client frames until the
  ack. No client frame can ever reach a fresh uninitialized agent, no
  matter when it arrives relative to the reconnect (verified: a
  `session/new` sent while the server was down is delivered intact after
  the reconnect).
- **Session state survives server restarts** via the server-side session
  map (A3): after an auto re-initialize, the client re-attaches with
  `session/load` / `session/resume`. This is exactly what F1 gate 4
  exercises.
- **Clean shutdown:** exits on its own when stdin closes (no SIGTERM
  needed — the ACP shutdown expectation, ACP-SHUTDOWN-001) and on
  SIGTERM/SIGINT.
- **Logs:** structured JSON on stderr (`start`, `open`,
  `auto_init_sent`, `auto_init_ack`, `reconnect_scheduled`, `close`,
  `stdin_end`, `exit`, …). The API key never appears in logs, config
  warnings, or the process argument list (it is read from the config
  file, never passed as an argument).
- **Config:** `ACP_PROXY_CONFIG` env var overrides the default path
  (`~/Library/Application Support/acp-proxy/config.json`);
  `--config <path>` works too. `--check` validates the config and
  exits (works before `ws` is installed, which `--version` also does).
  Recommend `chmod 600` on the config file (the proxy warns on a
  world-readable config).

## Verify without Xcode

```bash
# handshake round trip:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
  | node ~/acp-proxy/acp-proxy.mjs

# full protocol suite (needs the acp-tck from the pi-sandbox repo):
../tools/uv run acp-tck --agent-cwd /tmp/wd --timeout 90 --test-timeout 300 \
  --report-json /tmp/ws-tck.json \
  -- node ~/acp-proxy/acp-proxy.mjs
```
