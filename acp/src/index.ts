#!/usr/bin/env node
/**
 * ACP adapter entry point (tickets ACP-A1/A2).
 *
 * Serves ACP (JSON-RPC 2.0, newline-delimited) on stdio. Each ACP session
 * spawns a `pi --mode rpc` subprocess (with the bundled extension loaded via
 * `-e acp/pi-extension.ts`, plus `ACP_FS_DELEGATION` / `ACP_GATED_TOOLS`
 * env vars derived from the loaded config) and bridges:
 *
 *   client -> initialize      -> handshake (protocolVersion, capabilities)
 *   client -> session/new     -> pi new_session + thinking-level defaults
 *   client -> session/prompt  -> pi prompt, streamed back as session/update
 *                                (agent_message_chunk / agent_thought_chunk,
 *                                tool_call / tool_call_update) plus final
 *                                usage and stop reason.
 *   pi extension select       -> session/request_permission (gated tools)
 *   pi extension input        -> fs/read_text_file (read delegation,
 *                                cancelled when the client lacks the
 *                                fs.readTextFile capability)
 *
 * Diagnostics go to stderr only; stdout carries ACP frames exclusively.
 */

import { Readable } from "node:stream";
import { AgentSideConnection, ndJsonStream, type AnyMessage } from "@agentclientprotocol/sdk";
import { PI_EXTENSION_PATH, PiAcpAgent } from "./acp-server.js";
import { loadConfig } from "./config.js";

function main(): void {
  const config = loadConfig();
  // The adapter spawns pi with `-e <extensionPath>` and sets
  // ACP_FS_DELEGATION / ACP_GATED_TOOLS on the child env from this config.
  const agent = new PiAcpAgent({
    config,
    extensionPath: PI_EXTENSION_PATH,
    log: (m) => process.stderr.write(`[acp] ${m}\n`),
  });

  // stdio <-> Web streams (the ACP SDK speaks Web Streams).
  const out = new WritableStream<Uint8Array>({
    write: (chunk) => {
      process.stdout.write(Buffer.from(chunk));
    },
  });
  const inStream = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  const stream = ndJsonStream(out, inStream) as {
    writable: WritableStream<AnyMessage>;
    readable: ReadableStream<AnyMessage>;
  };
  const connection = new AgentSideConnection((conn) => agent.attach(conn), stream);
  void connection.closed.finally(() => process.exit(0));
}

main();
