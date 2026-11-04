#!/usr/bin/env node
/**
 * ACP adapter entry point (ticket ACP-A1).
 *
 * Serves ACP (JSON-RPC 2.0, newline-delimited) on stdio. Each ACP session
 * spawns a `pi --mode rpc` subprocess and bridges:
 *
 *   client -> initialize      -> handshake (protocolVersion, capabilities)
 *   client -> session/new     -> pi new_session + thinking-level defaults
 *   client -> session/prompt  -> pi prompt, streamed back as session/update
 *                                (agent_message_chunk / agent_thought_chunk)
 *                                plus final usage and stop reason.
 *
 * Diagnostics go to stderr only; stdout carries ACP frames exclusively.
 */
import { Readable } from "node:stream";
import { AgentSideConnection, ndJsonStream, type AnyMessage } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "./acp-server.js";
import { loadConfig } from "./config.js";

function main(): void {
  const config = loadConfig();
  const agent = new PiAcpAgent({
    config,
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
