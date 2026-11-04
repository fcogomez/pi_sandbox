# acp — ACP adapter for `pi --mode rpc` (tickets ACP-A1/A2)

A self-contained npm package that speaks the [Agent Client Protocol (ACP)](https://agentclientprotocol.com)
(JSON-RPC 2.0, newline-delimited, over stdio) on one end and pi's RPC mode
(`pi --mode rpc`, JSONL commands/responses + session event stream) on the other.

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
  `stopReason: end_turn`.
- pi-RPC-side thinking controls: `set_thinking_level`, `get_available_thinking_levels`,
  `cycle_thinking_level`, `get_state` (see `src/thinking.ts`).

Deferred by design (documented in code comments, not implemented in A1):
ACP runtime `session/set_mode` / `session/set_config_option` thinking override,
tool mapping + `session/request_permission` + `fs/read_text_file` (A2),
`session/load` / `session/cancel` / `session/resume` (A3).

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

## Layout

```
pi-extension.ts      standalone pi extension (loaded via -e, NOT compiled by
                     tsup): permission gate + read-tool override
src/index.ts         entry: stdio ACP server; passes the extension path to the agent
src/acp-server.ts    ACP agent: initialize, session/new, session/prompt, tool
                     event mapping, permission + fs extension_ui handlers
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
```

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
