# acp — ACP adapter for `pi --mode rpc` (ticket ACP-A1)

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

Deferred by design (documented in code comments, not implemented): ACP runtime
`session/set_mode` / `session/set_config_option` thinking override, tool mapping +
`session/request_permission` + `fs/read_text_file` (A2), `session/load` /
`session/cancel` / `session/resume` (A3).

## Layout

```
src/index.ts       entry: stdio ACP server, per-session pi --mode rpc spawn
src/acp-server.ts  ACP agent: initialize, session/new, session/prompt
src/pi-rpc.ts      pi subprocess wrapper: JSONL framing (LF-only split,
                   no U+2028/U+2029), async id-correlated commands, event stream
src/thinking.ts    thinking-level control (maps to pi RPC commands)
src/config.ts      adapter config: explicit thinkingLevel field (default "medium"),
                   optional JSON config file (ACP_PI_CONFIG or ./acp.config.json)
test/fake-pi-rpc.ts  in-process fake pi speaking the same JSONL (offline tests)
test/acp.test.ts     node --test unit tests against the fake
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
