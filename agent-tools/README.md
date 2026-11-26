# agent-tools (M1.2)

Relays Mac services to consumers on the Unraid LAN over WebSocket with
bearer auth. Two instances:

- **Xcode bridge** (port 3129): `xcrun mcpbridge` (stdio) — Xcode tools.
- **mac-ops** (port 3130): `node mac-ops.mjs` (stdio) — allowlist operations
  only: Xcode artifact cleanup + git tools (`repo` is a required per-call
  parameter). No free-form command execution.

```
                 Unraid (this image)                                Mac Mini
   ┌────────────────────────────────────────────┐     ┌──────────────────────────────────────────┐
   │ Hermes  ──stdio(NDJSON)──► remote-stdio.mjs │     │  ~/agent-tools/relay.mjs (launchd)       │
   │ pi      ──stdio(NDJSON)──► (same shim)      │ WS  │    │  Bearer auth on upgrade             │
   │                                             │ ◄──► │    │  1 connection = 1 child            │
   │ env: AGENT_TOOLS_URL + AGENT_TOOLS_KEY      │     │    ▼                                     │
   │ (point at 3129 = Xcode, 3130 = mac-ops)     │     │  xcrun mcpbridge / node mac-ops.mjs      │
   └────────────────────────────────────────────┘     │    ──► Xcode  /  git repo (per call)     │
              VLAN only (no internet exposure)        └──────────────────────────────────────────┘
```

Transport contract (probe-verified, `scripts/mcpbridge-probe.mjs`):
newline-delimited JSON-RPC 2.0, **one line per frame on both ends**, in both
directions. The relay and the shim are transparent line pipes; mcpbridge
needs **no env vars** (it auto-detects the running Xcode).

**Naming note:** the project was formerly `mcp-relay`. Env vars renamed
`MCP_RELAY_URL/KEY/CONFIG/BRIDGE_CMD/FRAME_LOG/STDERR_LOG` to
`AGENT_TOOLS_URL/KEY/CONFIG/BRIDGE_CMD/FRAME_LOG/STDERR_LOG`. The legacy
`MCP_RELAY_*` names are still accepted (deprecated) by the relay and the
shim, so existing consumer registrations keep working until you migrate.

## Files

| File | Runs where | Role |
|---|---|---|
| `relay.mjs` | Mac (launchd) | WS server; per-connection bridge child; child stderr → log file only |
| `mac-ops.mjs` | Mac (bridge child of 2nd relay) | Allowlist MCP server: `xcode_cleanup` + git tools (no shell, closed subcommand set, `repo` is a required per-call parameter) |
| `remote-stdio.mjs` | Unraid (any node host/container) | stdio MCP ↔ WS shim; env config only |
| `install.sh` | Mac | node check, `npm ci`, config + key generation, both launchd agents, legacy mcp-relay migration |
| `uninstall.sh` | Mac | Removes both agents, install dir, configs/keys, logs (interactive confirm) |
| `test/` | anywhere (node ≥ 20) | `node --test` suite against `test/fake-mcpbridge.mjs` (no Xcode, no LAN) |

## Security model

- **Loopback by default.** Each relay instance binds `127.0.0.1` unless
  `install.sh --bind <IP>` is used explicitly. The mac-ops instance inherits
  the Xcode instance's bind when created, so exposure stays symmetric.
  VLAN exposure is a deliberate, visible decision.
- **Bearer key on the WS upgrade.** The upgrade request must carry the
  bearer token (timing-safe comparison); failure → HTTP 401 and **no child
  process is spawned**. Each key is 32 random bytes (base64url), generated
  by `install.sh`, stored in `~/Library/Application Support/agent-tools/`
  (mode 600), and printed **once** at creation.
- **No internet exposure.** No public domain, no reverse-proxy route, no
  `0.0.0.0` default. The relays are reachable only from the LAN/VLAN where
  the Mac sits.
- **No secrets in the repo.** This repo contains placeholders only. Real
  values live in the Mac's generated configs and the Unraid host `.env`.
- **Child stderr never enters the MCP stream.** It is appended to
  `~/Library/Logs/agent-tools.stderr.log` only.
- **TLS is out of scope (future hardening).** The wire is unencrypted
  `ws://` inside a trusted VLAN. If the network is ever untrusted, put
  `stunnel` (or a TLS-terminating proxy) in front of the relay port and point
  consumers at `wss://` — the shim already accepts `wss://` URLs.
- **mac-ops is an allowlist, not a shell.** Its tools are a closed set with
  fixed commands spawned as argv (never a shell string):
  - `xcode_cleanup` deletes only `~/Library/Developer/Xcode/DerivedData` and
    the per-user temp `ActionArtifacts` dir; each path is `realpath`-resolved
    and must stay under its allowed root before deletion.
  - `git_*` tools take a REQUIRED `repo` parameter (absolute path) on every
    call — validated each time (exists, is a git repo), realpath-resolved as
    the git cwd. Nothing is pinned at install time, so the same instance
    serves any repo on the Mac. Subcommands are fixed
    (`status/log/diff/branch/remote/fetch/checkout/pull/push`); branch
    names are regex-validated; `pull` is `--ff-only`; push is never
    `--force`; no `git config`, no remote mutation, no credential handling.
  - Every mac-ops invocation is appended as JSONL to
    `~/Library/Logs/mac-ops.log` (audit trail).
- **Separate keys.** Each relay instance has its own bearer key
  (`config.json` / `config-macops.json`), so revoking one does not touch the
  other.

## Mac install (one-time)

```sh
cd agent-tools          # repo checkout on the Mac
./install.sh            # loopback default; installs BOTH instances
# or, to expose on the VLAN:
./install.sh --bind <MAC_VLAN_IP> [--port N]
# mac-ops needs no repo config: every git tool call passes the repo path
# itself (e.g. git_status with repo = /Users/<you>/github/<repo>)
```

`install.sh` installs and reloads two launchd agents: `com.pi.agent-tools`
(port 3129 → `xcrun mcpbridge`) and `com.pi.agent-tools-macops` (port 3130 →
`node mac-ops.mjs`, with its own key and logs). It prints each key **once**
and ready-to-paste consumer env snippets. Xcode must be running for the
Xcode tools to be available; with Xcode closed, `initialize` returns a
JSON-RPC error and the child exits (clean failure, surfaced to the consumer
as a WS close with code 4500).

**Legacy migration (from mcp-relay):** re-running the installer on a
pre-rename Mac install boots out the old `com.pi.mcp-relay*` agents,
carries the existing configs (and keys) over to
`~/Library/Application Support/agent-tools/` — so consumer keys are
unchanged — and removes the old plists. The old `~/mcp-relay` install dir is
left in place; delete it by hand once the new install is verified.

Re-run is idempotent: existing configs (and keys) are kept; both launchd
agents are rewritten and reloaded; a legacy `mac-ops.json` (from mac-ops
v1.0.x) is removed if present. Console logs:
`~/Library/Logs/agent-tools.console.log`, `~/Library/Logs/agent-tools-macops.console.log`.

## Uninstall

```sh
cd agent-tools
./uninstall.sh          # asks for "yes"; removes exactly what install.sh created
```

Removes both launchd agents + plists (new and legacy mcp-relay names), the
install dir (`~/agent-tools`, plus the legacy `~/mcp-relay` if present),
`~/Library/Application Support/agent-tools/` (configs **and keys** —
consumers break until re-install), and the log files. Touches nothing else.

## Consumer wiring

The shim accepts `AGENT_TOOLS_URL` / `AGENT_TOOLS_KEY` (canonical) or the
legacy `MCP_RELAY_URL` / `MCP_RELAY_KEY` (deprecated). Point each consumer
entry at the instance it wants: 3129 = Xcode tools, 3130 = mac-ops.

### (a) Hermes — `mcp_servers` entry

```toml
[mcp_servers.xcode-tools]
command = "node"
args = ["/path/to/pi-sandbox/agent-tools/remote-stdio.mjs"]
env = { AGENT_TOOLS_URL = "ws://<mac-host>:3129", AGENT_TOOLS_KEY = "key-from-mac-config" }
```

### (b) pi (in the pi-sandbox image)

pi 1.5.2 registers MCP servers in `mcp.json` (user-level:
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/mcp.json`; project-level: `.pi/mcp.json`).
Supported transports: **stdio** (`command`/`args`/`env`) and **streamable HTTP**
(`url`/`headers`) — no SSE, no native WS transport, hence the stdio shim.

The image's entrypoint (`config/entrypoint.sh`) upserts the `xcode-tools`
entry into `${PI_CODING_AGENT_DIR}/mcp.json` on startup **when**
`AGENT_TOOLS_URL` and `AGENT_TOOLS_KEY` are set to real (non-placeholder)
values (legacy `MCP_RELAY_*` names still trigger it):

```json
{
  "mcpServers": {
    "xcode-tools": {
      "command": "node",
      "args": ["/opt/agent-tools/remote-stdio.mjs"],
      "env": {
        "AGENT_TOOLS_URL": "url-from-image-env",
        "AGENT_TOOLS_KEY": "key-from-image-env"
      },
      "description": "Xcode tooling relayed from the Mac (DocumentationSearch, project state, builds)."
    }
  }
}
```

Equivalent manual setup inside a session host: `pi mcp add xcode-tools --env
AGENT_TOOLS_URL='url-value' --env AGENT_TOOLS_KEY='key-value' --
node /opt/agent-tools/remote-stdio.mjs`, then `/reload`.

### (c) mac-ops (port 3130)

Same shim, second instance, its own key:

```toml
[mcp_servers.mac-ops]
command = "node"
args = ["/path/to/pi-sandbox/agent-tools/remote-stdio.mjs"]
env = { AGENT_TOOLS_URL = "ws://<mac-host>:3130", AGENT_TOOLS_KEY = "key-from-macops-config" }
```

pi: a second `mcp.json` entry of the same shape pointing at the 3130 values.

## Tests

```sh
cd agent-tools
npm install            # ws (package-lock.json committed; install.sh uses npm ci)
npm test               # node --test — fully offline, fake mcpbridge, ephemeral ports
```

Coverage: bearer auth (401 + no child spawned), WS↔stdio round-trip,
client-disconnect → child SIGTERM, child-exit → WS close 4500 with exit code +
last stderr line, concurrent-connection isolation (distinct pids), shim
round-trip, relay-death propagation, missing-env failure, legacy env-name
fallback.
