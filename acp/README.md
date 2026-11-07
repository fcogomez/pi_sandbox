# acp — ACP adapter for `pi --mode rpc` (tickets ACP-A1…B2)

A self-contained npm package that speaks the [Agent Client Protocol (ACP)](https://agentclientprotocol.com)
(JSON-RPC 2.0, newline-delimited) on one end and pi's RPC mode
(`pi --mode rpc`, JSONL commands/responses + session event stream) on the other.

**Two transports, one code path (B1):**

- `acp` (no subcommand): stdio — the spec-native transport.
- `acp serve`: WebSocket (NDJSON over WS text messages) with **required**
  bearer auth (`PI_ACP_API_KEY`; refuses to start open; `crypto.timingSafeEqual`
  on the upgrade). Binds `PI_ACP_HOST:PI_ACP_PORT` (default `127.0.0.1:3123`).
  Each WS connection gets its own `PiAcpAgent` (fresh sessions, isolated pi
  children). See `src/serve.ts`.

## A1 scope

- `initialize` — handshake: `protocolVersion`, agent capabilities, agent info; reads
  the client's capabilities. A1 does **not** advertise tool-call/permission or
  fs-read capabilities (A2) or session persistence (A3).
- `session/new` — spawns one `pi --mode rpc` per session, runs `new_session`,
  queries `get_available_thinking_levels`, applies the configured default thinking
  level (`medium` when the model has tiers), and reports the levels in the session
  info as a `thought_level` select config option.
- `session/prompt` — runs the prompt in pi and streams results back as ACP
  `session/update` notifications: `agent_message_chunk` (text deltas),
  `agent_thought_chunk` (thinking deltas), and a final `usage`; ends with
  `stopReason: end_turn`. **Resolves at turn completion** (pi's
  `agent_settled` event), not at pi's prompt acceptance (B2 fix: real pi
  answers the `prompt` command at acceptance and writes the session file
  only after the turn — ACP clients that load/resume right after a prompt
  depend on the turn being complete).
- pi-RPC-side thinking controls: `set_thinking_level`, `get_available_thinking_levels`,
  `cycle_thinking_level`, `get_state` (see `src/thinking.ts`).

B2 (conformance) added:

- `session/set_config_option` — runtime override for the advertised
  `thinking_level` select option (applies the level, returns the COMPLETE
  configOptions list, ACP-CONFIG-002). `session/set_mode` remains
  unimplemented (no modes are advertised).
- Tool-call `locations[].path` is always **absolute** (resolved against the
  session cwd; ACP-PROMPT-004).
- `session/load` / `session/resume` of a live in-memory session that was
  never prompted (no on-disk file yet — pi writes it on the first prompt)
  reuse the live session instead of failing "session file missing".

## A2 scope

Tool mapping, permissions, and read delegation. Each session's pi is spawned
with the bundled standalone extension (`-e acp/pi-extension.ts`; the adapter
computes its absolute path relative to the package root and sets
`ACP_FS_DELEGATION` ("1"/"0") and `ACP_GATED_TOOLS` (comma-joined)
env vars on the child):

- **Tool mapping** (`src/tool-mapping.ts`): pi `tool_execution_start` /
  `tool_execution_update` / `tool_execution_end` events map to ACP
  `tool_call` / `tool_call_update` session updates. pi's `toolCallId` is used
  as the ACP `toolCallId` as-is. Locked ToolKind table: `read`→`read`,
  `write`/`edit`→`edit`, `bash`→`execute`, `grep`/`find`/`ls`→`search`,
  anything else→`other`.
- **Permissions** (`src/permissions.ts`): the extension gates a configurable
  set of tools (`AcpConfig.gatedTools`, default `bash,write,edit`; read-only
  tools are never gated) on pi's `tool_call` event via `ctx.ui.select` with
  the title convention `[acp:perm] <tool> [id:<toolCallId>] <summary>`. In
  RPC mode pi emits `extension_ui_request` and blocks; the adapter emits a
  `tool_call` update (status `pending`), calls ACP
  `session/request_permission` with exactly two options
  (`allow_once`, `reject_once`), and writes the selected option id back to
  pi (`extension_ui_response {value}`). Reject (or any failure) blocks the
  tool; there is no "always" memory in A2.
- **`fs/read_text_file`** (`src/fs-delegation.ts`): the extension overrides
  the built-in `read` tool and, when `fsDelegation` is enabled (default
  `true`, env `ACP_FS_DELEGATION=1`), calls
  `ctx.ui.input("[acp:read] <absolutePath>")`. The adapter intercepts it and,
  if the client advertised the `fs.readTextFile` capability, calls
  `connection.readTextFile({sessionId, path})` and writes the content back;
  otherwise it writes `cancelled: true` and the extension falls back to a
  local `readFile`. The extension applies `offset`/`limit` to the content.

Out of scope in A2: `session/load` / `session/cancel` / `session/resume`
(A3), `fs/write_text_file` delegation, persistent permission memory.

## A3 scope

- `session/load` and `session/resume` — session persistence via a JSON
  session map (`~/.acp-pi/sessions.json`, atomic write). `load` replays
  history to the client; `resume` re-attaches to a pi session after
  restart (pi session file lookup via `get_state`). `initialize`
  advertises `{ loadSession: true, sessionCapabilities: { resume: {} } }`.
- `session/cancel` — aborts the in-flight pi turn
  (`stopReason: "cancelled"`); unknown ids log and resolve.

## Layout

```
pi-extension.ts      standalone pi extension (loaded via -e, NOT compiled by
                     tsup): permission gate + read-tool override
src/index.ts         entry: stdio ACP server; `serve` subcommand -> src/serve.ts
src/serve.ts         B1: WebSocket transport (bearer auth, per-connection
                     PiAcpAgent, shared createAgentStream helper)
src/acp-server.ts    ACP agent: initialize, session/new, session/prompt
                     (turn-completion via agent_settled), session/load/resume/
                     cancel, set_config_option, tool event mapping, permission
                     + fs extension_ui handlers
src/pi-rpc.ts        pi subprocess wrapper: JSONL framing (LF-only split,
                     no U+2028/U+2029), async id-correlated commands, event
                     stream, extension_ui_request/response sub-protocol
src/thinking.ts      thinking-level control (maps to pi RPC commands)
src/config.ts        adapter config: thinkingLevel (default "medium"),
                     gatedTools (default bash,write,edit), fsDelegation
                     (default true); optional JSON config file
                     (ACP_PI_CONFIG or ./acp.config.json)
src/tool-mapping.ts  pure tool event -> ACP session/update mapping
src/permissions.ts   request_permission round-trip + title conventions
src/fs-delegation.ts read_text_file delegation to the ACP client
test/fake-pi-rpc.ts  in-process fake pi speaking the same JSONL (offline tests),
                     incl. tool events + extension_ui_request/response
test/fake-acp-client.ts  configurable fake ACP client + in-memory harness
test/acp.test.ts     A1 node --test unit tests against the fakes
test/tools.test.ts   A2 tool call lifecycle tests
test/permissions.test.ts  A2 permission granted/denied tests
test/fs.test.ts      A2 read_text_file delegation tests
test/smoke.test.ts   B2 offline smoke: initialize -> session/new ->
                     session/prompt round trip in BOTH transports (WS via a
                     real startAcpServer + raw ws client + fake pi)
tools/ws-stdio-bridge.mjs  B2 test harness: stdio<->WS bridge so stdio-only
                     tooling (the ACP TCK) can drive `acp serve`
```

## ACP conformance (B2, verified 2026-11-05)

Run against the official ACP Test Compatibility Kit
(`agentclientprotocol/acp-tck` v0.2.0, protocol v1, schema rev
`beac4ba9`), driving a **real** `pi --mode rpc` (0.85.1) against a live
vLLM endpoint in both: the stdio transport (the TCK's native mode) — and
the WS transport via `tools/ws-stdio-bridge.mjs` (a stdio↔WS bridge for
stdio-only tooling; the production Mac client in C1 is a native WS ACP
client, not this bridge).

**Verdict: CONFORMANT on both transports** — stdio: 31/31 MANDATORY PASS,
6/6 advertised CAPABILITY PASS; WS (via the bridge): 31/31 MANDATORY PASS,
6/6 CAPABILITY PASS, 5/5 INFORMATIONAL PASS (the bridge self-exits on
client stdin close, satisfying ACP-SHUTDOWN-001 over WS). 11 ADVISORY pass
on each transport, with 1 shared documented deviation:

- **ACP-SESSION-004 (ADVISORY) — documented deviation:** the `mcpServers`
  array is accepted on `session/new`/`load`/`resume` but **not forwarded**
  to pi (logged and ignored). The TCK's stdio-MCP-server probe therefore
  sees no connection. ADVISORY (a SHOULD), so it does not affect the
  verdict, and the TCK itself lists the MCP/terminal/filesystem
  capability surfaces as "not yet covered". Forwarding `mcpServers` to pi
  is a deliberate follow-up, not an oversight.

### Re-verified against pi 1.5.0 (2026-11-06)

Upstream `@earendil-works/pi-coding-agent` moved 0.85.1 → **1.5.0** (a
major line). Before pinning 1.5.0 in the Dockerfile, the full TCK was
re-run against a **real** `pi --mode rpc` 1.5.0 (same vLLM endpoint):
**CONFORMANT** — 31/31 MANDATORY, 6/6 CAPABILITY, 5/5 INFORMATIONAL,
11/12 ADVISORY (the same single ACP-SESSION-004 deviation), 55 passed /
18 skipped — identical to the 0.85.1 result. The 1.x bump did not change
the `pi --mode rpc` JSONL contract this adapter depends on
(`agent_settled` / `agent_end` / `switch_session` / extension API), nor
the `pi -p --mode json` stream the MCP bridge parses, nor the
`--thinking` level enum. Safe to build on 1.5.0.

B2 conformance findings fixed in this ticket (all verified by the kit run):

1. **Real-pi prompt field:** pi 0.85.1's RPC `prompt` command takes
   `message`, not `text` (the A1–A3 `FakePi` was modeled on `text`, which
   masked this — every real prompt crashed with `Cannot read properties of
   undefined (reading 'startsWith')`). ACP-PROMPT-001/003, ACP-META-001.
2. **Turn-completion semantics:** `session/prompt` now resolves at
   `agent_settled` (see A1 scope note above). ACP-LOAD-001/002/003,
   ACP-RESUME-001/002.
3. `session/set_config_option` implemented. ACP-CONFIG-002.
4. Absolute `locations[].path` in tool calls. ACP-PROMPT-004.

The offline smoke test (`test/smoke.test.ts`) covers the same
`initialize` → `session/new` → `session/prompt` round trip in **both**
transports with no real pi/LLM (the WS test drives a real
`startAcpServer` on an ephemeral port with a raw-NDJSON `ws` client and
the in-process fake pi via the spawner seam).

The full TCK JSON report is kept outside the repo (it embeds the
verification environment's hostnames/paths); the verdict above and the
per-requirement status are the committed record.

## Development

```
npm ci
npm run build      # tsup -> dist/ (bin "acp")
npx tsc --noEmit   # typecheck
npm test           # node --import tsx --test test/*.test.ts (offline, fake pi only)
```

## Architecture notes

The overall bridge shape (one stdio-facing ACP agent, one
`pi --mode rpc` child process per session, id-correlated JSONL commands,
event-stream → session/update mapping) follows the same architectural pattern
as `svkozak/pi-acp` (github.com/svkozak/pi-acp, MIT), which was used as a
reference only. **No code from that project was copied**; this is an
independent implementation.
